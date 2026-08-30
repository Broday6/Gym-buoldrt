import type { DataQualityReport, Product, Variant, VariantDoc } from '@compass/shared';
import { parseMeasurement, toInches } from '../query/dimensions.js';
import type { FieldMapping } from './mapping.js';

/** Raw source row: every value arrives as a string from CSV. */
export type SourceRow = Record<string, string>;

const DIMENSION_ATTRS = new Set([
  'width', 'height', 'depth', 'length', 'thickness', 'size',
]);

function pick(row: SourceRow, mapping: FieldMapping, field: string): string {
  const column = mapping.fields[field];
  if (!column) return '';
  return (row[column] ?? '').trim();
}

function toNumber(value: string): number | undefined {
  if (!value) return undefined;
  const cleaned = value.replace(/[$,%\s]/g, '').replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : undefined;
}

function toBoolean(value: string): boolean {
  return /^(1|t|true|y|yes)$/i.test(value.trim());
}

function splitMulti(value: string, delimiter: string): string[] {
  if (!value) return [];
  return value.split(delimiter).map((v) => v.trim()).filter(Boolean);
}

/**
 * Parse an attribute value into a facet value plus, when it reads like a
 * measurement, a numeric inches column so `4x6` filters can hit it.
 */
export function attributeToNumeric(key: string, value: string): number | undefined {
  const base = key.replace(/_in$/, '');
  if (!DIMENSION_ATTRS.has(base)) return undefined;
  const m = value.match(/^\s*([\d\s\-\/.]+?)\s*(mm|cm|m|in|inch|inches|ft|foot|feet|"|')?\s*$/i);
  if (!m) return undefined;
  const n = parseMeasurement(m[1]!);
  if (n === null) return undefined;
  return Math.round(toInches(n, m[2]) * 16) / 16;
}

export interface NormalizeResult {
  products: Product[];
  quality: DataQualityReport;
}

/**
 * Rows -> parent products with variants, plus a data-quality report.
 * Bad rows are reported, never silently dropped: a merchandiser needs to know
 * that 900 SKUs failed to ingest, not to discover it as missing search results.
 */
export function normalizeRows(
  site: string,
  rows: SourceRow[],
  mapping: FieldMapping,
): NormalizeResult {
  const byParent = new Map<string, Product>();
  const seenSkus = new Map<string, number>();
  const rejected: { row: number; reason: string }[] = [];
  const missingPrice: string[] = [];

  rows.forEach((row, i) => {
    const sku = pick(row, mapping, 'sku');
    if (!sku) {
      rejected.push({ row: i + 2, reason: 'missing SKU' });
      return;
    }
    const count = (seenSkus.get(sku) ?? 0) + 1;
    seenSkus.set(sku, count);
    if (count > 1) {
      rejected.push({ row: i + 2, reason: `duplicate SKU ${sku}` });
      return;
    }

    const title = pick(row, mapping, 'title');
    if (!title) {
      rejected.push({ row: i + 2, reason: `SKU ${sku} has no title` });
      return;
    }

    const parentId = (row[mapping.parentKey] ?? '').trim() || sku;
    const price = toNumber(pick(row, mapping, 'price'));
    if (price === undefined) missingPrice.push(sku);

    const attributes: Record<string, string | number> = {};
    for (const [key, column] of Object.entries(mapping.attributes)) {
      const raw = (row[column] ?? '').trim();
      if (!raw) continue;
      attributes[key] = raw;
      const numeric = attributeToNumeric(key, raw);
      if (numeric !== undefined) attributes[`${key.replace(/_in$/, '')}_in`] = numeric;
    }

    const variant: Variant = {
      sku,
      mpn: pick(row, mapping, 'mpn') || undefined,
      parentId,
      variantTitle: pick(row, mapping, 'variantTitle') || variantTitleFrom(attributes),
      price: price ?? 0,
      salePrice: toNumber(pick(row, mapping, 'salePrice')),
      inventory: toNumber(pick(row, mapping, 'inventory')) ?? 0,
      image: pick(row, mapping, 'image') || undefined,
      attributes,
      discontinued: toBoolean(pick(row, mapping, 'discontinued')),
    };

    const existing = byParent.get(parentId);
    if (existing) {
      existing.variants.push(variant);
      // Parent-level fields come from the first complete row seen.
      if (!existing.description) existing.description = pick(row, mapping, 'description');
      if (!existing.image) existing.image = variant.image;
      return;
    }

    const categoryRaw = pick(row, mapping, 'categoryPath');
    const categoryPath = categoryRaw
      ? categoryRaw.split(mapping.categoryDelimiter).map((c) => c.trim()).filter(Boolean)
      : [];

    byParent.set(parentId, {
      parentId,
      title,
      description: pick(row, mapping, 'description'),
      brand: pick(row, mapping, 'brand'),
      categoryPath,
      categoryIds: categoryIdsFor(categoryPath),
      image: variant.image,
      images: splitMulti(pick(row, mapping, 'images'), mapping.multiValueDelimiter),
      reviewScore: toNumber(pick(row, mapping, 'reviewScore')),
      reviewCount: toNumber(pick(row, mapping, 'reviewCount')),
      salesVelocity: toNumber(pick(row, mapping, 'salesVelocity')),
      margin: toNumber(pick(row, mapping, 'margin')),
      dateAdded: pick(row, mapping, 'dateAdded') || undefined,
      tags: splitMulti(pick(row, mapping, 'tags'), mapping.multiValueDelimiter),
      variants: [variant],
    });
  });

  const products = [...byParent.values()];
  const quality: DataQualityReport = {
    site,
    totalProducts: products.length,
    totalVariants: products.reduce((n, p) => n + p.variants.length, 0),
    missingImages: products.filter((p) => !p.image && !p.variants.some((v) => v.image)).map((p) => p.parentId),
    emptyDescriptions: products.filter((p) => !p.description || p.description.length < 20).map((p) => p.parentId),
    uncategorised: products.filter((p) => p.categoryPath.length === 0).map((p) => p.parentId),
    duplicateSkus: [...seenSkus.entries()].filter(([, n]) => n > 1).map(([sku]) => sku),
    missingPrice,
    rejected,
    generatedAt: new Date().toISOString(),
  };

  return { products, quality };
}

function variantTitleFrom(attributes: Record<string, string | number>): string {
  // Prefer the options a shopper actually chooses between.
  const order = ['finish', 'color', 'colour', 'material', 'style', 'size', 'length'];
  const parts = order
    .map((k) => attributes[k])
    .filter((v): v is string => typeof v === 'string' && v.length > 0);
  return parts.join(' / ');
}

/** Slugged category ids, one per level, so a browse request can target any depth. */
export function categoryIdsFor(path: string[]): string[] {
  const ids: string[] = [];
  let prefix = '';
  for (const segment of path) {
    const slug = segment.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    prefix = prefix ? `${prefix}/${slug}` : slug;
    ids.push(prefix);
  }
  return ids;
}

/** Flatten products into the variant-level documents the engine stores. */
export function toVariantDocs(site: string, products: Product[]): VariantDoc[] {
  const docs: VariantDoc[] = [];
  for (const product of products) {
    const variantCount = product.variants.length;
    for (const variant of product.variants) {
      const price = variant.price ?? 0;
      const salePrice = variant.salePrice && variant.salePrice > 0 ? variant.salePrice : 0;
      const effectivePrice = salePrice > 0 ? salePrice : price;
      const attributeText = Object.entries(variant.attributes)
        .filter(([key]) => !key.endsWith('_in'))
        .map(([key, value]) => `${key}:${value}`);
      docs.push({
        id: `${site}:${variant.sku}`,
        site,
        sku: variant.sku,
        mpn: variant.mpn ?? '',
        parentId: product.parentId,
        title: product.title,
        variantTitle: variant.variantTitle ?? '',
        description: product.description ?? '',
        brand: product.brand ?? '',
        categoryPath: product.categoryPath,
        categoryIds: product.categoryIds,
        // Values are searchable on their own ("walnut"), keys are for facets.
        attributeText: [...Object.values(variant.attributes).map(String), ...attributeText],
        attributeKeys: Object.keys(variant.attributes),
        price,
        salePrice,
        effectivePrice,
        discountPct: salePrice > 0 && price > 0 ? Math.round(((price - salePrice) / price) * 100) : 0,
        inventory: variant.inventory ?? 0,
        inStock: (variant.inventory ?? 0) > 0,
        discontinued: Boolean(variant.discontinued),
        image: variant.image || product.image || '',
        reviewScore: product.reviewScore ?? 0,
        reviewCount: product.reviewCount ?? 0,
        salesVelocity: product.salesVelocity ?? 0,
        margin: product.margin ?? 0,
        dateAddedTs: product.dateAdded ? Date.parse(product.dateAdded) || 0 : 0,
        tags: product.tags ?? [],
        attrs: variant.attributes as Record<string, string | number>,
        variantCount,
        labels: variant.labels ?? product.labels ?? [],
        collectionPositions: product.collectionPositions ?? {},
      });
    }
  }
  return docs;
}
