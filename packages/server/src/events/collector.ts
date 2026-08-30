import type { ShopperEvent } from '@compass/shared';
import type { Db } from '../db/pool.js';
import { normalise } from '../query/normalize.js';

/**
 * Event collector.
 *
 * Events are buffered in memory and flushed as one multi-row INSERT. A storefront
 * fires an event on every keystroke-adjacent interaction, so the collector must
 * never make the shopper wait on a database round trip, and must never drop the
 * request if Postgres is briefly unavailable.
 */

export interface CollectorOptions {
  /** Flush once this many events are buffered. */
  batchSize?: number;
  /** Flush at least this often, even when quiet. */
  flushIntervalMs?: number;
  /** Hard cap; beyond it the oldest events are dropped rather than the process. */
  maxBuffer?: number;
}

const VALID_TYPES = new Set([
  'search', 'click', 'add_to_cart', 'purchase', 'product_view', 'facet_apply', 'zero_result',
]);

export class EventCollector {
  private buffer: ShopperEvent[] = [];
  private timer?: NodeJS.Timeout;
  private flushing = false;
  private dropped = 0;
  private written = 0;

  constructor(
    private readonly db: Db,
    private readonly options: CollectorOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.flush();
    }, this.options.flushIntervalMs ?? 2_000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  stats(): { buffered: number; written: number; dropped: number } {
    return { buffered: this.buffer.length, written: this.written, dropped: this.dropped };
  }

  /** Returns the number of events accepted. Invalid events are rejected loudly. */
  collect(events: ShopperEvent[]): { accepted: number; rejected: string[] } {
    const rejected: string[] = [];
    let accepted = 0;
    for (const event of events) {
      const problem = validate(event);
      if (problem) {
        rejected.push(problem);
        continue;
      }
      this.buffer.push(event);
      accepted++;
    }
    const maxBuffer = this.options.maxBuffer ?? 50_000;
    if (this.buffer.length > maxBuffer) {
      const overflow = this.buffer.length - maxBuffer;
      this.buffer.splice(0, overflow);
      this.dropped += overflow;
    }
    if (this.buffer.length >= (this.options.batchSize ?? 200)) void this.flush();
    return { accepted, rejected };
  }

  async flush(): Promise<number> {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.write(batch);
      this.written += batch.length;
      return batch.length;
    } catch (err) {
      // Put them back at the front so a transient outage costs latency, not data.
      this.buffer = [...batch, ...this.buffer];
      console.error({ err: (err as Error).message, buffered: this.buffer.length }, 'event flush failed');
      return 0;
    } finally {
      this.flushing = false;
    }
  }

  private async write(events: ShopperEvent[]): Promise<void> {
    const columns = 18;
    const values: unknown[] = [];
    const tuples: string[] = [];
    events.forEach((e, i) => {
      const base = i * columns;
      tuples.push(
        `(${Array.from({ length: columns }, (_, c) => `$${base + c + 1}`).join(',')})`,
      );
      values.push(
        e.site,
        e.type,
        e.shopperId,
        e.sessionId,
        e.timestamp ? new Date(e.timestamp) : new Date(),
        e.query ?? null,
        e.query ? normalise(e.query) : null,
        e.position ?? null,
        e.sku ?? null,
        e.parentId ?? null,
        e.categoryId ?? null,
        e.filters ? JSON.stringify(e.filters) : null,
        e.resultCount ?? null,
        e.revenue ?? null,
        e.quantity ?? null,
        e.analyticsTags ?? null,
        e.rescueStrategy ?? null,
        e.effectiveQuery ?? null,
      );
    });
    await this.db.query(
      `INSERT INTO events (
         site_id, type, shopper_id, session_id, occurred_at, query, normalised_query,
         position, sku, parent_id, category_id, filters, result_count, revenue, quantity,
         analytics_tags, rescue_strategy, effective_query
       ) VALUES ${tuples.join(',')}`,
      values,
    );
  }
}

function validate(event: ShopperEvent): string | null {
  if (!event || typeof event !== 'object') return 'event is not an object';
  if (!VALID_TYPES.has(event.type)) return `unknown event type "${event.type}"`;
  if (!event.site) return `${event.type} event has no site`;
  if (!event.shopperId) return `${event.type} event has no shopperId`;
  if (!event.sessionId) return `${event.type} event has no sessionId`;
  if (event.type === 'click' && event.position !== undefined && event.position < 1) {
    return 'click position is 1-based';
  }
  return null;
}
