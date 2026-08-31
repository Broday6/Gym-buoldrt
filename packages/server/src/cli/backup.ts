/**
 * Backup, verify and restore the configuration and analytics database.
 *
 *   npm run backup                    # dump, verify, prune
 *   npm run backup -- verify <file>   # check an existing dump is readable
 *   npm run backup -- restore <file>  # restore into DATABASE_URL
 *   npm run backup -- list
 *
 * The retrieval index is disposable: it rebuilds from the catalogue in minutes.
 * PostgreSQL is not. It is the only home of every collection, custom attribute,
 * synonym, redirect, badge, API key hash and analytics event — every
 * merchandising decision anyone has made.
 *
 * Two things make a backup real rather than nominal, and both are done here
 * rather than described in a runbook nobody runs:
 *
 *   - **Every dump is verified immediately.** An unreadable backup discovered
 *     during an incident is the same as no backup, and `pg_dump` exiting 0 is
 *     not proof the file can be read back.
 *   - **The expected tables are checked by name.** A dump that restores cleanly
 *     but is missing `collections` because someone pointed this at the wrong
 *     database is worse than a failure, because it looks like success.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const run = promisify(execFile);

const DIR = process.env.COMPASS_BACKUP_DIR ?? './data/backups';
const URL_ = process.env.DATABASE_URL;
/** Keep every daily for this long; a weekly is kept for four times as long. */
const KEEP_DAYS = Number(process.env.COMPASS_BACKUP_KEEP_DAYS ?? 14);

/**
 * Losing any one of these loses work that cannot be recomputed from the
 * catalogue. A dump missing one is a failed backup, not a partial one.
 */
const REQUIRED_TABLES = [
  'sites', 'api_keys', 'collections', 'collection_members', 'custom_attributes',
  'custom_attribute_values', 'custom_attribute_assignments', 'badges',
  'synonyms', 'redirects', 'events', 'daily_query_stats', 'daily_product_stats',
  'audit_log',
];

function requireUrl(): string {
  if (!URL_) {
    console.error('DATABASE_URL is not set — nothing to back up.');
    process.exit(1);
  }
  return URL_;
}

const human = (bytes: number) =>
  bytes > 1e9 ? `${(bytes / 1e9).toFixed(1)}GB`
    : bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)}MB`
      : `${Math.max(1, Math.round(bytes / 1e3))}KB`;

/** Read a dump's table of contents. This is what proves the file is readable. */
async function tablesIn(file: string): Promise<string[]> {
  const { stdout } = await run('pg_restore', ['--list', file], { maxBuffer: 64 * 1024 * 1024 });
  return [...stdout.matchAll(/TABLE DATA \S+ (\S+)/g)].map((m) => m[1]!);
}

async function verify(file: string): Promise<string[]> {
  const tables = await tablesIn(file);
  const missing = REQUIRED_TABLES.filter((t) => !tables.includes(t));
  if (missing.length) {
    throw new Error(
      `dump is missing ${missing.length} required table(s): ${missing.join(', ')}\n` +
      'This is a failed backup, not a partial one — check DATABASE_URL points at the right database.',
    );
  }
  return tables;
}

async function backup(): Promise<void> {
  const url = requireUrl();
  mkdirSync(DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = resolve(join(DIR, `compass-${stamp}.dump`));

  process.stdout.write(`dumping to ${file} … `);
  // Custom format: compressed, and restorable table by table, which is what
  // you want at 3am when only one table needs rolling back.
  await run('pg_dump', ['--format=custom', '--no-owner', '--no-privileges', '--file', file, url],
    { maxBuffer: 64 * 1024 * 1024 });
  const size = statSync(file).size;
  console.log(human(size));

  process.stdout.write('verifying … ');
  const tables = await verify(file);
  console.log(`ok, ${tables.length} tables readable`);

  prune();
  console.log(`\nRestore this with:\n  npm run backup -- restore ${file}\n`);
}

/**
 * Keep every backup for KEEP_DAYS, and one per week beyond that.
 *
 * Corruption and bad merchandising changes are often noticed late, so the
 * retention has to reach back further than the daily window — without keeping
 * every daily forever.
 */
function prune(): void {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.dump')).sort();
  const now = Date.now();
  const keptWeeks = new Set<string>();
  let removed = 0;
  for (const name of files) {
    const path = join(DIR, name);
    const ageDays = (now - statSync(path).mtimeMs) / 86_400_000;
    if (ageDays <= KEEP_DAYS) continue;
    if (ageDays > KEEP_DAYS * 4) { unlinkSync(path); removed++; continue; }
    const week = new Date(statSync(path).mtimeMs).toISOString().slice(0, 8);
    if (keptWeeks.has(week)) { unlinkSync(path); removed++; } else keptWeeks.add(week);
  }
  if (removed) console.log(`pruned ${removed} old backup(s)`);
}

async function restore(file: string, force: boolean): Promise<void> {
  const url = requireUrl();
  await verify(file);

  // Restoring over live data is the one irreversible thing in this file.
  const { stdout } = await run('psql', [url, '-tAc',
    "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"]);
  const existing = Number(stdout.trim());
  if (existing > 0 && !force) {
    console.error(
      `\nThe target database already has ${existing} tables.\n` +
      'Restoring would overwrite them. Restore into an empty database, or pass --force\n' +
      'if you are certain this is the recovery you intend.\n',
    );
    process.exit(1);
  }

  process.stdout.write(`restoring ${file} … `);
  try {
    await run('pg_restore', ['--dbname', url, '--no-owner', '--no-privileges',
      ...(force ? ['--clean', '--if-exists'] : []), file], { maxBuffer: 64 * 1024 * 1024 });
  } catch (err) {
    // pg_restore exits non-zero on warnings it has already worked around, so
    // the exit code alone is not the answer — check what actually landed.
    const detail = (err as { stderr?: string }).stderr ?? String(err);
    const { stdout: after } = await run('psql', [url, '-tAc',
      "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'"]);
    if (Number(after.trim()) === 0) throw err;
    console.log(`completed with warnings\n\n${detail.trim().split('\n').slice(-5).join('\n')}\n`);
  }

  const { stdout: counts } = await run('psql', [url, '-tAc',
    REQUIRED_TABLES.map((t) => `SELECT '${t}', count(*) FROM ${t}`).join(' UNION ALL ')]);
  console.log('\nrestored:');
  for (const line of counts.trim().split('\n')) {
    const [table, n] = line.split('|');
    console.log(`  ${String(table).padEnd(30)} ${Number(n).toLocaleString()} rows`);
  }
  console.log('\nRebuild the retrieval index next:\n  npm run reindex\n');
}

function list(): void {
  let files: string[];
  try {
    files = readdirSync(DIR).filter((f) => f.endsWith('.dump')).sort().reverse();
  } catch {
    files = [];
  }
  if (!files.length) {
    console.log(`no backups in ${DIR} — create one with: npm run backup`);
    return;
  }
  console.log(`\n${files.length} backup(s) in ${DIR}\n`);
  for (const name of files) {
    const s = statSync(join(DIR, name));
    console.log(`  ${name.padEnd(40)} ${human(s.size).padStart(8)}   ${s.mtime.toISOString().slice(0, 16).replace('T', ' ')}`);
  }
  console.log('');
}

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case undefined:
    case 'create':
      await backup();
      break;
    case 'verify': {
      if (!args[0]) throw new Error('usage: backup verify <file>');
      const tables = await verify(args[0]);
      console.log(`${args[0]} is readable — ${tables.length} tables, all required ones present`);
      break;
    }
    case 'restore':
      if (!args[0]) throw new Error('usage: backup restore <file> [--force]');
      await restore(args[0], args.includes('--force'));
      break;
    case 'list':
      list();
      break;
    default:
      console.error('usage: backup [create|verify <file>|restore <file>|list]');
      process.exitCode = 1;
  }
} catch (err) {
  console.error(`\n${(err as Error).message}\n`);
  process.exitCode = 1;
}
