/**
 * Source-column -> schema-field mapping.
 *
 * A NetSuite saved-search export names columns for accountants, not for search
 * ("Item Name/Number", "Base Price", "Custom Item Field: Finish"). A
 * Searchspring feed names them for Searchspring ("category_hierarchy",
 * "imageUrl", "mfrPartNumber"). The mapping layer is what the admin
 * field-mapping UI edits; the defaults below understand the common headings of
 * both, so an unmapped file still ingests.
 *
 * Aliases are matched exactly against the canonicalised heading, so a name
 * this list guesses at that the file does not use costs nothing — the column
 * simply stays an attribute, which is where everything unclaimed goes anyway.
 */

export interface FieldMapping {
  /** schema field -> source column name. */
  fields: Record<string, string>;
  /** Source columns projected into variant attributes, keyed by attribute name. */
  attributes: Record<string, string>;
  /**
   * The subset of those worth offering as a filter without anyone asking.
   * Everything else is still searchable and still filterable by name; it just
   * does not get a facet group of its own on day one.
   */
  facetable?: string[];
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
  sku: ['sku', 'item name/number', 'item name', 'itemid', 'internal id', 'item', 'part number',
    'uid', 'product id'],
  mpn: ['mpn', 'manufacturer part number', 'mfg part number', 'vendor code', 'mfrpartnumber'],
  parentId: ['parent', 'parent item', 'parent sku', 'matrix parent', 'item group', 'product id'],
  title: ['title', 'display name', 'name', 'product name', 'storedisplayname'],
  variantTitle: ['variant', 'variant title', 'matrix option', 'option'],
  description: ['description', 'sales description', 'store description', 'detailed description'],
  brand: ['brand', 'manufacturer', 'vendor'],
  categoryPath: ['category hierarchy', 'category', 'category path', 'commerce category',
    'class', 'web category', 'categories'],
  price: ['price', 'base price', 'list price', 'msrp'],
  salePrice: ['sale price', 'online price', 'special price', 'promo price'],
  inventory: ['inventory', 'quantity available', 'qty available', 'available', 'stock',
    'quantity', 'stock status'],
  image: ['image', 'image url', 'imageurl', 'primary image', 'main image',
    'thumbnailimageurl', 'thumbnail image url'],
  images: ['images', 'image urls', 'gallery', 'additional images', 'alternate images',
    'secondary images'],
  reviewScore: ['review score', 'rating', 'avg rating', 'stars', 'reviewsaverage'],
  reviewCount: ['review count', 'reviews', 'num reviews', 'reviewscount'],
  salesVelocity: ['sales velocity', 'units sold', 'qty sold', 'sales rank', 'velocity',
    'popularity'],
  margin: ['margin', 'margin %', 'gross margin', 'markup'],
  dateAdded: ['date added', 'created date', 'date created', 'first available'],
  tags: ['tags', 'keywords', 'labels'],
  discontinued: ['discontinued', 'inactive', 'is inactive'],
};

/**
 * Headings worth putting in front of a shopper as a filter.
 *
 * Not a list of what to keep — everything unclaimed is kept. This is the much
 * narrower question of which attributes are worth a facet group by default: a
 * shopper filters by finish and material, not by "cubic feet per carton".
 */
const FACET_HINTS = [
  'finish', 'color', 'colour', 'material', 'style', 'size', 'length', 'width',
  'height', 'depth', 'thickness', 'profile', 'species', 'texture', 'mount',
];

/**
 * Columns that are plumbing rather than product.
 *
 * Keeping an internal id or a row timestamp costs nothing but noise: they can
 * never be searched for usefully, and they crowd the attribute list a
 * merchandiser reads.
 */
const IGNORED = [
  /^internal ?id$/, /^external ?id$/, /^record ?(id|type)$/,
  /^(date )?last modified/, /^(date )?created (by|from)/, /^modified by$/,
  /^_/, /^unnamed/, /^column \d+$/,
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
  const facetable: string[] = [];
  for (const header of headers) {
    if (claimed.has(header)) continue;
    const c = canonical(header);
    if (!c || IGNORED.some((rx) => rx.test(c))) continue;
    // Everything the source sends is kept.
    //
    // This used to keep only headings matching a list of sixteen words, which
    // meant a NetSuite export of ninety columns arrived as six. Whatever the
    // merchandising team put in a column, a shopper can eventually type — and a
    // field that was never ingested cannot be searched, filtered, shown or
    // discovered later. Storage is cheap next to a product nobody can find.
    const key = c.replace(/\s+/g, '_');
    if (attributes[key]) continue;
    attributes[key] = header;
    if (FACET_HINTS.some((h) => c === h || c.startsWith(`${h} `) || c.endsWith(` ${h}`))) {
      facetable.push(key);
    }
  }

  return {
    fields,
    attributes,
    facetable,
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
