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
import { CollectionStore } from '../server/src/merchandising/collections.js';

const productCount = Number(process.env.SEED_PRODUCTS ?? 520);

const db = createPool();
await migrate(db);

const engine = createEngine();
const sites = SiteRegistry.load();
const collections = new CollectionStore(db);

/**
 * Demo structures that deliberately cut across the catalogue taxonomy: none of
 * these map to a single category, which is the whole point of the feature.
 */
const DEMO_COLLECTIONS = [
  {
    slug: 'farmhouse-kitchen',
    name: 'Farmhouse Kitchen',
    description: 'Beams, brackets and moulding that read farmhouse.',
    selector: {
      all: [
        { field: 'variant.attrs.style', op: 'in', value: ['Rustic', 'Hand Hewn', 'Farmhouse', 'Craftsman'] },
        { field: 'inStock', op: 'equals', value: true },
      ],
    },
  },
  {
    slug: 'dark-finishes',
    name: 'Dark Finishes',
    description: 'Anything available in a dark finish, whatever it is.',
    selector: {
      any: [
        { field: 'variant.attrs.finish', op: 'in', value: ['Black', 'Matte Black', 'Espresso', 'Charcoal', 'Oil Rubbed Bronze'] },
      ],
    },
  },
  {
    slug: 'contractor-value',
    name: 'Contractor Value',
    description: 'High-margin, deep-stock lines worth pushing.',
    kind: 'internal' as const,
    selector: {
      all: [
        { field: 'margin', op: 'gte', value: 45 },
        { field: 'totalInventory', op: 'gte', value: 200 },
      ],
    },
  },
  {
    slug: 'clearance',
    name: 'Clearance',
    description: 'On sale right now.',
    selector: { all: [{ field: 'onSale', op: 'equals', value: true }] },
  },
];

/** A merchandiser-invented facet that no source system supplies. */
const DEMO_ATTRIBUTES = [
  {
    key: 'room',
    label: 'Room',
    displayType: 'checkbox' as const,
    position: 12,
    values: [
      { value: 'Kitchen', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Beams' },
        { field: 'categoryPath', op: 'contains', value: 'Brackets' },
      ] } },
      { value: 'Living Room', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Moulding' },
        { field: 'categoryPath', op: 'contains', value: 'Ceiling' },
        { field: 'categoryPath', op: 'contains', value: 'Lighting' },
      ] } },
      { value: 'Exterior', selector: { any: [
        { field: 'categoryPath', op: 'contains', value: 'Exterior' },
      ] } },
      { value: 'Bathroom', selector: { all: [
        { field: 'categoryPath', op: 'contains', value: 'Wall' },
        { field: 'variant.attrs.material', op: 'in', value: ['PVC', 'Composite'] },
      ] } },
    ],
  },
  {
    key: 'price_band',
    label: 'Budget',
    displayType: 'checkbox' as const,
    position: 2,
    sortBy: 'custom' as const,
    customOrder: ['Under $100', '$100 – $300', '$300 – $700', 'Premium'],
    values: [
      { value: 'Under $100', selector: { all: [{ field: 'minPrice', op: 'lt', value: 100 }] } },
      { value: '$100 – $300', selector: { all: [{ field: 'minPrice', op: 'between', value: 100, to: 300 }] } },
      { value: '$300 – $700', selector: { all: [{ field: 'minPrice', op: 'between', value: 300, to: 700 }] } },
      { value: 'Premium', selector: { all: [{ field: 'minPrice', op: 'gt', value: 700 }] } },
    ],
  },
];

mkdirSync('./data/demo', { recursive: true });

for (const [index, site] of sites.list().entries()) {
  // Different seeds so the two brands do not share an identical catalogue.
  const csv = generateCatalogCsv({ productCount, seed: 20260830 + index * 977 });
  const path = `./data/demo/${site.id}-catalog.csv`;
  writeFileSync(path, csv);

  for (const collection of DEMO_COLLECTIONS) {
    await collections.create(site.id, { ...collection, author: 'seed' } as never);
  }
  for (const attribute of DEMO_ATTRIBUTES) {
    await collections.createAttribute(site.id, attribute as never);
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
      `  labels:   ${Object.entries(result.labelCounts)
        .sort((a, b) => b[1] - a[1])
        .map(([label, n]) => `${label}=${n}`)
        .join('  ') || 'none'}\n` +
      `  keys:     ${keys}`,
  );
}

await engine.close();
await db.end();
console.log('\nSeed complete. Start the API with `npm run dev`, then open http://localhost:3100/demo/\n');
