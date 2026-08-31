import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { matches, scoreCase, summarise, type Judgment } from '../src/relevance/judge.js';
import type { SearchResponse, VariantDoc } from '@compass/shared';

/**
 * The harness is the thing every future ranking change is measured against, so
 * a bug in its scoring is worse than a bug in the engine: it would either hide
 * a real regression or invent one. These cover the scorer, not the engine.
 */

function doc(partial: Partial<VariantDoc> & { sku: string }): VariantDoc {
  return {
    id: `ekena:${partial.sku}`, site: 'ekena', sku: partial.sku, mpn: '',
    parentId: partial.sku, title: '', variantTitle: '', description: '', brand: '',
    categoryPath: [], categoryIds: [], attributeText: [], attributeKeys: [],
    price: 10, salePrice: 0, effectivePrice: 10, discountPct: 0,
    inventory: 5, inStock: true, discontinued: false, image: '',
    reviewScore: 0, reviewCount: 0, salesVelocity: 0, margin: 0, dateAddedTs: 0,
    tags: [], attrs: {}, variantCount: 1, labels: [], collectionPositions: {},
    ...partial,
  } as VariantDoc;
}

function response(docs: VariantDoc[], extra: Partial<SearchResponse> = {}): SearchResponse {
  return {
    hits: docs.map((d) => ({
      parentId: d.parentId, sku: d.sku, title: d.title, variantTitle: d.variantTitle,
      brand: d.brand, categoryPath: d.categoryPath, image: '', price: d.price,
      salePrice: d.salePrice, effectivePrice: d.effectivePrice, inStock: d.inStock,
      reviewScore: 0, reviewCount: 0, variantCount: 1, matchedVariants: [],
    })),
    page: 0, hitsPerPage: 10, totalHits: docs.length, totalPages: 1,
    processingTimeMs: 1, query: '', effectiveQuery: '', queryType: 'keyword',
    facets: [], appliedFilters: {}, sort: 'relevance',
    ...extra,
  } as SearchResponse;
}

const shutter = doc({
  sku: 'SH-1', title: 'Joined PVC Board and Batten Shutter',
  categoryPath: ['Exterior', 'Shutters', 'Board and Batten Shutters'],
  attrs: { finish: 'Black', material: 'PVC' },
});
const beam = doc({
  sku: 'BM-1', title: 'Rustic Faux Wood Ceiling Beam',
  categoryPath: ['Millwork', 'Beams', 'Faux Wood Beams'],
  attrs: { finish: 'Walnut', material: 'Polyurethane' },
});

const lookup = (sku: string) => [shutter, beam].find((d) => d.sku === sku);
const base = { id: 'c', query: 'q', intent: 'i' };

describe('matching a document against a judgment', () => {
  test('a category matches at any depth of the path', () => {
    assert.ok(matches(shutter, { category: 'Shutters' }));
    assert.ok(matches(shutter, { category: 'Exterior' }));
    assert.ok(!matches(beam, { category: 'Shutters' }));
  });

  test('attributes must all hold, and any one may offer alternatives', () => {
    assert.ok(matches(shutter, { attr: { finish: 'Black', material: 'PVC' } }));
    assert.ok(!matches(shutter, { attr: { finish: 'Black', material: 'Cedar' } }));
    assert.ok(matches(shutter, { attr: { material: ['PVC', 'Composite'] } }));
  });

  test('an attribute the document does not carry is a miss, not a pass', () => {
    // Otherwise every judgment naming an attribute nothing has would score a
    // perfect 1.00, and the suite would be measuring nothing.
    assert.ok(!matches(shutter, { attr: { style: 'Shaker' } }));
  });

  test('anyOf lets a product be judged by taxonomy or by name', () => {
    // A product whose category column is blank is still a chandelier.
    const uncategorised = doc({ sku: 'CH-1', title: 'Sputnik Crystal Chandelier' });
    const isChandelier: Judgment = {
      anyOf: [{ category: 'Chandeliers' }, { title: 'chandelier' }],
    };
    assert.ok(matches(uncategorised, isChandelier));
    assert.ok(!matches(beam, isChandelier));
  });

  test('an empty judgment matches anything', () => {
    assert.ok(matches(beam, {}));
  });
});

describe('scoring a case', () => {
  test('precision is the share of the window that satisfies the expectation', () => {
    const r = scoreCase({ ...base, expect: { category: 'Shutters' } },
      response([shutter, beam]), lookup);
    assert.equal(r.precision, 0.5);
    assert.equal(r.pass, false);
    assert.match(r.failures[0]!, /1 of 2 results are not/);
  });

  test('a forbidden result fails the case even when precision is perfect', () => {
    // "Do not show chandeliers for black shutter" is not expressible as a
    // precision target, and it is the assertion that catches the worst pages.
    const r = scoreCase({ ...base, expect: {}, forbid: { category: 'Beams' } },
      response([shutter, beam]), lookup);
    assert.equal(r.precision, 1);
    assert.equal(r.pass, false);
  });

  test('only the top k is judged, so a long tail cannot dilute a bad first page', () => {
    const r = scoreCase({ ...base, k: 1, expect: { category: 'Shutters' } },
      response([shutter, beam]), lookup);
    assert.equal(r.precision, 1);
    assert.equal(r.judged, 1);
  });

  test('an empty result set scores zero rather than a vacuous one', () => {
    const r = scoreCase({ ...base, expect: { category: 'Shutters' } }, response([]), lookup);
    assert.equal(r.precision, 0);
  });

  test('a query that had to be rescued is reported when it should not have been', () => {
    const r = scoreCase({ ...base, rescued: false },
      response([shutter], { rescue: { strategy: 'category_fallback' } }), lookup);
    assert.equal(r.pass, false);
    assert.match(r.failures[0]!, /should have matched outright/);
  });

  test('entities the analyser failed to lift are named, along with what it did lift', () => {
    const r = scoreCase({ ...base, understands: ['Black', 'PVC'] },
      response([shutter], {
        parsedFilters: [{ field: 'finish', value: 'Black', source: 'black', kind: 'attribute' }],
      }), lookup);
    assert.match(r.failures[0]!, /did not understand PVC/);
    assert.match(r.failures[0]!, /understood black/);
  });

  test('a result missing from the corpus is called a harness fault, not a relevance one', () => {
    const r = scoreCase({ ...base, expect: { category: 'Shutters' } },
      response([shutter, doc({ sku: 'GHOST' })]), lookup);
    assert.match(r.failures.join(' '), /not in the corpus/);
  });
});

describe('summarising a suite', () => {
  test('the score is the mean precision, so one broken query cannot be hidden', () => {
    const suite = summarise([
      { precision: 1, pass: true }, { precision: 0, pass: false }, { precision: 1, pass: true },
    ].map((c, i) => ({
      id: `c${i}`, query: '', intent: '', matched: 0, judged: 0, totalHits: 0,
      failures: [], top: [], ...c,
    })));
    assert.equal(suite.score, 0.667);
    assert.equal(suite.passed, 2);
    assert.equal(suite.failed, 1);
  });
});
