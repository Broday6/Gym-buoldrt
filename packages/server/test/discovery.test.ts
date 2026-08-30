import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SynonymSet, type SynonymRule } from '../src/merchandising/synonyms.js';
import { RedirectSet, type RedirectRule } from '../src/merchandising/redirects.js';
import { relaxTerms, suggestCorrection } from '../src/query/spelling.js';
import { ResultCache, cacheKey } from '../src/services/cache.js';

const TYPO = { minWordLengthFor1Typo: 4, minWordLengthFor2Typos: 8 };

function synonym(partial: Partial<SynonymRule> & { id: number; terms: string[] }): SynonymRule {
  return {
    siteId: 'ekena', kind: 'two_way', fromTerms: [], enabled: true, ...partial,
  } as SynonymRule;
}

describe('synonyms', () => {
  test('acceptance: "sofa" finds couches through a two-way rule', () => {
    const set = new SynonymSet([synonym({ id: 1, terms: ['sofa', 'couch', 'settee'] })]);
    const expansions = set.expand(['sofa']);
    assert.equal(expansions.length, 1);
    const words = expansions[0]!.alternatives.flat();
    assert.ok(words.includes('couch'));
    assert.ok(words.includes('settee'));
    assert.ok(!words.includes('sofa'), 'a term does not expand to itself');
  });

  test('a two-way rule works from any of its terms', () => {
    const set = new SynonymSet([synonym({ id: 1, terms: ['sofa', 'couch'] })]);
    assert.ok(set.expand(['couch'])[0]!.alternatives.flat().includes('sofa'));
  });

  test('a one-way rule expands only in its declared direction', () => {
    const set = new SynonymSet([
      synonym({ id: 2, kind: 'one_way', fromTerms: ['crown'], terms: ['crown moulding'] }),
    ]);
    assert.deepEqual(set.expand(['crown'])[0]!.alternatives, [['crown', 'moulding']]);
    assert.equal(set.expand(['moulding']).length, 0, 'the reverse must not fire');
  });

  test('phrase synonyms match multiple tokens, longest first', () => {
    const set = new SynonymSet([
      synonym({ id: 3, kind: 'one_way', fromTerms: ['crown moulding'], terms: ['cornice'] }),
      synonym({ id: 4, kind: 'one_way', fromTerms: ['crown'], terms: ['coronet'] }),
    ]);
    const expansions = set.expand(['crown', 'moulding']);
    assert.equal(expansions.length, 1, 'the longer phrase wins the span');
    assert.equal(expansions[0]!.ruleId, 3);
    assert.equal(expansions[0]!.span.length, 2);
  });

  test('plural forms of a rule term still match', () => {
    const set = new SynonymSet([synonym({ id: 5, terms: ['beam', 'timber'] })]);
    assert.ok(set.expand(['beam'])[0]!.alternatives.flat().includes('timber'));
  });

  test('a disabled rule never fires', () => {
    const set = new SynonymSet([synonym({ id: 6, terms: ['sofa', 'couch'], enabled: false })]);
    assert.equal(set.size, 0);
    assert.deepEqual(set.expand(['sofa']), []);
  });
});

describe('redirects', () => {
  function redirect(partial: Partial<RedirectRule> & { id: number; pattern: string; url: string }): RedirectRule {
    return {
      siteId: 'ekena', matchType: 'exact', enabled: true, priority: 0, ...partial,
    } as RedirectRule;
  }

  test('an exact match redirects', () => {
    const set = new RedirectSet([redirect({ id: 1, pattern: 'returns', url: '/policy/returns' })]);
    assert.equal(set.match('Returns')?.url, '/policy/returns');
    assert.equal(set.match('returns policy'), null, 'exact means exact');
  });

  test('starts-with and contains match as described', () => {
    const set = new RedirectSet([
      redirect({ id: 1, pattern: 'ship', matchType: 'starts_with', url: '/shipping' }),
      redirect({ id: 2, pattern: 'warranty', matchType: 'contains', url: '/warranty' }),
    ]);
    assert.equal(set.match('shipping times')?.url, '/shipping');
    assert.equal(set.match('what is your warranty like')?.url, '/warranty');
  });

  test('priority decides when several rules match', () => {
    const set = new RedirectSet([
      redirect({ id: 1, pattern: 'beam', matchType: 'contains', url: '/low', priority: 1 }),
      redirect({ id: 2, pattern: 'beam', matchType: 'contains', url: '/high', priority: 9 }),
    ]);
    assert.equal(set.match('faux beam')?.url, '/high');
  });

  test('a regular expression that does not compile never matches, and never throws', () => {
    const set = new RedirectSet([
      redirect({ id: 1, pattern: '([unclosed', matchType: 'regex', url: '/nope' }),
    ]);
    assert.equal(set.match('anything at all'), null);
  });

  test('a disabled redirect is inert', () => {
    const set = new RedirectSet([
      redirect({ id: 1, pattern: 'returns', url: '/policy', enabled: false }),
    ]);
    assert.equal(set.size, 0);
    assert.equal(set.match('returns'), null);
  });
});

describe('spelling correction', () => {
  const vocabulary = new Set(['chandelier', 'shutter', 'beam', 'walnut', 'moulding', 'medallion']);

  test('corrects a misspelling to the vocabulary', () => {
    const c = suggestCorrection(['chandaleer'], { typo: TYPO, vocabulary });
    assert.equal(c.changed, true);
    assert.equal(c.suggestion, 'chandelier');
  });

  test('leaves a word that is already in the vocabulary alone', () => {
    assert.equal(suggestCorrection(['beam'], { typo: TYPO, vocabulary }).changed, false);
  });

  test('never rewrites a part number or anything with digits', () => {
    const c = suggestCorrection(['bmv4x6x120sm'], { typo: TYPO, vocabulary });
    assert.equal(c.changed, false);
  });

  test('requires the first letter to survive, so unrelated words are not proposed', () => {
    // "team" is one edit from "beam" but is not a plausible correction of it.
    const c = suggestCorrection(['team'], { typo: TYPO, vocabulary });
    assert.equal(c.changed, false);
  });

  test('correction is deterministic when several candidates tie', () => {
    const vocab = new Set(['beams', 'beamz']);
    const a = suggestCorrection(['beamx'], { typo: TYPO, vocabulary: vocab });
    const b = suggestCorrection(['beamx'], { typo: TYPO, vocabulary: vocab });
    assert.equal(a.suggestion, b.suggestion);
  });
});

describe('query relaxation', () => {
  test('drops the shortest term, which carries the least intent', () => {
    assert.deepEqual(relaxTerms(['mdf', 'crown', 'moulding']), ['crown', 'moulding']);
  });
  test('a single term cannot be relaxed further', () => {
    assert.equal(relaxTerms(['beam']), null);
  });
  test('relaxation converges', () => {
    let terms: string[] | null = ['a', 'bb', 'ccc', 'dddd'];
    let steps = 0;
    while (terms && steps < 10) {
      terms = relaxTerms(terms);
      steps++;
    }
    assert.ok(steps < 10, 'must terminate');
  });
});

describe('result cache', () => {
  test('a hit returns the stored value', () => {
    const cache = new ResultCache<number>();
    cache.set('ekena a', 1);
    assert.equal(cache.get('ekena a'), 1);
    assert.equal(cache.get('ekena b'), undefined);
  });

  test('invalidating one site leaves the others alone', () => {
    const cache = new ResultCache<number>();
    cache.set('ekena a', 1);
    cache.set('archdepot a', 2);
    assert.equal(cache.invalidate('ekena'), 1);
    assert.equal(cache.get('ekena a'), undefined);
    assert.equal(cache.get('archdepot a'), 2);
  });

  test('the least recently used entry is evicted first', () => {
    const cache = new ResultCache<number>({ maxEntries: 2 });
    cache.set('s a', 1);
    cache.set('s b', 2);
    cache.get('s a');       // 'b' is now the least recently used
    cache.set('s c', 3);
    assert.equal(cache.get('s b'), undefined);
    assert.equal(cache.get('s a'), 1);
  });

  test('entries expire', () => {
    const cache = new ResultCache<number>({ ttlMs: -1 });
    cache.set('s a', 1);
    assert.equal(cache.get('s a'), undefined);
  });

  test('the key is stable regardless of property or filter order', () => {
    const a = cacheKey('ekena', { q: 'beam', filters: { finish: ['Walnut'] }, page: 1 });
    const b = cacheKey('ekena', { page: 1, filters: { finish: ['Walnut'] }, q: 'beam' });
    assert.equal(a, b);
  });

  test('different filters produce different keys', () => {
    const a = cacheKey('ekena', { q: 'beam', filters: { finish: ['Walnut'] } });
    const b = cacheKey('ekena', { q: 'beam', filters: { finish: ['Espresso'] } });
    assert.notEqual(a, b);
  });

  test('undefined values do not change the key', () => {
    assert.equal(
      cacheKey('ekena', { q: 'beam', categoryId: undefined }),
      cacheKey('ekena', { q: 'beam' }),
    );
  });
});
