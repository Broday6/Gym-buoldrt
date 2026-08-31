/**
 * Seed the demo environment: generate a messy catalogue, ingest it into every
 * configured site, provision API keys and print a walkthrough.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateCatalogCsv } from './generate-catalog.js';
import { createEngine } from '../server/src/app.js';
import { SiteRegistry } from '../server/src/config/sites.js';
import { createPool, migrate } from '../server/src/db/pool.js';
import { ingestRows, parseCsv, summariseQuality } from '../server/src/ingest/pipeline.js';
import { ROLES, createApiKey, type KeyScope } from '../server/src/routes/auth.js';
import { CollectionStore } from '../server/src/merchandising/collections.js';
import { SearchService } from '../server/src/services/search.js';
import { AnalyticsService } from '../server/src/services/analytics.js';
import { recordChange } from '../server/src/services/history.js';
import { EventCollector } from '../server/src/events/collector.js';
import { generateTraffic } from './traffic.js';
import { DEMO_ATTRIBUTES, DEMO_BADGES, DEMO_COLLECTIONS } from './merchandising.js';

const productCount = Number(process.env.SEED_PRODUCTS ?? 520);

const db = createPool();
await migrate(db);

const engine = createEngine();
const sites = SiteRegistry.load();
const collections = new CollectionStore(db);


mkdirSync('./data/demo', { recursive: true });

/**
 * Demo API keys.
 *
 * The database stores only hashes, so a key that is generated and not written
 * down is gone. The storefront needs its search key on every page load and the
 * console needs its admin key, so the seed keeps the plaintext in a local file
 * under data/ — which is git-ignored, and is demo credentials for a catalogue
 * that does not exist. Nothing outside the demo reads it: production keys are
 * issued by `npm run keys` and shown once.
 */
const KEY_FILE = './data/demo/keys.json';
type DemoKeys = Record<string, Record<KeyScope, string>>;

function readDemoKeys(): DemoKeys {
  try {
    return JSON.parse(readFileSync(KEY_FILE, 'utf8')) as DemoKeys;
  } catch {
    return {};
  }
}

async function issueDemoKeys(siteId: string): Promise<Record<KeyScope, string> | null> {
  const file = readDemoKeys();
  const { rows } = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM api_keys WHERE site_id = $1 AND revoked_at IS NULL',
    [siteId],
  );
  // Keys still on record and still written down: leave both alone.
  if (Number(rows[0]?.n ?? 0) > 0 && file[siteId]) return null;

  // Otherwise the file and the database have drifted apart — a dropped
  // database, or a deleted file. Revoke whatever is on record and reissue, so
  // the two can never disagree about which key works.
  await db.query(
    'UPDATE api_keys SET revoked_at = now() WHERE site_id = $1 AND revoked_at IS NULL',
    [siteId],
  );
  // One key per role, so the demo console can be opened as each of them and
  // the difference is something you can see rather than read about.
  const issued = Object.fromEntries(
    await Promise.all(ROLES.map(async (role) =>
      [role, await createApiKey(db, siteId, role, `demo ${role}`)] as const)),
  ) as Record<KeyScope, string>;
  writeFileSync(KEY_FILE, JSON.stringify({ ...file, [siteId]: issued }, null, 2));
  return issued;
}

for (const [index, site] of sites.list().entries()) {
  // Different seeds so the two brands do not share an identical catalogue.
  const csv = generateCatalogCsv({ productCount, seed: 20260830 + index * 977 });
  const path = `./data/demo/${site.id}-catalog.csv`;
  writeFileSync(path, csv);

  // Recorded in the audit trail as the API records its own writes. The seed is
  // an actor making changes like any other, and a demo whose History screen is
  // empty until someone edits something teaches the wrong thing about it —
  // there is no baseline to compare a later change against.
  for (const collection of DEMO_COLLECTIONS) {
    await collections.create(site.id, { ...collection, author: 'seed' } as never);
    await recordChange(db, site.id, 'seed', 'create', 'collection',
      (collection as { slug: string }).slug, null, collection);
  }
  for (const attribute of DEMO_ATTRIBUTES) {
    await collections.createAttribute(site.id, attribute as never);
    await recordChange(db, site.id, 'seed', 'create', 'attribute',
      (attribute as { key: string }).key, null, attribute);
  }
  for (const badge of DEMO_BADGES) {
    await collections.createBadge(site.id, { ...badge, author: 'seed' } as never);
    await recordChange(db, site.id, 'seed', 'create', 'badge',
      (badge as { key: string }).key, null, badge);
  }

  const rows = parseCsv(csv);
  // Merchandiser structure is stamped on at ingest, exactly as the API does it.
  const result = await ingestRows(engine, site.id, rows, {
    labels: await collections.plan(site.id),
  });

  await db.query(
    `INSERT INTO sites (id, name, config) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [site.id, site.name, JSON.stringify(site)],
  );
  await db.query(
    `INSERT INTO ingest_runs
       (site_id, index_name, source, products, variants, duration_ms, quality, mapping, learned)
     VALUES ($1,$2,'seed',$3,$4,$5,$6,$7,$8)`,
    [site.id, result.indexName, result.productsIndexed, result.variantsIndexed,
     result.durationMs, JSON.stringify(result.quality), JSON.stringify(result.mapping),
     result.learned ? JSON.stringify(result.learned) : null],
  );

  // Keys are issued once and then kept, so the console key a merchandiser
  // pasted in survives a reseed. They are recorded in data/demo/keys.json —
  // the only place the plaintext exists, since the database stores hashes.
  const issued = await issueDemoKeys(site.id);
  const keys = issued
    ? `\n${ROLES.map((r) => `    ${r.padEnd(13)} ${issued[r]}`).join('\n')}`
    : '(existing keys kept)';

  console.log(
    `\n${site.name} (${site.id})\n` +
      `  catalog:  ${path}\n` +
      `  indexed:  ${result.productsIndexed} products / ${result.variantsIndexed} variants in ${result.durationMs}ms\n` +
      `  quality:  ${summariseQuality(result.quality).join(', ') || 'no issues'}\n` +
      `  labels:   ${Object.entries(result.labelCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `${label}=${n}`)
        .join('  ') || 'none'}\n` +
      `  keys:     ${keys}`,
  );
}

// ---- demo traffic ----------------------------------------------------------
//
// An analytics dashboard with no data demonstrates nothing. This drives real
// searches against the index just built and records the events, so every figure
// on the dashboard is computed rather than fabricated.
if (process.env.SEED_TRAFFIC !== '0') {
  const search = new SearchService(engine, { collections });
  const collector = new EventCollector(db, { batchSize: 5_000 });
  const analytics = new AnalyticsService(db);

  for (const site of sites.list()) {
    await db.query('DELETE FROM events WHERE site_id = $1 AND shopper_id LIKE $2',
      [site.id, 'demo-shopper-%']);

    const { events, impressions } = await generateTraffic(site.id, async (query) => {
      const r = await search.search(site, { q: query, hitsPerPage: 20, facets: [], rescue: false });
      return {
        total: r.totalHits,
        hits: r.hits.map((h) => ({
          sku: h.sku, parentId: h.parentId, effectivePrice: h.effectivePrice || 120,
        })),
      };
    }, { sessions: Number(process.env.SEED_SESSIONS ?? 700) });

    // Written in chunks so one oversized INSERT cannot exceed the parameter cap.
    for (let i = 0; i < events.length; i += 2_000) {
      collector.collect(events.slice(i, i + 2_000));
      await collector.flush();
    }

    // What those searches showed. A running server counts this as it serves;
    // a month of history written after the fact has to be told. Without it
    // every click-through rate in the demo would be a click count over zero.
    for (let i = 0; i < impressions.length; i += 2_000) {
      const chunk = impressions.slice(i, i + 2_000);
      await db.query(
        `INSERT INTO daily_impressions (site_id, day, sku, impressions)
         SELECT $1, d::date, s, n
           FROM unnest($2::text[], $3::text[], $4::int[]) AS t(d, s, n)
         ON CONFLICT (site_id, day, sku)
         DO UPDATE SET impressions = daily_impressions.impressions + EXCLUDED.impressions`,
        [site.id, chunk.map((c) => c.day), chunk.map((c) => c.sku),
          chunk.map((c) => c.impressions)],
      );
    }

    const rolled = await analytics.rollup(site.id, 30);
    const overview = await analytics.overview(site.id, 30);
    console.log(
      `\n${site.name} traffic\n` +
        `  events:   ${events.length} across ${rolled.days} days\n` +
        `  searches: ${overview.volume.searches}  (${overview.volume.uniqueQueries} unique)\n` +
        `  zero-result rate: ${overview.quality.zeroResultRate}%  CTR: ${overview.engagement.clickThroughRate}%\n` +
        `  search-attributed revenue: $${overview.revenue.searchAttributedRevenue.toLocaleString()}`,
    );
  }
  await collector.stop();
}

await engine.close();
await db.end();
const finalKeys = readDemoKeys();
console.log(
  '\nSeed complete.\n' +
  '  Storefront: http://localhost:3100/demo/   (picks up its public search key automatically)\n' +
  '  Console:    http://localhost:3100/admin/  (paste the admin key below when it asks)\n\n' +
  Object.entries(finalKeys)
    .map(([id, k]) => `  ${id.padEnd(11)} admin key: ${k.admin}`)
    .join('\n') +
  '\n\n  Open the console as an analyst or a merchandiser with the other keys in\n' +
  '  data/demo/keys.json — the screens and the buttons change with the role.\n',
);
