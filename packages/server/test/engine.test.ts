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

  test('the finish facet shows only finishes that actually matched', async () => {
    const r = await service.search(site, { q: 'black shutter' });
    const finish = r.facets.find((f) => f.field === 'finish');
    assert.deepEqual(finish?.values.map((v) => v.value), ['Black']);
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

  test('sorting by price actually sorts by price', async () => {
    const r = await service.search(site, { q: '', categoryId: 'exterior', sort: 'price_asc' });
    const prices = r.hits.map((h) => h.effectivePrice);
    assert.deepEqual(prices, [...prices].sort((a, b) => a - b));
  });

  test('a query with no match returns empty rather than nonsense', async () => {
    const r = await service.search(site, { q: 'zzzqqxnothing' });
    assert.equal(r.totalHits, 0);
    assert.deepEqual(r.hits, []);
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
    assert.equal(r.totalHits, 0);
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
