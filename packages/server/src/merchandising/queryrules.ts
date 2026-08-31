/**
 * Query merchandising: rules bound to what a shopper typed.
 *
 * Collections merchandise a *product set* — a rule over the catalogue that a
 * shopper browses. This merchandises a *query*: "when someone searches beams,
 * put these three first, push that one down, and never show this one." It is
 * the interaction the console is built around, and the one §9 asks for.
 *
 * Three consequences, in the order they are resolved:
 *
 *   - **hide** removes a product from this query's results entirely.
 *   - **pin** places it at an explicit 1-based slot, ahead of relevance.
 *   - **bury** pushes it to the end without removing it.
 *
 * A pin applies even when the product did not match. That is deliberate and it
 * is most of the point: a merchandiser launching a range wants it on "beams"
 * today, not once the text happens to rank it. The pipeline fetches anything
 * pinned-but-absent by id rather than hoping the query reaches it.
 */
import type { Hit } from '@compass/shared';
import type { Db } from '../db/pool.js';

export type MatchType = 'exact' | 'phrase' | 'contains';
export type RuleAction = 'pin' | 'bury' | 'hide';

export interface QueryRuleAction {
  parentId: string;
  action: RuleAction;
  /** 1-based slot. Pins only; bury and hide have no slot. */
  position: number | null;
}

export interface QueryRule {
  id: number;
  siteId: string;
  /** Empty when the rule fires on a category rather than typed text. */
  query: string;
  /** Set when the rule merchandises a category page instead of a search. */
  categoryId: string | null;
  matchType: MatchType;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  priority: number;
  note: string | null;
  actions: QueryRuleAction[];
}

export interface QueryRuleInput {
  /** One of these, never neither: a rule has to fire on something. */
  query?: string;
  categoryId?: string;
  matchType?: MatchType;
  enabled?: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
  priority?: number;
  note?: string | null;
  actions: QueryRuleAction[];
  author?: string;
}

/** Whitespace and case are not part of what a shopper meant. */
export function normaliseQuery(query: string): string {
  return query.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** A rule is live when it is enabled and inside its schedule. */
export function isLive(rule: QueryRule, now = new Date()): boolean {
  if (!rule.enabled) return false;
  if (rule.startsAt && rule.startsAt > now) return false;
  if (rule.endsAt && rule.endsAt < now) return false;
  return true;
}

export function matchesQuery(rule: QueryRule, query: string): boolean {
  const typed = normaliseQuery(query);
  const trigger = normaliseQuery(rule.query);
  if (!typed || !trigger) return false;
  switch (rule.matchType) {
    case 'exact': return typed === trigger;
    // The trigger appears as a whole phrase, so "beam" does not fire on
    // "beamish" while "faux beam" still fires on "white faux beam".
    case 'phrase': return ` ${typed} `.includes(` ${trigger} `);
    case 'contains': return typed.includes(trigger);
  }
}

/**
 * Apply one rule to a ranked list of products.
 *
 * Runs on the whole ranked window rather than the page, so a pin at slot one
 * lands on page one — applying it per page would put a different product first
 * on every page.
 *
 * `absent` supplies products a pin names that the query did not match; the
 * caller fetches them by id. Anything still missing is skipped rather than
 * leaving a hole where the merchandiser expected a product.
 */
export function applyRule(
  hits: Hit[],
  rule: QueryRule,
  absent: Map<string, Hit> = new Map(),
): Hit[] {
  const byAction = new Map<string, QueryRuleAction>();
  for (const action of rule.actions) byAction.set(action.parentId, action);

  const hidden = new Set(
    rule.actions.filter((a) => a.action === 'hide').map((a) => a.parentId),
  );
  const buried: Hit[] = [];
  const rest: Hit[] = [];
  const found = new Map<string, Hit>();

  for (const hit of hits) {
    if (hidden.has(hit.parentId)) continue;
    const action = byAction.get(hit.parentId);
    if (action?.action === 'pin') {
      found.set(hit.parentId, hit);
      continue;
    }
    if (action?.action === 'bury') {
      buried.push(hit);
      continue;
    }
    rest.push(hit);
  }

  const pins = rule.actions
    .filter((a) => a.action === 'pin')
    .map((a) => ({ action: a, hit: found.get(a.parentId) ?? absent.get(a.parentId) }))
    .filter((p): p is { action: QueryRuleAction; hit: Hit } => Boolean(p.hit))
    // Lowest slot first, so a pin at 1 is placed before a pin at 3 competes.
    .sort((a, b) => (a.action.position ?? Infinity) - (b.action.position ?? Infinity));

  // Pins claim their slots; everything else closes up around them. A slot past
  // the end of the list simply lands at the end rather than padding with holes.
  const out: (Hit | undefined)[] = [];
  const queue = [...rest, ...buried];
  for (const { action, hit } of pins) {
    const slot = Math.max(1, action.position ?? out.length + 1) - 1;
    while (out.length < slot && queue.length) out.push(queue.shift());
    out.splice(Math.min(slot, out.length), 0, hit);
  }
  return [...out, ...queue].filter((h): h is Hit => Boolean(h));
}

interface RuleRow {
  id: string; site_id: string; query: string | null; category_id: string | null;
  match_type: MatchType;
  enabled: boolean; starts_at: Date | null; ends_at: Date | null;
  priority: number; note: string | null;
  parent_id: string | null; action: RuleAction | null; position: number | null;
}

function toRules(rows: RuleRow[]): QueryRule[] {
  const byId = new Map<number, QueryRule>();
  for (const row of rows) {
    const id = Number(row.id);
    let rule = byId.get(id);
    if (!rule) {
      byId.set(id, (rule = {
        id, siteId: row.site_id, query: row.query ?? '', categoryId: row.category_id,
        matchType: row.match_type,
        enabled: row.enabled, startsAt: row.starts_at, endsAt: row.ends_at,
        priority: row.priority, note: row.note, actions: [],
      }));
    }
    if (row.parent_id && row.action) {
      rule.actions.push({ parentId: row.parent_id, action: row.action, position: row.position });
    }
  }
  for (const rule of byId.values()) {
    rule.actions.sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  }
  return [...byId.values()];
}

const SELECT = `
  SELECT r.id, r.site_id, r.query, r.category_id, r.match_type, r.enabled,
         r.starts_at, r.ends_at, r.priority, r.note, a.parent_id, a.action, a.position
  FROM query_rules r
  LEFT JOIN query_rule_actions a ON a.rule_id = r.id`;

export class QueryRuleStore {
  private cache = new Map<string, { rules: QueryRule[]; expires: number }>();

  constructor(private readonly db: Db, private readonly ttlMs = 15_000) {}

  async list(siteId: string): Promise<QueryRule[]> {
    const { rows } = await this.db.query<RuleRow>(
      `${SELECT} WHERE r.site_id = $1
        ORDER BY r.priority DESC, coalesce(r.query, r.category_id)`, [siteId],
    );
    return toRules(rows);
  }

  /**
   * Rules live right now, cached briefly.
   *
   * On the query path, so it degrades the way the rest of the merchandising
   * does: losing the database costs rules, not the ability to search.
   */
  async live(siteId: string): Promise<QueryRule[]> {
    const cached = this.cache.get(siteId);
    if (cached && cached.expires > Date.now()) return cached.rules;
    try {
      const rules = (await this.list(siteId)).filter((r) => isLive(r));
      this.cache.set(siteId, { rules, expires: Date.now() + this.ttlMs });
      return rules;
    } catch (err) {
      console.error({ err: (err as Error).message, site: siteId }, 'query rules unavailable');
      return cached?.rules ?? [];
    }
  }

  /**
   * The highest-priority live rule for what the shopper is looking at.
   *
   * A category is checked first and exactly: browsing a category is an
   * unambiguous statement of where you are, while a query rule is a guess at
   * what some text meant. When both could fire — a search made inside a
   * category — the typed words are the more specific intent and win.
   */
  async forCategory(siteId: string, categoryId: string): Promise<QueryRule | null> {
    if (!categoryId) return null;
    const matching = (await this.live(siteId))
      .filter((rule) => rule.categoryId === categoryId)
      .sort((a, b) => b.priority - a.priority);
    return matching[0] ?? null;
  }

  /** The highest-priority live rule matching this query, or none. */
  async forQuery(siteId: string, query: string): Promise<QueryRule | null> {
    if (!query.trim()) return null;
    const matching = (await this.live(siteId))
      .filter((rule) => rule.query && matchesQuery(rule, query))
      // Priority first, then the most specific trigger: an exact rule for
      // "beams" should beat a contains rule for "beam".
      .sort((a, b) => b.priority - a.priority
        || SPECIFICITY[b.matchType] - SPECIFICITY[a.matchType]
        || b.query.length - a.query.length);
    return matching[0] ?? null;
  }

  async save(siteId: string, input: QueryRuleInput): Promise<QueryRule> {
    const query = normaliseQuery(input.query ?? '');
    const categoryId = (input.categoryId ?? '').trim();
    if (!query && !categoryId) {
      throw new Error('a rule needs a search term or a category');
    }
    if (query && categoryId) {
      throw new Error('a rule fires on a search term or a category, not both');
    }
    const matchType = input.matchType ?? 'exact';
    for (const action of input.actions) {
      if (action.action === 'pin' && (action.position ?? 0) < 1) {
        throw new Error('a pinned product needs a position of 1 or more');
      }
    }

    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      // Two upserts, because the uniqueness that identifies a rule differs:
      // typed rules are unique on (query, match type), category rules on the
      // category. One statement with a shared conflict target would need a
      // constraint covering both, which would let a query rule and a category
      // rule collide on NULLs.
      const params = [siteId, matchType, input.enabled ?? true,
        input.startsAt ?? null, input.endsAt ?? null, input.priority ?? 100,
        input.note ?? null, input.author ?? null];
      const { rows } = categoryId
        ? await client.query<{ id: string }>(
            `INSERT INTO query_rules
               (site_id, match_type, enabled, starts_at, ends_at, priority, note,
                created_by, category_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (site_id, category_id) WHERE category_id IS NOT NULL
             DO UPDATE SET
               enabled = EXCLUDED.enabled, starts_at = EXCLUDED.starts_at,
               ends_at = EXCLUDED.ends_at, priority = EXCLUDED.priority,
               note = EXCLUDED.note, updated_at = now()
             RETURNING id`,
            [...params, categoryId])
        : await client.query<{ id: string }>(
            `INSERT INTO query_rules
               (site_id, match_type, enabled, starts_at, ends_at, priority, note,
                created_by, query)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
             ON CONFLICT (site_id, query, match_type) DO UPDATE SET
               enabled = EXCLUDED.enabled, starts_at = EXCLUDED.starts_at,
               ends_at = EXCLUDED.ends_at, priority = EXCLUDED.priority,
               note = EXCLUDED.note, updated_at = now()
             RETURNING id`,
            [...params, query]);
      const id = Number(rows[0]!.id);
      // Replaced wholesale: the console sends the arrangement it wants, and a
      // diff would let a dropped tile survive as a stale pin.
      await client.query('DELETE FROM query_rule_actions WHERE rule_id = $1', [id]);
      for (const action of input.actions) {
        await client.query(
          `INSERT INTO query_rule_actions (rule_id, parent_id, action, position)
           VALUES ($1,$2,$3,$4) ON CONFLICT (rule_id, parent_id) DO UPDATE
           SET action = EXCLUDED.action, position = EXCLUDED.position`,
          [id, action.parentId, action.action,
           action.action === 'pin' ? action.position : null],
        );
      }
      await client.query('COMMIT');
      this.cache.delete(siteId);
      return (await this.list(siteId)).find((r) => r.id === id)!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async get(siteId: string, id: number): Promise<QueryRule | null> {
    const { rows } = await this.db.query<RuleRow>(
      `${SELECT} WHERE r.site_id = $1 AND r.id = $2`, [siteId, id],
    );
    return toRules(rows)[0] ?? null;
  }

  async remove(siteId: string, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM query_rules WHERE site_id = $1 AND id = $2', [siteId, id],
    );
    this.cache.delete(siteId);
    return (rowCount ?? 0) > 0;
  }

  invalidate(siteId?: string): void {
    if (siteId) this.cache.delete(siteId);
    else this.cache.clear();
  }
}

const SPECIFICITY: Record<MatchType, number> = { exact: 3, phrase: 2, contains: 1 };
