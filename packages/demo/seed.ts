/**
 * Seed the demo environment: generate a messy catalogue, ingest it into every
 * configured site, provision API keys and print a walkthrough.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { generateCatalogCsv } from './generate-catalog.js';
import { createEngine } from '../server/src/app.js';
import { SiteRegistry } from '../server/src/config/sites.js';
import { createPool, migrate } from '../server/src/db/pool.js';
import { ingestRows, parseCsv, summariseQuality } from '../server/src/ingest/pipeline.js';
import { createApiKey } from '../server/src/routes/auth.js';

const productCount = Number(process.env.SEED_PRODUCTS ?? 520);

const db = createPool();
await migrate(db);

const engine = createEngine();
const sites = SiteRegistry.load();

mkdirSync('./data/demo', { recursive: true });

for (const [index, site] of sites.list().entries()) {
  // Different seeds so the two brands do not share an identical catalogue.
  const csv = generateCatalogCsv({ productCount, seed: 20260830 + index * 977 });
  const path = `./data/demo/${site.id}-catalog.csv`;
  writeFileSync(path, csv);

  const rows = parseCsv(csv);
  const result = await ingestRows(engine, site.id, rows);

  await db.query(
    `INSERT INTO sites (id, name, config) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()`,
    [site.id, site.name, JSON.stringify(site)],
  );
  await db.query(
    `INSERT INTO ingest_runs (site_id, index_name, source, products, variants, duration_ms, quality, mapping)
     VALUES ($1,$2,'seed',$3,$4,$5,$6,$7)`,
    [site.id, result.indexName, result.productsIndexed, result.variantsIndexed,
     result.durationMs, JSON.stringify(result.quality), JSON.stringify(result.mapping)],
  );

  const { rows: existing } = await db.query<{ n: string }>(
    'SELECT COUNT(*) AS n FROM api_keys WHERE site_id = $1 AND revoked_at IS NULL',
    [site.id],
  );
  let keys = '(existing keys kept)';
  if (Number(existing[0]?.n ?? 0) === 0) {
    const searchKey = await createApiKey(db, site.id, 'search', 'storefront');
    const adminKey = await createApiKey(db, site.id, 'admin', 'seed');
    keys = `\n    search key: ${searchKey}\n    admin key:  ${adminKey}`;
  }

  console.log(
    `\n${site.name} (${site.id})\n` +
      `  catalog:  ${path}\n` +
      `  indexed:  ${result.productsIndexed} products / ${result.variantsIndexed} variants in ${result.durationMs}ms\n` +
      `  quality:  ${summariseQuality(result.quality).join(', ') || 'no issues'}\n` +
      `  keys:     ${keys}`,
  );
}

await engine.close();
await db.end();
console.log('\nSeed complete. Start the API with `npm run dev`, then open http://localhost:3100/demo/\n');
