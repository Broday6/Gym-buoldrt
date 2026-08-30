import type { Db } from '../db/pool.js';

/**
 * Analytics.
 *
 * Events are append-only and grow without bound; the dashboard reads daily
 * aggregates instead. Rollups are idempotent per (site, day) — a re-run repairs
 * rather than double-counts, which matters because re-running the job is the
 * first thing anyone does after a reporting bug.
 *
 * Every table here is designed to end in an action. A zero-result query is only
 * interesting if a merchandiser can fix it from the row it appears in, so each
 * row carries what a synonym or redirect would need.
 */

export interface DateRange {
  from: string;
  to: string;
}

export interface Overview {
  range: DateRange;
  volume: {
    searches: number;
    uniqueQueries: number;
    sessionsWithSearch: number;
    searchesPerSession: number;
  };
  quality: {
    zeroResultRate: number;
    lowResultRate: number;
    avgResults: number;
    rescueRate: number;
  };
  engagement: {
    clickThroughRate: number;
    avgClickPosition: number;
    searchToCartRate: number;
  };
  revenue: {
    searchAttributedRevenue: number;
    conversionRate: number;
    revenuePerSearch: number;
  };
}

export interface QueryRow {
  query: string;
  searches: number;
  clicks: number;
  addToCarts: number;
  revenue: number;
  avgResults: number;
  zeroResults: number;
  clickThroughRate: number;
  /** What a merchandiser would do about this row. */
  suggestion?: 'synonym' | 'redirect' | 'review';
}

export interface TrendRow {
  query: string;
  current: number;
  previous: number;
  changePct: number;
}

export class AnalyticsService {
  constructor(private readonly db: Db) {}

  /**
   * Roll events into daily aggregates.
   *
   * Deletes and rewrites the day rather than incrementing, so running it twice
   * produces the same numbers as running it once.
   */
  async rollup(siteId: string, days = 30): Promise<{ days: number; events: number }> {
    const client = await this.db.connect();
    let total = 0;
    try {
      await client.query('BEGIN');
      const since = `now() - interval '${Number(days)} days'`;

      await client.query(
        `DELETE FROM daily_query_stats WHERE site_id = $1 AND day >= (${since})::date`,
        [siteId],
      );
      await client.query(
        `INSERT INTO daily_query_stats
           (site_id, day, query, searches, clicks, add_to_carts, purchases, revenue,
            zero_results, avg_results, avg_click_position, sessions, rescued)
         SELECT
           e.site_id,
           e.occurred_at::date AS day,
           e.normalised_query AS query,
           COUNT(*) FILTER (WHERE e.type IN ('search', 'zero_result')) AS searches,
           COUNT(*) FILTER (WHERE e.type = 'click') AS clicks,
           COUNT(*) FILTER (WHERE e.type = 'add_to_cart') AS add_to_carts,
           COUNT(*) FILTER (WHERE e.type = 'purchase') AS purchases,
           COALESCE(SUM(e.revenue) FILTER (WHERE e.type = 'purchase'), 0) AS revenue,
           COUNT(*) FILTER (WHERE e.type = 'zero_result') AS zero_results,
           AVG(e.result_count) FILTER (WHERE e.result_count IS NOT NULL) AS avg_results,
           AVG(e.position) FILTER (WHERE e.type = 'click') AS avg_click_position,
           COUNT(DISTINCT e.session_id) AS sessions,
           COUNT(*) FILTER (WHERE e.rescue_strategy IS NOT NULL) AS rescued
         FROM events e
         WHERE e.site_id = $1 AND e.occurred_at >= (${since})
           AND e.normalised_query IS NOT NULL AND e.normalised_query <> ''
         GROUP BY e.site_id, day, e.normalised_query`,
        [siteId],
      );

      /**
       * Revenue per query, attributed multi-touch within the session.
       *
       * A purchase event carries no query — the shopper bought a product, not a
       * search — so revenue is spread evenly across the distinct queries that
       * preceded it in the same session. Attributing it all to the last query
       * would overstate whichever term happens to sit closest to checkout.
       */
      await client.query(
        `WITH touches AS (
           SELECT DISTINCT p.id AS purchase_id, p.revenue, s.normalised_query AS query,
                  s.occurred_at::date AS day
           FROM events p
           JOIN events s ON s.session_id = p.session_id AND s.site_id = p.site_id
           WHERE p.site_id = $1 AND p.type = 'purchase' AND p.revenue IS NOT NULL
             AND p.occurred_at >= (${since})
             AND s.type IN ('search', 'zero_result')
             AND s.occurred_at <= p.occurred_at
             AND s.normalised_query IS NOT NULL AND s.normalised_query <> ''
         ),
         -- Counted in its own step: Postgres will not nest a window function
         -- inside an aggregate, and the share depends on the touch count.
         shares AS (
           SELECT purchase_id, COUNT(*) AS touch_count FROM touches GROUP BY purchase_id
         ),
         weighted AS (
           SELECT t.query, t.day, SUM(t.revenue / s.touch_count) AS revenue
           FROM touches t JOIN shares s ON s.purchase_id = t.purchase_id
           GROUP BY t.query, t.day
         )
         UPDATE daily_query_stats d
         SET revenue = w.revenue
         FROM weighted w
         WHERE d.site_id = $1 AND d.query = w.query AND d.day = w.day`,
        [siteId],
      );

      await client.query(
        `DELETE FROM daily_product_stats WHERE site_id = $1 AND day >= (${since})::date`,
        [siteId],
      );
      await client.query(
        `INSERT INTO daily_product_stats
           (site_id, day, sku, impressions, clicks, add_to_carts, purchases, revenue,
            avg_click_position)
         SELECT
           e.site_id, e.occurred_at::date, e.sku,
           0 AS impressions,
           COUNT(*) FILTER (WHERE e.type = 'click'),
           COUNT(*) FILTER (WHERE e.type = 'add_to_cart'),
           COUNT(*) FILTER (WHERE e.type = 'purchase'),
           COALESCE(SUM(e.revenue) FILTER (WHERE e.type = 'purchase'), 0),
           AVG(e.position) FILTER (WHERE e.type = 'click')
         FROM events e
         WHERE e.site_id = $1 AND e.occurred_at >= (${since}) AND e.sku IS NOT NULL
         GROUP BY e.site_id, e.occurred_at::date, e.sku`,
        [siteId],
      );

      // Facet usage: which filters shoppers actually touch.
      await client.query(
        `DELETE FROM daily_facet_stats WHERE site_id = $1 AND day >= (${since})::date`,
        [siteId],
      );
      await client.query(
        `INSERT INTO daily_facet_stats (site_id, day, field, value, applications)
         SELECT e.site_id, e.occurred_at::date, f.key AS field,
                TRIM(BOTH '"' FROM v::text) AS value, COUNT(*)
         FROM events e
         CROSS JOIN LATERAL jsonb_each(COALESCE(e.filters, '{}'::jsonb)) AS f(key, val)
         CROSS JOIN LATERAL jsonb_array_elements(f.val) AS v
         WHERE e.site_id = $1 AND e.occurred_at >= (${since})
           AND e.filters IS NOT NULL AND jsonb_typeof(e.filters) = 'object'
         GROUP BY e.site_id, e.occurred_at::date, f.key, v::text`,
        [siteId],
      );

      const counted = await client.query<{ n: string }>(
        `SELECT COUNT(*) AS n FROM events WHERE site_id = $1 AND occurred_at >= (${since})`,
        [siteId],
      );
      total = Number(counted.rows[0]?.n ?? 0);

      await client.query(
        `INSERT INTO rollup_runs (site_id, day, events_seen)
         VALUES ($1, CURRENT_DATE, $2)
         ON CONFLICT (site_id, day) DO UPDATE SET events_seen = EXCLUDED.events_seen,
                                                 ran_at = now()`,
        [siteId, total],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
    return { days, events: total };
  }

  async overview(siteId: string, days = 30): Promise<Overview> {
    const since = `now() - interval '${Number(days)} days'`;
    const { rows } = await this.db.query<Record<string, string | null>>(
      `SELECT
         COUNT(*) FILTER (WHERE type IN ('search', 'zero_result')) AS searches,
         COUNT(DISTINCT normalised_query) FILTER (WHERE normalised_query IS NOT NULL) AS unique_queries,
         COUNT(DISTINCT session_id) FILTER (WHERE type IN ('search', 'zero_result')) AS search_sessions,
         COUNT(*) FILTER (WHERE type = 'zero_result') AS zero_results,
         COUNT(*) FILTER (WHERE result_count IS NOT NULL AND result_count < 3) AS low_results,
         COUNT(*) FILTER (WHERE rescue_strategy IS NOT NULL) AS rescued,
         AVG(result_count) FILTER (WHERE result_count IS NOT NULL) AS avg_results,
         COUNT(*) FILTER (WHERE type = 'click') AS clicks,
         AVG(position) FILTER (WHERE type = 'click') AS avg_position,
         COUNT(*) FILTER (WHERE type = 'add_to_cart') AS carts,
         COUNT(*) FILTER (WHERE type = 'purchase') AS purchases,
         COALESCE(SUM(revenue) FILTER (WHERE type = 'purchase'), 0) AS revenue
       FROM events WHERE site_id = $1 AND occurred_at >= (${since})`,
      [siteId],
    );
    const r = rows[0] ?? {};
    const n = (key: string) => Number(r[key] ?? 0);
    const searches = n('searches');
    const sessions = n('search_sessions');

    // Revenue attribution is session-scoped: a purchase counts as search-driven
    // when that session searched at all. Multi-touch within a session, which is
    // the honest granularity for anonymous shoppers.
    const attributed = await this.db.query<{ revenue: string; orders: string }>(
      `SELECT COALESCE(SUM(p.revenue), 0) AS revenue, COUNT(*) AS orders
       FROM events p
       WHERE p.site_id = $1 AND p.type = 'purchase' AND p.occurred_at >= (${since})
         AND EXISTS (
           SELECT 1 FROM events s
           WHERE s.session_id = p.session_id AND s.site_id = p.site_id
             AND s.type IN ('search', 'zero_result') AND s.occurred_at <= p.occurred_at
         )`,
      [siteId],
    );
    const revenue = Number(attributed.rows[0]?.revenue ?? 0);
    const orders = Number(attributed.rows[0]?.orders ?? 0);

    return {
      range: { from: `${days} days ago`, to: 'now' },
      volume: {
        searches,
        uniqueQueries: n('unique_queries'),
        sessionsWithSearch: sessions,
        searchesPerSession: sessions ? round(searches / sessions, 2) : 0,
      },
      quality: {
        zeroResultRate: rate(n('zero_results'), searches),
        lowResultRate: rate(n('low_results'), searches),
        avgResults: round(Number(r.avg_results ?? 0), 1),
        rescueRate: rate(n('rescued'), searches),
      },
      engagement: {
        clickThroughRate: rate(n('clicks'), searches),
        avgClickPosition: round(Number(r.avg_position ?? 0), 1),
        searchToCartRate: rate(n('carts'), searches),
      },
      revenue: {
        searchAttributedRevenue: round(revenue, 2),
        conversionRate: rate(orders, sessions),
        revenuePerSearch: searches ? round(revenue / searches, 2) : 0,
      },
    };
  }

  /** Top queries by volume, with what a merchandiser might do about each. */
  async topQueries(siteId: string, days = 30, limit = 25): Promise<QueryRow[]> {
    const { rows } = await this.db.query(
      `SELECT query,
              SUM(searches) AS searches, SUM(clicks) AS clicks,
              SUM(add_to_carts) AS carts, SUM(revenue) AS revenue,
              AVG(avg_results) AS avg_results, SUM(zero_results) AS zero_results
       FROM daily_query_stats
       WHERE site_id = $1 AND day >= (now() - interval '${Number(days)} days')::date
       GROUP BY query ORDER BY searches DESC LIMIT $2`,
      [siteId, limit],
    );
    return rows.map(toQueryRow);
  }

  /**
   * Queries that found nothing, or nearly nothing.
   *
   * The single most actionable table in the product: every row is a shopper who
   * wanted something and was not shown it.
   */
  async problemQueries(siteId: string, days = 30, limit = 25): Promise<QueryRow[]> {
    const { rows } = await this.db.query(
      `SELECT query,
              SUM(searches) AS searches, SUM(clicks) AS clicks,
              SUM(add_to_carts) AS carts, SUM(revenue) AS revenue,
              AVG(avg_results) AS avg_results, SUM(zero_results) AS zero_results
       FROM daily_query_stats
       WHERE site_id = $1 AND day >= (now() - interval '${Number(days)} days')::date
       GROUP BY query
       HAVING SUM(zero_results) > 0 OR AVG(avg_results) < 3
       ORDER BY SUM(searches) DESC LIMIT $2`,
      [siteId, limit],
    );
    return rows.map(toQueryRow);
  }

  /** Queries moving up or down against the preceding equal-length window. */
  async trending(siteId: string, days = 7, limit = 10): Promise<{ rising: TrendRow[]; falling: TrendRow[] }> {
    const { rows } = await this.db.query(
      `WITH windows AS (
         SELECT query,
           SUM(searches) FILTER (WHERE day >= (now() - interval '${Number(days)} days')::date) AS current,
           SUM(searches) FILTER (
             WHERE day >= (now() - interval '${Number(days) * 2} days')::date
               AND day <  (now() - interval '${Number(days)} days')::date
           ) AS previous
         FROM daily_query_stats WHERE site_id = $1
         GROUP BY query
       )
       SELECT query, COALESCE(current, 0) AS current, COALESCE(previous, 0) AS previous
       FROM windows WHERE COALESCE(current, 0) + COALESCE(previous, 0) >= 3`,
      [siteId],
    );
    const scored: TrendRow[] = rows.map((r) => {
      const current = Number(r.current);
      const previous = Number(r.previous);
      return {
        query: r.query,
        current,
        previous,
        // A query with no history is new interest, not an infinite increase.
        changePct: previous === 0 ? 100 : round(((current - previous) / previous) * 100, 1),
      };
    });
    return {
      rising: [...scored].sort((a, b) => b.changePct - a.changePct).slice(0, limit),
      falling: [...scored].filter((r) => r.changePct < 0)
        .sort((a, b) => a.changePct - b.changePct).slice(0, limit),
    };
  }

  /** What shoppers click after a given query — the ranking sanity check. */
  async clickedProducts(siteId: string, query: string, days = 30, limit = 10) {
    const { rows } = await this.db.query(
      `SELECT sku, COUNT(*) AS clicks, AVG(position) AS avg_position,
              COUNT(*) FILTER (WHERE type = 'add_to_cart') AS carts
       FROM events
       WHERE site_id = $1 AND normalised_query = $2
         AND occurred_at >= now() - interval '${Number(days)} days'
         AND sku IS NOT NULL AND type IN ('click', 'add_to_cart')
       GROUP BY sku ORDER BY clicks DESC LIMIT $3`,
      [siteId, query.toLowerCase().trim(), limit],
    );
    return rows.map((r) => ({
      sku: r.sku,
      clicks: Number(r.clicks),
      avgPosition: round(Number(r.avg_position ?? 0), 1),
      addToCarts: Number(r.carts),
    }));
  }

  async facetUsage(siteId: string, days = 30, limit = 20) {
    const { rows } = await this.db.query(
      `SELECT field, value, SUM(applications) AS applications
       FROM daily_facet_stats
       WHERE site_id = $1 AND day >= (now() - interval '${Number(days)} days')::date
       GROUP BY field, value ORDER BY applications DESC LIMIT $2`,
      [siteId, limit],
    );
    return rows.map((r) => ({
      field: r.field,
      value: r.value,
      applications: Number(r.applications),
    }));
  }

  /** Daily search volume and zero-result rate, for the dashboard sparkline. */
  async timeseries(siteId: string, days = 30) {
    const { rows } = await this.db.query(
      `SELECT day, SUM(searches) AS searches, SUM(zero_results) AS zero_results,
              SUM(clicks) AS clicks, SUM(revenue) AS revenue
       FROM daily_query_stats
       WHERE site_id = $1 AND day >= (now() - interval '${Number(days)} days')::date
       GROUP BY day ORDER BY day`,
      [siteId],
    );
    return rows.map((r) => ({
      day: r.day instanceof Date ? r.day.toISOString().slice(0, 10) : String(r.day),
      searches: Number(r.searches),
      zeroResults: Number(r.zero_results),
      clicks: Number(r.clicks),
      revenue: round(Number(r.revenue ?? 0), 2),
    }));
  }

  /** CSV export for any of the tables above. */
  toCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return '';
    const headers = Object.keys(rows[0]!);
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers.join(','), ...rows.map((r) => headers.map((h) => escape(r[h])).join(','))]
      .join('\n');
  }
}

function toQueryRow(r: Record<string, unknown>): QueryRow {
  const searches = Number(r.searches ?? 0);
  const clicks = Number(r.clicks ?? 0);
  const zeroResults = Number(r.zero_results ?? 0);
  const avgResults = round(Number(r.avg_results ?? 0), 1);
  return {
    query: String(r.query),
    searches,
    clicks,
    addToCarts: Number(r.carts ?? 0),
    revenue: round(Number(r.revenue ?? 0), 2),
    avgResults,
    zeroResults,
    clickThroughRate: rate(clicks, searches),
    // A query finding nothing usually needs vocabulary; one finding plenty but
    // earning no clicks is a ranking problem, not a vocabulary one.
    suggestion: zeroResults > 0 ? 'synonym' : clicks === 0 && searches >= 3 ? 'review' : undefined,
  };
}

function rate(part: number, whole: number): number {
  return whole > 0 ? round((part / whole) * 100, 1) : 0;
}

function round(n: number, places: number): number {
  const factor = 10 ** places;
  return Math.round((Number.isFinite(n) ? n : 0) * factor) / factor;
}
