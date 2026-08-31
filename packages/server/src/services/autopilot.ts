/**
 * Merchandising the system proposes for itself.
 *
 * The console can express any rule a merchandiser wants, which is not the same
 * as anyone having time to write them. On a catalogue of 2.3M SKUs, the number
 * of queries worth tuning is larger than any team, so the rules that get
 * written are the ones somebody happened to think of — not the ones the numbers
 * would have picked.
 *
 * This reads what shoppers did and proposes the specific, bounded changes the
 * evidence supports. Three rules, each answering a question a merchandiser
 * would otherwise have to ask by hand for every query:
 *
 *   - **promote** — this product earns clicks from deep in the results.
 *     Shoppers are scrolling past what we ranked first to reach it.
 *   - **demote** — this product holds a top slot and nobody takes it. It is
 *     spending the most valuable space on the page.
 *   - **synonym** — this query finds nothing, and these words find plenty.
 *
 * Every proposal carries the numbers that produced it, applies through the
 * same stores a person would use, and is recorded in the change history — so
 * it is visible, attributable and revertible. Nothing here writes anything on
 * its own; `apply` is called by a person or, when a site turns it on, by the
 * scheduler, and either way the trail says which.
 */
import type { Db } from '../db/pool.js';
import type { QueryRuleStore, QueryRuleAction } from '../merchandising/queryrules.js';
import type { SynonymStore } from '../merchandising/synonyms.js';
import { recordChange } from './history.js';

export type ProposalKind = 'promote' | 'demote' | 'synonym';

/**
 * What an application actually wrote.
 *
 * Returned rather than audited here so the trail is written in one place — the
 * route — exactly as it is for a change a person makes by hand. An automatic
 * change that skipped the audit would be the one kind of change nobody could
 * see or undo, which is the opposite of what makes automation safe to turn on.
 */
export interface AppliedChange {
  entity: 'query_rule' | 'synonym';
  entityId: string;
  before: unknown;
  after: unknown;
}

export interface Evidence {
  label: string;
  value: string;
}

export interface Proposal {
  /**
   * Stable across runs, derived from what the proposal is about rather than
   * when it was generated — a dismissal has to outlive the next rollup.
   */
  id: string;
  kind: ProposalKind;
  query: string;
  /**
   * The products a promotion pins, in the order they are pinned. One proposal
   * covers a whole query rather than one product: the store holds one rule per
   * query, so ten single-product proposals for "beam" would not be ten
   * changes — they would be one change, applied ten times, each overwriting
   * the last.
   */
  products?: { parentId: string; sku: string; clicks: number; position: number; title?: string }[];
  sku?: string;
  title?: string;
  /** What will happen, in the words a merchandiser would use. */
  summary: string;
  /** Why, in numbers. */
  evidence: Evidence[];
  /**
   * How strongly the data supports it, 0..1. Drives ordering, and the
   * threshold above which an unattended run is allowed to act.
   */
  confidence: number;
  /** Searches per month the change would touch. Ordering, not scoring. */
  reach: number;
}

export interface AutopilotOptions {
  /** How far back behaviour counts. */
  windowDays?: number;
  /** Below this many searches a query is noise, whatever its rates look like. */
  minSearches?: number;
  /** Below this many impressions a product on a query is noise. */
  minImpressions?: number;
  /** Slot a promotion pins into. */
  pinPosition?: number;
}

interface Stores {
  queryRules?: QueryRuleStore;
  synonyms?: SynonymStore;
}

/**
 * How many products one promotion pins.
 *
 * Three is the top row on most grids. Pinning more replaces the ranking with a
 * hand-made list, which is the thing this exists to avoid doing by hand.
 */
const MAX_PINS_PER_QUERY = 3;

const DEFAULTS = {
  windowDays: 30,
  minSearches: 20,
  minImpressions: 30,
  pinPosition: 1,
};

export class AutopilotService {
  private readonly options: Required<AutopilotOptions>;

  constructor(
    private readonly db: Db,
    private readonly stores: Stores = {},
    options: AutopilotOptions = {},
  ) {
    this.options = { ...DEFAULTS, ...options };
  }

  /** Everything the evidence currently supports, best first. */
  async proposals(siteId: string, limit = 25): Promise<Proposal[]> {
    const [promote, demote, synonym] = await Promise.all([
      this.promotions(siteId),
      this.demotions(siteId),
      this.synonyms(siteId),
    ]);

    const dismissed = await this.dismissed(siteId);
    const all = [...promote, ...demote, ...synonym]
      .filter((p) => !dismissed.has(p.id))
      // Confidence first, then reach: a change nobody sees is not worth the
      // risk of being wrong, but neither is a popular guess.
      .sort((a, b) => (b.confidence * Math.log1p(b.reach)) - (a.confidence * Math.log1p(a.reach)));
    return all.slice(0, limit);
  }

  /**
   * Products earning clicks from below the fold.
   *
   * The signal is a product whose click share on a query is far above what its
   * average position would predict. Shoppers are working to reach it, which is
   * the clearest statement they can make that it should have been higher.
   */
  private async promotions(siteId: string): Promise<Proposal[]> {
    const { rows } = await this.db.query<{
      query: string; sku: string; parent_id: string;
      clicks: string; searches: string; avg_position: string; carts: string;
    }>(
      `WITH q AS (
         SELECT normalised_query AS query, count(*) AS searches
           FROM events
          WHERE site_id = $1 AND type IN ('search', 'zero_result')
            AND occurred_at >= now() - ($2::int * interval '1 day')
            AND normalised_query <> ''
          GROUP BY 1
         HAVING count(*) >= $3
       )
       SELECT e.normalised_query AS query, e.sku, max(e.parent_id) AS parent_id,
              count(*) FILTER (WHERE e.type = 'click')::text        AS clicks,
              max(q.searches)::text                                 AS searches,
              avg(e.position) FILTER (WHERE e.type = 'click')::text  AS avg_position,
              count(*) FILTER (WHERE e.type = 'add_to_cart')::text  AS carts
         FROM events e
         JOIN q ON q.query = e.normalised_query
        WHERE e.site_id = $1 AND e.sku IS NOT NULL
          AND e.type IN ('click', 'add_to_cart')
          AND e.occurred_at >= now() - ($2::int * interval '1 day')
        GROUP BY e.normalised_query, e.sku
       HAVING count(*) FILTER (WHERE e.type = 'click') >= 5
          AND avg(e.position) FILTER (WHERE e.type = 'click') >= 4
        ORDER BY count(*) FILTER (WHERE e.type = 'click') DESC
        LIMIT 40`,
      [siteId, this.options.windowDays, this.options.minSearches],
    );

    // Grouped by query, because a rule is per query. Within one, the products
    // shoppers work hardest to reach come first.
    const byQuery = new Map<string, typeof rows>();
    for (const row of rows) {
      const list = byQuery.get(row.query) ?? [];
      list.push(row);
      byQuery.set(row.query, list);
    }

    const out: Proposal[] = [];
    for (const [query, group] of byQuery) {
      const ranked = group
        .map((row) => ({
          parentId: row.parent_id,
          sku: row.sku,
          clicks: Number(row.clicks),
          carts: Number(row.carts),
          position: Number(row.avg_position),
          searches: Number(row.searches),
        }))
        // Depth times volume: a product clicked often from far down is the
        // clearest case that the order is wrong.
        .sort((a, b) => (b.clicks * b.position) - (a.clicks * a.position))
        .slice(0, MAX_PINS_PER_QUERY);
      if (!ranked.length) continue;

      const searches = ranked[0]!.searches;
      const clicks = ranked.reduce((n, p) => n + p.clicks, 0);
      const carts = ranked.reduce((n, p) => n + p.carts, 0);
      const depth = ranked.reduce((n, p) => n + p.position, 0) / ranked.length;

      out.push({
        id: `promote:${query}:${ranked.map((p) => p.parentId).join(',')}`,
        kind: 'promote',
        query,
        products: ranked.map((p, i) => ({
          parentId: p.parentId, sku: p.sku, clicks: p.clicks, position: i + 1,
        })),
        summary: ranked.length === 1
          ? `Move 1 product to the top of “${query}”`
          : `Move ${ranked.length} products to the top of “${query}”`,
        evidence: [
          { label: 'Clicks they earned', value: `${clicks} in ${this.options.windowDays} days` },
          { label: 'Average position clicked', value: depth.toFixed(1) },
          { label: 'Added to cart', value: String(carts) },
          { label: 'Searches for this query', value: searches.toLocaleString() },
          { label: 'Products', value: ranked.map((p) => p.sku).join(', ') },
        ],
        // Deeper and more-clicked both raise it; carts confirm the clicks were
        // not mis-clicks. Capped well short of 1 — this is evidence, not proof.
        confidence: clamp01(
          0.25
          + Math.min(0.3, clicks / 60)
          + Math.min(0.25, (depth - 3) / 20)
          + (carts > 0 ? 0.1 : 0),
        ),
        reach: searches,
      });
    }
    return out;
  }

  /**
   * Products holding the top of a page nobody clicks.
   *
   * The top three slots are most of the attention a query has to give. A
   * product sitting there through hundreds of impressions without a click is
   * not merely unpopular; it is displacing something.
   */
  private async demotions(siteId: string): Promise<Proposal[]> {
    const { rows } = await this.db.query<{
      sku: string; impressions: string; clicks: string; site_mean: string;
    }>(
      `WITH totals AS (
         SELECT sum(impressions)::numeric AS impressions, sum(clicks)::numeric AS clicks
           FROM daily_product_stats
          WHERE site_id = $1 AND day >= current_date - ($2::int - 1)
       )
       SELECT p.sku,
              sum(p.impressions)::text AS impressions,
              sum(p.clicks)::text      AS clicks,
              (SELECT CASE WHEN impressions > 0 THEN clicks / impressions ELSE 0 END
                 FROM totals)::text    AS site_mean
         FROM daily_product_stats p
        WHERE p.site_id = $1 AND p.day >= current_date - ($2::int - 1)
        GROUP BY p.sku
       HAVING sum(p.impressions) >= $3 AND sum(p.clicks) = 0
        ORDER BY sum(p.impressions) DESC
        LIMIT 25`,
      [siteId, this.options.windowDays, this.options.minImpressions * 4],
    );

    return rows.map((row) => {
      const impressions = Number(row.impressions);
      const mean = Number(row.site_mean);
      // How surprising is a run of zero clicks at the site's own rate? The
      // chance of it is (1 - mean)^impressions; the confidence is how far that
      // is from plausible.
      const chance = mean > 0 ? Math.pow(1 - mean, impressions) : 1;
      return {
        id: `demote:${row.sku}`,
        kind: 'demote' as const,
        query: '',
        sku: row.sku,
        summary: `${row.sku} is shown often and never chosen`,
        evidence: [
          { label: 'Times shown', value: impressions.toLocaleString() },
          { label: 'Clicks', value: '0' },
          { label: 'Site average', value: `${(mean * 100).toFixed(1)}% click-through` },
          {
            label: 'Odds of this by chance',
            value: chance < 0.001 ? 'under 1 in 1,000' : `${(chance * 100).toFixed(1)}%`,
          },
        ],
        confidence: clamp01(1 - chance),
        reach: impressions,
      };
    });
  }

  /**
   * Queries that find nothing, next to queries that find plenty.
   *
   * A shopper who searched and got nothing is the one shopper the catalogue
   * definitely failed. When a productive query shares a word with the failing
   * one, the fix is usually vocabulary rather than merchandising.
   */
  private async synonyms(siteId: string): Promise<Proposal[]> {
    const { rows } = await this.db.query<{ query: string; searches: string }>(
      `SELECT query, sum(searches)::text AS searches
         FROM daily_query_stats
        WHERE site_id = $1 AND day >= current_date - ($2::int - 1)
        GROUP BY query
       HAVING sum(zero_results) >= sum(searches) * 0.9 AND sum(searches) >= $3
        ORDER BY sum(searches) DESC
        LIMIT 15`,
      [siteId, this.options.windowDays, this.options.minSearches],
    );
    if (!rows.length) return [];

    const { rows: productive } = await this.db.query<{ query: string; searches: string }>(
      `SELECT query, sum(searches)::text AS searches
         FROM daily_query_stats
        WHERE site_id = $1 AND day >= current_date - ($2::int - 1)
        GROUP BY query
       HAVING sum(clicks) > 0 AND sum(zero_results) = 0
        ORDER BY sum(clicks) DESC
        LIMIT 200`,
      [siteId, this.options.windowDays],
    );

    const out: Proposal[] = [];
    for (const row of rows) {
      const match = nearest(row.query, productive.map((p) => p.query));
      if (!match) continue;
      const searches = Number(row.searches);
      out.push({
        id: `synonym:${row.query}`,
        kind: 'synonym',
        query: row.query,
        summary: `Treat “${row.query}” as “${match.term}”`,
        evidence: [
          { label: 'Searches', value: `${searches}, almost all with no results` },
          { label: 'Closest query that works', value: match.term },
          { label: 'How close', value: `${Math.round(match.score * 100)}% of the words` },
        ],
        // Word overlap is a weaker signal than a click, and this rewrites what
        // a search means. It stays below any sane auto-apply threshold.
        confidence: clamp01(0.3 + match.score * 0.4),
        reach: searches,
      });
    }
    return out;
  }

  // ---- acting on them ------------------------------------------------------

  /**
   * Carry out a proposal.
   *
   * Everything goes through the same stores the console writes to, so an
   * automatic change and a hand-made one are the same kind of object: both
   * appear in the change history, both name an actor, and both can be undone
   * by the same button.
   */
  async apply(siteId: string, proposal: Proposal, actor: string): Promise<AppliedChange> {
    if (proposal.kind === 'promote') {
      if (!this.stores.queryRules) throw new Error('query rules are not configured');
      if (!proposal.products?.length) throw new Error('a promotion needs products');
      const actions: QueryRuleAction[] = proposal.products.map((product, i) => ({
        parentId: product.parentId,
        action: 'pin',
        position: i + 1,
      }));
      const before = await this.stores.queryRules.forQuery(siteId, proposal.query);
      const saved = await this.stores.queryRules.save(siteId, {
        query: proposal.query,
        matchType: 'exact',
        enabled: true,
        actions,
        note: `Autopilot: ${proposal.evidence.map((e) => `${e.label} ${e.value}`).join(', ')}`,
        author: actor,
      });
      return this.audited(siteId, actor,
        { entity: 'query_rule', entityId: String(saved.id), before, after: saved });
    }

    if (proposal.kind === 'synonym') {
      if (!this.stores.synonyms) throw new Error('synonyms are not configured');
      const target = /“(.+?)”$/.exec(proposal.summary)?.[1];
      if (!target) throw new Error('the proposal names no replacement');
      // One-way: the failing words are rewritten to the working ones, and not
      // the reverse — a shopper who typed the query that works should keep
      // getting exactly what they asked for.
      const saved = await this.stores.synonyms.create(siteId, {
        kind: 'one_way',
        fromTerms: [proposal.query],
        terms: [target],
        note: `Autopilot: ${proposal.evidence.map((e) => `${e.label} ${e.value}`).join(', ')}`,
        author: actor,
      });
      return this.audited(siteId, actor,
        { entity: 'synonym', entityId: String(saved.id), before: null, after: saved });
    }

    // A demotion is deliberately not automatic. Hiding a product is the one
    // action here that can lose a sale outright rather than reorder one, and
    // "no clicks" can mean the photography is missing, not the product.
    throw new Error('a demotion is reviewed by a person, not applied automatically');
  }

  /**
   * Every application is written to the trail, whoever made it.
   *
   * Here rather than in the route, because the route is only one of the two
   * ways in: a nightly unattended run goes straight to `apply`, and that is
   * precisely the path where an unrecorded change would be invisible.
   */
  private async audited(
    siteId: string,
    actor: string,
    change: AppliedChange,
  ): Promise<AppliedChange> {
    await recordChange(this.db, siteId, actor, change.before ? 'upsert' : 'create',
      change.entity, change.entityId, change.before, change.after);
    return change;
  }

  /** Remember that someone said no, so it stops being offered. */
  async dismiss(siteId: string, proposalId: string, actor: string): Promise<void> {
    await this.db.query(
      `INSERT INTO autopilot_dismissals (site_id, proposal_id, actor)
       VALUES ($1, $2, $3)
       ON CONFLICT (site_id, proposal_id) DO NOTHING`,
      [siteId, proposalId, actor],
    );
  }

  private async dismissed(siteId: string): Promise<Set<string>> {
    const { rows } = await this.db.query<{ proposal_id: string }>(
      'SELECT proposal_id FROM autopilot_dismissals WHERE site_id = $1',
      [siteId],
    );
    return new Set(rows.map((r) => r.proposal_id));
  }

  /**
   * Apply everything confident enough to act on unattended.
   *
   * The threshold is high and the kinds are restricted: promotions and
   * synonyms reorder or widen what a shopper sees, and both are revertible in
   * one click from the history screen. Demotions are never included.
   */
  async run(siteId: string, threshold = 0.7, limit = 5): Promise<{ applied: Proposal[] }> {
    const candidates = (await this.proposals(siteId, 50))
      .filter((p) => p.kind === 'promote' && p.confidence >= threshold)
      .slice(0, limit);

    const applied: Proposal[] = [];
    for (const proposal of candidates) {
      try {
        await this.apply(siteId, proposal, 'autopilot');
        applied.push(proposal);
      } catch {
        // One bad proposal must not stop the rest; the others are independent.
      }
    }
    return { applied };
  }
}

/**
 * The productive query sharing the most words with a failing one.
 *
 * Word overlap rather than edit distance: "barn door hardware" and "barn door
 * track" are the same shopper, and no character-level measure says so.
 */
function nearest(query: string, candidates: string[]): { term: string; score: number } | null {
  const words = new Set(query.split(/\s+/).filter(Boolean));
  if (!words.size) return null;
  let best: { term: string; score: number } | null = null;
  for (const candidate of candidates) {
    const other = new Set(candidate.split(/\s+/).filter(Boolean));
    let shared = 0;
    for (const word of words) if (other.has(word)) shared++;
    const score = shared / Math.max(words.size, other.size);
    if (score >= 0.5 && (!best || score > best.score)) best = { term: candidate, score };
  }
  return best;
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}
