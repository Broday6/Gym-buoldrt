import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HistoryService, diff } from '../src/services/history.js';
import type { Db } from '../src/db/pool.js';

/**
 * An undo is only as good as the record it works from. These cover both halves:
 * that the diff describes what actually changed, and that reverting puts the
 * prior state back without ever losing the history of having done so.
 */

function fakeDb(rows: Record<string, unknown>[]) {
  const inserted: unknown[][] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.includes('INSERT INTO audit_log')) {
        inserted.push(params);
        return { rows: [], rowCount: 1 };
      }
      return { rows, rowCount: rows.length };
    },
  } as unknown as Db;
  return { db, inserted };
}

const entry = (over: Record<string, unknown> = {}) => ({
  id: '7', site_id: 'ekena', actor: 'sarah', action: 'upsert', entity_type: 'badge',
  entity_id: 'clearance', before: { key: 'clearance', label: 'Clearance', priority: 100 },
  after: { key: 'clearance', label: 'Big Clearance', priority: 5 },
  occurred_at: new Date('2026-08-31T09:00:00Z'), ...over,
});

function service(rows: Record<string, unknown>[]) {
  const calls: string[] = [];
  const record = (name: string) => async (...args: unknown[]) => {
    calls.push(`${name}(${args.slice(1).map((a) => JSON.stringify(a)).join(',')})`);
    return true;
  };
  const { db, inserted } = fakeDb(rows);
  const stores = {
    collections: {
      create: record('collection.create'), remove: record('collection.remove'),
      createAttribute: record('attribute.create'), removeAttribute: record('attribute.remove'),
      createBadge: record('badge.create'), removeBadge: record('badge.remove'),
    },
    synonyms: { create: record('synonym.create'), remove: record('synonym.remove') },
    redirects: { create: record('redirect.create'), remove: record('redirect.remove') },
  };
  return { history: new HistoryService(db, stores as never), calls, inserted };
}

describe('diff', () => {
  test('reports only the fields that moved', () => {
    const changes = diff(
      { label: 'Clearance', priority: 100, tone: 'sale' },
      { label: 'Big Clearance', priority: 100, tone: 'sale' },
    );
    assert.deepEqual(changes, [{ field: 'label', before: 'Clearance', after: 'Big Clearance' }]);
  });

  test('bookkeeping columns are not changes anyone made', () => {
    const changes = diff(
      { label: 'A', id: 1, updatedAt: 'then', siteId: 'ekena', author: 'x' },
      { label: 'A', id: 2, updatedAt: 'now', siteId: 'ekena', author: 'y' },
    );
    assert.deepEqual(changes, []);
  });

  test('a nested rule change is detected, not glossed over', () => {
    const changes = diff(
      { selector: { all: [{ field: 'margin', op: 'gte', value: 50 }] } },
      { selector: { all: [{ field: 'margin', op: 'gte', value: 55 }] } },
    );
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.field, 'selector');
  });

  test('a creation shows every field arriving, a deletion every field leaving', () => {
    assert.deepEqual(diff(null, { label: 'New' }),
      [{ field: 'label', before: null, after: 'New' }]);
    assert.deepEqual(diff({ label: 'Gone' }, null),
      [{ field: 'label', before: 'Gone', after: null }]);
  });
});

describe('history', () => {
  test('each entry carries its own change set', async () => {
    const { history } = service([entry()]);
    const [row] = await history.list('ekena');
    assert.deepEqual(row!.changes?.map((c) => c.field), ['label', 'priority']);
    assert.equal(row!.revertible, true);
  });

  test('a change with no recorded prior state says so instead of offering a button', async () => {
    // Entries written before the log captured `before` would otherwise offer an
    // undo that silently deletes the thing it claims to restore.
    const { history } = service([entry({ before: null, after: null })]);
    const [row] = await history.list('ekena');
    assert.equal(row!.revertible, false);
    assert.match(row!.reason!, /predates full history/);
  });

  test('an entity type the undo cannot rebuild is marked, with a reason', async () => {
    const { history } = service([entry({ entity_type: 'catalog', before: { a: 1 } })]);
    const [row] = await history.list('ekena');
    assert.equal(row!.revertible, false);
    assert.match(row!.reason!, /cannot be undone/);
  });
});

describe('revert', () => {
  test('an edit is undone by writing the prior state back', async () => {
    const { history, calls } = service([entry()]);
    const result = await history.revert('ekena', 7, 'sarah');
    assert.equal(result.action, 'restored');
    assert.match(calls[0]!, /^badge\.create/);
    assert.match(calls[0]!, /"label":"Clearance"/, 'the prior label, not the new one');
  });

  test('a creation is undone by removing what it created', async () => {
    const { history, calls } = service([entry({ action: 'create', before: null })]);
    const result = await history.revert('ekena', 7, 'sarah');
    assert.equal(result.action, 'removed');
    assert.deepEqual(calls, ['badge.remove("clearance")']);
  });

  test('a deletion is undone by putting the entity back', async () => {
    const { history, calls } = service([entry({ action: 'delete', after: null })]);
    const result = await history.revert('ekena', 7, 'sarah');
    assert.equal(result.action, 'restored');
    assert.match(calls[0]!, /^badge\.create/);
  });

  test('undoing an undo does not compound the label', async () => {
    // `revert:revert:revert:upsert` is accurate and unreadable.
    const { history, inserted } = service([entry({ action: 'revert' })]);
    await history.revert('ekena', 7, 'sarah');
    assert.equal(inserted[0]![2], 'revert');
  });

  test('the undo is itself recorded, with its sides reversed', async () => {
    // So undoing the undo is the same operation again, and the log stays
    // append-only rather than editing away the thing that went wrong.
    const { history, inserted } = service([entry()]);
    await history.revert('ekena', 7, 'sarah');
    const [siteId, actor, action, entityType, entityId, before, after] = inserted[0]!;
    assert.equal(siteId, 'ekena');
    assert.equal(actor, 'sarah');
    assert.equal(action, 'revert');
    assert.equal(entityType, 'badge');
    assert.equal(entityId, 'clearance');
    assert.match(String(before), /Big Clearance/, 'the undo starts from what the change produced');
    assert.match(String(after), /"label":"Clearance"/, 'and ends at what it replaced');
  });

  test('reverting a labelled entity says the index needs rebuilding', async () => {
    // Collections, attributes and badges are baked into the index as labels, so
    // the undo is not visible in results until the next ingest.
    for (const type of ['collection', 'attribute', 'badge']) {
      const { history } = service([entry({ entity_type: type })]);
      assert.equal((await history.revert('ekena', 7, 'x')).reindexRequired, true, type);
    }
    for (const type of ['synonym', 'redirect']) {
      const { history } = service([entry({ entity_type: type, entity_id: '3' })]);
      assert.equal((await history.revert('ekena', 7, 'x')).reindexRequired, false, type);
    }
  });

  test('a restored rule is honest about getting a new id', async () => {
    const { history } = service([entry({ entity_type: 'synonym', entity_id: '3' })]);
    const [row] = await history.list('ekena');
    assert.match(row!.reason!, /new id/);
  });

  test('an entry from another site cannot be reverted', async () => {
    const { history } = service([]);
    await assert.rejects(() => history.revert('ekena', 7, 'sarah'), /no history entry/);
  });

  test('an unrevertible entry is refused rather than half-applied', async () => {
    const { history, calls } = service([entry({ entity_type: 'catalog', before: { a: 1 } })]);
    await assert.rejects(() => history.revert('ekena', 7, 'sarah'));
    assert.deepEqual(calls, [], 'nothing was written');
  });
});
