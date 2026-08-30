/**
 * `npm run reindex -- ekena ./catalog.csv` — full rebuild from a source file.
 *
 * Builds a new physical index and promotes it atomically, so the live index
 * keeps serving until the replacement is complete. The run and its data-quality
 * report are recorded in `ingest_runs` for the admin console.
 */
import { existsSync } from 'node:fs';
import { createEngine } from '../app.js';
import { SiteRegistry } from '../config/sites.js';
import { createPool, migrate } from '../db/pool.js';
import { ingestCsvFile, summariseQuality } from '../ingest/pipeline.js';

const [siteId, path] = process.argv.slice(2);
if (!siteId || !path) {
  console.error('usage: reindex <site> <catalog.csv>');
  process.exit(1);
}
if (!existsSync(path)) {
  console.error(`no such file: ${path}`);
  process.exit(1);
}

const site = SiteRegistry.load().require(siteId);
const db = createPool();
await migrate(db);
const engine = createEngine();

console.log(`reindexing ${site.name} from ${path} …`);
let lastLogged = 0;

try {
  const result = await ingestCsvFile(engine, site.id, path, {
    onProgress: (indexed, total) => {
      // One line per 10%, so a million-SKU rebuild does not flood the log.
      const decile = Math.floor((indexed / total) * 10);
      if (decile > lastLogged) {
        lastLogged = decile;
        console.log(`  ${indexed}/${total} documents`);
      }
    },
  });

  await db.query(
    `INSERT INTO ingest_runs (site_id, index_name, source, products, variants, duration_ms, quality, mapping)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [site.id, result.indexName, path, result.productsIndexed, result.variantsIndexed,
     result.durationMs, JSON.stringify(result.quality), JSON.stringify(result.mapping)],
  );

  const issues = summariseQuality(result.quality);
  console.log(
    `\ndone: ${result.productsIndexed} products / ${result.variantsIndexed} variants ` +
      `in ${result.durationMs}ms\nindex: ${result.indexName} (promoted)\n` +
      `quality: ${issues.length ? issues.join(', ') : 'no issues'}`,
  );
  if (result.quality.rejected.length) {
    console.log('\nfirst rejected rows:');
    for (const r of result.quality.rejected.slice(0, 10)) {
      console.log(`  line ${r.row}: ${r.reason}`);
    }
  }
} catch (err) {
  await db.query(
    `INSERT INTO ingest_runs (site_id, index_name, source, status, error) VALUES ($1,'',$2,'error',$3)`,
    [site.id, path, (err as Error).message],
  );
  console.error(`\nreindex failed, the live index is unchanged: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await engine.close();
  await db.end();
}
