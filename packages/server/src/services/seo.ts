/**
 * SEO directives for a result page.
 *
 * §4.11 asks for canonical tags on filtered URLs, `noindex` on facet
 * permutations, and a crawlable fallback. All three exist because a faceted
 * catalogue generates a combinatorial number of URLs that are all the same
 * products in a different order — left alone, a crawler spends its budget on
 * `?material=PVC&finish=Black&sort=price_asc&page=7` and never reaches the
 * collection page that was supposed to rank.
 *
 * The rules, and why each one:
 *
 *   - **Internal search results are never indexed.** `noindex, follow`. This is
 *     search-engine guidance, not a preference: a results page for an arbitrary
 *     query is thin content generated on demand.
 *   - **A category or collection with no filters is the canonical page.** It is
 *     the landing page the merchandiser built.
 *   - **One value from one allow-listed facet stays indexable**, self-canonical.
 *     "Black shutters" is a real thing people search for and a page worth
 *     ranking. Two filters is already a permutation.
 *   - **Anything else canonicalises to the unfiltered page** and is
 *     `noindex, follow` — followed, so the crawler still reaches the products.
 *   - **Sort is never part of a canonical URL.** Re-ordering the same products
 *     does not make a different page.
 *   - **Page 2 and beyond are self-canonical and indexable.** Canonicalising
 *     them to page 1 hides everything past the first page from the index.
 */
import type { SearchRequest, SearchResponse } from '@compass/shared';

export interface SeoConfig {
  /** Absolute origin of the storefront, e.g. https://www.ekenamillwork.com */
  baseUrl: string;
  /** Facets whose single-value pages are worth ranking. */
  indexableFacets: string[];
  /** URL shape for a category or collection landing page. */
  path: (kind: 'category' | 'collection' | 'search', id: string) => string;
}

export interface SeoDirectives {
  canonical: string;
  robots: string;
  title: string;
  description: string;
  /** schema.org ItemList, ready to drop into a script tag. */
  jsonLd: object;
}

const DEFAULT_PATH: SeoConfig['path'] = (kind, id) =>
  kind === 'search' ? '/search' : `/${kind === 'collection' ? 'collections' : 'c'}/${id}`;

export function seoConfigFor(siteId: string): SeoConfig {
  const env = (suffix: string) =>
    process.env[`COMPASS_SEO_${siteId.toUpperCase()}_${suffix}`] ?? process.env[`COMPASS_SEO_${suffix}`];
  return {
    baseUrl: env('BASE_URL') ?? '',
    indexableFacets: (env('INDEXABLE_FACETS') ?? 'material,finish,style,color').split(',')
      .map((f) => f.trim()).filter(Boolean),
    path: DEFAULT_PATH,
  };
}

/** Selected filters, flattened, so "one value from one facet" is countable. */
function selections(request: SearchRequest): { field: string; value: string }[] {
  const out: { field: string; value: string }[] = [];
  for (const [field, values] of Object.entries(request.filters ?? {})) {
    for (const value of values ?? []) out.push({ field, value: String(value) });
  }
  for (const [field, values] of Object.entries(request.labelFilters ?? {})) {
    for (const value of values ?? []) out.push({ field, value: String(value) });
  }
  for (const range of request.ranges ?? []) out.push({ field: range.field, value: 'range' });
  return out;
}

const titleCase = (value: string) =>
  value.replace(/[-_/]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function seoDirectives(
  request: SearchRequest,
  response: SearchResponse,
  config: SeoConfig,
  siteName: string,
): SeoDirectives {
  const chosen = selections(request);
  const kind: 'category' | 'collection' | 'search' =
    request.collection ? 'collection' : request.categoryId ? 'category' : 'search';
  const id = request.collection ?? request.categoryId ?? '';

  const base = `${config.baseUrl}${config.path(kind, id)}`;
  const params = new URLSearchParams();

  // A page of internal search results is thin content by construction.
  let indexable = kind !== 'search';

  if (chosen.length === 1 && config.indexableFacets.includes(chosen[0]!.field)) {
    // One value from one allow-listed facet: a page worth ranking, on its own URL.
    params.set(chosen[0]!.field, chosen[0]!.value);
  } else if (chosen.length > 0) {
    // A permutation. Still crawled — `follow` — so products stay reachable.
    indexable = false;
  }
  if ((request.page ?? 1) > 1) params.set('page', String(request.page));
  // Sort re-orders the same products; it never makes a different page.

  const query = params.toString();
  const canonical = query ? `${base}?${query}` : base;

  const subject = kind === 'search'
    ? `“${request.q ?? ''}”`
    : titleCase(id.split('/').pop() ?? id);
  const filterSuffix = chosen.length === 1 ? `${titleCase(chosen[0]!.value)} ` : '';
  const pageSuffix = (request.page ?? 1) > 1 ? ` — Page ${request.page}` : '';

  return {
    canonical,
    // `follow` throughout: a page we do not want in the index is still a path
    // to products we do.
    robots: indexable ? 'index, follow' : 'noindex, follow',
    title: kind === 'search'
      ? `Search results for ${subject} | ${siteName}`
      : `${filterSuffix}${subject}${pageSuffix} | ${siteName}`,
    description: kind === 'search'
      ? `${response.totalHits.toLocaleString()} results for ${subject} at ${siteName}.`
      : `Browse ${response.totalHits.toLocaleString()} ${filterSuffix}${subject.toLowerCase()} ` +
        `products at ${siteName}.`,
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'ItemList',
      name: subject,
      numberOfItems: response.totalHits,
      itemListElement: response.hits.slice(0, 20).map((hit, i) => ({
        '@type': 'ListItem',
        position: ((request.page ?? 1) - 1) * (request.hitsPerPage ?? 24) + i + 1,
        item: {
          '@type': 'Product',
          name: hit.title,
          sku: hit.sku,
          ...(hit.brand ? { brand: { '@type': 'Brand', name: hit.brand } } : {}),
          ...(hit.image ? { image: hit.image } : {}),
          offers: {
            '@type': 'Offer',
            price: hit.effectivePrice,
            priceCurrency: 'USD',
            availability: hit.inStock
              ? 'https://schema.org/InStock'
              : 'https://schema.org/OutOfStock',
          },
        },
      })),
    },
  };
}

/**
 * A sitemap of the pages worth ranking.
 *
 * Only the landing pages: categories and enabled collections. Filter
 * permutations are deliberately absent — a sitemap listing them would ask a
 * crawler to spend its budget on exactly the URLs the rules above tell it to
 * ignore.
 */
export function sitemapXml(
  entries: { kind: 'category' | 'collection'; id: string; products: number }[],
  config: SeoConfig,
): string {
  const urls = entries
    .filter((e) => e.products > 0)
    .map((e) => {
      // Depth is a reasonable proxy for importance: a top-level category is a
      // more valuable landing page than a fourth-level one.
      const depth = e.id.split('/').length;
      const priority = e.kind === 'collection' ? 0.8 : Math.max(0.3, 1 - (depth - 1) * 0.2);
      return `  <url>\n    <loc>${escapeXml(`${config.baseUrl}${config.path(e.kind, e.id)}`)}</loc>\n` +
        `    <changefreq>daily</changefreq>\n    <priority>${priority.toFixed(1)}</priority>\n  </url>`;
    });
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
}
