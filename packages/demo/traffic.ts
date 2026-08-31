/**
 * Demo traffic generator.
 *
 * An analytics dashboard with no data demonstrates nothing, and hand-written
 * fixtures produce numbers that do not behave like real ones. This simulates
 * shopper sessions against the live index, so every figure on the dashboard is
 * computed from events the system actually recorded.
 *
 * The shape of the traffic is deliberately realistic:
 *
 *   - Query volume is head-heavy. A handful of terms carry most of the traffic,
 *     which is what makes the result cache worth having and what makes a
 *     "top queries" table meaningful.
 *   - Click-through decays with position. Position one gets clicked far more
 *     than position ten, so average click position is a real signal rather than
 *     a uniform average.
 *   - Some queries fail. Misspellings, product names the catalogue does not use,
 *     and competitor terms — which is exactly what the zero-result report is for.
 *   - Sessions are bursty across the window, not evenly spread, so day-over-day
 *     trends move.
 */
import type { ShopperEvent } from '@compass/shared';

export interface TrafficOptions {
  sessions?: number;
  days?: number;
  seed?: number;
}

/** Deterministic PRNG so a demo looks the same every time it is rebuilt. */
function mulberry32(seed: number): () => number {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Head-heavy query mix: the first entries carry most of the volume. */
const POPULAR = [
  'beam', 'shutters', 'crown moulding', 'faux wood beam', 'ceiling medallion',
  'black shutter', 'chandelier', 'corbel', 'bracket', 'column',
  'walnut beam', 'board and batten shutter', 'wainscot panel', 'porch column',
  '4x6 beam', 'espresso beam', 'primed white moulding', 'exterior bracket',
];

/** Queries that should fail, and which the merchandiser ought to see. */
const FAILING = [
  'chandaleer', 'shuters', 'moulding trim kit', 'wainscoting panels',
  'faux beams 20ft', 'barn door hardware', 'quarter round', 'cornice board',
  'crown molding', 'tin ceiling tile',
];

const FILTER_FIELDS: [string, string[]][] = [
  ['material', ['PVC', 'Polyurethane', 'MDF', 'Western Red Cedar']],
  ['finish', ['Walnut', 'Black', 'Primed White', 'Espresso']],
  ['style', ['Rustic', 'Farmhouse', 'Craftsman']],
];

export interface SearchProbe {
  (query: string): Promise<{ hits: { sku: string; parentId: string; effectivePrice: number }[]; total: number }>;
}

/**
 * Build a session's worth of events by actually searching the index, so clicks
 * point at products that really matched.
 */
/** One product, shown that many times on that day. */
export interface ImpressionCount {
  day: string;
  sku: string;
  impressions: number;
}

export async function generateTraffic(
  site: string,
  probe: SearchProbe,
  options: TrafficOptions = {},
): Promise<{ events: ShopperEvent[]; impressions: ImpressionCount[] }> {
  const sessions = options.sessions ?? 600;
  const days = options.days ?? 30;
  const rand = mulberry32(options.seed ?? 424242);
  const events: ShopperEvent[] = [];
  // Every search shows a page of products, and click-through is meaningless
  // without that denominator. A live server counts this as it serves; here the
  // history is being written after the fact, so it is counted here.
  const shown = new Map<string, number>();

  // Cache probe results: the same head queries repeat constantly, and this is
  // a demo generator, not a load test.
  const resultCache = new Map<string, Awaited<ReturnType<SearchProbe>>>();
  const lookup = async (query: string) => {
    const cached = resultCache.get(query);
    if (cached) return cached;
    const result = await probe(query);
    resultCache.set(query, result);
    return result;
  };

  for (let s = 0; s < sessions; s++) {
    const shopperId = `demo-shopper-${Math.floor(rand() * (sessions / 3))}`;
    const sessionId = `demo-session-${s}`;

    // Bursty rather than uniform: weekends and recent days carry more traffic,
    // so day-over-day trends actually move.
    const dayOffset = Math.floor(Math.pow(rand(), 1.6) * days);
    const base = Date.now() - dayOffset * 86_400_000 - Math.floor(rand() * 86_400_000);
    let clock = base;
    const tick = (ms: number) => {
      clock += ms;
      return new Date(clock).toISOString();
    };

    const searchesInSession = 1 + Math.floor(Math.pow(rand(), 2) * 4);
    let sessionBought = false;

    for (let i = 0; i < searchesInSession; i++) {
      // ~12% of searches fail. That is roughly what a real store sees before
      // anyone has done vocabulary work, and it is what the report is for.
      const failing = rand() < 0.12;
      const query = failing
        ? FAILING[Math.floor(rand() * FAILING.length)]!
        : POPULAR[Math.floor(Math.pow(rand(), 2.2) * POPULAR.length)]!;

      const result = await lookup(query);
      const zero = result.total === 0;

      events.push({
        type: zero ? 'zero_result' : 'search',
        site, shopperId, sessionId,
        timestamp: tick(2_000 + rand() * 8_000),
        query,
        resultCount: result.total,
        rescueStrategy: zero ? 'category_fallback' : undefined,
      });

      // A third of searches also apply a filter, which is what makes the facet
      // usage report worth reading.
      if (!zero && rand() < 0.33) {
        const [field, values] = FILTER_FIELDS[Math.floor(rand() * FILTER_FIELDS.length)]!;
        events.push({
          type: 'facet_apply',
          site, shopperId, sessionId,
          timestamp: tick(1_500 + rand() * 4_000),
          query,
          filters: { [field]: [values[Math.floor(rand() * values.length)]!] },
        });
      }

      if (zero || result.hits.length === 0) continue;

      const day = new Date(clock).toISOString().slice(0, 10);
      for (const hit of result.hits.slice(0, 24)) {
        const key = `${day}\u0000${hit.sku}`;
        shown.set(key, (shown.get(key) ?? 0) + 1);
      }

      // Click-through decays sharply with position, so average click position
      // is a real signal rather than a uniform average.
      const clicks = rand() < 0.55 ? 1 + (rand() < 0.25 ? 1 : 0) : 0;
      for (let c = 0; c < clicks; c++) {
        // Real click-through curves are steep: position one takes roughly a
        // third of clicks and the top three take well over half. A flatter
        // curve would make average click position a meaningless statistic.
        const position = 1 + Math.floor(Math.pow(rand(), 3.4) * Math.min(result.hits.length, 20));
        const hit = result.hits[position - 1];
        if (!hit) continue;

        events.push({
          type: 'click',
          site, shopperId, sessionId,
          timestamp: tick(3_000 + rand() * 15_000),
          query, position, sku: hit.sku, parentId: hit.parentId,
        });
        events.push({
          type: 'product_view',
          site, shopperId, sessionId,
          timestamp: tick(500),
          sku: hit.sku, parentId: hit.parentId,
        });

        if (rand() < 0.22) {
          const quantity = 1 + Math.floor(rand() * 3);
          events.push({
            type: 'add_to_cart',
            site, shopperId, sessionId,
            timestamp: tick(8_000 + rand() * 30_000),
            query, sku: hit.sku, parentId: hit.parentId, quantity,
          });

          if (!sessionBought && rand() < 0.35) {
            sessionBought = true;
            events.push({
              type: 'purchase',
              site, shopperId, sessionId,
              timestamp: tick(20_000 + rand() * 120_000),
              sku: hit.sku, parentId: hit.parentId, quantity,
              revenue: Math.round(hit.effectivePrice * quantity * 100) / 100,
            });
          }
        }
      }
    }
  }

  return {
    events,
    impressions: [...shown].map(([key, impressions]) => {
      const [day, sku] = key.split('\u0000');
      return { day: day!, sku: sku!, impressions };
    }),
  };
}
