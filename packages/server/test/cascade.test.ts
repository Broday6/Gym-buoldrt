import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { BusinessWeights, SearchableAttribute, VariantDoc } from '@compass/shared';
import type { EngineCandidate } from '../src/engine/types.js';
import { computeTextSignals, compareTextRelevance, rankCandidates } from '../src/ranking/cascade.js';
import { businessScore } from '../src/ranking/business.js';

const WEIGHTS: SearchableAttribute[] = [
  { field: 'title', weight: 10 },
  { field: 'sku', weight: 9 },
  { field: 'brand', weight: 7 },
  { field: 'categoryPath', weight: 6 },
  { field: 'attributes', weight: 5 },
  { field: 'description', weight: 2 },
];

const NEUTRAL_BUSINESS: BusinessWeights = {
  salesVelocity: 0, margin: 0, inventoryDepth: 0, recency: 0, reviewScore: 0, ctr: 0,
};

function doc(overrides: Partial<VariantDoc> = {}): VariantDoc {
  return {
    id: 'ekena:X', site: 'ekena', sku: 'X', mpn: '', parentId: 'P',
    title: '', variantTitle: '', description: '', brand: '',
    categoryPath: [], categoryIds: [], attributeText: [], attributeKeys: [],
    price: 100, salePrice: 0, effectivePrice: 100, discountPct: 0,
    inventory: 10, inStock: true, discontinued: false, image: '',
    reviewScore: 0, reviewCount: 0, salesVelocity: 0, margin: 0,
    dateAddedTs: 0, tags: [], attrs: {}, variantCount: 1,
    ...overrides,
  };
}

function candidate(
  d: Partial<VariantDoc>,
  matched: EngineCandidate['matchedTerms'],
  retrievalScore = 0,
): EngineCandidate {
  return { doc: doc(d), retrievalScore, matchedTerms: matched };
}

describe('textual relevance cascade', () => {
  test('fewer typos wins, whatever else is true', () => {
    const clean = computeTextSignals(
      candidate({ title: 'walnut beam' }, [{ term: 'walnut', matched: 'walnut', distance: 0, prefix: false }]),
      ['walnut'], WEIGHTS,
    );
    const typo = computeTextSignals(
      candidate({ title: 'walnut beam walnut beam' }, [{ term: 'walnut', matched: 'wallnut', distance: 1, prefix: false }]),
      ['walnut'], WEIGHTS,
    );
    assert.equal(clean.typos, 0);
    assert.equal(typo.typos, 1);
    assert.ok(compareTextRelevance(clean, typo) < 0, 'the clean match must sort first');
  });

  test('more words matched wins once typos tie', () => {
    const both = computeTextSignals(
      candidate({ title: 'black shutter' }, [
        { term: 'black', matched: 'black', distance: 0, prefix: false },
        { term: 'shutter', matched: 'shutter', distance: 0, prefix: false },
      ]),
      ['black', 'shutter'], WEIGHTS,
    );
    const one = computeTextSignals(
      candidate({ title: 'shutter' }, [{ term: 'shutter', matched: 'shutter', distance: 0, prefix: false }]),
      ['black', 'shutter'], WEIGHTS,
    );
    assert.equal(both.wordsMatched, 2);
    assert.equal(one.wordsMatched, 1);
    assert.ok(compareTextRelevance(both, one) < 0);
  });

  test('a title match outranks a description match', () => {
    const matched = [{ term: 'walnut', matched: 'walnut', distance: 0, prefix: false }];
    const inTitle = computeTextSignals(candidate({ title: 'walnut beam' }, matched), ['walnut'], WEIGHTS);
    const inDescription = computeTextSignals(
      candidate({ title: 'pine beam', description: 'not walnut at all' }, matched), ['walnut'], WEIGHTS,
    );
    assert.equal(inTitle.bestField, 'title');
    assert.equal(inDescription.bestField, 'description');
    assert.ok(compareTextRelevance(inTitle, inDescription) < 0);
  });

  test('closer words win once field weight ties', () => {
    const matched = [
      { term: 'walnut', matched: 'walnut', distance: 0, prefix: false },
      { term: 'beam', matched: 'beam', distance: 0, prefix: false },
    ];
    const adjacent = computeTextSignals(candidate({ title: 'walnut beam' }, matched), ['walnut', 'beam'], WEIGHTS);
    const apart = computeTextSignals(
      candidate({ title: 'walnut stained rustic ceiling beam' }, matched), ['walnut', 'beam'], WEIGHTS,
    );
    assert.equal(adjacent.proximity, 0);
    assert.ok(apart.proximity > 0);
    assert.ok(compareTextRelevance(adjacent, apart) < 0);
  });

  test('exact beats prefix once everything above ties', () => {
    const exact = computeTextSignals(
      candidate({ title: 'beam' }, [{ term: 'beam', matched: 'beam', distance: 0, prefix: false }]),
      ['beam'], WEIGHTS,
    );
    const prefix = computeTextSignals(
      candidate({ title: 'beams' }, [{ term: 'beam', matched: 'beams', distance: 0, prefix: true }]),
      ['beam'], WEIGHTS,
    );
    assert.ok(exact.exactness > prefix.exactness);
    assert.ok(compareTextRelevance(exact, prefix) < 0);
  });

  test('the cascade is strictly ordered: a criterion never overrides one above it', () => {
    // Worse on every later criterion, better on typos: typos must still decide.
    const fewerTypos = computeTextSignals(
      candidate({ description: 'a beam somewhere in here' }, [
        { term: 'beam', matched: 'beam', distance: 0, prefix: false },
      ]),
      ['beam'], WEIGHTS,
    );
    const moreTypos = computeTextSignals(
      candidate({ title: 'beam' }, [{ term: 'beam', matched: 'bean', distance: 1, prefix: false }]),
      ['beam'], WEIGHTS,
    );
    assert.ok(compareTextRelevance(fewerTypos, moreTypos) < 0);
  });
});

describe('business ranking', () => {
  test('scores stay inside 0..1 for absurd inputs', () => {
    const weights: BusinessWeights = {
      salesVelocity: 1, margin: 1, inventoryDepth: 1, recency: 1, reviewScore: 1, ctr: 1,
    };
    const huge = businessScore(
      doc({ salesVelocity: 1e9, margin: 5000, inventory: 1e6, reviewScore: 99, dateAddedTs: Date.now() }),
      weights,
    );
    assert.ok(huge.score <= 1 && huge.score >= 0, `got ${huge.score}`);

    // Every signal the catalogue owns is zero for an empty product.
    const { ctr: _drop, ...catalogueOnly } = weights;
    const empty = businessScore(doc({ inventory: 0 }), { ...catalogueOnly, ctr: 0 });
    assert.equal(empty.score, 0);

    // Click-through is the exception, and deliberately so: a product nobody
    // has measured scores the same as an average one rather than last. Ranking
    // the unmeasured below everything is how a catalogue freezes — nothing new
    // can ever be seen, so nothing new can ever be clicked.
    const unmeasured = businessScore(doc({ inventory: 0 }), weights);
    assert.equal(unmeasured.breakdown.ctr, 0.5);
    assert.ok(unmeasured.score > 0);
  });

  test('a zero weight removes a signal from the breakdown entirely', () => {
    const { breakdown } = businessScore(doc({ margin: 60, salesVelocity: 400 }), {
      ...NEUTRAL_BUSINESS, margin: 1,
    });
    assert.deepEqual(Object.keys(breakdown), ['margin']);
  });

  test('newer products score higher on recency', () => {
    const weights = { ...NEUTRAL_BUSINESS, recency: 1 };
    const fresh = businessScore(doc({ dateAddedTs: Date.now() - 86_400_000 }), weights).score;
    const stale = businessScore(doc({ dateAddedTs: Date.now() - 730 * 86_400_000 }), weights).score;
    assert.ok(fresh > stale, `${fresh} should beat ${stale}`);
  });
});

describe('rankCandidates', () => {
  test('business ranking orders within a band but never across bands', () => {
    const exactLowMargin = candidate({ sku: 'A', title: 'walnut beam', margin: 5 },
      [{ term: 'walnut', matched: 'walnut', distance: 0, prefix: false }]);
    const exactHighMargin = candidate({ sku: 'B', title: 'walnut beam', margin: 90 },
      [{ term: 'walnut', matched: 'walnut', distance: 0, prefix: false }]);
    const typoHighMargin = candidate({ sku: 'C', title: 'wallnut beam', margin: 100 },
      [{ term: 'walnut', matched: 'wallnut', distance: 1, prefix: false }]);

    const ranked = rankCandidates([exactLowMargin, typoHighMargin, exactHighMargin], {
      terms: ['walnut'],
      weights: WEIGHTS,
      business: { ...NEUTRAL_BUSINESS, margin: 10 },
    });

    assert.deepEqual(ranked.map((r) => r.candidate.doc.sku), ['B', 'A', 'C'],
      'margin reorders the two exact matches, but never lifts the typo match above them');
  });

  test('ordering is deterministic for identical candidates', () => {
    const make = (sku: string) => candidate({ sku, title: 'beam' },
      [{ term: 'beam', matched: 'beam', distance: 0, prefix: false }]);
    const first = rankCandidates([make('Z'), make('A'), make('M')], {
      terms: ['beam'], weights: WEIGHTS, business: NEUTRAL_BUSINESS,
    });
    const second = rankCandidates([make('M'), make('Z'), make('A')], {
      terms: ['beam'], weights: WEIGHTS, business: NEUTRAL_BUSINESS,
    });
    assert.deepEqual(first.map((r) => r.candidate.doc.sku), second.map((r) => r.candidate.doc.sku));
  });

  test('every hit carries an explanation that names the deciding field', () => {
    const ranked = rankCandidates(
      [candidate({ title: 'walnut beam' }, [{ term: 'walnut', matched: 'walnut', distance: 0, prefix: false }])],
      { terms: ['walnut'], weights: WEIGHTS, business: NEUTRAL_BUSINESS },
    );
    assert.equal(ranked[0]!.explanation.bestField, 'title');
    assert.equal(ranked[0]!.explanation.bestFieldWeight, 10);
    assert.equal(ranked[0]!.explanation.typos, 0);
  });
});
