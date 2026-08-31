import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Hit } from '@compass/shared';
import { applyRule, matchesQuery, normaliseQuery, isLive, type QueryRule }
  from '../src/merchandising/queryrules.js';

/**
 * Merchandising bound to what the shopper typed. The arrangement a merchandiser
 * drags into place *is* the rule, so these cover what dragging produces:
 * something at a slot, something pushed down, something gone.
 */

const hit = (parentId: string): Hit => ({
  parentId, sku: `${parentId}-A`, title: parentId, categoryPath: [],
  price: 10, effectivePrice: 10, inStock: true, matchedVariants: [],
} as unknown as Hit);

const hits = (...ids: string[]) => ids.map(hit);
const ids = (list: Hit[]) => list.map((h) => h.parentId);

const rule = (actions: QueryRule['actions'], over: Partial<QueryRule> = {}): QueryRule => ({
  id: 1, siteId: 'ekena', query: 'beams', matchType: 'exact', enabled: true,
  startsAt: null, endsAt: null, priority: 100, note: null, actions, ...over,
});

describe('applying a rule to a ranked list', () => {
  test('a pin takes the slot it names', () => {
    const out = applyRule(hits('a', 'b', 'c', 'd'),
      rule([{ parentId: 'c', action: 'pin', position: 1 }]));
    assert.deepEqual(ids(out), ['c', 'a', 'b', 'd']);
  });

  test('several pins keep their own order', () => {
    const out = applyRule(hits('a', 'b', 'c', 'd', 'e'), rule([
      { parentId: 'd', action: 'pin', position: 1 },
      { parentId: 'b', action: 'pin', position: 3 },
    ]));
    assert.deepEqual(ids(out), ['d', 'a', 'b', 'c', 'e']);
  });

  test('a bury goes to the end without disappearing', () => {
    const out = applyRule(hits('a', 'b', 'c'), rule([{ parentId: 'a', action: 'bury', position: null }]));
    assert.deepEqual(ids(out), ['b', 'c', 'a']);
  });

  test('a hide is gone', () => {
    const out = applyRule(hits('a', 'b', 'c'), rule([{ parentId: 'b', action: 'hide', position: null }]));
    assert.deepEqual(ids(out), ['a', 'c']);
  });

  test('pin, bury and hide compose', () => {
    const out = applyRule(hits('a', 'b', 'c', 'd'), rule([
      { parentId: 'd', action: 'pin', position: 1 },
      { parentId: 'a', action: 'bury', position: null },
      { parentId: 'b', action: 'hide', position: null },
    ]));
    assert.deepEqual(ids(out), ['d', 'c', 'a']);
  });

  test('a pin applies even when the query never matched the product', () => {
    // Most of the point of pinning: putting a new range on "beams" today should
    // not wait for the text to rank it.
    const out = applyRule(hits('a', 'b'),
      rule([{ parentId: 'z', action: 'pin', position: 1 }]),
      new Map([['z', hit('z')]]));
    assert.deepEqual(ids(out), ['z', 'a', 'b']);
  });

  test('a pin naming a product nobody can find is skipped, not left as a hole', () => {
    const out = applyRule(hits('a', 'b'), rule([{ parentId: 'gone', action: 'pin', position: 1 }]));
    assert.deepEqual(ids(out), ['a', 'b']);
  });

  test('a slot past the end lands at the end', () => {
    const out = applyRule(hits('a', 'b'), rule([{ parentId: 'b', action: 'pin', position: 99 }]));
    assert.deepEqual(ids(out), ['a', 'b']);
  });

  test('an empty rule changes nothing', () => {
    assert.deepEqual(ids(applyRule(hits('a', 'b', 'c'), rule([]))), ['a', 'b', 'c']);
  });

  test('pinning is applied to the whole list, not a page', () => {
    // Applied per page, a pin at slot one would put a different product first
    // on every page.
    const long = hits(...Array.from({ length: 50 }, (_, i) => `p${i}`));
    const out = applyRule(long, rule([{ parentId: 'p40', action: 'pin', position: 1 }]));
    assert.equal(out[0]!.parentId, 'p40');
    assert.equal(out.length, 50);
  });
});

describe('which rule fires', () => {
  test('case and spacing are not part of what a shopper meant', () => {
    assert.equal(normaliseQuery('  Black   SHUTTERS '), 'black shutters');
    assert.ok(matchesQuery(rule([], { query: 'Black Shutters' }), 'black   shutters'));
  });

  test('exact means exact', () => {
    const r = rule([], { query: 'beams', matchType: 'exact' });
    assert.ok(matchesQuery(r, 'beams'));
    assert.ok(!matchesQuery(r, 'faux beams'));
  });

  test('phrase matches whole words only', () => {
    const r = rule([], { query: 'beam', matchType: 'phrase' });
    assert.ok(matchesQuery(r, 'white faux beam'));
    assert.ok(!matchesQuery(r, 'beamish'), 'a phrase is not a prefix');
  });

  test('contains is the loosest', () => {
    const r = rule([], { query: 'beam', matchType: 'contains' });
    assert.ok(matchesQuery(r, 'beamish'));
  });

  test('a rule outside its schedule is not live', () => {
    const now = new Date('2026-06-15');
    assert.ok(!isLive(rule([], { startsAt: new Date('2026-07-01') }), now));
    assert.ok(!isLive(rule([], { endsAt: new Date('2026-06-01') }), now));
    assert.ok(isLive(rule([], { startsAt: new Date('2026-06-01'), endsAt: new Date('2026-07-01') }), now));
    assert.ok(!isLive(rule([], { enabled: false }), now));
  });
});
