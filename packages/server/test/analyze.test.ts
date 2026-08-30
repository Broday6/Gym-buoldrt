import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeQuery, looksLikeSku } from '../src/query/analyze.js';
import { splitCompound, typoBudget, editDistance } from '../src/query/normalize.js';

describe('part-number detection', () => {
  test('a real part number is recognised', () => {
    assert.ok(looksLikeSku('BMV4X6X120SM'));
    assert.ok(looksLikeSku('SH14X39BL418'));
  });
  test('sizes and words are not part numbers', () => {
    for (const notSku of ['4x6', '4x6x12', '12ft', 'beam', 'shutter', 'ab1']) {
      assert.ok(!looksLikeSku(notSku), `"${notSku}" should not read as a part number`);
    }
  });
});

describe('query router', () => {
  test('a part number takes the exact path with no typo tolerance', () => {
    const a = analyzeQuery('BMV4X6X120SM');
    assert.equal(a.type, 'sku');
    assert.equal(a.exactOnly, true);
    assert.equal(a.skuCandidate, 'BMV4X6X120SM');
    assert.equal(a.preferSemantic, false);
  });

  test('a size query becomes filters plus the remaining words', () => {
    const a = analyzeQuery('4x6 walnut beam 12ft');
    assert.equal(a.type, 'dimensional');
    assert.deepEqual(a.terms, ['walnut', 'beam']);
    assert.deepEqual(
      a.constraints.map((c) => `${c.field}=${c.value}`).sort(),
      ['height_in=6', 'length_in=144', 'width_in=4'],
    );
  });

  test('a descriptive sentence routes to the semantic path', () => {
    const a = analyzeQuery('something to cover the seam where the wall meets the ceiling');
    assert.equal(a.type, 'natural_language');
    assert.equal(a.preferSemantic, true);
    // Stopwords are stripped so the keyword half of a hybrid query stays useful.
    assert.ok(!a.terms.includes('the'));
    assert.ok(a.terms.includes('seam'));
  });

  test('a plain two-word query stays keyword', () => {
    const a = analyzeQuery('black shutter');
    assert.equal(a.type, 'keyword');
    assert.equal(a.preferSemantic, false);
    assert.deepEqual(a.terms, ['black', 'shutter']);
  });

  test('plurals fold to the singular form', () => {
    assert.deepEqual(analyzeQuery('faux beams').terms, ['faux', 'beam']);
    assert.deepEqual(analyzeQuery('shutters').terms, ['shutter']);
  });

  test('an empty query is its own type, not an error', () => {
    assert.equal(analyzeQuery('   ').type, 'empty');
  });

  test('compounds split against the index vocabulary', () => {
    const vocabulary = new Set(['crown', 'moulding', 'beam', 'walnut']);
    assert.deepEqual(analyzeQuery('crownmoulding', { vocabulary }).terms, ['crown', 'moulding']);
  });

  test('a brand word that merely looks compound is left alone', () => {
    const vocabulary = new Set(['endurathane', 'end', 'urathane', 'beam']);
    // "endurathane" is in the vocabulary, so it must never be split.
    assert.deepEqual(analyzeQuery('endurathane', { vocabulary }).terms, ['endurathane']);
  });
});

describe('typo budget', () => {
  const cfg = { minWordLengthFor1Typo: 4, minWordLengthFor2Typos: 8 };
  test('short words get no tolerance', () => assert.equal(typoBudget('oak', cfg), 0));
  test('mid-length words get one', () => assert.equal(typoBudget('beam', cfg), 1));
  test('long words get two', () => assert.equal(typoBudget('chandelier', cfg), 2));
  test('anything with a digit gets none', () => {
    assert.equal(typoBudget('bmv4x6x120sm', cfg), 0);
    assert.equal(typoBudget('12ft', cfg), 0);
  });
});

describe('edit distance', () => {
  test('acceptance: "chandaleer" is within two edits of "chandelier"', () => {
    assert.ok(editDistance('chandaleer', 'chandelier') <= 2);
  });
  test('the cap short-circuits distant pairs', () => {
    assert.ok(editDistance('beam', 'chandelier', 2) > 2);
  });
});

describe('compound splitting', () => {
  const vocabulary = new Set(['crown', 'moulding', 'wood', 'beam', 'ceiling', 'fan']);
  test('splits a known compound', () => {
    assert.deepEqual(splitCompound('crownmoulding', vocabulary), ['crown', 'moulding']);
  });
  test('refuses when either half is unknown', () => {
    assert.equal(splitCompound('crownzzzzzz', vocabulary), null);
  });
  test('refuses short words outright', () => {
    assert.equal(splitCompound('woodfan', vocabulary), null);
  });
});
