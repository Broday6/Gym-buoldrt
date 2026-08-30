/** Per-site configuration. Every index, rule and analytics view is site-scoped. */

export interface SearchableAttribute {
  field: string;
  /** Higher wins the tie-breaking cascade. Ordered, not additive. */
  weight: number;
}

export interface FacetConfig {
  field: string;
  label: string;
  displayType: 'checkbox' | 'slider' | 'swatch' | 'grid';
  order: number;
  collapsed: boolean;
  /** Show this many values before "Show more". */
  truncateAt: number;
  sortBy: 'count' | 'alpha' | 'custom';
  customOrder?: string[];
}

export interface BusinessWeights {
  salesVelocity: number;
  margin: number;
  inventoryDepth: number;
  recency: number;
  reviewScore: number;
  ctr: number;
}

export interface SiteConfig {
  id: string;
  name: string;
  /** Retrieval collection/alias name. */
  collection: string;
  searchableAttributes: SearchableAttribute[];
  /** 0 = pure keyword, 1 = pure vector. Phase 4 wires the vector side. */
  semanticWeight: number;
  typoTolerance: { minWordLengthFor1Typo: number; minWordLengthFor2Typos: number };
  business: BusinessWeights;
  defaultFacets: FacetConfig[];
  defaultSort: string;
  hitsPerPage: number;
  currency: string;
}

export interface SortOption {
  id: string;
  label: string;
  field?: string;
  direction?: 'asc' | 'desc';
}
