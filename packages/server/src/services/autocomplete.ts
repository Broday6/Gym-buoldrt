import type { SiteConfig } from '@compass/shared';
import type { SearchEngine } from '../engine/types.js';
import type { Db } from '../db/pool.js';
import type { RedirectStore } from '../merchandising/redirects.js';
import { normalise } from '../query/normalize.js';
import type { SearchService } from './search.js';

/**
 * Autocomplete.
 *
 * Fires on every keystroke, so nothing here is allowed to be slow. Query
 * suggestions, categories and brands are served from in-memory directories
 * refreshed in the background; only the product section touches the retrieval
 * engine, and it asks for no facets and a handful of hits.
 */

export interface QuerySuggestion {
  query: string;
  searches: number;
}

export interface AutocompleteRequest {
  q: string;
  /** Products to return. Kept small: the dropdown is not a results page. */
  limit?: number;
  shopperId?: string;
  sessionId?: string;
}

export interface AutocompleteResponse {
  query: string;
  suggestions: QuerySuggestion[];
  products: {
    sku: string;
    parentId: string;
    title: string;
    variantTitle: string;
    image: string;
    price: number;
    inStock: boolean;
    highlighted: string;
  }[];
  categories: { id: string; label: string; path: string[]; products: number }[];
  brands: { name: string; products: number }[];
  redirect?: { url: string; label?: string };
  /** Popular queries, shown when the box is empty. */
  trending: QuerySuggestion[];
  processingTimeMs: number;
}

const REFRESH_MS = 5 * 60 * 1000;

export class AutocompleteService {
  private popular = new Map<string, { queries: QuerySuggestion[]; expires: number }>();
  private inflight = new Map<string, Promise<QuerySuggestion[]>>();

  constructor(
    private readonly engine: SearchEngine,
    private readonly search: SearchService,
    private readonly db: Db,
    private readonly redirects?: RedirectStore,
  ) {}

  async complete(site: SiteConfig, request: AutocompleteRequest): Promise<AutocompleteResponse> {
    const started = performance.now();
    const q = normalise(request.q ?? '');
    const limit = Math.min(10, Math.max(1, request.limit ?? 6));

    const [popular, directory] = await Promise.all([
      this.popularQueries(site.id),
      this.engine.directory(site.id),
    ]);

    // An empty box gets trending searches rather than nothing at all.
    if (!q) {
      return {
        query: '',
        suggestions: [],
        products: [],
        categories: directory.categories
          .filter((c) => c.id.includes('/'))
          .slice(0, 6)
          .map((c) => ({ id: c.id, label: c.path[c.path.length - 1] ?? c.id, path: c.path, products: c.products })),
        brands: [],
        trending: popular.slice(0, 6),
        processingTimeMs: round(performance.now() - started),
      };
    }

    const redirect = this.redirects ? (await this.redirects.get(site.id)).match(q) : null;

    // Products come from the ordinary search path, which means autocomplete and
    // the results page can never disagree about what matches.
    const results = await this.search.search(site, {
      q,
      hitsPerPage: limit,
      facets: [],
      shopperId: request.shopperId,
      sessionId: request.sessionId,
    });

    return {
      query: q,
      suggestions: popular
        .filter((s) => s.query !== q && s.query.includes(q))
        // Prefix matches first: they are what the shopper is most likely typing.
        .sort((a, b) => rankSuggestion(a, b, q))
        .slice(0, 6),
      products: results.hits.map((hit) => ({
        sku: hit.sku,
        parentId: hit.parentId,
        title: hit.title,
        variantTitle: hit.variantTitle,
        image: hit.image,
        price: hit.effectivePrice,
        inStock: hit.inStock,
        highlighted: hit.highlights?.title ?? hit.title,
      })),
      categories: directory.categories
        .filter((c) => c.path.join(' ').toLowerCase().includes(q))
        .sort((a, b) => b.products - a.products)
        .slice(0, 4)
        .map((c) => ({ id: c.id, label: c.path.join(' / '), path: c.path, products: c.products })),
      brands: directory.brands
        .filter((b) => b.name.toLowerCase().includes(q))
        .slice(0, 3),
      redirect: redirect ? { url: redirect.url, label: redirect.label } : undefined,
      trending: [],
      processingTimeMs: round(performance.now() - started),
    };
  }

  /**
   * Popular queries from the event log, refreshed in the background.
   *
   * Only queries that actually returned results are suggested: proposing a
   * search that leads to an empty page is worse than proposing nothing.
   */
  private async popularQueries(siteId: string): Promise<QuerySuggestion[]> {
    const cached = this.popular.get(siteId);
    if (cached && cached.expires > Date.now()) return cached.queries;
    // Serve the stale set while a refresh is in flight rather than making every
    // keystroke wait on the same query.
    if (cached) {
      void this.refreshPopular(siteId);
      return cached.queries;
    }
    return this.refreshPopular(siteId);
  }

  private refreshPopular(siteId: string): Promise<QuerySuggestion[]> {
    const existing = this.inflight.get(siteId);
    if (existing) return existing;

    const promise = this.db
      .query<{ query: string; searches: string }>(
        `SELECT normalised_query AS query, COUNT(*) AS searches
         FROM events
         WHERE site_id = $1 AND type = 'search' AND normalised_query IS NOT NULL
           AND occurred_at > now() - interval '30 days'
           AND COALESCE(result_count, 0) > 0
         GROUP BY normalised_query
         ORDER BY searches DESC
         LIMIT 200`,
        [siteId],
      )
      .then((r) => {
        const queries = r.rows.map((row) => ({ query: row.query, searches: Number(row.searches) }));
        this.popular.set(siteId, { queries, expires: Date.now() + REFRESH_MS });
        return queries;
      })
      .catch(() => {
        // Autocomplete degrades to products and categories rather than failing.
        this.popular.set(siteId, { queries: [], expires: Date.now() + REFRESH_MS });
        return [] as QuerySuggestion[];
      })
      .finally(() => {
        this.inflight.delete(siteId);
      });

    this.inflight.set(siteId, promise);
    return promise;
  }

  invalidate(siteId?: string): void {
    if (siteId) this.popular.delete(siteId);
    else this.popular.clear();
  }
}

function rankSuggestion(a: QuerySuggestion, b: QuerySuggestion, q: string): number {
  const aPrefix = a.query.startsWith(q) ? 0 : 1;
  const bPrefix = b.query.startsWith(q) ? 0 : 1;
  if (aPrefix !== bPrefix) return aPrefix - bPrefix;
  return b.searches - a.searches;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
