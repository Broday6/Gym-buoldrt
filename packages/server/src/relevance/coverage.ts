/**
 * A judged case for every product type and every feature the catalogue holds.
 *
 * The hand-written cases in `cases.ts` say what a shopper means by a
 * particular phrasing, and each one exists because somebody thought of it.
 * That is their strength and their limit: "ceiling beams" returned ceiling
 * medallions for as long as it took a person to type it, because no case
 * covered it and no case would have, since the whole point of a bug is that
 * nobody thought of it.
 *
 * These are generated from the catalogue instead, so coverage follows the
 * data rather than anyone's imagination. If a category exists, searching its
 * name is tested. If a finish exists, filtering to it is tested. Add a
 * product line to the feed and it arrives already covered.
 *
 * The assertions are deliberately weak — every result is in the aisle you
 * named, every result has the finish you asked for — because a generated case
 * cannot know what *should* rank first. Weak assertions over the whole
 * catalogue catch a different class of fault from strong assertions over
 * fifteen queries, and the two together are the point.
 */
import type { VariantDoc } from '@compass/shared';
import type { RelevanceCase } from './judge.js';

/** Attributes worth generating cases for: the ones a shopper says out loud. */
const SPOKEN = ['finish', 'material', 'style', 'frame', 'type'];

/**
 * How many products a value needs before it is worth a case.
 *
 * A finish on one product is a long tail worth having in the index and not
 * worth a regression test: it is one row away from disappearing when the feed
 * changes, and the case would fail for that rather than for a fault.
 */
const MIN_PRODUCTS = 3;

export function coverageCases(docs: VariantDoc[]): RelevanceCase[] {
  return [...categoryCases(docs), ...attributeCases(docs)];
}

/** Searching a product type's own name returns that product type. */
function categoryCases(docs: VariantDoc[]): RelevanceCase[] {
  const byLeaf = new Map<string, Set<string>>();
  for (const doc of docs) {
    const leaf = doc.categoryPath[doc.categoryPath.length - 1];
    if (!leaf) continue;
    if (!byLeaf.has(leaf)) byLeaf.set(leaf, new Set());
    byLeaf.get(leaf)!.add(doc.parentId);
  }

  const cases: RelevanceCase[] = [];
  for (const [leaf, parents] of byLeaf) {
    if (parents.size < MIN_PRODUCTS) continue;
    cases.push({
      id: `cover-category-${slug(leaf)}`,
      query: leaf.toLowerCase(),
      intent: `Searching "${leaf}" returns ${leaf}`,
      expect: { category: leaf },
      minResults: 1,
      // A product type's own name should match outright. Needing the rescue
      // means the catalogue cannot find a thing it is named after.
      rescued: false,
    });
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Naming a feature and a product type returns products with that feature.
 *
 * Paired with the product type on purpose. A finish on its own is a fair
 * search but a vague one — "walnut" could reasonably return anything walnut —
 * while "walnut beam" has exactly one right answer, which is what a
 * regression test needs.
 */
function attributeCases(docs: VariantDoc[]): RelevanceCase[] {
  // value -> attribute -> the categories it appears in, with product counts
  const seen = new Map<string, Map<string, Map<string, Set<string>>>>();
  for (const doc of docs) {
    const leaf = doc.categoryPath[doc.categoryPath.length - 1];
    if (!leaf) continue;
    for (const key of SPOKEN) {
      const value = doc.attrs?.[key];
      if (typeof value !== 'string' || !value.trim()) continue;
      if (!seen.has(key)) seen.set(key, new Map());
      const byValue = seen.get(key)!;
      if (!byValue.has(value)) byValue.set(value, new Map());
      const byCategory = byValue.get(value)!;
      if (!byCategory.has(leaf)) byCategory.set(leaf, new Set());
      byCategory.get(leaf)!.add(doc.parentId);
    }
  }

  const cases: RelevanceCase[] = [];
  for (const [key, byValue] of seen) {
    for (const [value, byCategory] of byValue) {
      // The aisle where this value is most common: the least ambiguous place
      // to ask about it, and the one a shopper most likely means.
      let leaf = '';
      let best = 0;
      for (const [category, parents] of byCategory) {
        if (parents.size > best) {
          best = parents.size;
          leaf = category;
        }
      }
      if (best < MIN_PRODUCTS) continue;
      cases.push({
        id: `cover-${key}-${slug(value)}-${slug(leaf)}`,
        query: `${value} ${singular(leaf)}`.toLowerCase(),
        intent: `A ${key} named with its product type returns products having it`,
        expect: { category: leaf, attr: { [key]: value } },
        minResults: 1,
      });
    }
  }
  return cases.sort((a, b) => a.id.localeCompare(b.id));
}

/** "Faux Wood Beams" -> "faux wood beam": aisles are plural, shoppers are not. */
function singular(leaf: string): string {
  return leaf.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
