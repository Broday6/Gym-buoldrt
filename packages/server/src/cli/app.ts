/**
 * Stand the whole thing up with one command.
 *
 *   npm run app              # database, schema, catalogue, API, storefront, console
 *   npm run app -- --reseed  # throw away the demo data and generate it again
 *
 * Everything here is a step someone would otherwise have to know about and do
 * in the right order: find or create a database, apply the schema, notice that
 * the catalogue is empty and seed it, start the API, and find the admin key the
 * console is going to ask for. Each step reports what it found rather than what
 * it assumed, because the failure this replaces is a blank screen with no clue
 * which of the five steps did not happen.
 *
 * It is deliberately not a supervisor. It starts one server in the foreground
 * and forwards signals to it, so Ctrl-C behaves the way Ctrl-C behaves.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import pg from 'pg';

const run = promisify(execFile);

const args = process.argv.slice(2);
const RESEED = args.includes('--reseed');
const PORT = Number(process.env.PORT ?? 3100);
const KEY_FILE = './data/demo/keys.json';

/**
 * Candidate databases, in the order a developer's machine tends to have one.
 *
 * `DATABASE_URL` always wins and is never guessed past: if someone set it and
 * it does not work, silently using a different database is the worst possible
 * outcome — the app would come up healthy, pointed somewhere they did not mean.
 */
const CANDIDATES = [
  'postgres://localhost:5432/compass',
  'postgres://compass:compass@localhost:5432/compass',
  'postgres://postgres:postgres@localhost:5432/compass',
];

const ok = (label: string, detail: string) => console.log(`  ✓ ${label.padEnd(11)} ${detail}`);
const info = (label: string, detail: string) => console.log(`  · ${label.padEnd(11)} ${detail}`);

function fail(what: string, lines: string[]): never {
  console.error(`\n  ✗ ${what}\n`);
  for (const line of lines) console.error(`    ${line}`);
  console.error('');
  process.exit(1);
}

/** Connect once, with a short timeout: an unreachable host must not hang. */
async function reachable(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 2500 });
  try {
    await client.connect();
    await client.end();
    return true;
  } catch {
    try { await client.end(); } catch { /* already closed */ }
    return false;
  }
}

/**
 * A server that is running but has no `compass` database is the most common
 * shape of "no database", and the one worth fixing rather than reporting.
 */
async function createDatabase(url: string): Promise<boolean> {
  const admin = new URL(url);
  const name = admin.pathname.slice(1);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.href, connectionTimeoutMillis: 2500 });
  try {
    await client.connect();
    // Identifiers cannot be parameterised. The name comes from this file's own
    // candidate list or from DATABASE_URL, and is quoted either way.
    await client.query(`CREATE DATABASE "${name.replace(/"/g, '""')}"`);
    await client.end();
    return true;
  } catch {
    try { await client.end(); } catch { /* already closed */ }
    return false;
  }
}

async function dockerRunning(): Promise<boolean> {
  try {
    await run('docker', ['info'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

/** Find a database, make one, or explain precisely what to install. */
async function database(): Promise<string> {
  const configured = process.env.DATABASE_URL;
  if (configured) {
    if (await reachable(configured)) return configured;
    if (await createDatabase(configured) && await reachable(configured)) return configured;
    fail('DATABASE_URL is set but nothing answered on it', [
      configured.replace(/:[^:@/]*@/, ':***@'),
      '',
      'Start that server, or unset DATABASE_URL to let this find one.',
    ]);
  }

  for (const url of CANDIDATES) {
    if (await reachable(url)) return url;
  }
  // A server is up but the database does not exist yet.
  for (const url of CANDIDATES) {
    if (await createDatabase(url) && await reachable(url)) {
      info('database', `created ${new URL(url).pathname.slice(1)}`);
      return url;
    }
  }

  if (await dockerRunning()) {
    console.log('  · postgres    not running — starting the one in docker-compose.yml');
    try {
      await run('docker', ['compose', 'up', '-d', 'postgres'], { timeout: 180_000 });
    } catch (err) {
      fail('could not start the Postgres container', [String((err as Error).message).trim()]);
    }
    // The container reports healthy before it accepts connections on the first
    // boot, because initdb runs after the port opens.
    for (let i = 0; i < 60; i++) {
      for (const url of CANDIDATES) if (await reachable(url)) return url;
      await new Promise((r) => setTimeout(r, 1000));
    }
    fail('the Postgres container started but never accepted a connection', [
      'docker compose logs postgres',
    ]);
  }

  fail('no PostgreSQL to connect to', [
    'Compass keeps every merchandising decision, API key and analytics event in',
    'Postgres. Any one of these gets you one:',
    '',
    '  Docker      docker compose up -d postgres     (then run this again)',
    '  macOS       brew install postgresql@16 && brew services start postgresql@16',
    '  Debian      sudo apt install postgresql-16 && sudo service postgresql start',
    '',
    'Already have one somewhere else? Point at it:',
    '',
    '  DATABASE_URL=postgres://user:pass@host:5432/compass npm run app',
  ]);
}

/** Has anyone put a catalogue in this database yet? */
async function seeded(url: string): Promise<boolean> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'api_keys'`);
    if (rows[0]?.n === '0') return false;
    const keys = await client.query<{ n: string }>('SELECT count(*)::text AS n FROM api_keys');
    return Number(keys.rows[0]?.n ?? 0) > 0;
  } finally {
    await client.end();
  }
}

/**
 * Is anything already listening there?
 *
 * Worth asking before starting rather than after: a second copy fails to bind
 * and dies, but the health check in a moment would answer from the *first*
 * one and this would report a healthy start that never happened.
 */
function portFree(port: number): Promise<boolean> {
  return new Promise((settle) => {
    const probe = createServer();
    probe.once('error', () => settle(false));
    probe.once('listening', () => probe.close(() => settle(true)));
    probe.listen(port, '0.0.0.0');
  });
}

function step(label: string, command: string, argv: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolvePromise) => {
    const child = spawn(command, argv, { stdio: ['ignore', 'pipe', 'pipe'], env });
    let tail = '';
    const keep = (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      console.error(`\n  ✗ ${label} failed\n`);
      console.error(tail.split('\n').map((l) => `    ${l}`).join('\n'));
      process.exit(1);
    });
  });
}

// ---------------------------------------------------------------------------

console.log('\n  Compass Search\n');

const [major] = process.versions.node.split('.').map(Number);
if ((major ?? 0) < 22) {
  fail(`Node ${process.versions.node} is too old`, [
    'The retrieval engine used for development is node:sqlite, which landed in',
    'Node 22. Install Node 22 or newer and run this again.',
  ]);
}
ok('node', `v${process.versions.node}`);

const url = await database();
ok('postgres', url.replace(/:[^:@/]*@/, ':***@'));

// The summary below is the point of this command, and a request log scrolling
// underneath buries it. Warnings and errors still come through; ask for the
// request log with LOG_LEVEL=info npm run app.
const env = {
  ...process.env,
  DATABASE_URL: url,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  // node:sqlite prints an experimental-feature warning on every start. It is
  // expected, it is documented, and printed in the middle of this summary it
  // reads like something went wrong. Only that class is silenced.
  NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --disable-warning=ExperimentalWarning`.trim(),
};

// The seed applies migrations itself, so a fresh database needs one command,
// not two. An existing one is migrated here in case the schema moved under it.
if (RESEED || !(await seeded(url))) {
  info('catalogue', RESEED
    ? 'starting over (--reseed) — this takes a minute'
    : 'empty — generating one, which takes a minute');
  await step('seed', 'npx', ['tsx', 'packages/demo/seed.ts'], env);
  ok('catalogue', 'generated, indexed and merchandised');
} else {
  await step('migrate', 'npx', ['tsx', 'packages/server/src/cli/migrate.ts'], env);
  ok('catalogue', 'already present — reuse it, or start over with --reseed');
}

// ---- the API, in the foreground -------------------------------------------

const base = `http://localhost:${PORT}`;

if (!(await portFree(PORT))) {
  const mine = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
  fail(`port ${PORT} is already in use`, [
    mine
      ? 'A Compass server is already running on it — that one is still serving.'
      : 'Something else is listening on it.',
    '',
    'Stop it, or use another port:',
    '',
    `  PORT=3101 npm run app`,
  ]);
}

const server: ChildProcess = spawn('npx', ['tsx', 'packages/server/src/server.ts'], {
  stdio: ['ignore', 'inherit', 'inherit'],
  env,
});

let stopped: number | null = null;
let ready = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => { server.kill(signal); });
}
server.on('exit', (code) => {
  stopped = code ?? 0;
  // Before readiness the loop below reports it; after, this is Ctrl-C or a
  // crash, and the exit code is the server's.
  if (ready) process.exit(stopped);
});

for (let i = 0; i < 60 && !ready; i++) {
  if (stopped !== null) fail('the API stopped while starting', ['Its own output is above.']);
  await new Promise((r) => setTimeout(r, 500));
  ready = await fetch(`${base}/health`).then((r) => r.ok).catch(() => false);
}
if (!ready) fail('the API did not come up', ['Its own output is above.']);
ok('api', base);

const keys = existsSync(KEY_FILE)
  ? JSON.parse(readFileSync(KEY_FILE, 'utf8')) as Record<string, Record<string, string>>
  : {};
const admin = Object.values(keys)[0]?.admin;

console.log([
  '',
  `  Storefront   ${base}/demo/`,
  `  Console      ${base}/admin/`,
  `  API docs     ${base}/docs`,
  '',
  admin
    ? `  The console asks for a key once. Paste this one:\n\n    ${admin}\n`
    : `  Admin keys are in ${KEY_FILE}.\n`,
  '  There is one key per role in data/demo/keys.json — open the console as an',
  '  analyst or a merchandiser and the screens and buttons change with it.',
  '',
  '  Ctrl-C to stop.',
  '',
].join('\n'));
