import type {
  FacetFilters,
  ParsedConstraint,
  RangeFilter,
  SearchableAttribute,
  VariantDoc,
} from '@compass/shared';

/**
 * The retrieval contract.
 *
 * Engines are responsible for recall, filtering and facet counting only. They
 * return a bounded candidate window; the tie-breaking cascade, business ranking
 * and merchandising rules all run above this interface so they behave
 * identically whether the core is Typesense or the local SQLite dev engine.
 */
export interface EngineQuery {
  site: string;
  /** Analysed terms. Empty for a pure browse request. */
  terms: string[];
  rawQuery: string;
  /** Exact part-number lookup; short-circuits scoring when it hits. */
  sku?: string;
  categoryId?: string;
  filters: FacetFilters;
  ranges: RangeFilter[];
  /** Dimension filters lifted out of the query text. */
  constraints: ParsedConstraint[];
  facets: string[];
  sort: string;
  /** How many candidates to re-rank. Bounded so re-ranking stays O(window). */
  candidateLimit: number;
  typo: { minWordLengthFor1Typo: number; minWordLengthFor2Typos: number };
  weights: SearchableAttribute[];
  /** Disable fuzzy expansion entirely (part numbers, dimension-only queries). */
  exactOnly: boolean;
  /** Skus excluded by a "hide" rule, filtered at retrieval time. */
  excludeSkus?: string[];
}

export interface EngineCandidate {
  doc: VariantDoc;
  /** Engine-native relevance, used only to select the candidate window. */
  retrievalScore: number;
  /** Per-term expansions the engine actually matched, for typo counting. */
  matchedTerms: { term: string; matched: string; distance: number; prefix: boolean }[];
}

export interface EngineFacet {
  field: string;
  values: { value: string | number; count: number }[];
  stats?: { min: number; max: number };
}

export interface EngineResult {
  candidates: EngineCandidate[];
  /** Distinct parents matching the full filter set, not just the window. */
  totalGroups: number;
  facets: EngineFacet[];
  tookMs: number;
}

export interface IndexHandle {
  /** Physical collection name; may be a shadow index mid-rebuild. */
  name: string;
  site: string;
}

export interface SearchEngine {
  readonly kind: 'typesense' | 'sqlite';
  /** Create a new physical index to write into. Never serves traffic yet. */
  createIndex(site: string): Promise<IndexHandle>;
  indexBatch(handle: IndexHandle, docs: VariantDoc[]): Promise<void>;
  /** Point the site's alias at a freshly built index, atomically. */
  promote(handle: IndexHandle): Promise<void>;
  /** Price/inventory-only updates against the live index. */
  partialUpdate(
    site: string,
    updates: { sku: string; price?: number; salePrice?: number; inventory?: number }[],
  ): Promise<number>;
  search(query: EngineQuery): Promise<EngineResult>;
  /** Indexed vocabulary, used for compound splitting and spell correction. */
  vocabulary(site: string): Promise<Set<string>>;
  documentCount(site: string): Promise<number>;
  close(): Promise<void>;
}

export const SORTABLE: Record<string, { column: string; direction: 'asc' | 'desc' }> = {
  best_selling: { column: 'sales_velocity', direction: 'desc' },
  newest: { column: 'date_added_ts', direction: 'desc' },
  price_asc: { column: 'effective_price', direction: 'asc' },
  price_desc: { column: 'effective_price', direction: 'desc' },
  top_rated: { column: 'review_score', direction: 'desc' },
  discount: { column: 'discount_pct', direction: 'desc' },
};

let indexCounter = 0;

/**
 * Unique physical index suffix. A timestamp alone is not enough: two rebuilds
 * inside the same millisecond would collide on the name and silently merge
 * into one index, so a monotonic counter is appended.
 */
export function nextIndexSuffix(): string {
  indexCounter = (indexCounter + 1) % 0xffff;
  return `${Date.now().toString(36)}${indexCounter.toString(36).padStart(3, '0')}`;
}
