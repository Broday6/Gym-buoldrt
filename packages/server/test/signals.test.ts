import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SignalStore, shrink } from '../src/services/signals.js';
import { businessScore } from '../src/ranking/business.js';
import type { BusinessWeights, VariantDoc } from '@compass/shared';
import type { Db } from '../src/db/pool.js';

/**
 * Behaviour feeding back into ranking is the one part of the composite that
 * changes on its own, which makes it the part most able to go wrong quietly.
 * Two failure modes matter more than accuracy: a product riding one lucky
 * click to the top, and a new product frozen out because it has no history.
 */

const NEUTRAL: BusinessWeights = {
  salesVelocity: 0, margin: 0, inventoryDepth: 0, recency: 0, reviewScore: 0, ctr: 1,
};

function doc(sku: string): VariantDoc {
  return {
    id: sku, siteId: 'ekena', sku, parentId: 'P', title: 'T', description: '', brand: 'B',
    categoryPath: [], categoryIds: [], variantTitle: '', attrs: {}, price: 10, salePrice: 10,
    effectivePrice: 10, inventory: 1, inStock: true, salesVelocity: 0, margin: 0,
    reviewScore: 0, reviewCount: 0, dateAddedTs: 0, labels: [], collectionPositions: {},
  } as unknown as VariantDoc;
}

/** A database that answers the one query the store asks. */
function fakeDb(rows: { sku: string; impressions: number; clicks: number }[], fail = false): Db {
  return {
    query: async () => {
      if (fail) throw new Error('analytics store is down');
      return {
        rows: rows.map((r) => ({
          sku: r.sku, impressions: String(r.impressions), clicks: String(r.clicks),
        })),
        rowCount: rows.length,
      };
    },
  } as unknown as Db;
}

describe('click signals', () => {
  test('a lucky click is discounted almost to nothing', () => {
    // One click on three impressions reads as a 33% click-through. It is not
    // evidence of one; it is three impressions.
    const mean = 0.09;
    const lucky = shrink(1, 3, mean, 50);
    assert.ok(Math.abs(lucky - mean) < 0.02, `${lucky} should sit near ${mean}`);
    assert.ok(lucky < 0.12, `${lucky} is far from the 0.33 it would be raw`);
  });

  test('the same rate ranks higher the more it has been measured', () => {
    // This is the property ranking depends on. Both ran at 33%; only one of
    // them has earned it. A raw rate cannot tell them apart at all.
    const mean = 0.09;
    const thin = shrink(1, 3, mean, 50);
    const earned = shrink(100, 300, mean, 50);
    assert.ok(earned > thin * 2, `${earned} should be well above ${thin}`);
  });

  test('evidence overcomes the prior once there is enough of it', () => {
    const mean = 0.05;
    const thin = shrink(10, 50, mean, 50);
    const thick = shrink(200, 1000, mean, 50);
    // Both ran at 20%. The one measured twenty times over is trusted further.
    assert.ok(thick > thin);
    assert.ok(thick > 0.15 && thick <= 0.2);
  });

  test('a product with no impressions is the site average, not zero', () => {
    assert.equal(shrink(0, 0, 0.07, 50), 0.07);
  });

  test('the score is relative to the site, so a good rate ranks well anywhere', () => {
    // The same product, on two sites whose typical click-through differs by
    // an order of magnitude. Twice the local average either way.
    const busy = businessScore(doc('A'), NEUTRAL, Date.now(),
      { bySku: new Map([['A', 0.40]]), mean: 0.20 });
    const quiet = businessScore(doc('A'), NEUTRAL, Date.now(),
      { bySku: new Map([['A', 0.04]]), mean: 0.02 });
    assert.equal(busy.score, quiet.score);
    assert.equal(busy.score, 1);
  });

  test('an unmeasured product ranks as average, and a dead one below it', () => {
    const clicks = { bySku: new Map([['DEAD', 0]]), mean: 0.1 };
    const unknown = businessScore(doc('NEW'), NEUTRAL, Date.now(), clicks);
    const dead = businessScore(doc('DEAD'), NEUTRAL, Date.now(), clicks);
    assert.equal(unknown.score, 0.5);
    assert.equal(dead.score, 0);
  });

  test('the store computes a site mean and shrinks toward it', async () => {
    const store = new SignalStore(fakeDb([
      { sku: 'A', impressions: 1000, clicks: 200 },
      { sku: 'B', impressions: 1000, clicks: 0 },
      { sku: 'C', impressions: 2, clicks: 1 },
    ]), { priorWeight: 50 });

    const signals = await store.get('ekena');
    assert.equal(signals.measured, 3);
    assert.equal(signals.impressions, 2002);
    assert.ok(Math.abs(signals.siteMean - 201 / 2002) < 1e-9);
    assert.ok(signals.ctrBySku.get('A')! > signals.ctrBySku.get('C')!);
    assert.ok(signals.ctrBySku.get('C')! > signals.ctrBySku.get('B')!);
  });

  test('a broken analytics store leaves ranking working', async () => {
    const store = new SignalStore(fakeDb([], true));
    const signals = await store.get('ekena');
    // Empty, not thrown: behaviour is an enhancement, and search stays up
    // when the database it comes from does not.
    assert.equal(signals.measured, 0);
    assert.equal(signals.siteMean, 0);
  });

  test('concurrent searches share one rebuild', async () => {
    let calls = 0;
    const db = {
      query: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 20));
        return { rows: [{ sku: 'A', impressions: '10', clicks: '1' }], rowCount: 1 };
      },
    } as unknown as Db;
    const store = new SignalStore(db);
    await Promise.all([store.get('ekena'), store.get('ekena'), store.get('ekena')]);
    assert.equal(calls, 1);
  });
});
