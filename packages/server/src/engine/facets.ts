/**
 * Facetable attribute registry.
 *
 * Both engines project these attribute keys out of the free-form `attrs` bag
 * into typed, indexed columns — dedicated columns in the Typesense schema,
 * `attr_*` columns in SQLite. Faceting and filtering on a dedicated column is
 * an order of magnitude cheaper than a join against a key/value table, which is
 * what dominated latency at 100k documents.
 *
 * Adding a key here changes the index layout, so it takes a reindex to apply —
 * the same constraint Typesense puts on a schema change.
 */
export const FACETABLE_ATTRIBUTES = [
  'finish', 'color', 'colour', 'material', 'style', 'size', 'profile', 'species', 'mount',
] as const;

export const NUMERIC_ATTRIBUTES = [
  'width_in', 'height_in', 'length_in', 'depth_in', 'thickness_in',
] as const;

export type FacetableAttribute = (typeof FACETABLE_ATTRIBUTES)[number];

const FACETABLE_SET: Set<string> = new Set(FACETABLE_ATTRIBUTES);

export function isFacetableAttribute(field: string): boolean {
  return FACETABLE_SET.has(field);
}

/**
 * Facet fields that are dictionary-encoded to integers in SQLite.
 *
 * Brand sits alongside the attributes because it faces exactly the same way in
 * the UI and benefits from the same encoding.
 */
export const DICTIONARY_FACETS: string[] = ['brand', ...FACETABLE_ATTRIBUTES];

const DICTIONARY_SET: Set<string> = new Set(DICTIONARY_FACETS);

export function isDictionaryFacet(field: string): boolean {
  return DICTIONARY_SET.has(field);
}

/**
 * SQLite column holding a facet's integer value id.
 *
 * Facet values are stored as dense integers with a side dictionary rather than
 * as text. Counting facets means scanning every matching row, and marshalling
 * a few hundred thousand short strings out of SQLite and hashing them into
 * JavaScript Sets was the single largest cost in a faceted query at scale.
 * Integers marshal and hash several times faster, and the dictionary is only
 * consulted for the few dozen values that survive into the response.
 */
export function attributeColumn(field: string): string {
  return `f_${field}`;
}
