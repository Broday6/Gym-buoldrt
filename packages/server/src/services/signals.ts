/**
 * What shoppers actually do, fed back into ranking.
 *
 * The catalogue's own numbers — margin, sales velocity, review score — are
 * what a merchandiser or an ERP says about a product. They are not what
 * shoppers say. Click-through is the only signal in the composite that is
 * measured on this site, against these results, this week, and it is the one
 * that makes the system improve without anyone touching it: a product that
 * earns clicks rises, and one that does not, sinks.
 *
 * Two things make a raw rate dangerous, and both are handled here rather than
 * left to whoever reads the number:
 *
 *   - **Small samples lie.** One click on three impressions is not a 33% CTR,
 *     it is nearly no evidence. Every rate is shrunk toward what an average
 *     product on the site earns, in proportion to how thin its evidence is, so
 *     a product needs to keep earning clicks to keep the boost.
 *   - **A feedback loop compounds.** Whatever ranks first gets the
 *     impressions, so an early accident can entrench itself. Shrinking toward
 *     the mean damps that, and the weight this carries in the composite is
 *     deliberately smaller than relevance — it re-orders within a band of
 *     comparable matches, never across bands.
 */
import type { Db } from '../db/pool.js';

export interface ProductSignals {
  /** Shrunk click-through per SKU, 0..1. Absent means no evidence either way. */
  ctrBySku: Map<string, number>;
  /** What an average impression on this site earns — the prior. */
  siteMean: number;
  impressions: number;
  /** How many SKUs have any measurement at all. */
  measured: number;
  computedAt: number;
}

const EMPTY: ProductSignals = {
  ctrBySku: new Map(), siteMean: 0, impressions: 0, measured: 0, computedAt: 0,
};

export interface SignalStoreOptions {
  /** How far back behaviour counts. Long enough to be stable, short enough to move. */
  windowDays?: number;
  /** How long a computed set is reused before it is rebuilt. */
  ttlMs?: number;
  /**
   * Impressions' worth of prior. A product with this many impressions is
   * weighted half on its own record and half on the site average.
   */
  priorWeight?: number;
}

export class SignalStore {
  private readonly windowDays: number;
  private readonly ttlMs: number;
  private readonly priorWeight: number;
  private readonly cache = new Map<string, ProductSignals>();
  private readonly inFlight = new Map<string, Promise<ProductSignals>>();

  constructor(private readonly db: Db, options: SignalStoreOptions = {}) {
    this.windowDays = options.windowDays ?? 30;
    this.ttlMs = options.ttlMs ?? 300_000;
    this.priorWeight = options.priorWeight ?? 50;
  }

  async get(siteId: string): Promise<ProductSignals> {
    const cached = this.cache.get(siteId);
    if (cached && Date.now() - cached.computedAt < this.ttlMs) return cached;

    // A rebuild is a full table scan of the window; several concurrent
    // searches must not each start one.
    const running = this.inFlight.get(siteId);
    if (running) return running;

    const build = this.compute(siteId)
      .then((signals) => {
        this.cache.set(siteId, signals);
        return signals;
      })
      .catch(() => {
        // Behaviour is an enhancement, never a dependency: with the analytics
        // database down, search ranks on the catalogue's own signals and stays
        // up. Serving the last known set beats serving nothing.
        return cached ?? EMPTY;
      })
      .finally(() => this.inFlight.delete(siteId));

    this.inFlight.set(siteId, build);
    return build;
  }

  /** Drop the cache so the next search sees a fresh rollup. */
  invalidate(siteId?: string): void {
    if (siteId) this.cache.delete(siteId);
    else this.cache.clear();
  }

  private async compute(siteId: string): Promise<ProductSignals> {
    const { rows } = await this.db.query<{ sku: string; impressions: string; clicks: string }>(
      `SELECT sku,
              sum(impressions)::text AS impressions,
              sum(clicks)::text      AS clicks
         FROM daily_product_stats
        WHERE site_id = $1
          AND day >= (current_date - ($2::int - 1))
        GROUP BY sku
       HAVING sum(impressions) > 0`,
      [siteId, this.windowDays],
    );

    let totalImpressions = 0;
    let totalClicks = 0;
    for (const row of rows) {
      totalImpressions += Number(row.impressions);
      totalClicks += Number(row.clicks);
    }
    const siteMean = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

    const ctrBySku = new Map<string, number>();
    for (const row of rows) {
      const impressions = Number(row.impressions);
      const clicks = Number(row.clicks);
      ctrBySku.set(row.sku, shrink(clicks, impressions, siteMean, this.priorWeight));
    }

    return {
      ctrBySku,
      siteMean,
      impressions: totalImpressions,
      measured: ctrBySku.size,
      computedAt: Date.now(),
    };
  }
}

/**
 * A rate you can rank on.
 *
 * The posterior mean of a beta-binomial whose prior is the site average: with
 * no impressions it *is* the site average, and it converges on the product's
 * own rate as evidence accumulates. This is why a new product is not punished
 * for having no history and a lucky one is not rewarded for a single click.
 */
export function shrink(
  clicks: number,
  impressions: number,
  siteMean: number,
  priorWeight: number,
): number {
  if (impressions <= 0) return siteMean;
  return (clicks + priorWeight * siteMean) / (impressions + priorWeight);
}
