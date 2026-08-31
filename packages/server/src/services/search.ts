import type {
  FacetResult,
  Hit,
  RescueStrategy,
  SearchRequest,
  SearchResponse,
  SiteConfig,
  ParsedConstraint,
} from '@compass/shared';
import type { EngineFacet, EngineQuery, SearchEngine } from '../engine/types.js';
import { analyzeQuery, type AnalyzedQuery } from '../query/analyze.js';
import { buildEntityIndex, type EntityIndex } from '../query/entities.js';
import { relaxTerms, suggestCorrection } from '../query/spelling.js';
import { rankCandidates } from '../ranking/cascade.js';
import { groupByParent, highlight, hitFromDoc } from '../ranking/group.js';
import type { SynonymStore } from '../merchandising/synonyms.js';
import type { BadgeDefinition, CustomAttributeDefinition } from '../merchandising/labels.js';
import type { RedirectStore } from '../merchandising/redirects.js';
import { ResultCache, cacheKey } from './cache.js';
import { seoConfigFor, seoDirectives } from './seo.js';
import { applyRule, type QueryRuleStore } from '../merchandising/queryrules.js';

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
  /**
   * Products ranked per query, and therefore the deepest reachable result.
   * Beyond it a shopper refines rather than paginates.
   */
  rankingWindow?: number;
  synonyms?: SynonymStore;
  redirects?: RedirectStore;
  /** Pins, buries and hides bound to what the shopper typed. */
  queryRules?: QueryRuleStore;
  /**
   * Source of merchandiser-defined attributes. Typed structurally rather than
   * as the concrete store so the search pipeline does not depend on Postgres
   * just to know which custom facets exist.
   */
  collections?: {
    listAttributes(siteId: string): Promise<CustomAttributeDefinition[]>;
    listBadges?(siteId: string): Promise<BadgeDefinition[]>;
  };
  cache?: ResultCache<SearchResponse>;
  /**
   * Measured shopper behaviour. Optional, and typed structurally: search must
   * rank without an analytics database, just less well.
   */
  signals?: { get(siteId: string): Promise<{ ctrBySku: Map<string, number>; siteMean: number }> };
  /** Counts what was served, so click-through has a denominator. */
  impressions?: { record(siteId: string, skus: string[]): void };
}

/**
 * Products ranked per query.
 *
 * This is the one knob trading latency against pagination depth: every query
 * fetches this many products' worth of variants, whichever page was asked for,
 * because a window that varied by page made ordering unstable. 240 is ten pages
 * of 24, which is past where anyone paginates.
 */
const DEFAULT_RANKING_WINDOW = Number(process.env.COMPASS_RANKING_WINDOW ?? 240);

/** More than two badges on one card stops being emphasis and becomes noise. */
const MAX_BADGES_PER_CARD = 2;

export class SearchService {
  private readonly cache: ResultCache<SearchResponse>;
  private readonly entities = new Map<string, { index: EntityIndex; expires: number }>();

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
    // into one entry per visitor. Affinity is left out for the same reason,
    // which is why personalisation happens after the cache rather than inside
    // it: one shopper's preferences must never be served to the next.
    const { shopperId, sessionId, affinity, ...cacheable } = request;
    const key = cacheKey(site.id, cacheable as Record<string, unknown>);
    const cached = this.cache.get(key);
    if (cached) {
      return personalise({ ...cached, processingTimeMs: round(performance.now() - started) },
        affinity);
    }

    const response = await this.execute(site, request, started);
    // A redirect is not worth caching: it is cheap to recompute and short-lived.
    if (!response.redirect) this.cache.set(key, response);
    return personalise(response, affinity);
  }

  /**
   * SEO directives for a result page.
   *
   * Computed after the cache rather than inside it: the directives depend only
   * on the request and the totals, so folding them into the cached body would
   * mean two cache entries for a page that differs by a boolean.
   */
  seoFor(site: SiteConfig, request: SearchRequest, response: SearchResponse): SearchResponse {
    if (!request.seo) return response;
    return {
      ...response,
      seo: seoDirectives(request, response, seoConfigFor(site.id), site.name),
    };
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
    // `entities: false` says the shopper removed a filter the query itself
    // produced. Withholding the dictionary — rather than stripping the
    // constraints afterwards — keeps one code path: nothing downstream, rescue
    // included, can re-lift what was taken off.
    const entities = request.entities === false
      ? undefined
      : await this.entityIndex(site);
    const analyzed = analyzeQuery(query, { vocabulary, entities });

    // Entities the query named become ordinary filters. Going through the same
    // path as a facet click is what makes them precise, visible and removable:
    // the shopper sees "Brand: Heritage" as a chip and can take it off.
    request = applyEntityConstraints(request, analyzed.constraints);

    // 2. Synonyms expand the query rather than the index, so an edit takes
    //    effect on the next search instead of needing a reindex.
    const { terms, ruleIds } = await this.applySynonyms(site.id, analyzed);

    const facetFields = request.facets ?? site.defaultFacets.map((f) => f.field);
    // Merchandiser-defined attributes are counted alongside the built-in
    // facets, so a custom filter behaves exactly like a catalogue one.
    const attributes = this.options.collections
      ? (await this.options.collections.listAttributes(site.id)).filter((a) => a.enabled)
      : [];
    const labelFacets = attributes.map((a) => a.key);

    const attempt = await this.retrieve(site, request, {
      terms,
      analyzed,
      facetFields,
      labelFacets,
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
        analyzed, terms, facetFields, labelFacets, sort, page, hitsPerPage, vocabulary,
      });
      if (rescued?.response) {
        // A delegated fallback is already a complete response; relabel it with
        // the query the shopper actually typed and the path that rescued it.
        // What the rescue actually searched, not what was asked for: its own
        // `appliedFilters` is the only record of that, and a branch that
        // dropped a constraint reports which ones it kept.
        const kept = rescued.kept ?? analyzed.constraints;
        return {
          ...rescued.response,
          query: request.q ?? '',
          effectiveQuery: '',
          queryType: analyzed.type,
          // Carried through: a shopper shown a relaxed result set still needs
          // to see what the query was understood to mean, and which part of it
          // was dropped to get here.
          parsedFilters: kept.length ? kept : undefined,
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

    // 4. Merchandising bound to the query itself. Applied to the whole ranked
    //    window rather than the page, so a pin at slot one lands on page one.
    const merchandised = await this.applyQueryRule(site, request, grouped, ruleIds);

    const start = (page - 1) * hitsPerPage;
    const pageHits = merchandised.slice(start, start + hitsPerPage);
    const surfaces = [...new Set(effectiveTerms)];
    for (const hit of pageHits) this.addHighlights(hit, surfaces);
    await this.addBadges(site.id, pageHits);

    // What was served, counted where it is known for certain. Buffered in
    // memory by the recorder, so this is a map write, not a database call.
    this.options.impressions?.record(site.id, pageHits.map((h) => h.sku));

    // A rule can remove products and add ones the query never matched, so the
    // count a shopper is shown follows the merchandised list, not retrieval.
    const merchandisedTotal = totalHits + (merchandised.length - grouped.length);

    // totalHits is the true count; totalPages is what can actually be paged to.
    const reachable = Math.min(merchandisedTotal, this.maxPaginationHits(hitsPerPage));
    return {
      hits: pageHits,
      page,
      hitsPerPage,
      totalHits: merchandisedTotal,
      totalPages: Math.max(1, Math.ceil(reachable / hitsPerPage)),
      reachableHits: reachable < merchandisedTotal ? reachable : undefined,
      processingTimeMs: round(performance.now() - started),
      query: request.q ?? '',
      effectiveQuery: effectiveTerms.join(' '),
      queryType: analyzed.type,
      facets: this.buildFacets(site, engineFacets, request, attributes),
      appliedFilters: request.filters ?? {},
      sort,
      rescue,
      rulesApplied: ruleIds.length ? ruleIds : undefined,
      parsedFilters: analyzed.constraints.length ? analyzed.constraints : undefined,
    };
  }

  /**
   * Pins, buries and hides for this query.
   *
   * A pin names a product whether or not the query reached it, which is most of
   * why merchandisers want pinning at all: putting a new range on "beams" today
   * should not wait for the text to rank it. Anything pinned but absent is
   * fetched by id — one lookup, only when a rule actually names something the
   * results do not already contain.
   */
  /**
   * What the analyser makes of a query, without running a search.
   *
   * Analytics needs this to tell a ranking problem from a vocabulary one: a
   * query nothing was clicked on means something different when the catalogue
   * has no concept for the words at all.
   */
  async understand(site: SiteConfig, query: string): Promise<{ brand?: string; category?: string }> {
    const entities = await this.entityIndex(site);
    const analyzed = analyzeQuery(query, { entities });
    return {
      brand: analyzed.constraints.find((c) => c.kind === 'brand')?.value as string | undefined,
      category: analyzed.constraints.find((c) => c.kind === 'category')?.value as string | undefined,
    };
  }

  /**
   * The brands, product types and product features the catalogue carries,
   * cached per site.
   *
   * Built from the index's own directory and facet counts, so nothing is
   * configured: a brand is a brand because products carry it, and "walnut" is
   * a finish because the finish facet holds it. Rebuilt when the index
   * changes, which `invalidate` already signals.
   */
  private async entityIndex(site: SiteConfig): Promise<EntityIndex> {
    const cached = this.entities.get(site.id);
    if (cached && cached.expires > Date.now()) return cached.index;
    // The site's own facets: the fields a merchandiser already decided
    // shoppers care about. Recognising every stored column would happily match
    // an accounting code.
    const fields = site.defaultFacets
      .filter((f) => f.displayType !== 'slider' && f.field !== 'in_stock')
      .map((f) => f.field);
    const index = await buildEntityIndex(this.engine, site.id, fields);
    this.entities.set(site.id, { index, expires: Date.now() + 60_000 });
    return index;
  }

  private async applyQueryRule(
    site: SiteConfig,
    request: SearchRequest,
    grouped: Hit[],
    ruleIds: string[],
  ): Promise<Hit[]> {
    const store = this.options.queryRules;
    if (!store) return grouped;
    const query = (request.q ?? '').trim();
    const categoryId = (request.categoryId ?? '').trim();
    if (!query && !categoryId) return grouped;

    // Typed words first: a search made inside a category is a more specific
    // statement of intent than the category the shopper happens to be in.
    const rule = (query ? await store.forQuery(site.id, query).catch(() => null) : null)
      ?? (categoryId ? await store.forCategory(site.id, categoryId).catch(() => null) : null);
    if (!rule) return grouped;

    const present = new Set(grouped.map((h) => h.parentId));
    const missing = rule.actions
      .filter((a) => a.action === 'pin' && !present.has(a.parentId))
      .map((a) => a.parentId);

    const absent = new Map<string, Hit>();
    if (missing.length) {
      const docs = await this.engine.getByParentIds(site.id, missing).catch(() => []);
      for (const doc of docs) absent.set(doc.parentId, hitFromDoc(doc));
    }

    ruleIds.push(`query_rule:${rule.id}`);
    return applyRule(grouped, rule, absent);
  }

  /**
   * Relax a query whose entities were understood but which still found nothing.
   *
   * Three steps, most-preserving first, because each drops more of what the
   * shopper asked for:
   *
   *   1. Keep the entities, drop the leftover words. "heritage beams" in a
   *      catalogue with no Heritage brand still means beams, and showing beams
   *      beats showing best sellers.
   *   2. Drop the brand, keep the product type — what they came for.
   *   3. Drop the product type, keep the brand.
   *
   * Every branch says what it dropped. A result set that quietly ignores half
   * the query is worse than one that explains itself.
   */
  private async dropEntity(
    site: SiteConfig,
    ctx: RescueContext,
  ): Promise<RescueOutcome | null> {
    const brand = ctx.analyzed.constraints.find((c) => c.kind === 'brand');
    const category = ctx.analyzed.constraints.find((c) => c.kind === 'category');
    const attributes = ctx.analyzed.constraints.filter((c) => c.kind === 'attribute');
    if (!brand && !category && !attributes.length) return null;

    // `q: ''` throughout: leaving the text in would re-lift the same entities
    // and land straight back here.
    const base = {
      q: '',
      sort: ctx.sort === 'relevance' ? 'best_selling' : ctx.sort,
      page: ctx.page,
      hitsPerPage: ctx.hitsPerPage,
      facets: ctx.facetFields,
    };
    // Everything understood, kept. "black pvc corbel" in a catalogue with no
    // corbel category is still a shopper asking for something black and PVC,
    // and answering with the whole catalogue throws away the two things they
    // said that the catalogue does understand.
    const understoodFilters: Record<string, string[]> = {};
    if (brand) understoodFilters.brand = [String(brand.value)];
    for (const attribute of attributes) {
      understoodFilters[attribute.field] = [String(attribute.value)];
    }
    const asFilters = {
      ...(category ? { categoryId: String(category.value) } : {}),
      ...(Object.keys(understoodFilters).length ? { filters: understoodFilters } : {}),
    };
    const named = (c: typeof brand) => c?.source ?? '';

    const attempt = async (
      overrides: Record<string, unknown>,
      notice: string,
      kept: (ParsedConstraint | undefined)[],
    ): Promise<RescueOutcome | null> => {
      const response = await this.search(site, { ...base, ...overrides });
      if (response.totalHits === 0) return null;
      return {
        response,
        terms: ctx.terms,
        rescue: { strategy: 'drop_entity', notice },
        kept: kept.filter((c): c is ParsedConstraint => Boolean(c)),
      };
    };

    // 1. The words around what was understood were the problem.
    if (ctx.terms.length > 0) {
      const names = [
        brand ? brand.value : null,
        ...attributes.map((a) => a.value),
        category ? named(category) : null,
      ].filter(Boolean).join(' ');
      const outcome = await attempt(
        asFilters, `No exact matches. Showing ${names}.`, [brand, category, ...attributes]);
      if (outcome) return outcome;
    }

    // 2. Everything together found nothing, so relax the features one at a
    //    time. "No black polyurethane corbels" should land on black ones, not
    //    on the best sellers — the shopper said two things the catalogue
    //    understands, and dropping both throws away more than it has to. The
    //    first feature named is kept longest: in "black polyurethane" the
    //    colour is what they came for and the material is the qualifier.
    for (let keep = attributes.length - 1; keep >= 1; keep--) {
      const kept = attributes.slice(0, keep);
      const dropped = attributes.slice(keep);
      const filters: Record<string, string[]> = {};
      if (brand) filters.brand = [String(brand.value)];
      for (const attribute of kept) filters[attribute.field] = [String(attribute.value)];

      const outcome = await attempt(
        {
          ...(category ? { categoryId: String(category.value) } : {}),
          filters,
        },
        `No ${[...kept, ...dropped].map((a) => a.value).join(' ')}. `
          + `Showing ${kept.map((a) => a.value).join(' ')}.`,
        [brand, category, ...kept],
      );
      if (outcome) return outcome;
    }

    if (!brand || !category) return null;

    // 3. That brand does not make that thing.
    const withoutBrand = await attempt(
      { categoryId: String(category.value) },
      `No ${brand.value} ${named(category)}. Showing all ${named(category)}.`,
      [category],
    );
    if (withoutBrand) return withoutBrand;

    // 4. Last: keep the brand, show everything it does make.
    return attempt(
      { filters: { brand: [String(brand.value)] } },
      `No ${brand.value} ${named(category)}. Showing all ${brand.value}.`,
      [brand],
    );
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
      labelFacets: string[];
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
      collection: request.collection,
      labelFilters: request.labelFilters,
      labelFacets: probe ? [] : ctx.labelFacets,
      filters: request.filters ?? {},
      ranges: request.ranges ?? [],
      constraints: ctx.analyzed.constraints,
      facets: probe ? [] : ctx.facetFields,
      sort: ctx.sort,
      groupWindow: probe ? 1 : this.groupWindow(),
      candidateLimit: probe ? 1 : this.candidateLimit(),
      typo: site.typoTolerance,
      weights: site.searchableAttributes,
      exactOnly: ctx.analyzed.exactOnly,
    };

    const result = await this.engine.search(engineQuery);
    // Behaviour is read per query rather than cached with the result: the
    // store is already cached and the map is shared, so this is a lookup, and
    // ranking that silently used a stale snapshot for an hour is worse.
    const measured = site.business.ctr
      ? await this.options.signals?.get(site.id).catch(() => undefined)
      : undefined;

    const ranked = rankCandidates(result.candidates, {
      terms: ctx.terms,
      weights: site.searchableAttributes,
      business: site.business,
      clicks: measured ? { bySku: measured.ctrBySku, mean: measured.siteMean } : undefined,
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
   * How many parent products to bring back for re-ranking.
   *
   * Deliberately independent of the requested page. The cascade re-ranks
   * whatever it is given, so a window that grew with the page produced a
   * different ordering on every page — products appeared twice, and others
   * never appeared at all. A fixed window makes the ordering a property of the
   * query alone, so pagination is stable by construction.
   */
  private groupWindow(): number {
    return this.options.rankingWindow ?? DEFAULT_RANKING_WINDOW;
  }

  /**
   * Hard cap on variant rows. A window of 500 products on a catalogue averaging
   * six variants each is ~3,000 rows; the cap stops a handful of very wide
   * products from turning that into ten times as many.
   */
  private candidateLimit(): number {
    return Math.min(6_000, this.groupWindow() * 8);
  }

  /**
   * Deep pagination is capped at the ranking window.
   *
   * Serving page 400 means ranking everything before it, and nobody paginates
   * that far — they refine instead. Every hosted search engine caps this for
   * the same reason. The cap is reported in the response so a storefront can
   * stop offering page links rather than offering ones that return nothing.
   */
  private maxPaginationHits(hitsPerPage: number): number {
    return Math.max(hitsPerPage, this.groupWindow());
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
    ctx: RescueContext,
  ): Promise<RescueOutcome | null> {
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

    // 2. A brand and a product type that are each real but empty together.
    //    "Timberthane beams" is not a misspelling and not a nonsense query —
    //    both halves exist, that combination does not. Dropping the brand and
    //    saying so beats falling through to best sellers, which answers a
    //    question nobody asked.
    const entityRescue = await this.dropEntity(site, ctx);
    if (entityRescue) return entityRescue;

    // 3. Relax: drop the least informative term and retry.
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

    // 4. Nearest category: whichever category best matches any query word.
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

    // 5. Last resort: the site's best sellers. Never a dead end.
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

  /**
   * Resolve `badge:*` labels into the labels and tones a card renders.
   *
   * Only the page's hits are decorated — the badge definitions are a handful of
   * rows and the labels are already on the document, so this costs one cached
   * lookup rather than a query per card. Highest priority first, capped, so a
   * product matching six badges does not turn its card into a wall of pills.
   */
  private async addBadges(siteId: string, hits: Hit[]): Promise<void> {
    if (hits.length === 0) return;
    const definitions = (await this.options.collections?.listBadges?.(siteId)) ?? [];
    const byKey = new Map(definitions.map((b) => [b.key, b]));

    for (const hit of hits) {
      // `labels` is carried through grouping purely to resolve badges here; it
      // is internal and must be stripped on every path, including the one where
      // no badges are defined at all.
      const labels = (hit as Hit & { labels?: string[] }).labels ?? [];
      const badges = labels
        .filter((l) => l.startsWith('badge:'))
        .map((l) => byKey.get(l.slice('badge:'.length)))
        .filter((b): b is BadgeDefinition => Boolean(b) && b!.enabled)
        .sort((a, b) => a.priority - b.priority)
        .slice(0, MAX_BADGES_PER_CARD)
        .map((b) => ({ key: b.key, label: b.label, tone: b.tone }));
      if (badges.length) hit.badges = badges;
      delete (hit as Hit & { labels?: string[] }).labels;
    }
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
    attributes: { key: string; label: string; displayType: FacetResult['displayType'];
                  position: number; collapsed: boolean; truncateAt: number;
                  sortBy: 'count' | 'alpha' | 'custom'; customOrder: string[] | null }[] = [],
  ): FacetResult[] {
    const byField = new Map(engineFacets.map((f) => [f.field, f]));
    const selected = request.filters ?? {};
    const out: FacetResult[] = [];

    // Custom attributes render exactly like catalogue facets, ordered together
    // with them, so a shopper cannot tell which came from the feed.
    const configs = [
      ...site.defaultFacets,
      ...attributes.map((a) => ({
        field: a.key, label: a.label, displayType: a.displayType, order: a.position,
        collapsed: a.collapsed, truncateAt: a.truncateAt, sortBy: a.sortBy,
        customOrder: a.customOrder ?? undefined, custom: true as const,
      })),
    ];
    const selectedLabels = request.labelFilters ?? {};

    for (const config of configs.sort((a, b) => a.order - b.order)) {
      const isCustom = 'custom' in config;
      if (isCustom) {
        const engineFacet = byField.get(config.field);
        if (!engineFacet?.values.length) continue;
        const chosen = new Set((selectedLabels[config.field] ?? []).map(String));
        out.push({
          field: config.field,
          label: config.label,
          displayType: config.displayType,
          custom: true,
          values: engineFacet.values.map((v) => ({
            value: v.value,
            label: String(v.value),
            count: v.count,
            selected: chosen.has(String(v.value)),
          })),
        });
        continue;
      }
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

/** What every rescue branch is handed. */
interface RescueContext {
  analyzed: AnalyzedQuery;
  terms: string[];
  facetFields: string[];
  labelFacets: string[];
  sort: string;
  page: number;
  hitsPerPage: number;
  vocabulary: Set<string>;
}

/** What a branch returns when it saved the query. */
interface RescueOutcome {
  attempt?: { grouped: Hit[]; engineFacets: EngineFacet[]; totalHits: number };
  /** A complete response, when the branch delegated to a cached search. */
  response?: SearchResponse;
  terms: string[];
  rescue: { strategy: RescueStrategy; didYouMean?: string; notice?: string };
  /**
   * The constraints still in force after the branch dropped what it had to.
   * A rescue that discards the brand must not go on reporting the brand as
   * applied: the storefront prints these, and a filter the page names but the
   * results do not obey is worse than no explanation at all.
   */
  kept?: ParsedConstraint[];
}

/**
 * Fold entity constraints into the request as ordinary filters.
 *
 * A brand becomes a brand facet selection; a product type becomes the category
 * being browsed. An explicit choice the shopper already made always wins — if
 * they are inside Exterior and type "beams", the words narrow the text rather
 * than teleporting them out of the category they chose.
 */
/**
 * Re-order one page for the shopper looking at it.
 *
 * A shopper who has clicked three black products is telling you something, and
 * the cheapest way to use it is to move the black ones up the page they were
 * already getting. Deliberately bounded:
 *
 *   - **It re-orders, never re-selects.** Nothing enters or leaves the page,
 *     so the count, the facets and the pagination all stay true, and a shopper
 *     cannot be quietly walled into a narrower catalogue by their own history.
 *   - **A merchandiser's arrangement wins.** When a rule pinned something, the
 *     order is somebody's explicit decision, and a guess does not get to move
 *     it.
 *   - **It is stable.** Products with equal affinity keep their relevance
 *     order, so this tilts the page rather than shuffling it.
 */
export function personalise(
  response: SearchResponse,
  affinity: string[] | undefined,
): SearchResponse {
  if (!affinity?.length || response.rulesApplied?.length || response.hits.length < 2) {
    return response;
  }
  const wanted = new Set(affinity.map((a) => a.trim().toLowerCase()).filter(Boolean));
  // The variant label already carries the attributes that distinguish it —
  // "Black / PVC / Joined" — so nothing has to be added to the response to
  // read them. A shopper's affinity is expressed in exactly these words,
  // because it was collected from the same labels.
  const score = (hit: Hit): number => {
    let n = 0;
    for (const part of (hit.variantTitle ?? '').split('/')) {
      if (wanted.has(part.trim().toLowerCase())) n++;
    }
    if (hit.brand && wanted.has(hit.brand.toLowerCase())) n++;
    return n;
  };

  const scored = response.hits.map((hit, index) => ({ hit, index, score: score(hit) }));
  if (!scored.some((s) => s.score > 0)) return response;
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return { ...response, hits: scored.map((s) => s.hit), personalised: true };
}

function applyEntityConstraints(
  request: SearchRequest,
  constraints: ParsedConstraint[],
): SearchRequest {
  const brand = constraints.find((c) => c.kind === 'brand');
  const category = constraints.find((c) => c.kind === 'category');
  const attributes = constraints.filter((c) => c.kind === 'attribute');
  if (!brand && !category && !attributes.length) return request;

  const next: SearchRequest = { ...request };
  const filters = { ...(request.filters ?? {}) };
  if (brand && !filters.brand?.length) filters.brand = [String(brand.value)];
  // A feature the shopper named — "black", "polyurethane" — narrows exactly as
  // a facet click does. An explicit selection on the same field always wins:
  // they are looking at the facet panel, and the words are the older intent.
  for (const attribute of attributes) {
    if (!filters[attribute.field]?.length) filters[attribute.field] = [String(attribute.value)];
  }
  if (Object.keys(filters).length) next.filters = filters;
  if (category && !request.categoryId && !request.collection) {
    next.categoryId = String(category.value);
  }
  return next;
}

/** `in_stock` is stored 0/1; shoppers should never see that. */
function facetValueLabel(field: string, value: string | number): string {
  if (field === 'in_stock') return String(value) === '1' ? 'In Stock' : 'Out of Stock';
  return String(value);
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}
