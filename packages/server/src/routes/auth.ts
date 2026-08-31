import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';

/**
 * Role-scoped API keys.
 *
 * Four roles, strictly ordered, because the jobs are strictly ordered: an
 * analyst reads what a shopper sees plus the reports; a merchandiser also
 * changes what shoppers see; an admin also changes the catalogue and the keys
 * themselves. Ordering them means one comparison at the guard instead of a
 * permission matrix nobody keeps current.
 *
 * A `search` key is safe to ship inside a storefront bundle. Every other role
 * must stay server-side, or in a console the operator trusts.
 *
 * The column is still called `scope`, and the two original values still mean
 * what they meant, so existing keys keep working across this change.
 */

export const ROLES = ['search', 'analyst', 'merchandiser', 'admin'] as const;
export type KeyScope = (typeof ROLES)[number];

/** What each role adds to the one before it. Shown by the CLI and the console. */
export const ROLE_SUMMARY: Record<KeyScope, string> = {
  search: 'Read search endpoints and post shopper events. Safe in a browser bundle.',
  analyst: 'Everything a storefront can do, plus the reports and catalogue health. Read-only.',
  merchandiser: 'Everything an analyst can do, plus collections, badges, attributes, synonyms and redirects.',
  admin: 'Everything, including catalogue pushes, reindexing and key management.',
};

const RANK: Record<KeyScope, number> = { search: 0, analyst: 1, merchandiser: 2, admin: 3 };

export function isRole(value: unknown): value is KeyScope {
  return typeof value === 'string' && (ROLES as readonly string[]).includes(value);
}

/** Does `held` cover everything `needed` allows? */
export function roleCovers(held: KeyScope, needed: KeyScope): boolean {
  return RANK[held] >= RANK[needed];
}

export interface KeyIdentity {
  siteId: string;
  scope: KeyScope;
  label: string | null;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * The role is in the prefix, because the prefix is what a human sees.
 *
 * A key found in a commit, a log or a support ticket has to announce what it
 * can do without a database lookup — and a merchandiser key that read
 * `ck_search_…` would look like the one that is safe to publish.
 */
export function generateKey(scope: KeyScope): string {
  return `ck_${scope}_${randomBytes(24).toString('base64url')}`;
}

export async function issueApiKey(
  db: Db,
  siteId: string,
  scope: KeyScope,
  label?: string,
): Promise<{ key: string; id: number }> {
  const key = generateKey(scope);
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO api_keys (site_id, scope, key_hash, label)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [siteId, scope, hashKey(key), label ?? null],
  );
  return { key, id: Number(rows[0]!.id) };
}

/** The plaintext key alone, for callers that do not need its row. */
export async function createApiKey(
  db: Db,
  siteId: string,
  scope: KeyScope,
  label?: string,
): Promise<string> {
  return (await issueApiKey(db, siteId, scope, label)).key;
}

export class KeyStore {
  // Keys change rarely and are checked on every search; a short TTL cache keeps
  // authentication off the p95 path without making revocation slow.
  private cache = new Map<string, { identity: KeyIdentity | null; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  async resolve(key: string): Promise<KeyIdentity | null> {
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.identity;
    const { rows } = await this.db.query<{ site_id: string; scope: KeyScope; label: string | null }>(
      'SELECT site_id, scope, label FROM api_keys WHERE key_hash = $1 AND revoked_at IS NULL',
      [hashKey(key)],
    );
    const row = rows[0];
    const identity = row ? { siteId: row.site_id, scope: row.scope, label: row.label } : null;
    this.cache.set(key, { identity, expires: Date.now() + this.ttlMs });
    if (row) {
      // Only on a cache miss, and never awaited: this exists so an operator
      // rotating credentials can tell a live key from a forgotten one, which
      // is not worth a write on the p95 path.
      void this.db
        .query('UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1', [hashKey(key)])
        .catch(() => {});
    }
    return identity;
  }

  invalidate(): void {
    this.cache.clear();
  }
}

export interface AuthOptions {
  keyStore: KeyStore;
  /** Dev escape hatch so the demo storefront runs without provisioning keys. */
  open: boolean;
}

/** Guard factory: `requireScope('merchandiser')` rejects analyst and search keys. */
export function requireScope(scope: KeyScope, options: AuthOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (options.open) {
      // Dev mode still reports an identity, so a route that varies by role
      // behaves the same way it will in production.
      (request as FastifyRequest & { identity?: KeyIdentity }).identity = {
        siteId: (request.params as { site?: string } | undefined)?.site ?? '',
        scope: 'admin',
        label: 'dev-open',
      };
      return;
    }
    const header = request.headers['x-compass-key'];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) {
      await reply.code(401).send({ error: 'missing x-compass-key header' });
      return;
    }
    const identity = await options.keyStore.resolve(key);
    if (!identity) {
      await reply.code(401).send({ error: 'invalid API key' });
      return;
    }
    if (!roleCovers(identity.scope, scope)) {
      // Name the role that is missing: "forbidden" sends an operator hunting
      // through routes to work out which key they should have used.
      await reply.code(403).send({
        error: `this endpoint requires the "${scope}" role or higher; this key is "${identity.scope}"`,
      });
      return;
    }
    const site = (request.params as { site?: string } | undefined)?.site;
    if (site && identity.siteId !== site) {
      await reply.code(403).send({ error: `key is not scoped to site "${site}"` });
      return;
    }
    (request as FastifyRequest & { identity?: KeyIdentity }).identity = identity;
  };
}
