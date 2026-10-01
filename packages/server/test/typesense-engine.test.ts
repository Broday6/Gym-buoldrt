import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { TypesenseEngine } from '../src/engine/typesense.js';
import { SearchService } from '../src/services/search.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';
import { catalogue, QUERIES } from './engine-fixture.js';

/**
 * Typesense is the production engine and SQLite the one every other test runs
 * on. This holds Typesense to the same cases the browser engine is held to:
 * which products match, how many, the facet counts, and which product the
 * ranking cascade puts first.
 *
 * It needs a live server, so it runs only when TYPESENSE_HOST is set:
 *
 *   docker compose --profile typesense up -d typesense
 *   TYPESENSE_HOST=localhost TYPESENSE_API_KEY=dev-typesense-key npm test
 */

const site = new SiteRegistry().require('ekena');
const live = Boolean(process.env.TYPESENSE_HOST);

describe('Typesense engine matches the SQLite engine', { skip: !live && 'TYPESENSE_HOST is not set' }, () => {
  let sqliteEngine: SqliteEngine;
  let typesenseEngine: TypesenseEngine;
  let sqlite: SearchService;
  let typesense: SearchService;

  before(async () => {
    const products = catalogue();
    sqliteEngine = new SqliteEngine(':memory:');
    await indexProducts(sqliteEngine, 'ekena', products);
    typesenseEngine = new TypesenseEngine({
      host: process.env.TYPESENSE_HOST!,
      port: Number(process.env.TYPESENSE_PORT ?? 8108),
      protocol: process.env.TYPESENSE_PROTOCOL ?? 'http',
      apiKey: process.env.TYPESENSE_API_KEY ?? '',
    });
    await indexProducts(typesenseEngine, 'ekena', products);
    sqlite = new SearchService(sqliteEngine);
    typesense = new SearchService(typesenseEngine);
  });

  after(async () => {
    await sqliteEngine?.close();
    await typesenseEngine?.close();
  });

  test('the same products match, and there are the same number of them', async () => {
    for (const { label, request } of QUERIES) {
      const a = await sqlite.search(site, request);
      const b = await typesense.search(site, request);
      assert.equal(b.totalHits, a.totalHits, `${label}: total`);
      assert.deepEqual(
        new Set(b.hits.map((h) => h.parentId)),
        new Set(a.hits.map((h) => h.parentId)),
        `${label}: the same products on the page`,
      );
    }
  });

  test('the cascade puts the same product first', async () => {
    for (const { label, request } of QUERIES) {
      const a = await sqlite.search(site, request);
      const b = await typesense.search(site, request);
      if (!a.hits.length) continue;
      assert.equal(b.hits[0]?.parentId, a.hits[0]?.parentId, `${label}: top result`);
    }
  });

  test('a variant query returns the matching variant, not the parent default', async () => {
    const a = await sqlite.search(site, { q: 'black shutter' });
    const b = await typesense.search(site, { q: 'black shutter' });
    assert.match(b.hits[0]!.variantTitle!, /Black/);
    assert.equal(b.hits[0]!.sku, a.hits[0]!.sku);
  });

  test('facet counts agree, value for value', async () => {
    for (const request of [{ q: 'shutter' }, { categoryId: 'exterior/shutters' },
      { q: '', filters: { finish: ['Black'] } }]) {
      const a = await sqlite.search(site, request);
      const b = await typesense.search(site, request);
      const counts = (r: typeof a) => Object.fromEntries(r.facets.map((f) =>
        [f.field, Object.fromEntries(f.values.map((v) => [String(v.value), v.count]))]));
      assert.deepEqual(counts(b), counts(a), JSON.stringify(request));
    }
  });

  test('a filtered group still counts its own alternatives', async () => {
    const request = { q: '', filters: { material: ['PVC'] } };
    const a = await sqlite.search(site, request);
    const b = await typesense.search(site, request);
    const materials = (r: typeof a) => r.facets.find((f) => f.field === 'material')!.values.length;
    assert.ok(materials(b) > 1, 'the other materials are still offered');
    assert.equal(materials(b), materials(a));
  });

  test('the in-stock filter means the same thing on both', async () => {
    for (const value of ['1', '0', 'true']) {
      const request = { q: '', filters: { in_stock: [value] } };
      const a = await sqlite.search(site, request);
      const b = await typesense.search(site, request);
      assert.equal(b.totalHits, a.totalHits, `in_stock=${value}: total`);
    }
  });

  test('pagination is complete and free of duplicates', async () => {
    const seen = new Set<string>();
    const first = await typesense.browse(site, { categoryId: 'exterior/shutters', hitsPerPage: 7 });
    for (let page = 1; page <= first.totalPages; page++) {
      const r = await typesense.browse(site, { categoryId: 'exterior/shutters', hitsPerPage: 7, page });
      for (const hit of r.hits) {
        assert.ok(!seen.has(hit.parentId), `duplicate ${hit.parentId} on page ${page}`);
        seen.add(hit.parentId);
      }
    }
    assert.equal(seen.size, first.totalHits);
  });

  test('a rebuild swaps in the new index without losing documents', async () => {
    const before = await typesenseEngine.documentCount('ekena');
    await indexProducts(typesenseEngine, 'ekena', catalogue());
    assert.equal(await typesenseEngine.documentCount('ekena'), before);
    const r = await typesense.search(site, { q: 'shutter' });
    assert.ok(r.totalHits > 0, 'search still answers after the swap');
  });

  test('single-record upsert and delete take effect', async () => {
    const [doc] = await typesenseEngine.getByParentIds('ekena', ['P-0']);
    assert.ok(doc, 'P-0 is indexed');
    const renamed = { ...doc!, title: 'Zebrawood Shutter Special' };
    assert.equal(await typesenseEngine.upsertDocuments('ekena', [renamed]), 1);
    const found = await typesense.search(site, { q: 'zebrawood' });
    assert.ok(found.hits.some((h) => h.parentId === 'P-0'), 'the upserted title is searchable');
    assert.equal(await typesenseEngine.deleteBySku('ekena', [renamed.sku]), 1);
    const [after] = await typesenseEngine.getByParentIds('ekena', ['P-0']);
    assert.notEqual(after?.sku, renamed.sku, 'the deleted variant is gone');
  });

  test('the vocabulary holds the catalogue words compound splitting needs', async () => {
    const words = await typesenseEngine.vocabulary('ekena');
    for (const w of ['shutter', 'moulding', 'black']) assert.ok(words.has(w), `${w} is known`);
  });
});
