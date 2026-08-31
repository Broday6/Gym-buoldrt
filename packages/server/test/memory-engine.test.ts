import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '@compass/shared';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { MemoryEngine } from '../src/engine/memory.js';
import { SearchService } from '../src/services/search.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';
import { applyLabels, EMPTY_LABEL_PLAN } from '../src/merchandising/labels.js';
import { toVariantDocs } from '../src/ingest/normalize.js';

const site = new SiteRegistry().require('ekena');

/**
 * The browser engine exists so a demo can run the real pipeline rather than a
 * drawing of it. That claim is only worth making if the two engines agree, so
 * this indexes one catalogue into both and compares what comes out.
 *
 * Retrieval scores are not compared: SQLite ranks the candidate window with
 * BM25 and the memory engine with a simpler weighted match. What must agree is
 * everything a shopper can see — which products match, how many, the facet
 * counts, and which product the ranking cascade puts first.
 */

const FINISHES = ['Black', 'White', 'Bronze', 'Hunter Green', 'Sage'];
const MATERIALS = ['PVC', 'Western Red Cedar', 'Composite'];

function catalogue(): Product[] {
  const products: Product[] = [];
  for (let p = 0; p < 40; p++) {
    const material = MATERIALS[p % MATERIALS.length]!;
    const exterior = p % 2 === 0;
    products.push({
      parentId: `P-${p}`,
      title: exterior ? `Board and Batten Shutter ${12 + p}"W` : `Crown Moulding Profile ${p}`,
      description: exterior
        ? 'Cellular exterior shutter that will not rot, warp or attract insects.'
        : 'Interior crown moulding, primed and ready to finish.',
      brand: p % 5 === 0 ? 'Timberthane' : 'Ekena Millwork',
      categoryPath: exterior ? ['Exterior', 'Shutters'] : ['Interior', 'Moulding'],
      categoryIds: exterior ? ['exterior', 'exterior/shutters'] : ['interior', 'interior/moulding'],
      salesVelocity: 500 - p * 7,
      margin: 30 + (p % 40),
      reviewScore: 3 + (p % 20) / 10,
      reviewCount: p * 3,
      dateAdded: `2025-0${1 + (p % 9)}-01`,
      variants: FINISHES.slice(0, 2 + (p % 4)).map((finish, i) => ({
        sku: `P${p}-${finish.slice(0, 2).toUpperCase()}-${i}`,
        parentId: `P-${p}`,
        variantTitle: `${finish} / ${material}`,
        price: 80 + p * 9 + i * 13,
        salePrice: p % 4 === 0 ? 60 + p * 8 : undefined,
        inventory: (p + i) % 7,
        image: `https://x/${p}-${i}.jpg`,
        attributes: {
          finish, material,
          width_in: 12 + p, height_in: 39 + (p % 5) * 12,
        },
      })),
    });
  }
  return products;
}

async function bothEngines() {
  const products = catalogue();
  const sqlite = new SqliteEngine(':memory:');
  await indexProducts(sqlite, 'ekena', products);

  // The browser engine is handed the documents a real ingest produced — the
  // same function the server path uses, so nothing diverges in normalisation.
  const memory = new MemoryEngine();
  const { products: labelled } = applyLabels(products, EMPTY_LABEL_PLAN);
  memory.load('ekena', toVariantDocs('ekena', labelled));

  return {
    sqlite: new SearchService(sqlite),
    memory: new SearchService(memory),
    close: () => sqlite.close(),
  };
}

const QUERIES = [
  { label: 'a plain keyword', request: { q: 'shutter' } },
  { label: 'two words', request: { q: 'board batten' } },
  { label: 'a misspelling', request: { q: 'shuter' } },
  { label: 'a brand', request: { q: 'timberthane' } },
  { label: 'a finish plus a noun', request: { q: 'black shutter' } },
  { label: 'a facet filter', request: { q: 'shutter', filters: { material: ['PVC'] } } },
  { label: 'two facet groups', request: { q: '', filters: { material: ['PVC'], finish: ['Black'] } } },
  { label: 'a category browse', request: { categoryId: 'exterior/shutters' } },
  { label: 'a price sort', request: { categoryId: 'exterior/shutters', sort: 'price_asc' } },
  { label: 'best selling', request: { categoryId: 'interior/moulding', sort: 'best_selling' } },
  { label: 'a price range', request: { q: '', ranges: [{ field: 'price', min: 100, max: 300 }] } },
  { label: 'a second page', request: { categoryId: 'exterior/shutters', page: 2 } },
  { label: 'a query that matches nothing', request: { q: 'zzzznothing', rescue: false } },
];

describe('memory engine matches the SQLite engine', () => {
  test('the same products match, and there are the same number of them', async () => {
    const { sqlite, memory, close } = await bothEngines();
    for (const { label, request } of QUERIES) {
      const a = await sqlite.search(site, request);
      const b = await memory.search(site, request);
      assert.equal(b.totalHits, a.totalHits, `${label}: total`);
      assert.deepEqual(
        new Set(b.hits.map((h) => h.parentId)),
        new Set(a.hits.map((h) => h.parentId)),
        `${label}: the same products on the page`,
      );
    }
    await close();
  });

  test('the cascade puts the same product first', async () => {
    const { sqlite, memory, close } = await bothEngines();
    for (const { label, request } of QUERIES) {
      const a = await sqlite.search(site, request);
      const b = await memory.search(site, request);
      if (!a.hits.length) continue;
      assert.equal(b.hits[0]?.parentId, a.hits[0]?.parentId, `${label}: top result`);
    }
    await close();
  });

  test('a variant query still returns the matching variant, not the parent default', async () => {
    // The requirement the whole design exists for: "black shutter" must show
    // the black one, whichever engine answered.
    const { sqlite, memory, close } = await bothEngines();
    const a = await sqlite.search(site, { q: 'black shutter' });
    const b = await memory.search(site, { q: 'black shutter' });
    assert.match(a.hits[0]!.variantTitle!, /Black/);
    assert.match(b.hits[0]!.variantTitle!, /Black/);
    assert.equal(b.hits[0]!.sku, a.hits[0]!.sku);
    await close();
  });

  test('facet counts agree, value for value', async () => {
    const { sqlite, memory, close } = await bothEngines();
    for (const request of [{ q: 'shutter' }, { categoryId: 'exterior/shutters' },
      { q: '', filters: { finish: ['Black'] } }]) {
      const a = await sqlite.search(site, request);
      const b = await memory.search(site, request);
      const counts = (r: typeof a) => Object.fromEntries(r.facets.map((f) =>
        [f.field, Object.fromEntries(f.values.map((v) => [String(v.value), v.count]))]));
      assert.deepEqual(counts(b), counts(a), JSON.stringify(request));
    }
    await close();
  });

  test('a filtered group still counts its own alternatives', async () => {
    // Having picked PVC you must still see what the other materials would give
    // you, or multi-select is unusable. Both engines lift the group's own
    // selection when counting that group.
    const { sqlite, memory, close } = await bothEngines();
    const request = { q: '', filters: { material: ['PVC'] } };
    const a = await sqlite.search(site, request);
    const b = await memory.search(site, request);
    const materials = (r: typeof a) => r.facets.find((f) => f.field === 'material')!.values.length;
    assert.ok(materials(a) > 1, 'the other materials are still offered');
    assert.equal(materials(b), materials(a));
    await close();
  });

  test('pagination is complete and free of duplicates, on both', async () => {
    const { sqlite, memory, close } = await bothEngines();
    for (const service of [sqlite, memory]) {
      const seen = new Set<string>();
      const first = await service.browse(site, { categoryId: 'exterior/shutters', hitsPerPage: 7 });
      for (let page = 1; page <= first.totalPages; page++) {
        const r = await service.browse(site, {
          categoryId: 'exterior/shutters', hitsPerPage: 7, page,
        });
        for (const hit of r.hits) {
          assert.ok(!seen.has(hit.parentId), `duplicate ${hit.parentId} on page ${page}`);
          seen.add(hit.parentId);
        }
      }
      assert.equal(seen.size, first.totalHits);
    }
    await close();
  });

  test('the write half refuses rather than silently doing nothing', async () => {
    // A no-op createIndex would look like a successful reindex.
    const memory = new MemoryEngine();
    await assert.rejects(() => memory.createIndex('ekena'), /read-only/);
    await assert.rejects(() => memory.upsertDocuments('ekena', []), /read-only/);
    await assert.rejects(() => memory.deleteBySku('ekena', []), /read-only/);
  });
});
