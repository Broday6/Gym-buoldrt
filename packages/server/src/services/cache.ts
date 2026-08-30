/**
 * Bounded result cache.
 *
 * Search traffic is extremely head-heavy: a handful of queries account for most
 * of the volume, and every shopper who types them gets an identical response.
 * Caching those is worth more than any further micro-optimisation of the
 * retrieval path.
 *
 * Correctness rests on invalidation, not on a short TTL: the cache is purged
 * whenever an index is promoted or a merchandising object changes, so a change
 * going live is visible immediately rather than after an expiry.
 */
export interface CacheOptions {
  maxEntries?: number;
  ttlMs?: number;
}

interface Entry<T> {
  value: T;
  expires: number;
}

export class ResultCache<T> {
  private entries = new Map<string, Entry<T>>();
  private hits = 0;
  private misses = 0;
  private readonly maxEntries: number;
  private readonly ttlMs: number;

  constructor(options: CacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 2_000;
    this.ttlMs = options.ttlMs ?? 60_000;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (entry.expires <= Date.now()) {
      this.entries.delete(key);
      this.misses++;
      return undefined;
    }
    // Re-insert to move it to the end: Map preserves insertion order, which
    // makes the first key the least recently used.
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expires: Date.now() + this.ttlMs });
  }

  /** Purge everything, or just one site's entries. */
  invalidate(siteId?: string): number {
    if (!siteId) {
      const size = this.entries.size;
      this.entries.clear();
      return size;
    }
    let removed = 0;
    const prefix = `${siteId} `;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  stats(): { size: number; hits: number; misses: number; hitRate: number } {
    const total = this.hits + this.misses;
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      hitRate: total ? Math.round((this.hits / total) * 1000) / 1000 : 0,
    };
  }
}

/**
 * A stable cache key. Filter and facet ordering must not change the key, or two
 * identical searches would miss each other; shopper and session ids must not
 * enter it, or the cache would degenerate into one entry per visitor.
 */
export function cacheKey(siteId: string, request: Record<string, unknown>): string {
  return `${siteId} ${stableStringify(request)}`;
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${k}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
