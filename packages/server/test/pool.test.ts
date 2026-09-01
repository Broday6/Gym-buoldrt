import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sslFor } from '../src/db/pool.js';

/**
 * The failure this guards is silent. A database connection that encrypts
 * without checking the certificate looks identical to one that checks it —
 * same latency, same logs, same behaviour — right up until somebody is
 * reading the queries.
 */

const SUPABASE = 'postgres://postgres:pw@db.abcdefgh.supabase.co:5432/postgres';
const LOCAL = 'postgres://compass:compass@localhost:5432/compass';

describe('deciding how to connect to the database', () => {
  test('a hosted database is encrypted and its certificate checked', () => {
    assert.deepEqual(sslFor(SUPABASE), { rejectUnauthorized: true });
  });

  test('the decision does not depend on sslmode being in the URL', () => {
    // node-postgres treats `sslmode=require` as verify-full today and warns
    // that its next major version will not. Anything relying on the URL to
    // ask for verification would quietly stop getting it.
    assert.deepEqual(sslFor(`${SUPABASE}?sslmode=require`), { rejectUnauthorized: true });
    assert.deepEqual(sslFor(SUPABASE), { rejectUnauthorized: true });
  });

  test('a database on this machine is not put behind TLS', () => {
    // Local Postgres usually has no certificate at all, and requiring one
    // would break every developer and CI run for no gain.
    for (const url of [LOCAL, 'postgres://u:p@127.0.0.1:5432/db', 'postgres://u:p@[::1]:5432/db']) {
      assert.equal(sslFor(url), false, url);
    }
  });

  test('sslmode=disable is honoured, because saying so is a decision', () => {
    assert.equal(sslFor(`${SUPABASE}?sslmode=disable`), false);
  });

  test('a connection string that is not a URL is treated as a local socket', () => {
    assert.equal(sslFor('/var/run/postgresql'), false);
  });

  test('a pooler host is still a remote host', () => {
    // Supabase's transaction pooler is a different hostname on port 6543.
    assert.deepEqual(
      sslFor('postgres://postgres.abc:pw@aws-0-us-east-1.pooler.supabase.com:6543/postgres'),
      { rejectUnauthorized: true },
    );
  });
});
