import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { SiteRegistry } from '../src/config/sites.js';

/**
 * A facet rail is configuration, and the query analyser reads the same list —
 * so an attribute missing from it is not merely absent from the sidebar, it is
 * a word the analyser has never been told the meaning of.
 */
describe('offering what a feed carries as a filter', () => {
  test('an attribute the site has never seen becomes a filter', () => {
    const registry = new SiteRegistry();
    const added = registry.adoptFacets('ekena', ['frame', 'vent_type']);
    assert.deepEqual(added.map((f) => f.field), ['frame', 'vent_type']);
    assert.deepEqual(added.map((f) => f.label), ['Frame', 'Vent Type']);
    assert.ok(registry.require('ekena').defaultFacets.some((f) => f.field === 'frame'));
  });

  test('a facet a merchandiser already configured is left exactly as it is', () => {
    // Their label, order and display type outrank anything inferred.
    const registry = new SiteRegistry();
    const before = registry.require('ekena').defaultFacets.find((f) => f.field === 'finish');
    assert.deepEqual(registry.adoptFacets('ekena', ['finish']), []);
    assert.deepEqual(registry.require('ekena').defaultFacets.find((f) => f.field === 'finish'),
      before, 'the swatch display type survives');
  });

  test('new filters arrive collapsed and last', () => {
    // A rail that grows itself must not push the filters somebody chose off
    // the screen.
    const registry = new SiteRegistry();
    const [added] = registry.adoptFacets('ekena', ['frame']);
    const facets = registry.require('ekena').defaultFacets;
    assert.equal(added!.collapsed, true);
    assert.equal(added!.order, Math.max(...facets.map((f) => f.order)));
  });

  test('adopting for one site does not change another', () => {
    // Both built-in sites were handed the same array object, so this would
    // have silently added Architectural Depot's filters to Ekena's rail.
    const registry = new SiteRegistry();
    registry.adoptFacets('ekena', ['frame']);
    assert.ok(!registry.require('archdepot').defaultFacets.some((f) => f.field === 'frame'));
  });

  test('adopting twice adds nothing the second time', () => {
    const registry = new SiteRegistry();
    registry.adoptFacets('ekena', ['frame']);
    assert.deepEqual(registry.adoptFacets('ekena', ['frame']), []);
  });

  test('an unknown site is a no-op rather than a crash', () => {
    assert.deepEqual(new SiteRegistry().adoptFacets('nope', ['frame']), []);
  });
});
