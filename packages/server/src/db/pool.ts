import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const HERE = dirname(fileURLToPath(import.meta.url));

export type Db = pg.Pool;

/**
 * Whether to encrypt the connection, and whether to check who is on the end.
 *
 * Decided here rather than left to the URL, for two reasons. A managed
 * database — Supabase, Neon, RDS — refuses an unencrypted connection outright,
 * and a URL without `sslmode` simply fails to connect with an error that says
 * nothing about TLS. And `sslmode=require`, the obvious thing to reach for,
 * is a trap: node-postgres currently treats it as `verify-full`, but warns
 * that its next major version adopts libpq semantics, where `require`
 * encrypts without verifying the certificate at all. An upgrade would
 * silently turn a checked connection into an unchecked one, with the
 * connection string unchanged and nothing in the logs.
 *
 * So: anything that is not on this machine gets TLS with the certificate
 * verified. `sslmode=disable` is honoured, because saying so is a decision.
 * A private CA goes in PGSSLROOTCERT.
 */
export function sslFor(connectionString: string): pg.PoolConfig['ssl'] {
  if (/[?&]sslmode=disable\b/.test(connectionString)) return false;

  let host = '';
  try {
    // URL keeps the brackets on an IPv6 literal: [::1] rather than ::1.
    host = new URL(connectionString).hostname.replace(/^\[|\]$/g, '');
  } catch {
    // A unix socket path or something unparseable: not a network hop.
    return false;
  }
  const local = !host
    || host === 'localhost'
    || host === '127.0.0.1'
    || host === '::1'
    || host.endsWith('.local');
  if (local) return false;

  const ca = process.env.PGSSLROOTCERT;
  if (process.env.COMPASS_DB_SSL_INSECURE === '1') {
    // Deliberately loud. This accepts any certificate, which means anything
    // able to answer for the host can read every query.
    console.warn('DATABASE SSL: certificate verification is OFF '
      + '(COMPASS_DB_SSL_INSECURE=1). The connection is encrypted but unauthenticated.');
    return { rejectUnauthorized: false };
  }
  return {
    rejectUnauthorized: true,
    ...(ca ? { ca: readFileSync(ca, 'utf8') } : {}),
  };
}

export function createPool(connectionString = process.env.DATABASE_URL): Db {
  if (!connectionString) {
    throw new Error('DATABASE_URL is not set; the config + analytics store is required');
  }
  const pool = new pg.Pool({
    connectionString,
    ssl: sslFor(connectionString),
    max: Number(process.env.PGPOOL_MAX ?? 10),
    idleTimeoutMillis: 30_000,
    // Analytics writes must never wedge a request; fail fast and buffer instead.
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error({ err: err.message }, 'idle postgres client error');
  });
  return pool;
}

/** Apply every .sql file in migrations/ once, in name order. */
export async function migrate(db: Db, dir = join(HERE, 'migrations')): Promise<string[]> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const applied = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const ran: string[] = [];
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      ran.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`migration ${file} failed: ${(err as Error).message}`);
    } finally {
      client.release();
    }
  }
  return ran;
}
