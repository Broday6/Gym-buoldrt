import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '@compass/shared';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { SearchService } from '../src/services/search.js';
import { PreviewService } from '../src/services/preview.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';
import { labelsFor, type BadgeDefinition, type LabelPlan } from '../src/merchandising/labels.js';
import { generateTraffic } from '../../demo/traffic.js';

const site = new SiteRegistry().require('ekena');

function product(id: string, overrides: Partial<Product> = {}): Product {
  return {
    parentId: id,
    title: `Product ${id}`,
    description: 'A product.',
    brand: 'Ekena Millwork',
    categoryPath: ['Millwork', 'Beams'],
    categoryIds: ['millwork', 'millwork/beams'],
    margin: 50,
    salesVelocity: 500,
    dateAdded: new Date().toISOString().slice(0, 10),
    variants: [
      { sku: `${id}-A`, parentId: id, variantTitle: 'Walnut', price: 400, inventory: 40,
        attributes: { finish: 'Walnut' } },
      { sku: `${id}-B`, parentId: id, variantTitle: 'Black', price: 90, inventory: 3,
        attributes: { finish: 'Black' } },
    ],
    ...overrides,
  };
}

function badge(partial: Partial<BadgeDefinition> & { key: string }): BadgeDefinition {
  return {
    id: 1, siteId: 'ekena', label: partial.key, tone: 'neutral', selector: null,
    priority: 100, enabled: true, startsAt: null, endsAt: null, ...partial,
  } as BadgeDefinition;
}

function plan(badges: BadgeDefinition[]): LabelPlan {
  return { collections: [], attributes: [], badges };
}

describe('badges', () => {
  test('a badge lands only on the variants its rule matches', () => {
    const labels = labelsFor(product('P1'), plan([
      badge({ key: 'low_stock', label: 'Low Stock',
        selector: { all: [{ field: 'variant.inventory', op: 'lte', value: 5 }] } }),
    ]));
    // "Only 3 left" belongs on the variant that is nearly out, not the product.
    assert.deepEqual(labels.get('P1-B'), ['badge:low_stock']);
    assert.deepEqual(labels.get('P1-A'), []);
  });

  test('a product-level badge lands on every variant', () => {
    const labels = labelsFor(product('P1'), plan([
      badge({ key: 'best', label: 'Best Seller',
        selector: { all: [{ field: 'salesVelocity', op: 'gte', value: 100 }] } }),
    ]));
    assert.deepEqual(labels.get('P1-A'), ['badge:best']);
    assert.deepEqual(labels.get('P1-B'), ['badge:best']);
  });

  test('an expired badge never applies', () => {
    const labels = labelsFor(product('P1'), plan([
      badge({ key: 'gone', selector: { all: [{ field: 'brand', op: 'exists' }] },
        endsAt: new Date('2020-01-01') }),
    ]));
    assert.deepEqual(labels.get('P1-A'), []);
  });

  test('a disabled badge never applies', () => {
    const labels = labelsFor(product('P1'), plan([
      badge({ key: 'off', enabled: false, selector: { all: [{ field: 'brand', op: 'exists' }] } }),
    ]));
    assert.deepEqual(labels.get('P1-A'), []);
  });

  test('hits carry at most two badges, highest priority first', async () => {
    const engine = new SqliteEngine(':memory:');
    const badges = [
      badge({ key: 'a', label: 'A', priority: 30, selector: { all: [{ field: 'brand', op: 'exists' }] } }),
      badge({ key: 'b', label: 'B', priority: 10, selector: { all: [{ field: 'brand', op: 'exists' }] } }),
      badge({ key: 'c', label: 'C', priority: 20, selector: { all: [{ field: 'brand', op: 'exists' }] } }),
    ];
    await indexProducts(engine, 'ekena', [product('P1')], { labels: plan(badges) });
    const service = new SearchService(engine, {
      collections: { listAttributes: async () => [], listBadges: async () => badges },
    });
    const r = await service.search(site, { q: 'Product' });
    // More than two badges on one card stops being emphasis and becomes noise.
    assert.deepEqual(r.hits[0]?.badges?.map((b) => b.label), ['B', 'C']);
    await engine.close();
  });

  test('a hit with no badges carries none, and never a stray labels field', async () => {
    const engine = new SqliteEngine(':memory:');
    await indexProducts(engine, 'ekena', [product('P1')], { labels: plan([]) });
    const service = new SearchService(engine, {
      collections: { listAttributes: async () => [], listBadges: async () => [] },
    });
    const r = await service.search(site, { q: 'Product' });
    assert.equal(r.hits[0]?.badges, undefined);
    assert.ok(!('labels' in (r.hits[0] as object)), 'internal labels must not leak to the API');
    await engine.close();
  });
});

describe('rule preview', () => {
  test('counts what a rule would catch, before it is saved', async () => {
    const engine = new SqliteEngine(':memory:');
    await indexProducts(engine, 'ekena', [
      product('P1', { margin: 60 }),
      product('P2', { margin: 20 }),
      product('P3', { margin: 55 }),
    ]);
    const preview = new PreviewService(engine);
    const result = await preview.preview('ekena', {
      all: [{ field: 'margin', op: 'gte', value: 50 }],
    });
    assert.equal(result.total, 3);
    assert.equal(result.matched, 2);
    assert.equal(result.exact, true, 'a small catalogue is counted exactly, not sampled');
    assert.match(result.description, /margin ≥ 50/);
    assert.equal(result.examples.length, 2);
    await engine.close();
  });

  test('a malformed rule is rejected rather than silently matching nothing', async () => {
    const engine = new SqliteEngine(':memory:');
    await indexProducts(engine, 'ekena', [product('P1')]);
    const preview = new PreviewService(engine);
    await assert.rejects(() => preview.preview('ekena', { all: [{ field: 'margin', op: 'nope' }] }));
    await engine.close();
  });

  test('variant conditions are evaluated against whole products', async () => {
    const engine = new SqliteEngine(':memory:');
    await indexProducts(engine, 'ekena', [product('P1'), product('P2')]);
    const preview = new PreviewService(engine);
    // The regrouped product must carry every variant, or a variant rule misfires.
    const result = await preview.preview('ekena', {
      all: [{ field: 'variant.attrs.finish', op: 'equals', value: 'Black' }],
    });
    assert.equal(result.matched, 2);
    await engine.close();
  });
});

describe('traffic generator', () => {
  test('produces a head-heavy, position-decayed, partly-failing event stream', async () => {
    const probe = async (query: string) => {
      if (query.includes('chandaleer') || query.includes('barn door')) return { hits: [], total: 0 };
      return {
        total: 40,
        hits: Array.from({ length: 20 }, (_, i) => ({
          sku: `S-${i}`, parentId: `P-${i}`, effectivePrice: 100 + i,
        })),
      };
    };
    const events = await generateTraffic('ekena', probe, { sessions: 400, seed: 7 });

    const searches = events.filter((e) => e.type === 'search' || e.type === 'zero_result');
    const zero = events.filter((e) => e.type === 'zero_result');
    const clicks = events.filter((e) => e.type === 'click');
    assert.ok(searches.length > 400, 'every session searches at least once');

    // Some queries must fail, or the zero-result report has nothing to show.
    assert.ok(zero.length > 0 && zero.length / searches.length < 0.3, 'a realistic failure rate');

    // Click-through has to decay with position, or average click position is
    // a meaningless statistic.
    const positions = clicks.map((c) => c.position ?? 0);
    const top3 = positions.filter((p) => p <= 3).length;
    assert.ok(top3 / positions.length > 0.5, 'most clicks land in the first three results');

    // Head-heavy: one query should dominate.
    const counts = new Map<string, number>();
    for (const s of searches) counts.set(s.query!, (counts.get(s.query!) ?? 0) + 1);
    const sorted = [...counts.values()].sort((a, b) => b - a);
    assert.ok(sorted[0]! > sorted[sorted.length - 1]! * 5, 'volume is head-heavy, not uniform');
  });

  test('is deterministic for a given seed', async () => {
    const probe = async () => ({ total: 5, hits: [{ sku: 'A', parentId: 'P', effectivePrice: 10 }] });
    const a = await generateTraffic('ekena', probe, { sessions: 40, seed: 99 });
    const b = await generateTraffic('ekena', probe, { sessions: 40, seed: 99 });
    assert.equal(a.length, b.length);
    assert.deepEqual(a.map((e) => e.type), b.map((e) => e.type));
  });

  test('a purchase always follows an add to cart in the same session', async () => {
    const probe = async () => ({
      total: 10,
      hits: Array.from({ length: 10 }, (_, i) => ({ sku: `S${i}`, parentId: `P${i}`, effectivePrice: 50 })),
    });
    const events = await generateTraffic('ekena', probe, { sessions: 300, seed: 3 });
    const carts = new Set(events.filter((e) => e.type === 'add_to_cart').map((e) => `${e.sessionId}|${e.sku}`));
    for (const purchase of events.filter((e) => e.type === 'purchase')) {
      assert.ok(carts.has(`${purchase.sessionId}|${purchase.sku}`),
        'revenue must trace back to a cart, or attribution is fiction');
    }
  });
});
