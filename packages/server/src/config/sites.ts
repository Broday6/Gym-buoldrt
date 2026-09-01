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
    // Copied, not shared. Every site held the same array object, so a facet
    // added for one would have appeared on the other — which nothing did
    // until facets became something the ingest can add.
    defaultFacets: DEFAULT_FACETS.map((f) => ({ ...f })),
    defaultSort: 'relevance',
    hitsPerPage: 24,
    currency: 'USD',
  };
}

const BUILT_IN: SiteConfig[] = [
  site('ekena', 'Ekena Millwork'),
  site('archdepot', 'Architectural Depot'),
];

/** `vent_type` -> `Vent Type`. */
function titleCase(key: string): string {
  return key.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

const CONFIG_PATH = process.env.COMPASS_SITES_PATH ?? './data/sites.json';

export class SiteRegistry {
  private sites = new Map<string, SiteConfig>();

  constructor(configs: SiteConfig[] = BUILT_IN) {
    for (const c of configs) {
      // The facet rail is the one part of a site config this process mutates,
      // and the built-in configs are module state shared by every registry
      // ever constructed. Without this copy, adopting a filter for one site
      // would leak into the next registry built — including, in the tests,
      // the one that expects a clean slate.
      this.sites.set(c.id, { ...c, defaultFacets: c.defaultFacets.map((f) => ({ ...f })) });
    }
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

  /**
   * Offer attributes the ingest found as filters.
   *
   * A facet rail is configuration: it lists the fields a merchandiser decided
   * shoppers care about, and both the rail and the query analyser read it —
   * which is why an attribute recovered from a product description was, until
   * now, only half recovered. The value reached the index and could be
   * searched as text, but nothing offered it as a filter and typing
   * "brickmould gable vent" narrowed nothing, because `brickmould` was not a
   * word the analyser had ever been told was a frame.
   *
   * The ingest already decides which attributes are facet-worthy — a finish, a
   * material, a frame, not a carton weight — so that judgement is published
   * here rather than left stranded. Added at the end of the rail and plainly
   * labelled, so a merchandiser sees a new filter appear and can remove it;
   * proposing rather than deciding is how everything else in this system
   * treats an automatic change.
   *
   * Existing facets are never touched: a merchandiser's label, order and
   * display type outrank anything inferred.
   */
  adoptFacets(siteId: string, keys: string[]): FacetConfig[] {
    const site = this.sites.get(siteId);
    if (!site) return [];
    const known = new Set(site.defaultFacets.map((f) => f.field));
    let order = Math.max(0, ...site.defaultFacets.map((f) => f.order));
    const added: FacetConfig[] = [];
    for (const key of keys) {
      if (known.has(key)) continue;
      known.add(key);
      added.push({
        field: key,
        label: titleCase(key),
        displayType: 'checkbox',
        order: ++order,
        // Collapsed, because a rail that grows itself should not push the
        // filters somebody chose off the screen.
        collapsed: true,
        truncateAt: 8,
        sortBy: 'count',
      });
    }
    if (added.length) site.defaultFacets = [...site.defaultFacets, ...added];
    return added;
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
