import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '@compass/shared';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { SearchService } from '../src/services/search.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';

const site = new SiteRegistry().require('ekena');

/** A shutter parent with seven finishes: the case that motivated variant-level indexing. */
function shutter(): Product {
  const finishes = ['Black', 'White', 'Bronze', 'Hunter Green', 'Colonial Red', 'Sage', 'Charcoal'];
  return {
    parentId: 'SH-100',
    title: 'Board and Batten Shutter',
    description: 'Cellular PVC exterior shutter that will not rot, warp or attract insects.',
    brand: 'Ekena Millwork',
    categoryPath: ['Exterior', 'Shutters'],
    categoryIds: ['exterior', 'exterior/shutters'],
    salesVelocity: 200, margin: 40, reviewScore: 4.5, reviewCount: 30,
    dateAdded: '2025-01-01',
    variants: finishes.map((finish, i) => ({
      sku: `SH-${finish.slice(0, 2).toUpperCase()}-${i}`,
      parentId: 'SH-100',
      variantTitle: finish,
      price: 199 + i,
      inventory: 10,
      image: `https://x/${finish}.jpg`,
      attributes: { finish, material: 'PVC', width: '14 in', width_in: 14, height_in: 39 },
    })),
  };
}

function beam(): Product {
  return {
    parentId: 'BM-200',
    title: 'Endurathane Faux Wood Ceiling Beam',
    description: 'Lightweight faux beam that installs with construction adhesive.',
    brand: 'Ekena Millwork',
    categoryPath: ['Millwork', 'Beams'],
    categoryIds: ['millwork', 'millwork/beams'],
    salesVelocity: 500, margin: 55, reviewScore: 4.8, reviewCount: 80,
    dateAdded: '2025-06-01',
    variants: [
      { sku: 'BMV4X6X120WA', parentId: 'BM-200', variantTitle: 'Walnut / 10 ft', price: 399,
        inventory: 5, attributes: { finish: 'Walnut', width_in: 4, height_in: 6, length_in: 120 } },
      { sku: 'BMV4X6X144WA', parentId: 'BM-200', variantTitle: 'Walnut / 12 ft', price: 459,
        inventory: 5, attributes: { finish: 'Walnut', width_in: 4, height_in: 6, length_in: 144 } },
      { sku: 'BMV6X8X144ES', parentId: 'BM-200', variantTitle: 'Espresso / 12 ft', price: 629,
        inventory: 0, attributes: { finish: 'Espresso', width_in: 6, height_in: 8, length_in: 144 } },
    ],
  };
}

let engine: SqliteEngine;
let service: SearchService;

before(async () => {
  engine = new SqliteEngine(':memory:');
  service = new SearchService(engine);
  await indexProducts(engine, 'ekena', [shutter(), beam()]);
});

after(async () => {
  await engine.close();
});

describe('variant-level indexing with parent grouping', () => {
  test('acceptance: "black shutter" returns the black variant, not the whole variant set', async () => {
    const r = await service.search(site, { q: 'black shutter' });
    assert.equal(r.totalHits, 1, 'one product card, not seven');
    const hit = r.hits[0]!;
    assert.equal(hit.parentId, 'SH-100');
    assert.equal(hit.variantTitle, 'Black', 'the representative is the variant that matched');
    assert.equal(hit.matchedVariants.length, 0, 'no non-black siblings ride along');
    assert.equal(hit.variantCount, 7, 'the card still knows the parent has seven options');
  });

  test('a finish named in the query behaves exactly like clicking that facet', async () => {
    // "black" is a finish the catalogue holds, so it is lifted out of the text
    // and applied as a filter rather than searched as a word. That makes
    // typing "black shutter" and searching "shutter" then clicking Black the
    // same operation — including the facet panel still offering the other
    // finishes, which is what lets a shopper change their mind without
    // retyping.
    const typed = await service.search(site, { q: 'black shutter' });
    const clicked = await service.search(site, { q: 'shutter', filters: { finish: ['Black'] } });

    const finish = typed.facets.find((f) => f.field === 'finish');
    assert.ok(finish?.values.find((v) => v.value === 'Black')?.selected, 'Black is selected');
    assert.ok(finish!.values.length > 1, 'the other finishes are still offered');
    assert.deepEqual(
      finish?.values.map((v) => v.value),
      clicked.facets.find((f) => f.field === 'finish')?.values.map((v) => v.value),
    );

    // And what it narrows is real: the results are black.
    assert.deepEqual(typed.appliedFilters.finish, ['Black']);
    assert.equal(typed.hits[0]?.variantTitle, 'Black');
  });

  test('an unqualified query returns the product once, with siblings attached', async () => {
    const r = await service.search(site, { q: 'shutter' });
    assert.equal(r.totalHits, 1);
    assert.ok(r.hits[0]!.matchedVariants.length > 0, 'all seven finishes matched, so siblings ride along');
  });
});

describe('search behaviour end to end', () => {
  test('acceptance: a part number returns that exact product first', async () => {
    const r = await service.search(site, { q: 'BMV4X6X144WA' });
    assert.equal(r.queryType, 'sku');
    assert.equal(r.hits[0]?.sku, 'BMV4X6X144WA');
    assert.equal(r.totalHits, 1);
  });

  test('acceptance: typo tolerance finds the product anyway', async () => {
    const r = await service.search(site, { q: 'shuttar' });
    assert.equal(r.hits[0]?.parentId, 'SH-100');
  });

  test('acceptance: "4x6 beam 12ft" filters to the matching variant', async () => {
    const r = await service.search(site, { q: '4x6 beam 12ft' });
    assert.equal(r.queryType, 'dimensional');
    assert.equal(r.totalHits, 1);
    assert.equal(r.hits[0]?.sku, 'BMV4X6X144WA', 'the 10ft and 6x8 variants are filtered out');
  });

  test('browse serves a category through the same pipeline', async () => {
    const r = await service.browse(site, { categoryId: 'exterior/shutters' });
    assert.equal(r.totalHits, 1);
    assert.equal(r.hits[0]?.parentId, 'SH-100');
  });

  test('browse respects an explicit sort and only defaults when none is given', async () => {
    const explicit = await service.browse(site, { categoryId: 'exterior/shutters', sort: 'price_asc' });
    assert.equal(explicit.sort, 'price_asc');
    const defaulted = await service.browse(site, { categoryId: 'exterior/shutters' });
    assert.equal(defaulted.sort, 'best_selling', 'relevance is meaningless with no query');
  });

  test('facet counts are parent counts and never zero', async () => {
    const r = await service.search(site, { q: '' , categoryId: 'millwork' });
    for (const facet of r.facets) {
      for (const value of facet.values) {
        assert.ok(value.count > 0, `${facet.field}=${value.value} must not be offered with zero results`);
      }
    }
  });

  test('a facet selection narrows results and stays consistent', async () => {
    const before = await service.search(site, { q: 'shutter' });
    const after = await service.search(site, { q: 'shutter', filters: { finish: ['Black'] } });
    assert.equal(before.totalHits, 1);
    assert.equal(after.totalHits, 1);
    assert.equal(after.hits[0]?.variantTitle, 'Black');
    const finish = after.facets.find((f) => f.field === 'finish');
    assert.ok(finish!.values.length > 1, 'a group excludes its own selection from its counts, so siblings stay clickable');
    assert.ok(finish!.values.find((v) => v.value === 'Black')?.selected);
  });

  test('sorting by price actually sorts by price, on browse and on search', async () => {
    for (const request of [
      { categoryId: 'exterior', sort: 'price_asc' },
      { q: 'shutter', sort: 'price_asc' },
      { q: 'shutter', sort: 'price_desc' },
    ]) {
      const r = await service.search(site, request);
      const prices = r.hits.map((h) => h.effectivePrice);
      const expected = request.sort === 'price_desc'
        ? [...prices].sort((a, b) => b - a)
        : [...prices].sort((a, b) => a - b);
      // An explicit sort must survive the relevance cascade, which would
      // otherwise reorder the candidate window it was applied to.
      assert.deepEqual(prices, expected, `sort ${request.sort} on ${JSON.stringify(request)}`);
    }
  });

  test('an explicit sort survives grouping across many variants', async () => {
    const r = await service.search(site, { q: 'shutter', sort: 'price_asc', hitsPerPage: 50 });
    const prices = r.hits.map((h) => h.effectivePrice);
    assert.ok(prices.length > 0);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });

  test('a query with no match is rescued rather than dead-ending', async () => {
    const r = await service.search(site, { q: 'zzzqqxnothing' });
    // A zero-results page is a conversion emergency: the cascade must always
    // leave the shopper something to click.
    assert.ok(r.rescue, 'the rescue path must be reported');
    assert.ok(r.totalHits > 0, 'the shopper is never shown an empty page');
    assert.ok(r.rescue!.notice, 'and must be told what happened');
  });
});

describe('pagination', () => {
  /**
   * A catalogue whose products carry many variants each — the case that broke
   * paging when the candidate window was measured in variants rather than in
   * products.
   */
  async function wideCatalogue() {
    const local = new SqliteEngine(':memory:');
    const products: Product[] = [];
    for (let p = 0; p < 60; p++) {
      products.push({
        parentId: `W-${p}`,
        title: `Wide Product ${p} Shutter`,
        description: 'A product with a deep variant matrix.',
        brand: 'Ekena Millwork',
        categoryPath: ['Exterior', 'Shutters'],
        categoryIds: ['exterior', 'exterior/shutters'],
        salesVelocity: 1000 - p,
        variants: Array.from({ length: 8 }, (_, v) => ({
          sku: `W-${p}-${v}`,
          parentId: `W-${p}`,
          variantTitle: `Finish ${v}`,
          price: 100 + p + v,
          inventory: 5,
          attributes: { finish: `Finish ${v}`, material: 'PVC' },
        })),
      });
    }
    await indexProducts(local, 'ekena', products);
    return { local, service: new SearchService(local) };
  }

  test('every page is full, and the last page holds the remainder', async () => {
    const { local, service: svc } = await wideCatalogue();
    const first = await svc.search(site, { q: 'shutter', hitsPerPage: 24, page: 1 });
    assert.equal(first.totalHits, 60, '60 products, not 480 variants');
    assert.equal(first.hits.length, 24, 'a full page, despite eight variants per product');
    assert.equal(first.totalPages, 3);
    const last = await svc.search(site, { q: 'shutter', hitsPerPage: 24, page: 3 });
    assert.equal(last.hits.length, 12);
    await local.close();
  });

  test('paging through returns every product exactly once', async () => {
    const { local, service: svc } = await wideCatalogue();
    const seen: string[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await svc.search(site, { q: 'shutter', hitsPerPage: 24, page });
      seen.push(...r.hits.map((h) => h.parentId));
    }
    // Ordering must be a property of the query alone. A window that grew with
    // the page re-ranked differently each time, so products appeared twice and
    // others never appeared at all.
    assert.equal(seen.length, 60);
    assert.equal(new Set(seen).size, 60, 'no duplicates across pages');
    await local.close();
  });

  test('beyond the last page returns nothing, and totalPages says so', async () => {
    const { local, service: svc } = await wideCatalogue();
    const r = await svc.search(site, { q: 'shutter', hitsPerPage: 24, page: 9 });
    assert.equal(r.hits.length, 0);
    assert.equal(r.totalPages, 3);
    await local.close();
  });

  test('deep pagination is capped, and the cap is reported', async () => {
    const { local } = await wideCatalogue();
    const capped = new SearchService(local, { rankingWindow: 30 });
    const r = await capped.search(site, { q: 'shutter', hitsPerPage: 24, page: 1 });
    assert.equal(r.totalHits, 60, 'the true count is still reported');
    assert.equal(r.totalPages, 2, 'but only the reachable window can be paged');
    assert.equal(r.reachableHits, 30);
    await local.close();
  });
});

describe('index lifecycle', () => {
  test('a rebuild swaps atomically and the old documents go away', async () => {
    const local = new SqliteEngine(':memory:');
    const svc = new SearchService(local);
    await indexProducts(local, 'ekena', [shutter(), beam()]);
    assert.equal(await local.documentCount('ekena'), 10);

    await indexProducts(local, 'ekena', [beam()]);
    assert.equal(await local.documentCount('ekena'), 3, 'the replaced index is dropped, not merged');
    const r = await svc.search(site, { q: 'shutter' });
    assert.ok(
      r.hits.every((h) => h.parentId !== 'SH-100'),
      'the shutter is gone from the index; anything returned is a rescue fallback',
    );
    await local.close();
  });

  test('a partial update changes price and stock without a reindex', async () => {
    const local = new SqliteEngine(':memory:');
    const svc = new SearchService(local);
    await indexProducts(local, 'ekena', [beam()]);

    const changed = await local.partialUpdate('ekena', [
      { sku: 'BMV4X6X120WA', price: 111, inventory: 0 },
    ]);
    assert.equal(changed, 1);

    const r = await svc.search(site, { q: 'BMV4X6X120WA' });
    assert.equal(r.hits[0]?.effectivePrice, 111);
    assert.equal(r.hits[0]?.inStock, false);
    await local.close();
  });
});
