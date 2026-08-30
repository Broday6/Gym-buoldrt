import type {
  FacetResult,
  Hit,
  RescueStrategy,
  SearchRequest,
  SearchResponse,
  SiteConfig,
} from '@compass/shared';
import type { EngineFacet, EngineQuery, SearchEngine } from '../engine/types.js';
import { analyzeQuery, type AnalyzedQuery } from '../query/analyze.js';
import { relaxTerms, suggestCorrection } from '../query/spelling.js';
import { rankCandidates } from '../ranking/cascade.js';
import { groupByParent, highlight } from '../ranking/group.js';
import type { SynonymStore } from '../merchandising/synonyms.js';
import type { RedirectStore } from '../merchandising/redirects.js';
import { ResultCache, cacheKey } from './cache.js';

/**
 * The query pipeline.
 *
 *   redirect? -> analyse -> synonyms -> retrieve a bounded candidate window ->
 *   cascade re-rank -> business rank within band -> group to one card per
 *   parent -> facets -> rescue if empty
 *
 * Facet counts come from the engine over the FULL filtered set, never from the
 * candidate window, or counts would drift as pagination moved.
 */

export interface SearchServiceOptions {
  /** Candidates re-ranked per query. Bounds tail latency at catalogue scale. */
  candidateLimit?: number;
  /** Cascade criteria forming a relevance band; see ranking/cascade.ts. */
  bandDepth?: number;
  synonyms?: SynonymStore;
  redirects?: RedirectStore;
  cache?: ResultCache<SearchResponse>;
}

export class SearchService {
  private readonly cache: ResultCache<SearchResponse>;

  constructor(
    private readonly engine: SearchEngine,
    private readonly options: SearchServiceOptions = {},
  ) {
    this.cache = options.cache ?? new ResultCache<SearchResponse>();
  }

  /** Purge cached results — on reindex, or when merchandising changes. */
  invalidate(siteId?: string): void {
    this.cache.invalidate(siteId);
  }

  cacheStats() {
    return this.cache.stats();
  }

  async search(site: SiteConfig, request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();

    // Shopper identity must never enter the cache key, or the cache degenerates
    // into one entry per visitor.
    const { shopperId, sessionId, ...cacheable } = request;
    const key = cacheKey(site.id, cacheable as Record<string, unknown>);
    const cached = this.cache.get(key);
    if (cached) {
      return { ...cached, processingTimeMs: round(performance.now() - started) };
    }

    const response = await this.execute(site, request, started);
    // A redirect is not worth caching: it is cheap to recompute and short-lived.
    if (!response.redirect) this.cache.set(key, response);
    return response;
  }

  private async execute(
    site: SiteConfig,
    request: SearchRequest,
    started: number,
  ): Promise<SearchResponse> {
    const page = Math.max(1, request.page ?? 1);
    const hitsPerPage = Math.min(100, Math.max(1, request.hitsPerPage ?? site.hitsPerPage));
    const sort = request.sort ?? site.defaultSort;
    const query = (request.q ?? '').trim();

    // 1. Redirects short-circuit before any retrieval happens.
    if (query && this.options.redirects) {
      const redirect = (await this.options.redirects.get(site.id)).match(query);
      if (redirect) {
        return this.emptyResponse(site, request, page, hitsPerPage, sort, started, {
          redirect: { url: redirect.url, ruleId: redirect.ruleId },
        });
      }
    }

    const vocabulary = await this.engine.vocabulary(site.id);
    const analyzed = analyzeQuery(query, { vocabulary });

    // 2. Synonyms expand the query rather than the index, so an edit takes
    //    effect on the next search instead of needing a reindex.
    const { terms, ruleIds } = await this.applySynonyms(site.id, analyzed);

    const facetFields = request.facets ?? site.defaultFacets.map((f) => f.field);
    const attempt = await this.retrieve(site, request, {
      terms,
      analyzed,
      facetFields,
      sort,
      page,
      hitsPerPage,
    });

    let { grouped, engineFacets, totalHits } = attempt;
    let effectiveTerms = terms;
    let rescue: SearchResponse['rescue'];

    // 3. A zero-result page is a conversion emergency; cascade before giving up.
    if (totalHits === 0 && query && request.rescue !== false) {
      const rescued = await this.rescue(site, request, {
        analyzed, terms, facetFields, sort, page, hitsPerPage, vocabulary,
      });
      if (rescued?.response) {
        // A delegated fallback is already a complete response; relabel it with
        // the query the shopper actually typed and the path that rescued it.
        return {
          ...rescued.response,
          query: request.q ?? '',
          effectiveQuery: '',
          queryType: analyzed.type,
          appliedFilters: request.filters ?? {},
          rescue: rescued.rescue,
          processingTimeMs: round(performance.now() - started),
        };
      }
      if (rescued?.attempt) {
        ({ grouped, engineFacets, totalHits } = rescued.attempt);
        effectiveTerms = rescued.terms;
        rescue = rescued.rescue;
      }
    }

    const start = (page - 1) * hitsPerPage;
    const pageHits = grouped.slice(start, start + hitsPerPage);
    const surfaces = [...new Set(effectiveTerms)];
    for (const hit of pageHits) this.addHighlights(hit, surfaces);

    return {
      hits: pageHits,
      page,
      hitsPerPage,
      totalHits,
      totalPages: Math.max(1, Math.ceil(totalHits / hitsPerPage)),
      processingTimeMs: round(performance.now() - started),
      query: request.q ?? '',
      effectiveQuery: effectiveTerms.join(' '),
      queryType: analyzed.type,
      facets: this.buildFacets(site, engineFacets, request),
      appliedFilters: request.filters ?? {},
      sort,
      rescue,
      rulesApplied: ruleIds.length ? ruleIds : undefined,
      parsedFilters: analyzed.constraints.length ? analyzed.constraints : undefined,
    };
  }

  /** Browse is search with a category and no query — same engine, same rules. */
  async browse(site: SiteConfig, request: SearchRequest): Promise<SearchResponse> {
    // Relevance is meaningless without a query, so a browse with no explicit
    // sort falls back to best sellers. An explicit sort always wins.
    const fallback = site.defaultSort === 'relevance' ? 'best_selling' : site.defaultSort;
    return this.search(site, { ...request, sort: request.sort ?? fallback });
  }

  // ---- internals ---------------------------------------------------------

  private async applySynonyms(
    siteId: string,
    analyzed: AnalyzedQuery,
  ): Promise<{ terms: string[]; ruleIds: string[] }> {
    if (!this.options.synonyms || analyzed.terms.length === 0) {
      return { terms: analyzed.terms, ruleIds: [] };
    }
    const set = await this.options.synonyms.get(siteId);
    if (set.size === 0) return { terms: analyzed.terms, ruleIds: [] };

    const expansions = set.expand(analyzed.terms);
    if (expansions.length === 0) return { terms: analyzed.terms, ruleIds: [] };

    // Expansions are additive: the original terms always stay, so a synonym can
    // only ever widen recall, never take a shopper away from a literal match.
    const terms = [...analyzed.terms];
    const ruleIds: string[] = [];
    for (const expansion of expansions) {
      ruleIds.push(`synonym:${expansion.ruleId}`);
      for (const alternative of expansion.alternatives) {
        for (const token of alternative) if (!terms.includes(token)) terms.push(token);
      }
    }
    return { terms, ruleIds };
  }

  private async retrieve(
    site: SiteConfig,
    request: SearchRequest,
    ctx: {
      terms: string[];
      analyzed: AnalyzedQuery;
      facetFields: string[];
      sort: string;
      page: number;
      hitsPerPage: number;
    },
    /**
     * A probe only needs to know whether anything matched. Skipping facets and
     * the candidate window makes a rescue attempt a fraction of the cost of a
     * real search, which matters because the cascade may try four of them.
     */
    probe = false,
  ): Promise<{ grouped: Hit[]; engineFacets: EngineFacet[]; totalHits: number }> {
    const engineQuery: EngineQuery = {
      site: site.id,
      terms: ctx.terms,
      rawQuery: request.q ?? '',
      sku: ctx.analyzed.skuCandidate,
      categoryId: request.categoryId,
      filters: request.filters ?? {},
      ranges: request.ranges ?? [],
      constraints: ctx.analyzed.constraints,
      facets: probe ? [] : ctx.facetFields,
      sort: ctx.sort,
      candidateLimit: probe ? 1 : this.candidateLimit(ctx.page, ctx.hitsPerPage),
      typo: site.typoTolerance,
      weights: site.searchableAttributes,
      exactOnly: ctx.analyzed.exactOnly,
    };

    const result = await this.engine.search(engineQuery);
    const ranked = rankCandidates(result.candidates, {
      terms: ctx.terms,
      weights: site.searchableAttributes,
      business: site.business,
      bandDepth: this.options.bandDepth,
      // An explicit sort is the shopper's instruction and outranks relevance.
      preserveOrder: ctx.sort !== 'relevance',
    });
    return {
      grouped: groupByParent(ranked, { includeExplanations: request.explain === true }),
      engineFacets: result.facets,
      totalHits: result.totalGroups,
    };
  }

  /**
   * How many candidates to re-rank.
   *
   * Grouping collapses variants, so the window has to be wider than the page
   * itself — but a first page does not need the window a tenth page needs, and
   * fetching documents is the most expensive part of retrieval. Sizing it to
   * the requested page keeps the common case cheap.
   */
  private candidateLimit(page: number, hitsPerPage: number): number {
    const floor = this.options.candidateLimit ?? 120;
    return Math.min(1_000, Math.max(floor, page * hitsPerPage * 4));
  }

  /**
   * The zero-results cascade (§4.8): spell-correct, then relax, then fall back
   * to the nearest category. The semantic-only step lands with Phase 4 vectors.
   * Whichever step succeeds is reported so the shopper is told what happened
   * and analytics can see which path did the saving.
   */
  private async rescue(
    site: SiteConfig,
    request: SearchRequest,
    ctx: {
      analyzed: AnalyzedQuery;
      terms: string[];
      facetFields: string[];
      sort: string;
      page: number;
      hitsPerPage: number;
      vocabulary: Set<string>;
    },
  ): Promise<{
    attempt?: { grouped: Hit[]; engineFacets: EngineFacet[]; totalHits: number };
    /** A complete response, when the branch delegated to a cached search. */
    response?: SearchResponse;
    terms: string[];
    rescue: { strategy: RescueStrategy; didYouMean?: string; notice?: string };
  } | null> {
    const probe = (terms: string[], overrides: Partial<SearchRequest> = {}, sort = ctx.sort) =>
      this.retrieve(site, { ...request, ...overrides }, { ...ctx, terms, sort }, true);
    const build = (terms: string[], overrides: Partial<SearchRequest> = {}, sort = ctx.sort) =>
      this.retrieve(site, { ...request, ...overrides }, { ...ctx, terms, sort });

    // 1. Spelling.
    const correction = suggestCorrection(ctx.terms, {
      typo: site.typoTolerance,
      vocabulary: ctx.vocabulary,
    });
    if (correction.changed && (await probe(correction.terms)).totalHits > 0) {
      return {
        attempt: await build(correction.terms),
        terms: correction.terms,
        rescue: {
          strategy: 'spell_correct',
          didYouMean: correction.suggestion,
          notice: `Showing results for "${correction.suggestion}"`,
        },
      };
    }

    // 2. Relax: drop the least informative term and retry.
    let relaxed = relaxTerms(ctx.terms);
    while (relaxed) {
      if ((await probe(relaxed)).totalHits > 0) {
        return {
          attempt: await build(relaxed),
          terms: relaxed,
          rescue: {
            strategy: 'relax_query',
            notice: `No exact matches. Showing results for "${relaxed.join(' ')}".`,
          },
        };
      }
      relaxed = relaxTerms(relaxed);
    }

    // 3. Nearest category: whichever category best matches any query word.
    // A fallback has no query terms, so relevance means nothing — but if the
    // shopper picked a sort, it still applies to what they are shown.
    const fallbackSort = ctx.sort === 'relevance' ? 'best_selling' : ctx.sort;
    // The last two branches drop the query entirely, which makes them ordinary
    // browse requests — so they are issued through the cached search path. Every
    // failing query on a site shares the same fallback, so the first one pays
    // for it and the rest are served from cache.
    const category = await this.nearestCategory(site.id, ctx.terms);
    if (category) {
      // Filters go too: they were chosen for a result set that no longer exists.
      const response = await this.search(site, {
        categoryId: category.id,
        sort: fallbackSort,
        page: ctx.page,
        hitsPerPage: ctx.hitsPerPage,
        facets: ctx.facetFields,
      });
      if (response.totalHits > 0) {
        return {
          response,
          terms: [],
          rescue: {
            strategy: 'category_fallback',
            notice: `No matches. Showing popular products in ${category.path.join(' / ')}.`,
          },
        };
      }
    }

    // 4. Last resort: the site's best sellers. Never a dead end.
    // No facets here on purpose. A facet rail computed over the entire
    // catalogue is noise on a "we found nothing, here is what sells" page, and
    // it is the most expensive query the engine can be asked for.
    const response = await this.search(site, {
      sort: fallbackSort,
      page: ctx.page,
      hitsPerPage: ctx.hitsPerPage,
      facets: [],
    });
    if (response.totalHits > 0) {
      return {
        response,
        terms: [],
        rescue: { strategy: 'category_fallback', notice: 'No matches. Showing our best sellers.' },
      };
    }
    return null;
  }

  private async nearestCategory(
    siteId: string,
    terms: string[],
  ): Promise<{ id: string; path: string[] } | null> {
    if (terms.length === 0) return null;
    const { categories } = await this.engine.directory(siteId);
    let best: { id: string; path: string[]; score: number } | null = null;
    for (const category of categories) {
      const haystack = category.path.join(' ').toLowerCase();
      const score = terms.reduce((n, term) => n + (haystack.includes(term) ? term.length : 0), 0);
      if (score > 0 && (!best || score > best.score)) {
        best = { id: category.id, path: category.path, score };
      }
    }
    return best ? { id: best.id, path: best.path } : null;
  }

  private emptyResponse(
    site: SiteConfig,
    request: SearchRequest,
    page: number,
    hitsPerPage: number,
    sort: string,
    started: number,
    extra: Partial<SearchResponse>,
  ): SearchResponse {
    return {
      hits: [],
      page,
      hitsPerPage,
      totalHits: 0,
      totalPages: 1,
      processingTimeMs: round(performance.now() - started),
      query: request.q ?? '',
      effectiveQuery: '',
      queryType: 'keyword',
      facets: [],
      appliedFilters: request.filters ?? {},
      sort,
      ...extra,
    };
  }

  private addHighlights(hit: Hit, surfaces: string[]): void {
    hit.highlights = {
      title: highlight(hit.title, surfaces),
      variantTitle: highlight(hit.variantTitle, surfaces),
    };
  }

  /** Engine counts + site facet config -> what the widget renders. */
  private buildFacets(
    site: SiteConfig,
    engineFacets: EngineFacet[],
    request: SearchRequest,
  ): FacetResult[] {
    const byField = new Map(engineFacets.map((f) => [f.field, f]));
    const selected = request.filters ?? {};
    const out: FacetResult[] = [];

    for (const config of [...site.defaultFacets].sort((a, b) => a.order - b.order)) {
      const engineFacet = byField.get(config.field);
      if (!engineFacet) continue;

      if (config.displayType === 'slider') {
        if (!engineFacet.stats) continue;
        out.push({
          field: config.field,
          label: config.label,
          displayType: 'slider',
          values: [],
          stats: engineFacet.stats,
        });
        continue;
      }

      const selectedValues = new Set((selected[config.field] ?? []).map(String));
      // `value` is what gets sent back as a filter; `label` is what a shopper
      // reads. Conflating them breaks round-tripping on any facet whose stored
      // form differs from its display form, such as availability's 0/1.
      let values = engineFacet.values.map((v) => ({
        value: v.value,
        label: facetValueLabel(config.field, v.value),
        count: v.count,
        selected: selectedValues.has(String(v.value)),
      }));
      if (values.length === 0) continue;

      if (config.sortBy === 'alpha') {
        values.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
      } else if (config.sortBy === 'custom' && config.customOrder) {
        const rank = new Map(config.customOrder.map((v, i) => [v, i]));
        values.sort((a, b) => (rank.get(String(a.value)) ?? 999) - (rank.get(String(b.value)) ?? 999));
      }
      // A selected value always stays visible even when truncation would hide it.
      if (config.truncateAt > 0 && values.length > config.truncateAt) {
        const kept = values.slice(0, config.truncateAt);
        const keptSet = new Set(kept.map((v) => String(v.value)));
        values = [...kept, ...values.filter((v) => v.selected && !keptSet.has(String(v.value)))];
      }

      out.push({
        field: config.field,
        label: config.label,
        displayType: config.displayType,
        values,
      });
    }
    return out;
  }
}

/** `in_stock` is stored 0/1; shoppers should never see that. */
function facetValueLabel(field: string, value: string | number): string {
  if (field === 'in_stock') return String(value) === '1' ? 'In Stock' : 'Out of Stock';
  return String(value);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
