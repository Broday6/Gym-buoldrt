import { createHash, randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/pool.js';

/**
 * Scoped API keys. A `search` key is safe to ship inside a storefront bundle:
 * it can only read search endpoints and post events. An `admin` key can change
 * the catalogue and configuration and must stay server-side.
 */

export type KeyScope = 'search' | 'admin';

export interface KeyIdentity {
  siteId: string;
  scope: KeyScope;
  label: string | null;
}

export function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey(scope: KeyScope): string {
  return `${scope === 'admin' ? 'ck_admin' : 'ck_search'}_${randomBytes(24).toString('base64url')}`;
}

export async function createApiKey(
  db: Db,
  siteId: string,
  scope: KeyScope,
  label?: string,
): Promise<string> {
  const key = generateKey(scope);
  await db.query(
    'INSERT INTO api_keys (site_id, scope, key_hash, label) VALUES ($1, $2, $3, $4)',
    [siteId, scope, hashKey(key), label ?? null],
  );
  return key;
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

/** Guard factory: `requireScope('admin')` rejects search-scoped keys. */
export function requireScope(scope: KeyScope, options: AuthOptions) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (options.open) return;
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
    if (scope === 'admin' && identity.scope !== 'admin') {
      await reply.code(403).send({ error: 'this endpoint requires an admin key' });
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
