import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { FacetConfig, SiteConfig, SortOption } from '@compass/shared';

/**
 * Site configuration. One deployment serves every brand; every index, rule,
 * synonym set and analytics view is scoped by site id.
 */

export const SORT_OPTIONS: SortOption[] = [
  { id: 'relevance', label: 'Relevance' },
  { id: 'best_selling', label: 'Best Selling' },
  { id: 'newest', label: 'Newest' },
  { id: 'price_asc', label: 'Price: Low to High' },
  { id: 'price_desc', label: 'Price: High to Low' },
  { id: 'top_rated', label: 'Top Rated' },
  { id: 'discount', label: '% Off' },
];

/** Ordered searchable attributes: title beats sku beats brand beats description. */
const DEFAULT_WEIGHTS = [
  { field: 'title', weight: 10 },
  { field: 'sku', weight: 9 },
  { field: 'mpn', weight: 9 },
  { field: 'brand', weight: 7 },
  { field: 'categoryPath', weight: 6 },
  { field: 'attributes', weight: 5 },
  { field: 'variantTitle', weight: 4 },
  { field: 'description', weight: 2 },
];

const DEFAULT_FACETS: FacetConfig[] = [
  { field: 'price', label: 'Price', displayType: 'slider', order: 1, collapsed: false, truncateAt: 0, sortBy: 'count' },
  { field: 'brand', label: 'Brand', displayType: 'checkbox', order: 2, collapsed: false, truncateAt: 8, sortBy: 'count' },
  { field: 'material', label: 'Material', displayType: 'checkbox', order: 3, collapsed: false, truncateAt: 8, sortBy: 'count' },
  { field: 'finish', label: 'Finish', displayType: 'swatch', order: 4, collapsed: false, truncateAt: 12, sortBy: 'count' },
  { field: 'color', label: 'Color', displayType: 'swatch', order: 5, collapsed: false, truncateAt: 12, sortBy: 'count' },
  { field: 'style', label: 'Style', displayType: 'checkbox', order: 6, collapsed: false, truncateAt: 8, sortBy: 'count' },
  { field: 'size', label: 'Size', displayType: 'checkbox', order: 7, collapsed: true, truncateAt: 10, sortBy: 'alpha' },
  { field: 'in_stock', label: 'Availability', displayType: 'checkbox', order: 8, collapsed: false, truncateAt: 2, sortBy: 'count' },
];

function site(id: string, name: string): SiteConfig {
  return {
    id,
    name,
    collection: id,
    searchableAttributes: DEFAULT_WEIGHTS,
    // Phase 1 ships keyword-only retrieval; the vector half lands in Phase 4.
    semanticWeight: 0,
    typoTolerance: { minWordLengthFor1Typo: 4, minWordLengthFor2Typos: 8 },
    business: {
      salesVelocity: 3,
      margin: 2,
      inventoryDepth: 1,
      recency: 1,
      reviewScore: 2,
      // Measured on this site, against these results, this week — the only
      // signal here that is not somebody's opinion, and the one that makes
      // ranking improve without anyone editing a rule. Weighted below sales
      // velocity on purpose: it re-orders comparable matches, it does not
      // decide relevance.
      ctr: 2,
    },
    defaultFacets: DEFAULT_FACETS,
    defaultSort: 'relevance',
    hitsPerPage: 24,
    currency: 'USD',
  };
}

const BUILT_IN: SiteConfig[] = [
  site('ekena', 'Ekena Millwork'),
  site('archdepot', 'Architectural Depot'),
];

const CONFIG_PATH = process.env.COMPASS_SITES_PATH ?? './data/sites.json';

export class SiteRegistry {
  private sites = new Map<string, SiteConfig>();

  constructor(configs: SiteConfig[] = BUILT_IN) {
    for (const c of configs) this.sites.set(c.id, c);
  }

  static load(path = CONFIG_PATH): SiteRegistry {
    if (!existsSync(path)) return new SiteRegistry();
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as SiteConfig[];
      // Merge over the built-ins so a partial file cannot drop a site.
      const merged = new Map(BUILT_IN.map((s) => [s.id, s]));
      for (const s of parsed) merged.set(s.id, { ...merged.get(s.id), ...s } as SiteConfig);
      return new SiteRegistry([...merged.values()]);
    } catch {
      return new SiteRegistry();
    }
  }

  save(path = CONFIG_PATH): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...this.sites.values()], null, 2));
  }

  get(id: string): SiteConfig | undefined {
    return this.sites.get(id);
  }

  require(id: string): SiteConfig {
    const s = this.sites.get(id);
    if (!s) throw new SiteNotFoundError(id);
    return s;
  }

  list(): SiteConfig[] {
    return [...this.sites.values()];
  }

  upsert(config: SiteConfig): void {
    this.sites.set(config.id, config);
  }
}

export class SiteNotFoundError extends Error {
  constructor(public readonly siteId: string) {
    super(`Unknown site "${siteId}"`);
    this.name = 'SiteNotFoundError';
  }
}
