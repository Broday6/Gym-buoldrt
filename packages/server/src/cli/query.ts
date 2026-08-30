/**
 * `npm run query -- ekena "black shutter"` — run a query exactly as the API
 * would and print the ranking explanation. The command-line ancestor of the
 * admin console's "test a query" panel.
 */
import { createEngine } from '../app.js';
import { SiteRegistry } from '../config/sites.js';
import { SearchService } from '../services/search.js';

const [siteId, ...rest] = process.argv.slice(2);
const query = rest.join(' ');
if (!siteId) {
  console.error('usage: query <site> <query...>  [--explain] [--limit N] [--category ID]');
  process.exit(1);
}

const flags = new Set(rest.filter((a) => a.startsWith('--')));
const limitArg = rest.find((a) => a.startsWith('--limit='));
const categoryArg = rest.find((a) => a.startsWith('--category='));
const text = rest.filter((a) => !a.startsWith('--')).join(' ');

const engine = createEngine();
const site = SiteRegistry.load().require(siteId);
const service = new SearchService(engine);

const response = await service.search(site, {
  q: text,
  categoryId: categoryArg?.split('=')[1],
  hitsPerPage: Number(limitArg?.split('=')[1] ?? 10),
  explain: flags.has('--explain'),
});

console.log(
  `\nq="${response.query}"  type=${response.queryType}  effective="${response.effectiveQuery}"\n` +
    `${response.totalHits} products  ${response.processingTimeMs}ms`,
);
if (response.parsedFilters?.length) {
  console.log(`parsed filters: ${response.parsedFilters.map((f) => `${f.field}=${f.value}`).join('  ')}`);
}
console.log('');
response.hits.forEach((hit, i) => {
  const variants = hit.matchedVariants.length ? ` (+${hit.matchedVariants.length} matching variants)` : '';
  console.log(`${String(i + 1).padStart(2)}. ${hit.title}`);
  console.log(`    ${hit.variantTitle || '—'}  $${hit.effectivePrice}  ${hit.sku}${variants}`);
  const e = hit.explanation;
  if (e) {
    console.log(
      `    why: typos=${e.typos} words=${e.wordsMatched} field=${e.bestField}(w${e.bestFieldWeight}) ` +
        `prox=${e.proximity} exact=${e.exactness} business=${e.businessScore}`,
    );
  }
});
const facetSummary = response.facets
  .map((f) => `${f.label}(${f.stats ? `${Math.round(f.stats.min)}–${Math.round(f.stats.max)}` : f.values.length})`)
  .join('  ');
console.log(`\nfacets: ${facetSummary}\n`);

await engine.close();
