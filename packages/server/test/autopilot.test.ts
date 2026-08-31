import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AutopilotService, type Proposal } from '../src/services/autopilot.js';
import type { Db } from '../src/db/pool.js';

/**
 * A system that changes merchandising on its own has to be wrong in safe ways.
 * These cover the three that would matter most: proposing ten conflicting
 * changes for one query, applying something destructive without a person, and
 * making a change that leaves no trace.
 */

/** Answers each of the service's queries by matching on a fragment of its SQL. */
function fakeDb(answers: [string, Record<string, string>[]][]): Db & { writes: unknown[][] } {
  const writes: unknown[][] = [];
  const db = {
    writes,
    query: async (sql: string, params: unknown[] = []) => {
      for (const [needle, rows] of answers) {
        if (sql.includes(needle)) return { rows, rowCount: rows.length };
      }
      writes.push([sql, params]);
      return { rows: [], rowCount: 0 };
    },
  };
  return db as unknown as Db & { writes: unknown[][] };
}

const CLICKED_DEEP = [
  { query: 'beam', sku: 'A-1', parent_id: 'A', clicks: '9', searches: '300',
    avg_position: '11', carts: '3' },
  { query: 'beam', sku: 'B-1', parent_id: 'B', clicks: '7', searches: '300',
    avg_position: '9', carts: '1' },
  { query: 'beam', sku: 'C-1', parent_id: 'C', clicks: '6', searches: '300',
    avg_position: '8', carts: '0' },
  { query: 'beam', sku: 'D-1', parent_id: 'D', clicks: '5', searches: '300',
    avg_position: '4', carts: '0' },
  { query: 'shutter', sku: 'E-1', parent_id: 'E', clicks: '6', searches: '80',
    avg_position: '7', carts: '2' },
];

function service(rows = CLICKED_DEEP, stores = {}) {
  return new AutopilotService(
    fakeDb([['WITH q AS', rows], ['daily_product_stats', []], ['daily_query_stats', []]]),
    stores,
  );
}

describe('autopilot proposals', () => {
  test('one proposal per query, not one per product', async () => {
    // A rule is stored per query. Four single-product proposals for "beam"
    // would not be four changes — they would be one change applied four times,
    // each overwriting the last, and the merchandiser would watch three of
    // their clicks silently undo the others.
    const proposals = await service().proposals('ekena');
    const promotions = proposals.filter((p) => p.kind === 'promote');
    assert.equal(promotions.length, 2, 'one for beam, one for shutter');
    assert.deepEqual(promotions.map((p) => p.query).sort(), ['beam', 'shutter']);
  });

  test('a promotion pins at most a top row, ordered by how hard shoppers worked', async () => {
    const [beam] = (await service().proposals('ekena')).filter((p) => p.query === 'beam');
    assert.ok(beam);
    assert.equal(beam.products?.length, 3, 'a top row, not a hand-made list');
    // Ranked on clicks x depth: the product clicked most often from furthest
    // down is the strongest evidence the order is wrong.
    assert.deepEqual(beam.products?.map((p) => p.parentId), ['A', 'B', 'C']);
    assert.deepEqual(beam.products?.map((p) => p.position), [1, 2, 3]);
  });

  test('a proposal carries the numbers that produced it', async () => {
    const [beam] = (await service().proposals('ekena')).filter((p) => p.query === 'beam');
    const labels = beam!.evidence.map((e) => e.label);
    for (const expected of ['Clicks they earned', 'Average position clicked', 'Added to cart']) {
      assert.ok(labels.includes(expected), `${expected} is missing from the evidence`);
    }
    assert.ok(beam!.confidence > 0 && beam!.confidence < 1, 'evidence, never proof');
  });

  test('reach and confidence order the list, so a popular guess does not lead', async () => {
    const proposals = await service().proposals('ekena');
    const queries = proposals.filter((p) => p.kind === 'promote').map((p) => p.query);
    assert.equal(queries[0], 'beam', '300 searches beats 80 at similar confidence');
  });

  test('applying a promotion writes one rule with every pin in it', async () => {
    const saved: unknown[] = [];
    const stores = {
      queryRules: {
        forQuery: async () => null,
        save: async (_site: string, input: unknown) => {
          saved.push(input);
          return { id: 1 };
        },
      },
    };
    const svc = service(CLICKED_DEEP, stores as never);
    const [beam] = (await svc.proposals('ekena')).filter((p) => p.query === 'beam');
    await svc.apply('ekena', beam!, 'tester');

    assert.equal(saved.length, 1, 'one rule, not one per product');
    const input = saved[0] as { query: string; actions: { action: string; position: number }[] };
    assert.equal(input.query, 'beam');
    assert.deepEqual(input.actions.map((a) => a.position), [1, 2, 3]);
    assert.ok(input.actions.every((a) => a.action === 'pin'));
  });

  test('every application is written to the change history', async () => {
    const stores = {
      queryRules: { forQuery: async () => null, save: async () => ({ id: 7 }) },
    };
    const db = fakeDb([['WITH q AS', CLICKED_DEEP], ['daily_product_stats', []],
      ['daily_query_stats', []]]);
    const svc = new AutopilotService(db, stores as never);
    const [beam] = (await svc.proposals('ekena')).filter((p) => p.query === 'beam');

    // Recorded by the service, not by the route: an unattended nightly run
    // never goes through a route, and that is the path where an unrecorded
    // change would be invisible.
    await svc.apply('ekena', beam!, 'autopilot');
    const audits = db.writes.filter(([sql]) => String(sql).includes('audit_log'));
    assert.equal(audits.length, 1);
    assert.ok(String(audits[0]![1]).includes('autopilot'), 'the trail names who did it');
  });

  test('a demotion is never applied automatically', async () => {
    const svc = service();
    const demotion: Proposal = {
      id: 'demote:X', kind: 'demote', query: '', sku: 'X',
      summary: 'X is shown often and never chosen', evidence: [], confidence: 1, reach: 500,
    };
    // Hiding a product is the one action here that loses a sale outright
    // rather than reordering one, and "no clicks" can mean the photograph is
    // missing rather than the product being wrong.
    await assert.rejects(() => svc.apply('ekena', demotion, 'autopilot'),
      /reviewed by a person/);
  });

  test('an unattended run only ever promotes, and only when confident', async () => {
    const saved: unknown[] = [];
    const stores = {
      queryRules: {
        forQuery: async () => null,
        save: async (_s: string, input: unknown) => { saved.push(input); return { id: 1 }; },
      },
    };
    const svc = service(CLICKED_DEEP, stores as never);
    const { applied } = await svc.run('ekena', 0.7);
    assert.ok(applied.every((p) => p.kind === 'promote'));
    assert.ok(applied.every((p) => p.confidence >= 0.7));
    assert.equal(saved.length, applied.length);
  });

  test('a dismissed proposal stops being offered', async () => {
    const svc = new AutopilotService(fakeDb([
      ['WITH q AS', CLICKED_DEEP],
      ['daily_product_stats', []],
      ['daily_query_stats', []],
      ['autopilot_dismissals', [{ proposal_id: 'promote:beam:A,B,C' }]],
    ]));
    const proposals = await svc.proposals('ekena');
    assert.ok(!proposals.some((p) => p.query === 'beam'),
      'proposals are derived on every read, so a refusal has to be remembered');
    assert.ok(proposals.some((p) => p.query === 'shutter'), 'the others survive');
  });
});
