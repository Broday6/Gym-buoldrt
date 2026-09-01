import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildEntityIndex, liftEntities, type EntityIndex } from '../src/query/entities.js';
import { analyzeQuery } from '../src/query/analyze.js';
import { MemoryEngine } from '../src/engine/memory.js';
import { SqliteEngine } from '../src/engine/sqlite.js';
import { SearchService } from '../src/services/search.js';
import { SiteRegistry } from '../src/config/sites.js';
import { indexProducts } from '../src/ingest/pipeline.js';
import type { Product } from '@compass/shared';

const site = new SiteRegistry().require('ekena');

/**
 * "Heritage Beams" is a brand and a product type, not two words to look for in
 * text. Matching them as free text asks a much weaker question — does this
 * string appear anywhere in the document — which a bracket whose description
 * mentions beams answers yes to, while a brand that makes no beams at all falls
 * through to a fallback and returns that brand's brackets instead.
 */

function catalogue(): Product[] {
  const make = (
    id: string, title: string, brand: string, path: string[], ids: string[],
  ): Product => ({
    parentId: id, title, description: 'A millwork product.', brand,
    categoryPath: path, categoryIds: ids,
    salesVelocity: 100, margin: 40, reviewScore: 4, reviewCount: 5,
    dateAdded: '2025-01-01',
    variants: [{
      sku: `${id}-A`, parentId: id, variantTitle: 'Black', price: 100, inventory: 5,
      attributes: { finish: 'Black', material: 'PVC' },
    }],
  });
  return [
    make('B1', 'Rustic Faux Wood Ceiling Beam', 'Volterra', ['Millwork', 'Beams'], ['millwork', 'millwork/beams']),
    make('B2', 'Hand Hewn Faux Wood Ceiling Beam', 'Ekena Millwork', ['Millwork', 'Beams'], ['millwork', 'millwork/beams']),
    make('K1', 'Farmhouse Decorative Bracket', 'Timberthane', ['Exterior', 'Brackets'], ['exterior', 'exterior/brackets']),
    make('K2', 'Craftsman Decorative Bracket', 'Volterra', ['Exterior', 'Brackets'], ['exterior', 'exterior/brackets']),
    make('C1', 'Dentil Crown Moulding', 'Ekena Millwork', ['Millwork', 'Crown Moulding'], ['millwork', 'millwork/crown-moulding']),
  ];
}

async function service() {
  const engine = new SqliteEngine(':memory:');
  await indexProducts(engine, 'ekena', catalogue());
  return { search: new SearchService(engine), engine, close: () => engine.close() };
}

async function entityIndex(): Promise<EntityIndex> {
  const engine = new MemoryEngine();
  const sqlite = new SqliteEngine(':memory:');
  await indexProducts(sqlite, 'ekena', catalogue());
  const index = await buildEntityIndex(sqlite, 'ekena');
  await sqlite.close();
  void engine;
  return index;
}

describe('entity dictionary', () => {
  test('is built from the catalogue itself, with no configuration', async () => {
    const entities = await entityIndex();
    assert.equal(entities.brands.get('volterra'), 'Volterra');
    assert.equal(entities.brands.get('ekena millwork'), 'Ekena Millwork');
    assert.ok(entities.categories.get('beams'));
    assert.ok(entities.categories.get('crown moulding'));
  });

  test('singular and plural reach the same entity', async () => {
    const entities = await entityIndex();
    // A shopper types "beams"; the taxonomy says "Beams"; neither should
    // depend on the other's ending.
    assert.deepEqual(entities.categories.get('beam'), entities.categories.get('beams'));
  });
});

describe('lifting entities out of a query', () => {
  test('a brand and a product type are both recognised', async () => {
    const entities = await entityIndex();
    const { constraints, residual } = liftEntities(['volterra', 'beams'], entities);
    assert.deepEqual(constraints.map((c) => [c.kind, c.value]), [
      ['brand', 'Volterra'],
      ['category', 'millwork/beams'],
    ]);
    assert.deepEqual(residual, [], 'nothing is left to match as text');
  });

  test('a multi-word name is one entity, not two words', async () => {
    const entities = await entityIndex();
    const { constraints, residual } = liftEntities(['ekena', 'millwork', 'crown', 'moulding'], entities);
    assert.deepEqual(constraints.map((c) => c.source), ['ekena millwork', 'crown moulding']);
    assert.deepEqual(residual, []);
  });

  test('words that name nothing are left to search as text', async () => {
    const entities = await entityIndex();
    const { constraints, residual } = liftEntities(['rustic', 'beams'], entities);
    assert.deepEqual(constraints.map((c) => c.kind), ['category']);
    assert.deepEqual(residual, ['rustic']);
  });

  test('a token is consumed once', async () => {
    const entities = await entityIndex();
    const { residual } = liftEntities(['volterra', 'volterra'], entities);
    // One brand per query: a second is far more likely a describing word that
    // collides with a catalogue name than a shopper asking for two brands.
    assert.deepEqual(residual, ['volterra']);
  });

  test('an empty dictionary changes nothing', () => {
    const empty: EntityIndex = { brands: new Map(), categories: new Map(), maxTokens: 0 };
    const { constraints, residual } = liftEntities(['volterra', 'beams'], empty);
    assert.deepEqual(constraints, []);
    assert.deepEqual(residual, ['volterra', 'beams']);
  });

  test('the analyser reports an entity query as such', async () => {
    const entities = await entityIndex();
    const analyzed = analyzeQuery('volterra beams', { entities });
    assert.equal(analyzed.type, 'entity');
    assert.equal(analyzed.terms.length, 0);
  });

  test('a dimension alongside an entity still reads as dimensional', async () => {
    const entities = await entityIndex();
    const analyzed = analyzeQuery('4x6 beams', { entities });
    assert.equal(analyzed.type, 'dimensional');
    assert.ok(analyzed.constraints.some((c) => c.kind === 'category'));
    assert.ok(analyzed.constraints.some((c) => c.kind === 'dimension'));
  });
});

describe('searching by brand and product type', () => {
  test('both halves filter, so the results are exactly that brand of that thing', async () => {
    const { search, close } = await service();
    const r = await search.search(site, { q: 'volterra beams' });
    assert.equal(r.totalHits, 1);
    assert.equal(r.hits[0]!.brand, 'Volterra');
    assert.match(r.hits[0]!.title, /Beam/);
    assert.equal(r.rescue, undefined, 'a precise answer needs no rescue');
    await close();
  });

  test('the shopper is shown what was understood, so they can undo it', async () => {
    const { search, close } = await service();
    const r = await search.search(site, { q: 'volterra beams' });
    assert.deepEqual(r.parsedFilters?.map((c) => c.kind).sort(), ['brand', 'category']);
    await close();
  });

  test('a brand that does not make the thing says so, and shows the thing', async () => {
    // Timberthane makes brackets, not beams. Falling through to best sellers
    // would answer a question nobody asked.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'timberthane beams' });
    assert.equal(r.rescue?.strategy, 'drop_entity');
    assert.match(r.rescue!.notice!, /No Timberthane beams\. Showing all beams\./);
    assert.ok(r.hits.every((h) => /Beam/.test(h.title)), 'every result is still a beam');
    // And it stops claiming the brand it just dropped. A storefront prints
    // these; naming a filter the results do not obey is a lie about the grid.
    assert.equal(r.appliedFilters.brand, undefined);
    assert.ok(!r.parsedFilters?.some((c) => c.kind === 'brand'));
    assert.ok(r.parsedFilters?.some((c) => c.kind === 'category'));
    await close();
  });

  test('an unknown brand still gets the product type it asked for', async () => {
    // "heritage beams" in a catalogue with no Heritage brand still means beams.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'heritage beams' });
    assert.equal(r.rescue?.strategy, 'drop_entity');
    assert.ok(r.totalHits > 0);
    assert.ok(r.hits.every((h) => /Beam/.test(h.title)));
    await close();
  });

  test('an explicit choice the shopper already made is never overridden', async () => {
    // Inside Brackets, typing a brand narrows within it rather than teleporting
    // them out of the category they chose.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'volterra beams', categoryId: 'exterior/brackets' });
    assert.ok(r.hits.every((h) => /Bracket/.test(h.title)), 'still inside brackets');
    await close();
  });

  test('a shopper can turn the reading off, and it stays off', async () => {
    // The brand a query names is applied as an ordinary filter, so the
    // storefront offers a way to take it off. Removing the filter alone would
    // not survive: the next search re-reads the same words and lifts the same
    // brand. `entities: false` is what makes the control real.
    const { search, close } = await service();
    const lifted = await search.search(site, { q: 'volterra bracket' });
    assert.deepEqual(lifted.appliedFilters.brand, ['Volterra']);
    assert.ok(lifted.parsedFilters?.some((c) => c.kind === 'brand'));

    const literal = await search.search(site, { q: 'volterra bracket', entities: false });
    assert.equal(literal.appliedFilters.brand, undefined);
    assert.equal(literal.parsedFilters, undefined);
    assert.ok(literal.totalHits >= lifted.totalHits,
      'dropping a constraint cannot return fewer products');
    await close();
  });

  test('a product described by its features finds exactly those', async () => {
    // "black pvc bracket" is not three words to look for in text — it is a
    // finish, a material and a product type. Searched as text, a white PVC
    // bracket whose description mentions black would answer yes.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'black pvc bracket' });
    assert.deepEqual(r.appliedFilters.finish, ['Black']);
    assert.deepEqual(r.appliedFilters.material, ['PVC']);
    assert.ok(r.hits.every((h) => /Bracket/.test(h.title)), 'and still brackets');
    const kinds = r.parsedFilters?.map((c) => c.kind) ?? [];
    assert.equal(kinds.filter((k) => k === 'attribute').length, 2);
    await close();
  });

  test('a brand wins over a feature that shares its name', async () => {
    // Order matters: a catalogue can easily hold a finish called the same
    // thing as a brand, and the brand is the stronger reading.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'volterra' });
    assert.deepEqual(r.appliedFilters.brand, ['Volterra']);
    await close();
  });

  test('a query naming five features does not filter itself to nothing', async () => {
    // Every lifted attribute is a filter that can empty the page, and past
    // three the extra matches are far more likely to be describing words that
    // collide with a catalogue value than a shopper narrowing five ways.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'black pvc rustic farmhouse craftsman bracket' });
    const attributes = (r.parsedFilters ?? []).filter((c) => c.kind === 'attribute');
    assert.ok(attributes.length <= 3, `lifted ${attributes.length}`);
    await close();
  });

  test('an impossible combination of features relaxes rather than giving up', async () => {
    // The catalogue has black brackets and it has polyurethane ones, but no
    // black polyurethane ones. Falling through to best sellers would throw
    // away two things the shopper said that the catalogue understands.
    const { search, close } = await service();
    const r = await search.search(site, { q: 'black polyurethane bracket' });
    assert.ok(r.totalHits > 0);
    assert.deepEqual(r.appliedFilters.finish, ['Black'], 'the first feature is kept');
    assert.equal(r.appliedFilters.material, undefined, 'the second is the one dropped');
    assert.match(r.rescue!.notice!, /Showing Black/);
    await close();
  });

  test('a plain keyword query is untouched by any of this', async () => {
    const { search, close } = await service();
    const r = await search.search(site, { q: 'farmhouse' });
    assert.equal(r.queryType, 'keyword');
    assert.equal(r.totalHits, 1);
    await close();
  });
});

describe('a query that names two product types', () => {
  /**
   * The bug this covers returned ceiling medallions for "ceiling beams".
   * "Ceiling" is an aisle in its own right and comes first, so lifting the
   * earliest match filtered to it and dropped "beams" entirely — the shopper
   * asked for beams and got the one thing in that aisle which is not one.
   */
  function twoAisles(): Product[] {
    const make = (id: string, title: string, path: string[], ids: string[]): Product => ({
      parentId: id, title, description: 'A millwork product.', brand: 'Ekena Millwork',
      categoryPath: path, categoryIds: ids,
      salesVelocity: 100, margin: 40, reviewScore: 4, reviewCount: 5, dateAdded: '2025-01-01',
      variants: [{ sku: `${id}-A`, parentId: id, variantTitle: '', price: 100, inventory: 5,
        attributes: {} }],
    });
    return [
      make('B1', 'Rustic Faux Wood Ceiling Beam', ['Millwork', 'Beams'],
        ['millwork', 'millwork/beams']),
      make('M1', 'Acanthus Ceiling Medallion', ['Interior', 'Ceiling', 'Ceiling Medallions'],
        ['interior', 'interior/ceiling', 'interior/ceiling/ceiling-medallions']),
    ];
  }

  async function index(): Promise<EntityIndex> {
    const sqlite = new SqliteEngine(':memory:');
    await indexProducts(sqlite, 'ekena', twoAisles());
    const built = await buildEntityIndex(sqlite, 'ekena');
    await sqlite.close();
    return built;
  }

  test('the last one is the thing being asked for', async () => {
    const { constraints, residual } = liftEntities(['ceiling', 'beams'], await index());
    const category = constraints.filter((c) => c.kind === 'category');
    assert.equal(category.length, 1, 'exactly one aisle: nothing is both a beam and a medallion');
    assert.equal(category[0]!.value, 'millwork/beams');
    // And the loser is not thrown away — it still has to be matched, and it is
    // matched by the words in "Faux Wood Ceiling Beam".
    assert.deepEqual(residual, ['ceiling']);
  });

  test('a longer product name beats a shorter one inside it', async () => {
    const { constraints, residual } = liftEntities(['ceiling', 'medallion'], await index());
    assert.equal(constraints.find((c) => c.kind === 'category')?.value,
      'interior/ceiling/ceiling-medallions');
    assert.deepEqual(residual, [], 'both words are the name, so neither is left over');
  });

  test('a department in front of a product type narrows to the product type', async () => {
    const { constraints } = liftEntities(['interior', 'beams'], await index());
    assert.equal(constraints.find((c) => c.kind === 'category')?.value, 'millwork/beams');
  });

  test('one aisle on its own is still lifted', async () => {
    const { constraints, residual } = liftEntities(['beams'], await index());
    assert.equal(constraints.find((c) => c.kind === 'category')?.value, 'millwork/beams');
    assert.deepEqual(residual, []);
  });
});
