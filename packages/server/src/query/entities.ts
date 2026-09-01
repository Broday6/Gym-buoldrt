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

  // Words the taxonomy already uses. An attribute value that borrows one is
  // not allowed to redefine it: see `addPartialNames`.
  const categoryWords = new Set<string>();
  for (const category of directory.categories) {
    for (const segment of category.path) {
      for (const word of normalise(segment).split(' ')) {
        // Singular and plural both: the aisle is "Wall Panels" and the
        // shopper types "panel".
        if (word.length > 2) for (const form of keysFor(word)) categoryWords.add(form);
      }
    }
  }

  const attributes = attributeFields.length
    ? await attributeValues(engine, site, attributeFields, categoryWords)
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
  categoryWords: Set<string> = new Set(),
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

  addPartialNames(values, result.facets, categoryWords);
  return values;
}

/**
 * What a shopper is likely to call a value that the catalogue spells in full.
 *
 * Nobody types "Hunter Green". They type green. The catalogue's own words are
 * the merchandiser's, chosen to be precise on a product page, and a shopper
 * searching has one of them at best — so "green shutter", "red shutter" and
 * "white column" all matched nothing and fell through to whatever the aisle
 * happened to hold.
 *
 * The words worth accepting are read out of the values themselves rather than
 * from any list of colours, which is what makes this work on a catalogue of
 * paint and a catalogue of shoes alike. A word earns its place only when it
 * belongs to exactly one value of that attribute:
 *
 *   Hunter Green, Colonial Red, Primed White, Sage, Black
 *     -> hunter, green, colonial, red, primed, white all resolve
 *
 *   Standard Frame, Brickmould Frame, Brickmould Sill Frame
 *     -> "sill" and "standard" resolve; "frame" is in all three and "brickmould"
 *        in two, so neither is claimed and both stay ordinary search terms
 *
 * Refusing the ambiguous ones is the point. Guessing which brickmould someone
 * meant would filter half the range away on a coin flip, where leaving it as
 * text lets both through and lets relevance order them.
 */
function addPartialNames(
  values: Map<string, { field: string; value: string; products: number }>,
  facets: { field: string; values: { value: string | number; count: number }[] }[],
  /** Words the taxonomy already uses, which a feature may not redefine. */
  categoryWords: Set<string>,
): void {
  /** word -> every attribute value containing it, across every field. */
  const claims = new Map<string, {
    field: string; value: string; count: number; head: boolean;
  }[]>();

  for (const facet of facets) {
    for (const entry of facet.values) {
      const raw = String(entry.value);
      if (!/[a-z]{2,}/i.test(raw)) continue;
      const words = normalise(raw).split(' ').filter((w) => w.length > 2);
      // A single-word value is already its own key; splitting it adds nothing.
      if (words.length < 2) continue;
      const last = words[words.length - 1];
      for (const word of new Set(words)) {
        if (!claims.has(word)) claims.set(word, []);
        claims.get(word)!.push({
          field: facet.field, value: raw, count: entry.count, head: word === last,
        });
      }
    }
  }

  for (const [word, all] of claims) {
    // A word the taxonomy uses names a kind of thing, not a feature of one.
    // "Board and Batten" is a style of wall panel *and* a kind of shutter, and
    // letting the style claim `board` turned "board and batten shutter" into a
    // search for shutters in a wall-panel style — a combination no product has.
    // Same for `panel`, which made "shaker wainscot panel" ask for two
    // contradictory styles at once. A shopper typing a product noun means the
    // product.
    if (categoryWords.has(word)) continue;
    // Ambiguous inside one attribute is ambiguous, full stop: two frames are
    // brickmould, and picking one would filter half the range away on a coin
    // flip. Leaving it as text lets both through and lets relevance order them.
    const byField = new Map<string, typeof all>();
    for (const claim of all) {
      if (!byField.has(claim.field)) byField.set(claim.field, []);
      byField.get(claim.field)!.push(claim);
    }
    const candidates = [...byField.values()].filter((c) => c.length === 1).map((c) => c[0]!);
    if (!candidates.length) continue;

    // Between fields, the value the word is the *head* of wins. "Colonial Red"
    // is a red; "Western Red Cedar" is a cedar that happens to be reddish, and
    // a shopper typing "red shutter" means the first. Same rule that reads
    // "ceiling beams" as beams — the last word is what a name is about.
    const best = candidates.sort((a, b) => (
      Number(b.head) - Number(a.head) || b.count - a.count
    ))[0]!;

    for (const key of keysFor(word)) {
      // Never over an exact value: a catalogue carrying both "Green" and
      // "Hunter Green" means the plain word, and says so.
      if (values.has(key)) continue;
      values.set(key, { field: best.field, value: best.value, products: best.count });
    }
    // British and American spellings of the same colour are the same word.
    for (const [a, b] of [['gray', 'grey'], ['grey', 'gray']] as const) {
      if (!word.includes(a)) continue;
      const variant = normalise(word.replace(a, b));
      if (variant && !values.has(variant)) {
        values.set(variant, { field: best.field, value: best.value, products: best.count });
      }
    }
  }
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
  let attributesFound = 0;
  /**
   * Every product type the query names, not just the first one found.
   *
   * "ceiling beams" names two — Interior > Ceiling and Millwork > Beams — and
   * taking the first left-to-right filtered to the ceiling aisle and threw
   * "beams" away, so a shopper asking for beams got medallions. Which one is
   * meant is a choice, and it has to be made with both in hand.
   */
  const categorySpans: { at: number; width: number; id: string; source: string }[] = [];

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
      const category = entities.categories.get(key);
      if (category) {
        // Claimed for now so an attribute cannot steal the words while the
        // candidates are still being gathered; the losers are released below.
        categorySpans.push({ at: i, width, id: category.id, source: span.join(' ') });
        for (let j = i; j < i + width; j++) taken[j] = true;
        continue;
      }

      // Attributes last, and only after brand and category have had their
      // chance at this span: "Heritage" is a brand before it is a finish.
      const attribute = attributesFound < MAX_ATTRIBUTES
        ? entities.attributes.get(key)
        : undefined;
      // One value per attribute. Two are a contradiction, not a narrowing:
      // "shaker wainscot panel" was asking for a style that is Shaker and a
      // style that is Raised Panel, and no product is both. The first match
      // wins because the loop runs widest-span-first, so the longer, more
      // specific phrase has already had its turn.
      if (attribute && !constraints.some((c) => c.field === attribute.field)) {
        constraints.push({
          field: attribute.field, value: attribute.value,
          source: span.join(' '), kind: 'attribute',
        });
        for (let j = i; j < i + width; j++) taken[j] = true;
        attributesFound++;
      }
    }
  }

  const chosen = chooseCategory(categorySpans);
  if (chosen) {
    constraints.push({
      field: 'categoryId', value: chosen.id, source: chosen.source, kind: 'category',
    });
  }
  // Product types the query named but that lost the choice go back to being
  // ordinary search terms. That is what makes the answer right rather than
  // merely different: "ceiling" still has to be matched, and it is matched by
  // the words in "Faux Wood Ceiling Beam" — so the beams that mention a
  // ceiling outrank the ones that do not.
  for (const span of categorySpans) {
    if (span === chosen) continue;
    for (let j = span.at; j < span.at + span.width; j++) taken[j] = false;
  }

  return {
    constraints,
    residual: tokens.filter((_, i) => !taken[i]),
  };
}

/**
 * Which of the product types a query names is the one being asked for.
 *
 * Two rules, in order:
 *
 *   - **The longer phrase wins.** "ceiling medallion" is a more specific claim
 *     than "ceiling", and a shopper who typed the longer one meant it.
 *   - **Otherwise the last one wins.** English puts the head noun last and the
 *     modifiers before it: "ceiling beams" are beams, "exterior shutters" are
 *     shutters, "kitchen lighting" is lighting. The word in front describes
 *     where the thing goes, not what it is.
 *
 * Only one is lifted, because filtering to two aisles at once returns nothing:
 * no product is both a medallion and a beam.
 */
function chooseCategory<T extends { at: number; width: number }>(spans: T[]): T | undefined {
  let best: T | undefined;
  for (const span of spans) {
    if (!best
      || span.width > best.width
      || (span.width === best.width && span.at > best.at)) {
      best = span;
    }
  }
  return best;
}
