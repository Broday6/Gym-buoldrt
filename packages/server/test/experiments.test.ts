import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { assign } from '../src/merchandising/experiments.js';
import { experimentResult, sessionsToDetect, twoProportionZ }
  from '../src/services/experiment-results.js';
import type { Experiment } from '../src/merchandising/experiments.js';
import type { Db } from '../src/db/pool.js';

/**
 * The failure mode of an A/B test is not a broken split — it is a confident
 * number produced from noise, believed, and shipped. Most of these cover the
 * refusal to produce one.
 */

const experiment: Experiment = {
  id: 7, siteId: 'ekena', name: 'Pin beams', hypothesis: null, ruleId: 1,
  exposure: 50, status: 'running', startedAt: new Date('2026-08-01'),
  endedAt: null, outcomeNote: null,
};

function results(arms: Record<string, Record<string, number>>): Db {
  return {
    query: async () => ({
      rows: Object.entries(arms).map(([variant, v]) => ({
        ab_variant: variant,
        sessions: String(v.sessions ?? 0),
        searches: String(v.searches ?? 0),
        clicks: String(v.clicks ?? 0),
        carts: String(v.carts ?? 0),
        purchases: String(v.purchases ?? 0),
        revenue: String(v.revenue ?? 0),
      })),
      rowCount: Object.keys(arms).length,
    }),
  } as unknown as Db;
}

describe('assigning sessions to an arm', () => {
  test('a session gets the same arm every time it is asked', () => {
    // A shopper who saw the pinned grid, went to page two and got the
    // unpinned one would be in both arms at once, and neither number would
    // mean anything.
    const first = assign(7, 'session-abc', 50);
    for (let i = 0; i < 50; i++) assert.equal(assign(7, 'session-abc', 50), first);
  });

  test('the same session is assigned independently in different experiments', () => {
    // Salted by experiment, so a session unlucky in one is not systematically
    // unlucky in every one that follows.
    const ids = Array.from({ length: 40 }, (_, i) => i + 1);
    const arms = ids.map((id) => assign(id, 'session-abc', 50));
    assert.ok(new Set(arms).size === 2, 'both arms occur across experiments');
  });

  test('exposure is honoured across a population', () => {
    const sessions = Array.from({ length: 4000 }, (_, i) => `s-${i}`);
    for (const exposure of [10, 50, 90]) {
      const treated = sessions.filter((s) => assign(1, s, exposure) === 'treatment').length;
      const actual = (treated / sessions.length) * 100;
      assert.ok(Math.abs(actual - exposure) < 3,
        `${exposure}% exposure produced ${actual.toFixed(1)}%`);
    }
  });

  test('a session with no id is never in the treatment arm', () => {
    // No id means no stable assignment, so it cannot be measured. Showing such
    // a shopper the control is the honest default: it is the page they would
    // have seen anyway.
    assert.equal(assign(1, '', 99), 'control');
  });
});

describe('reading the result', () => {
  test('a handful of sessions produces no verdict at all', async () => {
    const r = await experimentResult(results({
      control: { sessions: 40, carts: 2 },
      treatment: { sessions: 38, carts: 6 },
    }), experiment);
    // 5% against 16% looks like a triumph and is three extra carts.
    assert.equal(r.verdict, 'not_enough_data');
    assert.equal(r.confidence, null);
    assert.match(r.summary, /Too early/);
  });

  test('a real difference on real volume is called', async () => {
    const r = await experimentResult(results({
      control: { sessions: 4000, carts: 400 },
      treatment: { sessions: 4000, carts: 520 },
    }), experiment);
    assert.equal(r.verdict, 'better');
    assert.ok(r.confidence! > 0.95);
    assert.equal(r.liftPct, 30);
  });

  test('a change that hurts is reported as loudly as one that helps', async () => {
    const r = await experimentResult(results({
      control: { sessions: 4000, carts: 520 },
      treatment: { sessions: 4000, carts: 400 },
    }), experiment);
    assert.equal(r.verdict, 'worse');
    assert.match(r.summary, /losing/);
  });

  test('a small difference on large volume is called no difference, with a number', async () => {
    const r = await experimentResult(results({
      control: { sessions: 3000, carts: 300 },
      treatment: { sessions: 3000, carts: 312 },
    }), experiment);
    assert.equal(r.verdict, 'no_difference');
    // "Not significant" is unactionable on its own; how much more it would
    // take is the part somebody can plan around.
    assert.ok((r.sessionsNeeded ?? 0) > 3000);
  });

  test('rates are per session, not per search', async () => {
    const r = await experimentResult(results({
      control: { sessions: 200, searches: 2000, carts: 20 },
      treatment: { sessions: 200, searches: 400, carts: 20 },
    }), experiment);
    // One shopper who searched forty times must not outweigh forty shoppers
    // who searched once.
    assert.equal(r.control.cartRate, r.treatment.cartRate);
  });

  test('an arm with no traffic does not crash or claim a winner', async () => {
    const r = await experimentResult(results({ control: { sessions: 500, carts: 50 } }), experiment);
    assert.equal(r.treatment.sessions, 0);
    assert.equal(r.verdict, 'not_enough_data');
  });
});

describe('the statistics themselves', () => {
  test('identical rates are never significant', () => {
    const { confidence } = twoProportionZ(100, 1000, 100, 1000);
    assert.ok(confidence < 1e-6, `got ${confidence}`);
  });

  test('the same rates on more data are more significant', () => {
    const small = twoProportionZ(60, 500, 40, 500).confidence;
    const large = twoProportionZ(600, 5000, 400, 5000).confidence;
    assert.ok(large > small);
  });

  test('the test is two-sided, so a loss is as detectable as a win', () => {
    const up = twoProportionZ(600, 5000, 400, 5000).confidence;
    const down = twoProportionZ(400, 5000, 600, 5000).confidence;
    assert.ok(Math.abs(up - down) < 1e-9);
  });

  test('a smaller difference needs more sessions to detect', () => {
    const big = sessionsToDetect(0.10, 0.14)!;
    const small = sessionsToDetect(0.10, 0.101)!;
    assert.ok(small > big * 100, `${small} should dwarf ${big}`);
  });

  test('no difference needs an infinite sample, and says so by not answering', () => {
    assert.equal(sessionsToDetect(0.1, 0.1), null);
  });
});
