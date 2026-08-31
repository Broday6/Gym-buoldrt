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
  /** Longest entity name in tokens, so the scanner knows how wide to look. */
  maxTokens: number;
}

const EMPTY: EntityIndex = { brands: new Map(), categories: new Map(), maxTokens: 0 };

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

  const maxTokens = Math.max(
    1,
    ...[...brands.keys(), ...categories.keys()].map((k) => k.split(' ').length),
  );
  return { brands, categories, maxTokens };
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
      }
    }
  }

  return {
    constraints,
    residual: tokens.filter((_, i) => !taken[i]),
  };
}
