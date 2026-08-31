import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler, type Job } from '../src/services/scheduler.js';
import type { Db } from '../src/db/pool.js';

/**
 * The scheduler runs inside the API process, so several instances behind a load
 * balancer each hold one. Everything here is about that: exactly one runs a job
 * per day, a failure retries rather than skipping the day, and nothing is
 * silent.
 */

/** A stand-in for the leases table, with the same primary-key behaviour. */
function fakeDb() {
  const claimed = new Set<string>();
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const key = params.join('|');
      if (sql.includes('INSERT INTO scheduled_runs')) {
        if (claimed.has(key)) return { rows: [], rowCount: 0 };
        claimed.add(key);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('DELETE FROM scheduled_runs')) {
        claimed.delete(key);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  } as unknown as Db;
  return { db, claimed };
}

const sites = { list: () => [{ id: 'ekena' }, { id: 'archdepot' }] } as never;
const silent = { info: () => {}, error: () => {} };

function build(job: Job, db: Db) {
  return new Scheduler({
    db, sites, analytics: {} as never, log: silent, jobs: [job],
  });
}

const at = (hour: number, day = '2026-08-31') => new Date(`${day}T${String(hour).padStart(2, '0')}:00:00Z`);

describe('scheduler', () => {
  test('a job runs once per site per day, however many instances are up', async () => {
    const { db } = fakeDb();
    let runs = 0;
    const job: Job = { name: 'rollup', hourUtc: 3, run: async () => { runs++; return 'ok'; } };

    // Three instances, all ticking, all day.
    const instances = [build(job, db), build(job, db), build(job, db)];
    for (let hour = 3; hour < 24; hour++) {
      for (const instance of instances) await instance.tick(at(hour));
    }
    assert.equal(runs, 2, 'once per site, not once per instance per tick');
  });

  test('a new day is a new claim', async () => {
    const { db } = fakeDb();
    let runs = 0;
    const scheduler = build({ name: 'rollup', hourUtc: 3, run: async () => { runs++; return 'ok'; } }, db);
    await scheduler.tick(at(4, '2026-08-31'));
    await scheduler.tick(at(4, '2026-09-01'));
    assert.equal(runs, 4, 'two sites across two days');
  });

  test('nothing runs before the scheduled hour', async () => {
    const { db } = fakeDb();
    let runs = 0;
    const scheduler = build({ name: 'rollup', hourUtc: 3, run: async () => { runs++; return 'ok'; } }, db);
    await scheduler.tick(at(1));
    assert.equal(runs, 0);
    await scheduler.tick(at(3));
    assert.equal(runs, 2);
  });

  test('a failure releases the claim so the next tick retries', async () => {
    const { db } = fakeDb();
    let attempts = 0;
    const scheduler = build({
      name: 'rollup', hourUtc: 3,
      run: async () => {
        attempts++;
        // Fail for both sites on the first pass, then succeed.
        if (attempts <= 2) throw new Error('database unavailable');
        return 'ok';
      },
    }, db);
    await scheduler.tick(at(3));
    assert.equal(attempts, 2, 'both sites attempted');
    await scheduler.tick(at(4));
    // A job that fails silently once a day is worse than one that retries.
    assert.equal(attempts, 4, 'the failed day was retried, not skipped');
  });

  test('the last outcome is reported, success or failure', async () => {
    const { db } = fakeDb();
    const scheduler = build({
      name: 'rollup', hourUtc: 0,
      run: async (site) => {
        if (site === 'ekena') return '412 events over 2 day(s)';
        throw new Error('connection refused');
      },
    }, db);
    await scheduler.tick(at(5));
    const status = scheduler.status();
    assert.equal(status['rollup:ekena']?.ok, true);
    assert.match(status['rollup:ekena']!.result, /412 events/);
    assert.equal(status['rollup:archdepot']?.ok, false);
    assert.match(status['rollup:archdepot']!.result, /connection refused/);
  });

  test('a slow job does not stack up behind itself', async () => {
    const { db } = fakeDb();
    let concurrent = 0;
    let peak = 0;
    const scheduler = build({
      name: 'rollup', hourUtc: 0,
      run: async () => {
        peak = Math.max(peak, ++concurrent);
        await new Promise((r) => setTimeout(r, 20));
        concurrent--;
        return 'ok';
      },
    }, db);
    await Promise.all([scheduler.tick(at(5)), scheduler.tick(at(5)), scheduler.tick(at(5))]);
    assert.equal(peak, 1, 'ticks overlapping must not run the job twice at once');
  });
});
