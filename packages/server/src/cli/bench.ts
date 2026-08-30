/**
 * Latency benchmark against the §7 targets:
 *   full search p95 < 100ms, category browse p95 < 120ms.
 * Reports server-side time only — the number the API contract is written on.
 */
import { createEngine } from '../app.js';
import { SiteRegistry } from '../config/sites.js';
import { SearchService } from '../services/search.js';
import { ResultCache } from '../services/cache.js';

const siteId = process.argv[2] ?? 'ekena';
const iterations = Number(process.argv[3] ?? 200);

const engine = createEngine();
const site = SiteRegistry.load().require(siteId);

// Two services: one whose cache expires entries immediately, to measure the
// retrieval path itself, and one with the production cache, to measure what a
// shopper on a popular query actually waits for. Reporting only the second
// would flatter the engine; reporting only the first would misrepresent
// production, where search traffic is extremely head-heavy.
const cold = new SearchService(engine, { cache: new ResultCache({ ttlMs: -1 }) });
const service = new SearchService(engine);

const QUERIES = [
  'chandaleer', 'black shutter', '4x6 beam 12ft', 'crownmoulding', 'faux beam',
  'walnut', 'shutters', 'ceiling medallion', 'primed white column', 'BMV4X6X120SM',
  '3-1/2 inch crown moulding', 'sage board and batten', 'bracket', 'wainscot panel',
];

function percentile(sorted: number[], p: number): number {
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index]! * 100) / 100;
}

async function measure(
  label: string,
  run: (i: number) => Promise<unknown>,
  target: number,
  { enforce = true }: { enforce?: boolean } = {},
) {
  // Warm the vocabulary and statement caches first; a cold first call is not
  // representative of steady-state traffic.
  for (let i = 0; i < 10; i++) await run(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    await run(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  const p95 = percentile(samples, 95);
  const pass = p95 < target;
  console.log(
    `${label.padEnd(22)} p50 ${String(percentile(samples, 50)).padStart(7)}ms  ` +
      `p95 ${String(p95).padStart(7)}ms  p99 ${String(percentile(samples, 99)).padStart(7)}ms  ` +
      `target <${target}ms  ${pass ? 'PASS' : 'FAIL'}`,
  );
  return enforce ? pass : true;
}

console.log(`\n${site.name}: ${await engine.documentCount(site.id)} variant documents, ${iterations} iterations\n`);

console.log('uncached — the retrieval path itself\n');
const results = [
  await measure('search', (i) => cold.search(site, { q: QUERIES[i % QUERIES.length]! }), 100),
  await measure('search + facet filter', (i) =>
    cold.search(site, { q: QUERIES[i % QUERIES.length]!, filters: { material: ['PVC'] } }), 100),
  await measure('browse', () => cold.browse(site, { categoryId: 'exterior/shutters' }), 120),
  await measure('browse deep page', () =>
    cold.browse(site, { categoryId: 'millwork', page: 5 }), 120),
];

console.log('\ncached — what a shopper on a popular query waits for\n');
await measure('search', (i) => service.search(site, { q: QUERIES[i % QUERIES.length]! }), 100,
  { enforce: false });
await measure('browse', () => service.browse(site, { categoryId: 'exterior/shutters' }), 120,
  { enforce: false });
console.log(`\ncache: ${JSON.stringify(service.cacheStats())}`);

console.log('');
await engine.close();
process.exit(results.every(Boolean) ? 0 : 1);
