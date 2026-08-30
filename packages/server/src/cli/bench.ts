/**
 * Latency benchmark against the §7 targets:
 *   full search p95 < 100ms, category browse p95 < 120ms.
 * Reports server-side time only — the number the API contract is written on.
 */
import { createEngine } from '../app.js';
import { SiteRegistry } from '../config/sites.js';
import { SearchService } from '../services/search.js';

const siteId = process.argv[2] ?? 'ekena';
const iterations = Number(process.argv[3] ?? 200);

const engine = createEngine();
const site = SiteRegistry.load().require(siteId);
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

async function measure(label: string, run: (i: number) => Promise<unknown>, target: number) {
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
  const verdict = p95 < target ? 'PASS' : 'FAIL';
  console.log(
    `${label.padEnd(18)} p50 ${String(percentile(samples, 50)).padStart(7)}ms  ` +
      `p95 ${String(p95).padStart(7)}ms  p99 ${String(percentile(samples, 99)).padStart(7)}ms  ` +
      `target <${target}ms  ${verdict}`,
  );
  return verdict === 'PASS';
}

console.log(`\n${site.name}: ${await engine.documentCount(site.id)} variant documents, ${iterations} iterations\n`);

const results = [
  await measure('search', (i) => service.search(site, { q: QUERIES[i % QUERIES.length]! }), 100),
  await measure('search + facets', (i) =>
    service.search(site, { q: QUERIES[i % QUERIES.length]!, filters: { material: ['PVC'] } }), 100),
  await measure('browse', () => service.browse(site, { categoryId: 'exterior/shutters' }), 120),
  await measure('browse deep page', () =>
    service.browse(site, { categoryId: 'millwork', page: 5 }), 120),
];

console.log('');
await engine.close();
process.exit(results.every(Boolean) ? 0 : 1);
