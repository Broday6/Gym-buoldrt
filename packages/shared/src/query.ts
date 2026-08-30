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
  | 'category_fallback';

export interface SearchResponse {
  hits: Hit[];
  page: number;
  hitsPerPage: number;
  totalHits: number;
  totalPages: number;
  processingTimeMs: number;
  query: string;
  /** What the engine actually searched for after analysis/rescue. */
  effectiveQuery: string;
  queryType: QueryType;
  facets: FacetResult[];
  appliedFilters: FacetFilters;
  sort: string;
  rescue?: { strategy: RescueStrategy; didYouMean?: string; notice?: string };
  redirect?: { url: string; ruleId: string };
  banners?: Banner[];
  rulesApplied?: string[];
  parsedFilters?: ParsedConstraint[];
}

export interface Banner {
  id: string;
  html?: string;
  image?: string;
  link?: string;
  position: 'top' | { inGrid: number };
}

export type QueryType = 'sku' | 'dimensional' | 'natural_language' | 'keyword' | 'empty';

/** A filter the query analyser inferred from the raw text. */
export interface ParsedConstraint {
  field: string;
  value: string | number;
  /** Original substring that produced it, for the "why" panel. */
  source: string;
  kind: 'dimension' | 'attribute' | 'sku' | 'unit';
}
