import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { Product } from '@compass/shared';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { SearchService } from '../src/services/search.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';
import {
  SelectorError, describeSelector, matches, validateSelector, type Selector,
} from '../src/merchandising/selector.js';
import {
  applyLabels, labelsFor, type CollectionDefinition, type LabelPlan,
} from '../src/merchandising/labels.js';
import { slugify } from '../src/merchandising/collections.js';

const site = new SiteRegistry().require('ekena');

function product(overrides: Partial<Product> = {}): Product {
  return {
    parentId: 'P1',
    title: 'Rustic Faux Wood Beam',
    description: 'A beam.',
    brand: 'Ekena Millwork',
    categoryPath: ['Millwork', 'Beams'],
    categoryIds: ['millwork', 'millwork/beams'],
    margin: 50,
    salesVelocity: 200,
    dateAdded: '2026-01-01',
    tags: ['beam', 'rustic'],
    variants: [
      { sku: 'P1-WAL', parentId: 'P1', variantTitle: 'Walnut', price: 400, inventory: 10,
        attributes: { finish: 'Walnut', style: 'Rustic', material: 'Endurathane' } },
      { sku: 'P1-BLK', parentId: 'P1', variantTitle: 'Black', price: 80, inventory: 4,
        attributes: { finish: 'Black', style: 'Rustic', material: 'Endurathane' } },
    ],
    ...overrides,
  };
}

describe('selector validation', () => {
  test('rejects a selector with no clauses', () => {
    assert.throws(() => validateSelector({}), SelectorError);
  });
  test('rejects an unknown comparator', () => {
    assert.throws(() => validateSelector({ all: [{ field: 'brand', op: 'sounds_like', value: 'x' }] }),
      SelectorError);
  });
  test('rejects a comparator missing its value', () => {
    assert.throws(() => validateSelector({ all: [{ field: 'brand', op: 'equals' }] }), SelectorError);
  });
  test('rejects "in" without an array', () => {
    assert.throws(() => validateSelector({ all: [{ field: 'brand', op: 'in', value: 'x' }] }),
      SelectorError);
  });
  test('accepts a well-formed nested selector', () => {
    assert.doesNotThrow(() => validateSelector({
      all: [{ field: 'margin', op: 'gte', value: 40 },
            { any: [{ field: 'brand', op: 'equals', value: 'Ekena Millwork' }] }],
    }));
  });
  test('refuses runaway nesting', () => {
    let nested: unknown = { all: [{ field: 'brand', op: 'exists' }] };
    for (let i = 0; i < 8; i++) nested = { all: [nested] };
    assert.throws(() => validateSelector(nested), SelectorError);
  });
});

describe('selector matching', () => {
  test('matches on a parent field', () => {
    assert.ok(matches(product(), { all: [{ field: 'brand', op: 'equals', value: 'ekena millwork' }] }));
  });

  test('an array field matches if any element does', () => {
    assert.ok(matches(product(), { all: [{ field: 'categoryPath', op: 'contains', value: 'beams' }] }));
  });

  test('a variant field matches if ANY variant satisfies it', () => {
    // The product is available in black, so it belongs in a black collection —
    // even though most of its variants are not.
    assert.ok(matches(product(), { all: [{ field: 'variant.attrs.finish', op: 'equals', value: 'Black' }] }));
  });

  test('aggregates read the way a merchandiser thinks about a product', () => {
    assert.ok(matches(product(), { all: [{ field: 'minPrice', op: 'lt', value: 100 }] }),
      'its cheapest variant is under $100');
    assert.ok(!matches(product(), { all: [{ field: 'maxPrice', op: 'lt', value: 100 }] }));
    assert.ok(matches(product(), { all: [{ field: 'inStock', op: 'equals', value: true }] }));
  });

  test('none excludes', () => {
    const selector: Selector = {
      all: [{ field: 'categoryPath', op: 'contains', value: 'Beams' }],
      none: [{ field: 'brand', op: 'equals', value: 'Ekena Millwork' }],
    };
    assert.ok(!matches(product(), selector));
  });

  test('between works on numbers and on dates', () => {
    assert.ok(matches(product(), { all: [{ field: 'margin', op: 'between', value: 40, to: 60 }] }));
    assert.ok(matches(product(), {
      all: [{ field: 'dateAdded', op: 'gte', value: '2025-06-01' }],
    }));
  });

  test('an empty selector matches nothing, rather than everything', () => {
    // A half-written rule must not sweep in the catalogue.
    assert.ok(!matches(product(), {} as Selector));
  });

  test('a missing field never matches', () => {
    assert.ok(!matches(product(), { all: [{ field: 'nonsense', op: 'equals', value: 'x' }] }));
    assert.ok(matches(product(), { all: [{ field: 'nonsense', op: 'missing' }] }));
  });

  test('describeSelector renders something a merchandiser can read', () => {
    const text = describeSelector({
      all: [{ field: 'margin', op: 'gte', value: 45 }, { field: 'inStock', op: 'equals', value: true }],
    });
    assert.match(text, /margin ≥ 45/);
    assert.match(text, /and/);
  });
});

function plan(collections: Partial<CollectionDefinition>[]): LabelPlan {
  return {
    collections: collections.map((c, i) => ({
      id: i + 1, siteId: 'ekena', slug: `c${i}`, name: `C${i}`, kind: 'marketing',
      parentId: null, selector: null, enabled: true, startsAt: null, endsAt: null, position: 0,
      includes: new Map(), excludes: new Set(),
      ...c,
    })) as CollectionDefinition[],
    attributes: [],
  };
}

describe('labelling', () => {
  test('a variant rule labels only the variants that satisfy it', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'dark', selector: { all: [{ field: 'variant.attrs.finish', op: 'equals', value: 'Black' }] },
    }]));
    // This is what makes browsing "Dark Finishes" show the black option rather
    // than whichever variant happened to sort first.
    assert.deepEqual(labels.get('P1-BLK'), ['collection:dark']);
    assert.deepEqual(labels.get('P1-WAL'), []);
  });

  test('a product-level rule labels every variant', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'ekena', selector: { all: [{ field: 'brand', op: 'equals', value: 'Ekena Millwork' }] },
    }]));
    assert.deepEqual(labels.get('P1-WAL'), ['collection:ekena']);
    assert.deepEqual(labels.get('P1-BLK'), ['collection:ekena']);
  });

  test('a hand-picked product carries the label on every variant', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'picked',
      selector: { all: [{ field: 'variant.attrs.finish', op: 'equals', value: 'Black' }] },
      includes: new Map([['P1', null]]),
    }]));
    // The merchandiser chose the product, not one of its options.
    assert.deepEqual(labels.get('P1-WAL'), ['collection:picked']);
  });

  test('an explicit exclude beats a matching rule', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'all-beams',
      selector: { all: [{ field: 'categoryPath', op: 'contains', value: 'Beams' }] },
      excludes: new Set(['P1']),
    }]));
    assert.deepEqual(labels.get('P1-WAL'), []);
  });

  test('an explicit include adds a product the rule missed', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'curated',
      selector: { all: [{ field: 'brand', op: 'equals', value: 'Someone Else' }] },
      includes: new Map([['P1', 3]]),
    }]));
    assert.deepEqual(labels.get('P1-WAL'), ['collection:curated']);
  });

  test('counts are per product, not per variant', () => {
    const { counts } = applyLabels([product(), product({ parentId: 'P2' })], plan([{
      slug: 'dark', selector: { all: [{ field: 'variant.attrs.finish', op: 'equals', value: 'Black' }] },
    }]));
    assert.equal(counts['collection:dark'], 2, 'two products, not four variants');
  });

  test('a disabled or expired collection still labels, but is not live', () => {
    const labels = labelsFor(product(), plan([{
      slug: 'seasonal',
      selector: { all: [{ field: 'brand', op: 'exists' }] },
      endsAt: new Date('2020-01-01'),
    }]));
    // Built into the index so activating it is a config change, not a reindex.
    assert.deepEqual(labels.get('P1-WAL'), ['collection:seasonal']);
  });
});

describe('slugs', () => {
  test('turns a name into a usable slug', () => {
    assert.equal(slugify('Farmhouse Kitchen!'), 'farmhouse-kitchen');
    assert.equal(slugify('  Black   Friday  '), 'black-friday');
  });
  test('an unusable name yields an empty slug rather than a broken one', () => {
    assert.equal(slugify('!!!'), '');
  });
});

describe('collections end to end', () => {
  const CROSS_CATEGORY: LabelPlan = {
    collections: [
      {
        id: 1, siteId: 'ekena', slug: 'farmhouse', name: 'Farmhouse', kind: 'marketing',
        parentId: null, enabled: true, startsAt: null, endsAt: null, position: 0,
        selector: { all: [{ field: 'variant.attrs.style', op: 'equals', value: 'Rustic' }] },
        includes: new Map(), excludes: new Set(),
      },
    ],
    attributes: [
      {
        id: 1, siteId: 'ekena', key: 'room', label: 'Room', displayType: 'checkbox',
        position: 20, collapsed: false, truncateAt: 8, sortBy: 'count', customOrder: null,
        enabled: true,
        values: [
          { id: 1, value: 'Kitchen', includes: new Set(), excludes: new Set(),
            selector: { any: [{ field: 'categoryPath', op: 'contains', value: 'Beams' }] } },
          { id: 2, value: 'Exterior', includes: new Set(), excludes: new Set(),
            selector: { any: [{ field: 'categoryPath', op: 'contains', value: 'Shutters' }] } },
        ],
      },
    ],
  };

  async function catalogue() {
    const engine = new SqliteEngine(':memory:');
    const beam = product();
    const shutter: Product = {
      parentId: 'S1',
      title: 'Board and Batten Shutter',
      description: 'A shutter.',
      brand: 'Ekena Millwork',
      categoryPath: ['Exterior', 'Shutters'],
      categoryIds: ['exterior', 'exterior/shutters'],
      margin: 30,
      salesVelocity: 100,
      variants: [
        { sku: 'S1-BLK', parentId: 'S1', variantTitle: 'Black', price: 200, inventory: 3,
          attributes: { finish: 'Black', style: 'Rustic', material: 'PVC' } },
      ],
    };
    await indexProducts(engine, 'ekena', [beam, shutter], { labels: CROSS_CATEGORY });
    // The pipeline learns which custom facets exist from this; in production it
    // is the CollectionStore, here a stub, because the search path should not
    // need a database just to know a facet's name.
    const collections = { listAttributes: async () => CROSS_CATEGORY.attributes };
    return { engine, service: new SearchService(engine, { collections }) };
  }

  test('a collection spans categories that share no taxonomy', async () => {
    const { engine, service } = await catalogue();
    const r = await service.browse(site, { collection: 'farmhouse' });
    assert.equal(r.totalHits, 2);
    const categories = new Set(r.hits.map((h) => h.categoryPath[0]));
    assert.deepEqual([...categories].sort(), ['Exterior', 'Millwork']);
    await engine.close();
  });

  test('a custom attribute filters and counts like a catalogue facet', async () => {
    const { engine, service } = await catalogue();
    const r = await service.search(site, { labelFilters: { room: ['Kitchen'] } });
    assert.equal(r.totalHits, 1);
    assert.equal(r.hits[0]?.parentId, 'P1');
    await engine.close();
  });

  test('a custom attribute appears as a facet, flagged as custom', async () => {
    const { engine, service } = await catalogue();
    const r = await service.search(site, {});
    const room = r.facets.find((f) => f.field === 'room');
    assert.ok(room, 'the custom facet is offered alongside the catalogue ones');
    assert.equal(room!.custom, true);
    assert.deepEqual(
      room!.values.map((v) => [v.value, v.count]).sort(),
      [['Exterior', 1], ['Kitchen', 1]],
    );
    await engine.close();
  });

  test('the total respects a custom attribute filter', async () => {
    const { engine, service } = await catalogue();
    // Regression: the facet pass lifted label filters and never reapplied them,
    // so the total and every built-in facet count ignored the filter.
    const r = await service.search(site, { labelFilters: { room: ['Exterior'] } });
    assert.equal(r.totalHits, 1);
    const brand = r.facets.find((f) => f.field === 'brand');
    assert.equal(brand?.values.reduce((n, v) => n + v.count, 0), 1);
    await engine.close();
  });

  test('a facet group still excludes its own selection from its own counts', async () => {
    const { engine, service } = await catalogue();
    const r = await service.search(site, { labelFilters: { room: ['Kitchen'] } });
    const room = r.facets.find((f) => f.field === 'room');
    assert.equal(room?.values.length, 2, 'the sibling value stays clickable');
    assert.ok(room?.values.find((v) => v.value === 'Kitchen')?.selected);
    await engine.close();
  });

  test('an unknown collection returns nothing rather than everything', async () => {
    const { engine, service } = await catalogue();
    const r = await service.browse(site, { collection: 'does-not-exist' });
    assert.equal(r.hits.length, 0);
    await engine.close();
  });
});
