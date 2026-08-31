/** Request/response contract for the public query API. Shared with the SDK. */

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  /** One of the exposed sort ids, e.g. "relevance" | "price_asc" | "newest". */
  id: string;
}

/** Facet selection: OR within a group, AND across groups. */
export interface FacetFilters {
  [field: string]: (string | number)[];
}

export interface RangeFilter {
  field: string;
  min?: number;
  max?: number;
}

export interface SearchRequest {
  q?: string;
  /** Browse mode: category id instead of a query. Both may be set. */
  categoryId?: string;
  /**
   * Collection slug. A merchandiser-defined grouping that cuts across the
   * catalogue taxonomy, browsed exactly like a category.
   */
  collection?: string;
  /**
   * Merchandiser-defined attribute filters, keyed by attribute. OR within a
   * key, AND across keys — the same shape as `filters`, kept separate so a
   * custom attribute can never collide with a catalogue field.
   */
  labelFilters?: Record<string, string[]>;
  filters?: FacetFilters;
  ranges?: RangeFilter[];
  sort?: string;
  page?: number;
  hitsPerPage?: number;
  /** Facet fields to compute; omit to use the site/category configured set. */
  facets?: string[];
  /** Free-form tags recorded against the query in analytics. */
  analyticsTags?: string[];
  /** Anonymous shopper + session ids, used for analytics and personalisation. */
  shopperId?: string;
  sessionId?: string;
  /** Return per-hit ranking explanations. Admin/debug only. */
  explain?: boolean;
  /**
   * Set false to suppress the zero-results rescue and see the literal result
   * set. This is what "search instead for X" sends after a spelling correction.
   */
  rescue?: boolean;
  /**
   * Set false to stop the analyser lifting brands and product types out of the
   * text. This is what a shopper sends by taking off a "Brand: Heritage" chip
   * the query itself produced: without it the next search would re-lift the
   * same entity and the chip would come straight back.
   */
  entities?: boolean;
  /**
   * Attribute values this shopper has shown interest in during this visit —
   * the finishes and materials they have been clicking. Used to re-order the
   * page they were going to get anyway, never to change which products it
   * contains, and never part of the cache key.
   */
  affinity?: string[];
  /**
   * Return SEO directives for this result page: canonical URL, robots policy,
   * title, description and schema.org ItemList. Off by default — a storefront
   * that renders its own head does not need the extra work on every request.
   */
  seo?: boolean;
}

export interface FacetValue {
  value: string | number;
  count: number;
  /** Present for range facets. */
  label?: string;
  selected?: boolean;
}

export interface FacetResult {
  field: string;
  label: string;
  displayType: 'checkbox' | 'slider' | 'swatch' | 'grid';
  values: FacetValue[];
  stats?: { min: number; max: number };
  /**
   * True for a merchandiser-defined attribute. Selections on these go back in
   * `labelFilters`, not `filters`, so a custom attribute can never collide with
   * a catalogue field name.
   */
  custom?: boolean;
}

/** Why a hit ranked where it did. Powers the admin explainability panel. */
export interface RankExplanation {
  typos: number;
  wordsMatched: number;
  /** Highest-weight attribute the query matched in. */
  bestField: string;
  bestFieldWeight: number;
  proximity: number;
  exactness: number;
  textScore: number;
  businessScore: number;
  businessBreakdown: Record<string, number>;
  finalScore: number;
  /** Ids of merchandising rules that touched this hit. */
  rulesApplied: string[];
  pinnedPosition?: number;
}

export interface Hit {
  parentId: string;
  sku: string;
  title: string;
  variantTitle: string;
  brand: string;
  categoryPath: string[];
  image: string;
  price: number;
  salePrice: number;
  effectivePrice: number;
  inStock: boolean;
  reviewScore: number;
  reviewCount: number;
  variantCount: number;
  /** Sibling variants of the same parent that also matched the query. */
  matchedVariants: { sku: string; variantTitle: string; price: number; image: string }[];
  /** Merchandiser-defined badges that apply to this variant. */
  badges?: { key: string; label: string; tone: string }[];
  /** Field -> highlighted snippet with <mark> around matched terms. */
  highlights?: Record<string, string>;
  explanation?: RankExplanation;
}

/** How a zero-result query was rescued, in the order the cascade tried. */
export type RescueStrategy =
  | 'none'
  | 'spell_correct'
  | 'relax_query'
  | 'semantic_only'
  /** A brand and a product type that are each real but empty in combination. */
  | 'drop_entity'
  | 'category_fallback';

export interface SearchResponse {
  hits: Hit[];
  page: number;
  hitsPerPage: number;
  totalHits: number;
  totalPages: number;
  /**
   * Set when deep pagination was capped: the true match count is `totalHits`,
   * but only this many can be paged to. Storefronts should stop offering page
   * links past `totalPages` and prompt the shopper to refine instead.
   */
  reachableHits?: number;
  processingTimeMs: number;
  query: string;
  /** What the engine actually searched for after analysis/rescue. */
  effectiveQuery: string;
  queryType: QueryType;
  facets: FacetResult[];
  appliedFilters: FacetFilters;
  sort: string;
  /** Present when `seo` was requested: what the page's <head> should say. */
  seo?: {
    canonical: string;
    robots: string;
    title: string;
    description: string;
    jsonLd: object;
  };
  rescue?: { strategy: RescueStrategy; didYouMean?: string; notice?: string };
  redirect?: { url: string; ruleId: string };
  banners?: Banner[];
  rulesApplied?: string[];
  parsedFilters?: ParsedConstraint[];
  /** True when this page was re-ordered for the shopper who asked for it. */
  personalised?: boolean;
}

export interface Banner {
  id: string;
  html?: string;
  image?: string;
  link?: string;
  position: 'top' | { inGrid: number };
}

export type QueryType = 'sku' | 'dimensional' | 'natural_language' | 'keyword' | 'empty' | 'entity';

/** A filter the query analyser inferred from the raw text. */
export interface ParsedConstraint {
  field: string;
  value: string | number;
  /** Original substring that produced it, for the "why" panel. */
  source: string;
  /**
   * `brand` and `category` are entities the query named — a brand the
   * catalogue carries, a product type the taxonomy has. `attribute` is a
   * product feature it named: a finish, a material, a style the catalogue
   * actually holds. All three are lifted out of the text and applied as
   * filters, so they are precise and the shopper can remove one.
   */
  kind: 'dimension' | 'attribute' | 'sku' | 'unit' | 'brand' | 'category';
}
