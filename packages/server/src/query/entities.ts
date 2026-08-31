/**
 * Entity recognition: the brands and product types a query names.
 *
 * "Heritage Beams" is not two words to match in text — it is a brand and a
 * product type, and a shopper means both. Matching them as free text asks the
 * index whether those characters appear somewhere in a document, which is a
 * different and much weaker question: a bracket whose description mentions
 * beams answers yes, and a brand with no beams at all quietly falls through to
 * the rescue path and returns that brand's brackets instead.
 *
 * So they are lifted out of the text and applied as filters, exactly as
 * dimensions already are. The result is precise, the shopper can see what was
 * understood, and — because they land as ordinary filters — they can remove one
 * without retyping.
 *
 * The dictionary is the index's own directory. Nothing is configured: a brand
 * is a brand because products carry it, and a product type is a category
 * because the taxonomy has one.
 */
import type { ParsedConstraint } from '@compass/shared';
import type { SearchEngine } from '../engine/types.js';

export interface EntityIndex {
  /** Normalised name -> the brand exactly as the catalogue spells it. */
  brands: Map<string, string>;
  /** Normalised leaf or full path name -> the most populated matching id. */
  categories: Map<string, { id: string; products: number }>;
  /**
   * Normalised attribute value -> the field and value the catalogue holds.
   *
   * A shopper describing a product — "black polyurethane corbel" — is naming
   * two attributes and a product type, and searching those words as free text
   * asks a far weaker question: does this document mention black anywhere. A
   * white corbel whose description says "also available in black" answers yes.
   */
  attributes: Map<string, { field: string; value: string; products: number }>;
  /** Longest entity name in tokens, so the scanner knows how wide to look. */
  maxTokens: number;
}

const EMPTY: EntityIndex = {
  brands: new Map(), categories: new Map(), attributes: new Map(), maxTokens: 0,
};

/**
 * How many attributes one query may name.
 *
 * Three is a shopper being specific — "black polyurethane 6 inch". Beyond that
 * the extra matches are far more likely to be describing words colliding with
 * a catalogue value than someone genuinely narrowing five ways at once, and
 * every lifted attribute is a filter that can empty the page.
 */
const MAX_ATTRIBUTES = 3;

const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * Singular and plural both point at the same entity: shoppers type "beams",
 * the taxonomy says "Beams", and neither should depend on the other's ending.
 */
function keysFor(name: string): string[] {
  const key = normalise(name);
  if (!key) return [];
  const keys = new Set([key]);
  const singular = key.replace(/(ies)$/, 'y').replace(/(?<=[^s])s$/, '');
  keys.add(singular);
  keys.add(`${singular}s`);
  return [...keys].filter(Boolean);
}

export async function buildEntityIndex(
  engine: SearchEngine,
  site: string,
  /**
   * Attribute fields worth recognising by value. Passed in rather than
   * discovered: the site's own facet list is exactly the set a merchandiser
   * decided shoppers care about, and recognising every stored column would
   * match accounting codes.
   */
  attributeFields: string[] = [],
): Promise<EntityIndex> {
  const directory = await engine.directory(site).catch(() => null);
  if (!directory) return EMPTY;

  const brands = new Map<string, string>();
  for (const brand of directory.brands) {
    for (const key of keysFor(brand.name)) brands.set(key, brand.name);
  }

  const categories = new Map<string, { id: string; products: number }>();
  for (const category of directory.categories) {
    const leaf = category.path[category.path.length - 1] ?? category.id;
    // A leaf name can occur in more than one branch. The most populated one is
    // the better guess, and the shopper can still narrow from there.
    for (const key of keysFor(leaf)) {
      const existing = categories.get(key);
      if (!existing || category.products > existing.products) {
        categories.set(key, { id: category.id, products: category.products });
      }
    }
  }

  const attributes = attributeFields.length
    ? await attributeValues(engine, site, attributeFields)
    : new Map<string, { field: string; value: string; products: number }>();

  const maxTokens = Math.max(
    1,
    ...[...brands.keys(), ...categories.keys(), ...attributes.keys()]
      .map((k) => k.split(' ').length),
  );
  return { brands, categories, attributes, maxTokens };
}

/**
 * The values each facet actually holds, read by asking the engine to count
 * them over the whole site.
 *
 * A facet-only query rather than a new engine method: every engine already
 * computes facets, so this works identically on all three, and there is no
 * fourth implementation to keep in step.
 */
async function attributeValues(
  engine: SearchEngine,
  site: string,
  fields: string[],
): Promise<Map<string, { field: string; value: string; products: number }>> {
  const values = new Map<string, { field: string; value: string; products: number }>();
  const result = await engine.search({
    site, terms: [], rawQuery: '', filters: {}, ranges: [], constraints: [],
    facets: fields, sort: 'relevance', groupWindow: 1, candidateLimit: 1,
    typo: { minWordLengthFor1Typo: 99, minWordLengthFor2Typos: 99 },
    weights: [], exactOnly: true,
  }).catch(() => null);
  if (!result) return values;

  for (const facet of result.facets) {
    for (const entry of facet.values) {
      const raw = String(entry.value);
      // Numbers on their own are dimensions, and the dimension parser already
      // owns those. Lifting "12" as a size here would fight it.
      if (!/[a-z]{2,}/i.test(raw)) continue;
      for (const key of keysFor(raw)) {
        const existing = values.get(key);
        // A value can occur under two fields — "Black" as both finish and
        // colour. The one carrying more products is the better guess.
        if (!existing || entry.count > existing.products) {
          values.set(key, { field: facet.field, value: raw, products: entry.count });
        }
      }
    }
  }
  return values;
}

export interface EntityMatch {
  constraints: ParsedConstraint[];
  /** Tokens left after the entities were lifted out. */
  residual: string[];
}

/**
 * Lift the entities a token sequence names.
 *
 * Longest span first, so "crown moulding" is one product type rather than two
 * words, and "ekena millwork" is one brand rather than a brand plus a noun.
 * A token is consumed once: an entity cannot be both.
 */
export function liftEntities(tokens: string[], entities: EntityIndex): EntityMatch {
  if (!tokens.length || entities.maxTokens === 0) {
    return { constraints: [], residual: tokens };
  }

  const constraints: ParsedConstraint[] = [];
  const taken = new Array<boolean>(tokens.length).fill(false);
  let brandFound = false;
  let categoryFound = false;
  let attributesFound = 0;

  for (let width = Math.min(entities.maxTokens, tokens.length); width >= 1; width--) {
    for (let i = 0; i + width <= tokens.length; i++) {
      if (taken.slice(i, i + width).some(Boolean)) continue;
      const span = tokens.slice(i, i + width);
      const key = normalise(span.join(' '));

      // One brand and one product type per query. A second of either is far
      // more likely to be a describing word that happens to collide with a
      // catalogue name than a shopper asking for two brands at once.
      const brand = !brandFound ? entities.brands.get(key) : undefined;
      if (brand) {
        constraints.push({ field: 'brand', value: brand, source: span.join(' '), kind: 'brand' });
        for (let j = i; j < i + width; j++) taken[j] = true;
        brandFound = true;
        continue;
      }
      const category = !categoryFound ? entities.categories.get(key) : undefined;
      if (category) {
        constraints.push({
          field: 'categoryId', value: category.id, source: span.join(' '), kind: 'category',
        });
        for (let j = i; j < i + width; j++) taken[j] = true;
        categoryFound = true;
        continue;
      }

      // Attributes last, and only after brand and category have had their
      // chance at this span: "Heritage" is a brand before it is a finish.
      const attribute = attributesFound < MAX_ATTRIBUTES
        ? entities.attributes.get(key)
        : undefined;
      if (attribute) {
        constraints.push({
          field: attribute.field, value: attribute.value,
          source: span.join(' '), kind: 'attribute',
        });
        for (let j = i; j < i + width; j++) taken[j] = true;
        attributesFound++;
      }
    }
  }

  return {
    constraints,
    residual: tokens.filter((_, i) => !taken[i]),
  };
}
