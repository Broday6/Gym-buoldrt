/**
 * Source-column -> schema-field mapping.
 *
 * A NetSuite saved-search export names columns for accountants, not for search
 * ("Item Name/Number", "Base Price", "Custom Item Field: Finish"). The mapping
 * layer is what the admin field-mapping UI edits; the defaults below already
 * understand the common NetSuite and generic-feed headings, so an unmapped file
 * still ingests.
 */

export interface FieldMapping {
  /** schema field -> source column name. */
  fields: Record<string, string>;
  /** Source columns projected into variant attributes, keyed by attribute name. */
  attributes: Record<string, string>;
  /** Column whose value groups variants into a parent product. */
  parentKey: string;
  /** Delimiter for multi-value columns such as images and tags. */
  multiValueDelimiter: string;
  /** Category path separator, e.g. "Millwork : Beams" or "Millwork > Beams". */
  categoryDelimiter: string;
}

export const SCHEMA_FIELDS = [
  'sku', 'mpn', 'parentId', 'title', 'variantTitle', 'description', 'brand',
  'categoryPath', 'price', 'salePrice', 'inventory', 'image', 'images',
  'reviewScore', 'reviewCount', 'salesVelocity', 'margin', 'dateAdded', 'tags',
  'discontinued',
] as const;

/** Candidate source headings per schema field, matched case/space-insensitively. */
const ALIASES: Record<string, string[]> = {
  sku: ['sku', 'item name/number', 'item name', 'itemid', 'internal id', 'item', 'part number'],
  mpn: ['mpn', 'manufacturer part number', 'mfg part number', 'vendor code'],
  parentId: ['parent', 'parent item', 'parent sku', 'matrix parent', 'item group', 'product id'],
  title: ['title', 'display name', 'name', 'product name', 'storedisplayname'],
  variantTitle: ['variant', 'variant title', 'matrix option', 'option'],
  description: ['description', 'sales description', 'store description', 'detailed description'],
  brand: ['brand', 'manufacturer', 'vendor'],
  categoryPath: ['category', 'category path', 'commerce category', 'class', 'web category'],
  price: ['price', 'base price', 'list price', 'msrp'],
  salePrice: ['sale price', 'online price', 'special price', 'promo price'],
  inventory: ['inventory', 'quantity available', 'qty available', 'available', 'stock'],
  image: ['image', 'image url', 'primary image', 'main image'],
  images: ['images', 'image urls', 'gallery', 'additional images'],
  reviewScore: ['review score', 'rating', 'avg rating', 'stars'],
  reviewCount: ['review count', 'reviews', 'num reviews'],
  salesVelocity: ['sales velocity', 'units sold', 'qty sold', 'sales rank', 'velocity'],
  margin: ['margin', 'margin %', 'gross margin', 'markup'],
  dateAdded: ['date added', 'created date', 'date created', 'first available'],
  tags: ['tags', 'keywords', 'labels'],
  discontinued: ['discontinued', 'inactive', 'is inactive'],
};

/** Source headings that should become searchable/facetable variant attributes. */
const ATTRIBUTE_HINTS = [
  'finish', 'color', 'colour', 'material', 'style', 'size', 'length', 'width',
  'height', 'depth', 'thickness', 'profile', 'species', 'texture', 'mount',
];

function canonical(header: string): string {
  return header.toLowerCase().replace(/^custom item field:\s*/, '').replace(/[_\s]+/g, ' ').trim();
}

/** Guess a mapping from the header row. The admin UI overrides any of it. */
export function inferMapping(headers: string[]): FieldMapping {
  const byCanonical = new Map(headers.map((h) => [canonical(h), h]));
  const fields: Record<string, string> = {};
  for (const [field, aliases] of Object.entries(ALIASES)) {
    for (const alias of aliases) {
      const match = byCanonical.get(alias);
      if (match) {
        fields[field] = match;
        break;
      }
    }
  }

  const claimed = new Set(Object.values(fields));
  const attributes: Record<string, string> = {};
  for (const header of headers) {
    if (claimed.has(header)) continue;
    const c = canonical(header);
    // Anything that reads like a product option becomes an attribute; NetSuite
    // custom item fields are attributes by convention.
    if (ATTRIBUTE_HINTS.some((h) => c === h || c.startsWith(`${h} `) || c.endsWith(` ${h}`)) ||
        /^custom item field:/i.test(header)) {
      attributes[c.replace(/\s+/g, '_')] = header;
    }
  }

  return {
    fields,
    attributes,
    parentKey: fields.parentId ?? fields.sku ?? headers[0] ?? 'sku',
    multiValueDelimiter: '|',
    categoryDelimiter: '>',
  };
}

export function mergeMapping(inferred: FieldMapping, overrides?: Partial<FieldMapping>): FieldMapping {
  if (!overrides) return inferred;
  return {
    ...inferred,
    ...overrides,
    fields: { ...inferred.fields, ...(overrides.fields ?? {}) },
    attributes: { ...inferred.attributes, ...(overrides.attributes ?? {}) },
  };
}
