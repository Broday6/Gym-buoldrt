import { parse } from 'csv-parse/sync';
import { readFileSync } from 'node:fs';
import type { DataQualityReport, Product } from '@compass/shared';
import type { SearchEngine } from '../engine/types.js';
import { inferMapping, mergeMapping, type FieldMapping } from './mapping.js';
import { normalizeRows, toVariantDocs, type SourceRow } from './normalize.js';

/**
 * Ingestion orchestration.
 *
 * Every full ingest builds a NEW physical index and promotes it atomically, so
 * a rebuild never serves a half-populated catalogue. Partial price/inventory
 * updates go straight to the live index instead — they must land in under a
 * minute, and a rebuild cannot meet that.
 */

export interface IngestResult {
  site: string;
  indexName: string;
  productsIndexed: number;
  variantsIndexed: number;
  durationMs: number;
  quality: DataQualityReport;
  mapping: FieldMapping;
}

export interface IngestOptions {
  /** Override any inferred column mapping. */
  mapping?: Partial<FieldMapping>;
  batchSize?: number;
  onProgress?: (indexed: number, total: number) => void;
}

export function parseCsv(content: string): SourceRow[] {
  return parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
    bom: true,
  }) as SourceRow[];
}

export async function ingestRows(
  engine: SearchEngine,
  site: string,
  rows: SourceRow[],
  options: IngestOptions = {},
): Promise<IngestResult> {
  const started = Date.now();
  const headers = Object.keys(rows[0] ?? {});
  const mapping = mergeMapping(inferMapping(headers), options.mapping);
  const { products, quality } = normalizeRows(site, rows, mapping);
  const result = await indexProducts(engine, site, products, options);
  return { ...result, quality, mapping, durationMs: Date.now() - started };
}

export async function indexProducts(
  engine: SearchEngine,
  site: string,
  products: Product[],
  options: IngestOptions = {},
): Promise<Omit<IngestResult, 'quality' | 'mapping' | 'durationMs'>> {
  const docs = toVariantDocs(site, products);
  const handle = await engine.createIndex(site);
  const batchSize = options.batchSize ?? 2_000;
  for (let i = 0; i < docs.length; i += batchSize) {
    await engine.indexBatch(handle, docs.slice(i, i + batchSize));
    options.onProgress?.(Math.min(i + batchSize, docs.length), docs.length);
  }
  await engine.promote(handle);
  return {
    site,
    indexName: handle.name,
    productsIndexed: products.length,
    variantsIndexed: docs.length,
  };
}

export async function ingestCsvFile(
  engine: SearchEngine,
  site: string,
  path: string,
  options: IngestOptions = {},
): Promise<IngestResult> {
  return ingestRows(engine, site, parseCsv(readFileSync(path, 'utf8')), options);
}

/** Human-readable digest of an ingest, for the CLI and the admin console. */
export function summariseQuality(q: DataQualityReport): string[] {
  const issues: string[] = [];
  if (q.missingImages.length) issues.push(`${q.missingImages.length} products with no image`);
  if (q.emptyDescriptions.length) issues.push(`${q.emptyDescriptions.length} products with thin or empty descriptions`);
  if (q.uncategorised.length) issues.push(`${q.uncategorised.length} uncategorised products`);
  if (q.duplicateSkus.length) issues.push(`${q.duplicateSkus.length} duplicate SKUs`);
  if (q.missingPrice.length) issues.push(`${q.missingPrice.length} variants with no price`);
  if (q.rejected.length) issues.push(`${q.rejected.length} rows rejected`);
  return issues;
}
