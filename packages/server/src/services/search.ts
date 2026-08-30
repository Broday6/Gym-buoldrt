import type {
  FacetResult,
  Hit,
  SearchRequest,
  SearchResponse,
  SiteConfig,
} from '@compass/shared';
import type { EngineFacet, EngineQuery, SearchEngine } from '../engine/types.js';
import { analyzeQuery } from '../query/analyze.js';
import { rankCandidates } from '../ranking/cascade.js';
import { groupByParent, highlight } from '../ranking/group.js';
import { SORT_OPTIONS } from '../config/sites.js';

/**
 * The query pipeline.
 *
 *   analyse -> retrieve a bounded candidate window -> cascade re-rank ->
 *   business rank within band -> group to one card per parent -> facets
 *
 * Facet counts come from the engine over the FULL filtered set, never from the
 * candidate window, or counts would drift as the window moved.
 */

export interface SearchServiceOptions {
  /** Candidates re-ranked per query. Bounds tail latency at catalogue scale. */
  candidateLimit?: number;
  /** Cascade criteria forming a relevance band; see ranking/cascade.ts. */
  bandDepth?: number;
}

export class SearchService {
  constructor(
    private readonly engine: SearchEngine,
    private readonly options: SearchServiceOptions = {},
  ) {}

  async search(site: SiteConfig, request: SearchRequest): Promise<SearchResponse> {
    const started = performance.now();
    const page = Math.max(1, request.page ?? 1);
    const hitsPerPage = Math.min(100, Math.max(1, request.hitsPerPage ?? site.hitsPerPage));
    const sort = request.sort ?? site.defaultSort;

    const vocabulary = await this.engine.vocabulary(site.id);
    const analyzed = analyzeQuery(request.q ?? '', { vocabulary });

    const facetFields = request.facets ?? site.defaultFacets.map((f) => f.field);
    const engineQuery: EngineQuery = {
      site: site.id,
      terms: analyzed.terms,
      rawQuery: request.q ?? '',
      sku: analyzed.skuCandidate,
      categoryId: request.categoryId,
      filters: request.filters ?? {},
      ranges: request.ranges ?? [],
      constraints: analyzed.constraints,
      facets: facetFields,
      sort,
      // Grouping collapses variants, so the window must be wide enough that a
      // deep page still has parents left after collapse.
      candidateLimit: Math.max(this.options.candidateLimit ?? 500, page * hitsPerPage * 4),
      typo: site.typoTolerance,
      weights: site.searchableAttributes,
      exactOnly: analyzed.exactOnly,
    };

    const result = await this.engine.search(engineQuery);

    const ranked = rankCandidates(result.candidates, {
      terms: analyzed.terms,
      weights: site.searchableAttributes,
      business: site.business,
      bandDepth: this.options.bandDepth,
    });

    const grouped = groupByParent(ranked, { includeExplanations: request.explain === true });
    const start = (page - 1) * hitsPerPage;
    const pageHits = grouped.slice(start, start + hitsPerPage);

    const surfaces = [...new Set(ranked.flatMap((r) => r.candidate.matchedTerms.map((m) => m.matched)))];
    for (const hit of pageHits) this.addHighlights(hit, surfaces);

    const totalHits = result.totalGroups;
    return {
      hits: pageHits,
      page,
      hitsPerPage,
      totalHits,
      totalPages: Math.max(1, Math.ceil(totalHits / hitsPerPage)),
      processingTimeMs: Math.round((performance.now() - started) * 100) / 100,
      query: request.q ?? '',
      effectiveQuery: analyzed.searchText,
      queryType: analyzed.type,
      facets: this.buildFacets(site, result.facets, request),
      appliedFilters: request.filters ?? {},
      sort,
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
      // Zero-count values are already excluded by the engine; that is what
      // stops a facet click from landing on an empty result set.
      let values = engineFacet.values.map((v) => ({
        value: displayValue(config.field, v.value),
        count: v.count,
        selected: selectedValues.has(String(v.value)),
      }));
      if (values.length === 0) continue;

      if (config.sortBy === 'alpha') {
        values.sort((a, b) => String(a.value).localeCompare(String(b.value), undefined, { numeric: true }));
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

/** `in_stock` is stored 0/1; shoppers should not see that. */
function displayValue(field: string, value: string | number): string | number {
  if (field === 'in_stock') return String(value) === '1' ? 'In Stock' : 'Out of Stock';
  return value;
}

export function sortOptionIds(): string[] {
  return SORT_OPTIONS.map((s) => s.id);
}
