/**
 * Build the self-contained storefront page.
 *
 * Generates the same demo catalogue the seed uses, applies the same
 * merchandising rules through the same label engine, and bakes the resulting
 * documents into one HTML file alongside a browser bundle of the real search
 * pipeline. What ships is a page that runs the product, not a mockup of it.
 *
 *   npm run build:browser
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, statSync, rmSync } from 'node:fs';
import { generateCatalogCsv } from '../generate-catalog.js';
import { DEMO_ATTRIBUTES, DEMO_BADGES, DEMO_COLLECTIONS } from '../merchandising.js';
import { parseCsv } from '../../server/src/ingest/pipeline.js';
import { normalizeRows, toVariantDocs } from '../../server/src/ingest/normalize.js';
import { inferMapping } from '../../server/src/ingest/mapping.js';
import { learnAttributes } from '../../server/src/ingest/learn.js';
import { applyLabels, type LabelPlan } from '../../server/src/merchandising/labels.js';
import type { CollectionDefinition, CustomAttributeDefinition, BadgeDefinition }
  from '../../server/src/merchandising/labels.js';

const SITE = 'ekena';
const OUT_DIR = './data/browser';
const PRODUCTS = Number(process.env.BROWSER_DEMO_PRODUCTS ?? 320);

/**
 * The definitions the database would hold, built from the same source the seed
 * writes. Ids and timestamps are the columns Postgres would fill; nothing in
 * the label engine reads them, so they are filled in plainly rather than faked
 * to look like real rows.
 */
function labelPlan(): LabelPlan {
  return {
    collections: DEMO_COLLECTIONS.map((c, i) => ({
      id: i + 1, siteId: SITE, slug: c.slug, name: c.name, kind: 'marketing',
      parentId: null, selector: c.selector as CollectionDefinition['selector'],
      enabled: true, startsAt: null, endsAt: null, position: i,
      description: c.description,
      // Hand-picked membership lives in Postgres. There is none here, so these
      // are empty rather than absent — the label engine reads them directly.
      includes: new Map(), excludes: new Set(),
    })),
    attributes: DEMO_ATTRIBUTES.map((a, i) => ({
      id: i + 1, siteId: SITE, key: a.key, label: a.label,
      displayType: (a.displayType ?? 'checkbox') as CustomAttributeDefinition['displayType'],
      position: i, collapsed: false, truncateAt: 8, sortBy: 'count', customOrder: null,
      enabled: true,
      values: a.values.map((v, j) => ({
        id: j + 1, value: v.value,
        selector: v.selector as CustomAttributeDefinition['values'][0]['selector'],
        position: j, includes: new Set<string>(), excludes: new Set<string>(),
      })),
    })) as CustomAttributeDefinition[],
    badges: DEMO_BADGES.map((b, i) => ({
      id: i + 1, siteId: SITE, key: b.key, label: b.label,
      tone: b.tone as BadgeDefinition['tone'],
      selector: b.selector as BadgeDefinition['selector'],
      priority: b.priority ?? 100, enabled: true, startsAt: null, endsAt: null,
    })) as BadgeDefinition[],
  };
}

console.log(`building the browser demo — ${PRODUCTS} products`);

const csv = generateCatalogCsv({ productCount: PRODUCTS, seed: 20260830 });
const rows = parseCsv(csv);
const headers = Object.keys(rows[0] ?? {});
const mapping = inferMapping(headers);
// The same recovery the server's ingest performs, so the hosted page searches
// the catalogue a real deployment would have rather than a thinner one.
const learned = learnAttributes(rows, mapping);
const { products, quality } = normalizeRows(SITE, rows, mapping);
const plan = labelPlan();
const { products: labelled, counts } = applyLabels(products, plan);
// Same facet-worthy set the server uses, so what the hosted page searches on
// matches what a real deployment searches on.
const docs = toVariantDocs(SITE, labelled, mapping.facetable);

console.log(`  ${labelled.length} products / ${docs.length} variants`
  + ` (${quality.rejected.length} rows rejected, as the seed does)`);
console.log(`  recovered ${learned.filled} attribute values the feed left blank`
  + ` (${Object.entries(learned.byKey).map(([k, n]) => `${k} ${n}`).join(', ')})`);
console.log(`  labels: ${Object.entries(counts).sort((a, b) => b[1] - a[1])
  .slice(0, 6).map(([k, v]) => `${k}=${v}`).join('  ')}`);

// Trim what the page will never read. Descriptions stay: they are searchable,
// and dropping them would quietly change what matches.
const slim = docs.map((d) => ({
  ...d,
  image: '',
  collectionPositions: Object.keys(d.collectionPositions ?? {}).length ? d.collectionPositions : undefined,
}));

mkdirSync(OUT_DIR, { recursive: true });
const dataPath = `${OUT_DIR}/catalog.json`;
writeFileSync(dataPath, JSON.stringify({
  site: SITE,
  docs: slim,
  attributes: plan.attributes,
  badges: plan.badges,
  collections: plan.collections.map((c) => ({ slug: c.slug, name: c.name, description: c.description })),
}));

execFileSync('node_modules/.bin/esbuild', [
  'packages/demo/browser/main.js',
  '--bundle',
  '--format=esm',
  '--platform=browser',
  '--target=es2022',
  '--minify',
  // Bundled modules import these for optional, server-only paths that the
  // browser build never takes; the imports still have to resolve.
  '--alias:node:fs=./packages/demo/browser/node-shims.js',
  '--alias:node:path=./packages/demo/browser/node-shims.js',
  '--alias:node:url=./packages/demo/browser/node-shims.js',
  // Tuning knobs are read from the environment; a page has none, so the
  // modules see an empty one and take the same defaults an unconfigured
  // server would.
  '--inject:./packages/demo/browser/process-shim.js',
  `--outfile=${OUT_DIR}/bundle.js`,
], { stdio: 'inherit' });

const bundle = readFileSync(`${OUT_DIR}/bundle.js`, 'utf8');
const data = readFileSync(dataPath, 'utf8');
const css = readFileSync('packages/sdk/src/styles.css', 'utf8');
const shell = readFileSync('packages/demo/browser/page.html', 'utf8');

const html = shell
  .replace('/*STYLES*/', () => css)
  .replace('/*DATA*/', () => data)
  .replace('/*BUNDLE*/', () => bundle);

writeFileSync('./data/browser/index.html', html);
rmSync(dataPath);
rmSync(`${OUT_DIR}/bundle.js`);

const mb = (statSync('./data/browser/index.html').size / 1e6).toFixed(2);
console.log(`  bundle ${(bundle.length / 1024).toFixed(0)}KB · catalogue ${(data.length / 1e6).toFixed(2)}MB`);
console.log(`\nwrote ./data/browser/index.html (${mb}MB)`);
