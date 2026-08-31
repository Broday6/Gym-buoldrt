/**
 * Counting what the engine showed.
 *
 * Click-through was unmeasurable because only the numerator existed: clicks
 * were recorded per product, impressions were written as a literal zero, and
 * every rate the system could compute was 0/0. This supplies the denominator.
 *
 * Counted in memory and flushed on an interval, never on the request path: a
 * search must not wait on a write, and the count is a statistic, so losing the
 * last few seconds of it when a process dies costs nothing worth a transaction.
 * The flush is one statement whose row count is bounded by distinct products
 * shown since the last one, not by searches served.
 */
import type { Db } from '../db/pool.js';

export interface ImpressionRecorderOptions {
  /** How often the buffer is written out. */
  flushIntervalMs?: number;
  /**
   * Flush early once this many distinct products are pending, so a burst of
   * traffic does not build an unbounded map between ticks.
   */
  maxPending?: number;
}

export class ImpressionRecorder {
  /** site -> sku -> count, since the last flush. */
  private pending = new Map<string, Map<string, number>>();
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private written = 0;
  private size = 0;

  constructor(
    private readonly db: Db,
    private readonly options: ImpressionRecorderOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs ?? 10_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  stats(): { pending: number; written: number } {
    return { pending: this.size, written: this.written };
  }

  /** One page of results was served. */
  record(siteId: string, skus: string[]): void {
    if (!skus.length) return;
    let bySku = this.pending.get(siteId);
    if (!bySku) this.pending.set(siteId, (bySku = new Map()));
    for (const sku of skus) {
      if (!sku) continue;
      if (!bySku.has(sku)) this.size++;
      bySku.set(sku, (bySku.get(sku) ?? 0) + 1);
    }
    if (this.size >= (this.options.maxPending ?? 20_000)) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.size === 0) return;
    this.flushing = true;
    const batch = this.pending;
    this.pending = new Map();
    const counted = this.size;
    this.size = 0;

    try {
      for (const [siteId, bySku] of batch) {
        const skus = [...bySku.keys()];
        const counts = skus.map((sku) => bySku.get(sku)!);
        // One statement per site. `unnest` keeps the parameter count at three
        // however many products were shown — a query per product would put
        // thousands of round trips behind a busy minute.
        await this.db.query(
          `INSERT INTO daily_impressions (site_id, day, sku, impressions)
           SELECT $1, current_date, s.sku, s.n
             FROM unnest($2::text[], $3::int[]) AS s(sku, n)
           ON CONFLICT (site_id, day, sku)
           DO UPDATE SET impressions = daily_impressions.impressions + EXCLUDED.impressions`,
          [siteId, skus, counts],
        );
      }
      this.written += counted;
    } catch {
      // A statistic is not worth failing a request or crashing a process over.
      // The counts in this batch are gone; the next one is unaffected.
    } finally {
      this.flushing = false;
    }
  }
}
