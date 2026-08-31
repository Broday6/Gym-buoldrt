import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { SearchRequest, SearchResponse } from '@compass/shared';
import { seoDirectives, sitemapXml, type SeoConfig } from '../src/services/seo.js';

/**
 * A faceted catalogue generates a combinatorial number of URLs that are the
 * same products in a different order. These tests pin the rules that stop a
 * crawler spending its budget on them.
 */
const config: SeoConfig = {
  baseUrl: 'https://www.ekenamillwork.com',
  indexableFacets: ['material', 'finish'],
  path: (kind, id) => (kind === 'search' ? '/search' : `/${kind === 'collection' ? 'collections' : 'c'}/${id}`),
};

const response = (overrides: Partial<SearchResponse> = {}): SearchResponse => ({
  hits: [{
    sku: 'SH-1', parentId: 'P1', title: 'Board and Batten Shutter', brand: 'Ekena Millwork',
    categoryPath: [], effectivePrice: 145.29, price: 145.29, inStock: true,
  }] as SearchResponse['hits'],
  page: 1, hitsPerPage: 24, totalHits: 63, totalPages: 3, processingTimeMs: 1,
  query: '', effectiveQuery: '', queryType: 'browse', facets: [], appliedFilters: {},
  sort: 'best_selling', ...overrides,
});

const directives = (request: SearchRequest, r = response()) =>
  seoDirectives(request, r, config, 'Ekena Millwork');

describe('canonical and robots', () => {
  test('a category landing page is indexable and canonical to itself', () => {
    const d = directives({ categoryId: 'exterior/shutters' });
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters');
    assert.equal(d.robots, 'index, follow');
  });

  test('internal search results are never indexed', () => {
    // Thin content by construction: generated on demand for an arbitrary query.
    const d = directives({ q: 'black shutter' });
    assert.equal(d.robots, 'noindex, follow');
    assert.match(d.title, /Search results for/);
  });

  test('one value from an allow-listed facet stays a page worth ranking', () => {
    const d = directives({ categoryId: 'exterior/shutters', filters: { material: ['PVC'] } });
    assert.equal(d.robots, 'index, follow');
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters?material=PVC');
  });

  test('two filters is a permutation: noindex, canonical to the clean page', () => {
    const d = directives({
      categoryId: 'exterior/shutters',
      filters: { material: ['PVC'], finish: ['Black'] },
    });
    assert.equal(d.robots, 'noindex, follow');
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters');
  });

  test('a facet that is not allow-listed is a permutation however few are set', () => {
    const d = directives({ categoryId: 'exterior/shutters', filters: { brand: ['Ekena'] } });
    assert.equal(d.robots, 'noindex, follow');
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters');
  });

  test('a price range is a permutation, not a landing page', () => {
    const d = directives({
      categoryId: 'exterior/shutters', ranges: [{ field: 'price', min: 100, max: 300 }],
    });
    assert.equal(d.robots, 'noindex, follow');
  });

  test('sort never appears in a canonical URL', () => {
    // Re-ordering the same products does not make a different page.
    const d = directives({ categoryId: 'exterior/shutters', sort: 'price_asc' });
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters');
  });

  test('page two is self-canonical, not folded into page one', () => {
    // Canonicalising deep pages to page 1 hides every product past the first
    // page from the index.
    const d = directives({ categoryId: 'exterior/shutters', page: 2 });
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/c/exterior/shutters?page=2');
    assert.equal(d.robots, 'index, follow');
    assert.match(d.title, /Page 2/);
  });

  test('a filtered page keeps both the filter and the page', () => {
    const d = directives({
      categoryId: 'exterior/shutters', filters: { material: ['PVC'] }, page: 3,
    });
    assert.equal(d.canonical,
      'https://www.ekenamillwork.com/c/exterior/shutters?material=PVC&page=3');
  });

  test('a custom-attribute filter is treated like any other facet', () => {
    const d = directives({ collection: 'dark-finishes', labelFilters: { room: ['Kitchen'] } });
    assert.equal(d.robots, 'noindex, follow');
    assert.equal(d.canonical, 'https://www.ekenamillwork.com/collections/dark-finishes');
  });

  test('a non-indexable page is still followed', () => {
    // The page is not worth indexing; the products it links to are.
    for (const request of [
      { q: 'beam' },
      { categoryId: 'x', filters: { material: ['PVC'], finish: ['Black'] } },
    ] as SearchRequest[]) {
      assert.match(directives(request).robots, /follow/);
      assert.doesNotMatch(directives(request).robots, /nofollow/);
    }
  });
});

describe('structured data', () => {
  test('products are listed with price and availability', () => {
    const d = directives({ categoryId: 'exterior/shutters' });
    const list = d.jsonLd as { itemListElement: { position: number; item: Record<string, unknown> }[] };
    assert.equal(list.itemListElement[0]!.position, 1);
    const item = list.itemListElement[0]!.item as { offers: { price: number; availability: string } };
    assert.equal(item.offers.price, 145.29);
    assert.match(item.offers.availability, /InStock/);
  });

  test('positions continue across pages rather than restarting', () => {
    const d = directives({ categoryId: 'x', page: 3, hitsPerPage: 24 });
    const list = d.jsonLd as { itemListElement: { position: number }[] };
    assert.equal(list.itemListElement[0]!.position, 49);
  });

  test('out of stock is stated, not omitted', () => {
    const r = response();
    r.hits[0]!.inStock = false;
    const list = directives({ categoryId: 'x' }, r).jsonLd as
      { itemListElement: { item: { offers: { availability: string } } }[] };
    assert.match(list.itemListElement[0]!.item.offers.availability, /OutOfStock/);
  });
});

describe('sitemap', () => {
  const entries = [
    { kind: 'category' as const, id: 'exterior', products: 200 },
    { kind: 'category' as const, id: 'exterior/shutters', products: 63 },
    { kind: 'category' as const, id: 'exterior/empty', products: 0 },
    { kind: 'collection' as const, id: 'dark-finishes', products: 12 },
  ];

  test('lists landing pages and nothing else', () => {
    const xml = sitemapXml(entries, config);
    assert.match(xml, /<loc>https:\/\/www\.ekenamillwork\.com\/c\/exterior<\/loc>/);
    assert.match(xml, /<loc>https:\/\/www\.ekenamillwork\.com\/collections\/dark-finishes<\/loc>/);
    // Listing filter permutations would ask a crawler to spend its budget on
    // exactly the URLs the canonical rules tell it to ignore.
    const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]!);
    assert.equal(locs.length, 3);
    assert.ok(locs.every((loc) => !loc.includes('?')), locs.join(' '));
  });

  test('an empty category is not offered as a page', () => {
    assert.doesNotMatch(sitemapXml(entries, config), /exterior\/empty/);
  });

  test('a top-level category outranks a nested one', () => {
    const xml = sitemapXml(entries, config);
    const priorities = [...xml.matchAll(/<priority>([\d.]+)<\/priority>/g)].map((m) => Number(m[1]));
    assert.ok(priorities[0]! > priorities[1]!, `${priorities[0]} vs ${priorities[1]}`);
  });

  test('URLs are escaped, so a slug with an ampersand cannot break the document', () => {
    const xml = sitemapXml([{ kind: 'collection', id: 'sale&clearance', products: 1 }], config);
    assert.match(xml, /sale&amp;clearance/);
    assert.doesNotMatch(xml, /sale&clearance/);
  });
});
