import type { Db } from '../db/pool.js';
import { normalise } from '../query/normalize.js';

/**
 * Query redirects.
 *
 * Some queries are not product searches at all. "returns", "shipping" and
 * "warranty" are navigation, and a brand name is often better served by its
 * landing page than by a result grid. A redirect is evaluated before retrieval,
 * so those queries never pay for a search they were never going to use.
 */

export type MatchType = 'exact' | 'contains' | 'starts_with' | 'regex';

export interface RedirectRule {
  id: number;
  siteId: string;
  pattern: string;
  matchType: MatchType;
  url: string;
  label?: string;
  enabled: boolean;
  priority: number;
}

export interface RedirectMatch {
  url: string;
  ruleId: string;
  label?: string;
}

export class RedirectSet {
  private rules: (RedirectRule & { compiled?: RegExp; normalised: string })[];

  constructor(rules: RedirectRule[]) {
    this.rules = rules
      .filter((r) => r.enabled)
      // Highest priority first; ties broken by id so the order is stable.
      .sort((a, b) => b.priority - a.priority || a.id - b.id)
      .map((rule) => ({
        ...rule,
        normalised: normalise(rule.pattern),
        compiled: rule.matchType === 'regex' ? safeRegex(rule.pattern) : undefined,
      }));
  }

  get size(): number {
    return this.rules.length;
  }

  match(query: string): RedirectMatch | null {
    const q = normalise(query);
    if (!q) return null;
    for (const rule of this.rules) {
      if (!matches(rule, q)) continue;
      return { url: rule.url, ruleId: `redirect:${rule.id}`, label: rule.label ?? undefined };
    }
    return null;
  }
}

function matches(
  rule: RedirectRule & { compiled?: RegExp; normalised: string },
  query: string,
): boolean {
  switch (rule.matchType) {
    case 'exact': return query === rule.normalised;
    case 'starts_with': return query.startsWith(rule.normalised);
    case 'contains': return query.includes(rule.normalised);
    // A pattern that failed to compile never matches, rather than throwing on
    // every search until someone notices.
    case 'regex': return rule.compiled ? rule.compiled.test(query) : false;
  }
}

function safeRegex(pattern: string): RegExp | undefined {
  try {
    return new RegExp(pattern, 'i');
  } catch {
    return undefined;
  }
}

export class RedirectStore {
  private cache = new Map<string, { set: RedirectSet; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  async get(siteId: string): Promise<RedirectSet> {
    const cached = this.cache.get(siteId);
    if (cached && cached.expires > Date.now()) return cached.set;
    const rows = await this.rows(siteId, true);
    const set = new RedirectSet(rows);
    this.cache.set(siteId, { set, expires: Date.now() + this.ttlMs });
    return set;
  }

  invalidate(siteId?: string): void {
    if (siteId) this.cache.delete(siteId);
    else this.cache.clear();
  }

  async list(siteId: string): Promise<RedirectRule[]> {
    return this.rows(siteId, false);
  }

  private async rows(siteId: string, enabledOnly: boolean): Promise<RedirectRule[]> {
    const { rows } = await this.db.query(
      `SELECT id, pattern, match_type, url, label, enabled, priority
       FROM redirects WHERE site_id = $1 ${enabledOnly ? 'AND enabled' : ''}
       ORDER BY priority DESC, id`,
      [siteId],
    );
    return rows.map((r) => ({
      id: r.id, siteId, pattern: r.pattern, matchType: r.match_type, url: r.url,
      label: r.label ?? undefined, enabled: r.enabled, priority: r.priority,
    }));
  }

  async create(
    siteId: string,
    input: { pattern: string; matchType: MatchType; url: string; label?: string; priority?: number; author?: string },
  ): Promise<RedirectRule> {
    if (!input.pattern?.trim()) throw new Error('a redirect needs a pattern');
    if (!input.url?.trim()) throw new Error('a redirect needs a destination URL');
    if (input.matchType === 'regex' && !safeRegex(input.pattern)) {
      throw new Error('that regular expression does not compile');
    }
    const { rows } = await this.db.query(
      `INSERT INTO redirects (site_id, pattern, match_type, url, label, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING id, pattern, match_type, url, label, enabled, priority`,
      [siteId, input.pattern, input.matchType, input.url, input.label ?? null,
       input.priority ?? 0, input.author ?? null],
    );
    this.invalidate(siteId);
    const r = rows[0]!;
    return {
      id: r.id, siteId, pattern: r.pattern, matchType: r.match_type, url: r.url,
      label: r.label ?? undefined, enabled: r.enabled, priority: r.priority,
    };
  }

  async remove(siteId: string, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM redirects WHERE site_id = $1 AND id = $2',
      [siteId, id],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  async setEnabled(siteId: string, id: number, enabled: boolean): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE redirects SET enabled = $3, updated_at = now() WHERE site_id = $1 AND id = $2',
      [siteId, id, enabled],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }
}
