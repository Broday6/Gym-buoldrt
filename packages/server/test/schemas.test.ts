import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import * as S from '../src/routes/schemas.js';

/**
 * The schemas are the runtime half of the API contract, so they are tested the
 * way the server applies them: same Ajv options, same shared definitions.
 */
function validator() {
  const ajv = new Ajv({ allErrors: true, removeAdditional: false, coerceTypes: false });
  for (const schema of S.SHARED_SCHEMAS) ajv.addSchema(schema as object);
  return ajv;
}

const accepts = (schema: object, body: unknown) => {
  const validate = validator().compile(schema);
  return validate(body) === true;
};

describe('shopper request validation', () => {
  test('a normal query is accepted', () => {
    assert.ok(accepts(S.searchBody, {
      q: 'black shutter', page: 2, hitsPerPage: 24,
      filters: { material: ['PVC', 'MDF'] }, sort: 'price_asc',
    }));
  });

  test('a wrongly typed field is rejected rather than crashing the handler', () => {
    // This used to reach the handler and 500 with an internal message.
    assert.equal(accepts(S.searchBody, { q: 123 }), false);
    assert.equal(accepts(S.searchBody, { filters: 'nope' }), false);
    assert.equal(accepts(S.searchBody, { page: 'abc' }), false);
  });

  test('anything that costs work is bounded', () => {
    assert.equal(accepts(S.searchBody, { hitsPerPage: 99999 }), false);
    assert.equal(accepts(S.searchBody, { page: 100000 }), false);
    assert.equal(accepts(S.searchBody, { page: 0 }), false);
    assert.equal(accepts(S.searchBody, { q: 'x'.repeat(600) }), false);
    assert.equal(accepts(S.eventsBody, {
      events: Array.from({ length: 500 }, () => ({ type: 'search' })),
    }), false);
  });

  test('an unknown field from an older SDK is tolerated', () => {
    // A storefront bundle outlives the server it was built against. Rejecting
    // a field a newer server dropped would break the page, not the request.
    assert.ok(accepts(S.searchBody, { q: 'beam', someFieldWeDropped: true }));
  });

  test('an event type the collector cannot handle is refused', () => {
    assert.ok(accepts(S.eventsBody, { events: [{ type: 'click', sku: 'A', position: 3 }] }));
    assert.equal(accepts(S.eventsBody, { events: [{ type: 'freeform' }] }), false);
    assert.equal(accepts(S.eventsBody, { events: [] }), false);
  });
});

describe('admin write validation', () => {
  test('a misspelled field fails instead of saving a record missing it', () => {
    assert.ok(accepts(S.badgeBody, { key: 'clearance', label: 'Clearance', priority: 5 }));
    assert.equal(accepts(S.badgeBody, { key: 'clearance', label: 'Clearance', prioroty: 5 }), false);
  });

  test('identifiers that become URLs and index labels are constrained', () => {
    assert.ok(accepts(S.collectionBody, { slug: 'dark-finishes', name: 'Dark Finishes' }));
    assert.equal(accepts(S.collectionBody, { slug: 'Dark Finishes', name: 'x' }), false);
    assert.equal(accepts(S.collectionBody, { slug: '../../etc', name: 'x' }), false);
    assert.equal(accepts(S.attributeBody, { key: 'room type', label: 'Room' }), false);
  });

  test('a rule is validated before it reaches the evaluator', () => {
    assert.ok(accepts(S.previewBody, {
      selector: { all: [{ field: 'margin', op: 'gte', value: 50 }] },
    }));
    assert.equal(accepts(S.previewBody, {
      selector: { all: [{ field: 'margin', op: 'nope' }] },
    }), false);
    assert.equal(accepts(S.previewBody, { selector: { all: [{ op: 'gte' }] } }), false);
  });

  test('a tone or match type outside the supported set is refused', () => {
    assert.equal(accepts(S.badgeBody, { key: 'a', label: 'A', tone: 'rainbow' }), false);
    assert.equal(accepts(S.redirectBody, { pattern: 'x', url: '/y', matchType: 'fuzzy' }), false);
    assert.ok(accepts(S.redirectBody, { pattern: 'x', url: '/y', matchType: 'regex' }));
  });

  test('the catalogue envelope is bounded but its rows stay free-form', () => {
    // A source row is whatever the customer's export produces; rejecting an
    // unrecognised column would reject the feed the mapping layer interprets.
    assert.ok(accepts(S.catalogIngestBody, {
      rows: [{ 'Item Name': 'x', 'Custom NetSuite Column': 'y' }],
    }));
    assert.equal(accepts(S.catalogUpdatesBody, { updates: [{ sku: 'A', prise: 4 }] }), false);
    assert.equal(accepts(S.catalogUpdatesBody, { updates: [{ sku: 'A', price: -1 }] }), false);
    assert.ok(accepts(S.catalogUpdatesBody, { updates: [{ sku: 'A', price: 12.5, inventory: 3 }] }));
  });
});

describe('path and query validation', () => {
  test('every route carries the site parameter, plus whatever it names', () => {
    const withSlug = S.forSite({}, S.SLUG_PARAM);
    const validate = validator().compile(withSlug.params as object);
    assert.ok(validate({ site: 'ekena', slug: 'dark-finishes' }));
    assert.equal(validate({ site: 'ekena' }), false, 'a missing slug must not reach the handler');
  });

  test('report windows are digits, so a query string cannot ask for a scan', () => {
    const validate = validator().compile(S.reportQuery);
    assert.ok(validate({ days: '30', format: 'csv' }));
    assert.equal(validate({ days: 'all' }), false);
    assert.equal(validate({ format: 'xml' }), false);
  });
});
