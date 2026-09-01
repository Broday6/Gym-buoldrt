/**
 * Recovering attributes the feed states but does not fill in.
 *
 * A catalogue adopts structured fields partway through its life. The SKUs
 * added since carry a Finish column; the ones before it say "Walnut" in the
 * item name and nothing else. Both are findable by a shopper who types
 * "walnut" as a word — the title is searchable text — but only the newer ones
 * can be *filtered* to, appear under the Finish facet, or be caught by a
 * merchandising rule about walnut products. The older half is invisible to
 * every part of the system that works on structure rather than words.
 *
 * Nobody is going to backfill that by hand at two million SKUs. So it is
 * inferred, under four rules that between them decide whether this is useful
 * or dangerous:
 *
 *   - **The vocabulary comes from the catalogue, never from a word list.**
 *     What counts as a finish is whatever appears in the finish column of the
 *     products that have one. This is why it works on a millwork catalogue and
 *     would work on one selling shoes, and why it needs no configuration: the
 *     feed teaches it what the feed means. It is learned per category as well
 *     as overall, because the same words mean different things in different
 *     aisles: "Board and Batten" is a style of wall panel and a kind of
 *     shutter, and a shutter titled "Joined 14\"W x 39\"H Western Red Cedar
 *     Board and Batten Shutter" names two known styles until you notice that
 *     only one of them has ever been a style *of a shutter*.
 *   - **Only blanks are filled.** A stated value is never overwritten,
 *     however confident the text looks. The source is the authority; this is
 *     repair, not opinion.
 *   - **Ambiguity is declined, not resolved.** A shutter description reading
 *     "cellular PVC that will not rot" names a material the product may not be
 *     made of. Where the most trustworthy text naming a value names more than
 *     one, nothing is written. A blank is recoverable later; a wrong value is
 *     believed by everything downstream.
 *   - **Everything it did is reported.** A merchandiser can read what was
 *     inferred and from where, because a system that silently invents product
 *     data is one nobody should trust with a catalogue.
 *
 * It runs on the raw feed rows rather than on normalised products, which is
 * both simpler and more correct: a filled cell flows through the existing
 * pipeline as though the source had sent it, so facets, variant titles,
 * dimensional search and merchandising all pick it up with no further
 * plumbing — and per-variant text (a keyword column that differs by finish)
 * is still attached to its own row, which it no longer is once variants are
 * grouped under a parent.
 */
import type { SourceRow } from './normalize.js';
import type { FieldMapping } from './mapping.js';
import { parseMeasurement, toInches } from '../query/dimensions.js';

export interface LearnOptions {
  /**
   * How many products must state a value in its own column before it is
   * treated as part of that attribute's vocabulary. One is enough — a rare
   * finish is still a real finish — but a typo in a single row would otherwise
   * become a word this happily matches against.
   */
  minEvidence?: number;
  /** How many individual recoveries to keep for display. */
  maxSamples?: number;
  /**
   * How many times one inferred value may appear among the samples.
   *
   * Without a cap the sample is the first N rows, and since every variant of a
   * product repeats its parent's material and style, fifty rows show about ten
   * products — all of them beams. A reviewer checking the work needs to see
   * the range of what was claimed, not the same claim fifty times.
   */
  samplesPerValue?: number;
  /** Attribute keys to leave alone. */
  skip?: string[];
  /**
   * How many products must use a labelled pair before it is treated as part of
   * the feed's shape and given a column. Defaults to the larger of five rows
   * and one percent of them.
   */
  minLabelledRows?: number;
}

export interface LearnedValue {
  sku: string;
  key: string;
  value: string;
  /** Which field the value was read out of. */
  source: string;
}

export interface LearnReport {
  /** Cells filled. */
  filled: number;
  /**
   * Attributes that existed nowhere but in prose, and the labelled pairs that
   * produced them. Counted apart from `filled` because they are a different
   * claim: filling a blank column asserts a value, while this asserts that a
   * whole product attribute exists at all.
   */
  discovered: Record<string, number>;
  rowsChanged: number;
  byKey: Record<string, number>;
  bySource: Record<string, number>;
  /** Blanks left alone because the text named more than one candidate. */
  declined: number;
  /** Distinct known values per attribute, i.e. what it had to work with. */
  vocabulary: Record<string, number>;
  samples: LearnedValue[];
}

/**
 * Text fields worth reading, most specific first.
 *
 * Order decides ties, and the ordering is a claim about trust: a variant's own
 * option name is about that variant, a title is curated, a keyword list is a
 * dumping ground, and a description is prose that will happily mention a
 * material the product is not made of. The first of these that names any
 * candidate at all is the one consulted — so a title naming exactly one
 * material settles the question before the description gets to muddy it.
 */
const TEXT_FIELDS = ['variantTitle', 'title', 'tags', 'description'] as const;

/** Attributes whose values are measurements, read by a different route. */
const DIMENSION_KEYS = new Set(['width', 'height', 'depth', 'length', 'thickness']);

/**
 * Fill blank attribute cells from the row's own text, in place.
 *
 * Mutates `rows` rather than copying them: at catalogue scale the copy is the
 * expensive part, and the caller has just parsed these out of a file nobody
 * else holds a reference to.
 */
export function learnAttributes(
  rows: SourceRow[],
  mapping: FieldMapping,
  options: LearnOptions = {},
): LearnReport {
  const minEvidence = options.minEvidence ?? 1;
  const maxSamples = options.maxSamples ?? 500;
  const samplesPerValue = options.samplesPerValue ?? 2;
  const sampled = new Map<string, number>();
  const keepSample = (value: LearnedValue): void => {
    if (report.samples.length >= maxSamples) return;
    const seen = `${value.key}=${value.value}`;
    const n = sampled.get(seen) ?? 0;
    if (n >= samplesPerValue) return;
    sampled.set(seen, n + 1);
    report.samples.push(value);
  };
  const skip = new Set(options.skip ?? []);

  const report: LearnReport = {
    filled: 0, discovered: {}, rowsChanged: 0, byKey: {}, bySource: {},
    declined: 0, vocabulary: {}, samples: [],
  };

  const textColumns: [string, string][] = TEXT_FIELDS
    .map((field) => [field, mapping.fields[field] ?? ''] as [string, string])
    .filter(([, column]) => Boolean(column));
  if (!textColumns.length) return report;

  const skuColumn = mapping.fields.sku ?? '';
  const categoryColumn = mapping.fields.categoryPath ?? '';

  // Before anything else, because it can create the very columns the rest of
  // this function then learns a vocabulary from.
  readLabelledPairs(rows, mapping, textColumns, skuColumn, report, options);

  const learnable = Object.entries(mapping.attributes)
    .filter(([key]) => !skip.has(key) && !DIMENSION_KEYS.has(key));

  // ---- Induce the vocabulary from the rows that do state a value. ----
  // Twice over: once for the catalogue, and once per category. The catalogue
  // -wide set is the fallback for a product filed nowhere; the per-category
  // set is what actually gets used, and is the difference between reading a
  // shutter's title correctly and refusing to read it at all.
  const global = new Map<string, Map<string, number>>();
  const byCategory = new Map<string, Map<string, Map<string, number>>>();
  const bump = (into: Map<string, Map<string, number>>, key: string, value: string) => {
    if (!into.has(key)) into.set(key, new Map());
    const counts = into.get(key)!;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  };
  for (const row of rows) {
    const scope = (row[categoryColumn] ?? '').trim();
    for (const [key, column] of learnable) {
      const value = (row[column] ?? '').trim();
      if (!usableValue(value)) continue;
      bump(global, key, value);
      if (!scope) continue;
      if (!byCategory.has(scope)) byCategory.set(scope, new Map());
      bump(byCategory.get(scope)!, key, value);
    }
  }

  const prune = (counts: Map<string, Map<string, number>>) => {
    for (const [key, values] of counts) {
      const kept = new Map([...values].filter(([, n]) => n >= minEvidence));
      if (kept.size) counts.set(key, kept);
      else counts.delete(key);
    }
    return counts;
  };
  prune(global);
  for (const counts of byCategory.values()) prune(counts);
  const vocabulary = global;
  for (const [key, values] of global) report.vocabulary[key] = values.size;

  // A value claimed by two attributes ("Black" as both a finish and a colour)
  // cannot be assigned from text alone unless only one of them is blank.
  const claims = new Map<string, Set<string>>();
  for (const [key, values] of vocabulary) {
    for (const value of values.keys()) {
      const lower = value.toLowerCase();
      if (!claims.has(lower)) claims.set(lower, new Set());
      claims.get(lower)!.add(key);
    }
  }

  // Compiled once per scope and reused across every row in it.
  const compiled = new Map<string, Map<string, Candidate[]>>();
  const compile = (counts: Map<string, Map<string, number>>) => {
    const out = new Map<string, Candidate[]>();
    for (const [key, values] of counts) {
      out.set(key, [...values.keys()].map((value) => ({ value, re: phrase(value) })));
    }
    return out;
  };
  compiled.set('', compile(global));
  for (const [scope, counts] of byCategory) compiled.set(scope, compile(counts));

  /**
   * A category's own words, falling back to the catalogue's only where the
   * category has never stated this attribute at all. Not falling back when the
   * category *does* have a vocabulary is the point: a style the shutters
   * aisle has never used is not a candidate for a shutter, whoever else uses
   * it.
   */
  const candidatesFor = (scope: string, key: string): Candidate[] | undefined =>
    compiled.get(scope)?.get(key) ?? compiled.get('')!.get(key);

  // ---- Fill the blanks. ----
  const dimensionColumns = dimensionColumnsOf(mapping);
  for (const row of rows) {
    const text = new Map(textColumns.map(([field, column]) => [field, row[column] ?? '']));
    const sku = (row[skuColumn] ?? '').trim();
    let changed = false;

    const scope = (row[categoryColumn] ?? '').trim();
    const missing = learnable.filter(([, column]) => !(row[column] ?? '').trim());
    for (const [key, column] of missing) {
      const candidates = candidatesFor(scope, key);
      if (!candidates) continue;

      const found = firstNaming(text, candidates);
      if (!found) continue;
      if (found.values.length > 1) {
        report.declined++;
        continue;
      }
      const value = found.values[0]!;

      // Claimed by more than one attribute: only safe when this is the only
      // one of them still empty, otherwise the word may belong to the other.
      const claimedBy = claims.get(value.toLowerCase());
      if (claimedBy && claimedBy.size > 1) {
        const alsoEmpty = [...claimedBy].filter((other) => {
          if (other === key) return false;
          const otherColumn = mapping.attributes[other];
          return Boolean(otherColumn) && !(row[otherColumn!] ?? '').trim();
        });
        if (alsoEmpty.length) {
          report.declined++;
          continue;
        }
      }

      row[column] = value;
      changed = true;
      report.filled++;
      report.byKey[key] = (report.byKey[key] ?? 0) + 1;
      report.bySource[found.field] = (report.bySource[found.field] ?? 0) + 1;
      keepSample({ sku, key, value, source: found.field });
    }

    // Dimensions are not vocabulary — "6 in" is not a word the catalogue
    // teaches — so they are read out of the shape a title states them in.
    for (const { key, column, value } of dimensionsFrom(text, dimensionColumns, row)) {
      row[column] = value;
      changed = true;
      report.filled++;
      report.byKey[key] = (report.byKey[key] ?? 0) + 1;
      report.bySource.title = (report.bySource.title ?? 0) + 1;
      keepSample({ sku, key, value, source: 'title' });
    }

    if (changed) report.rowsChanged++;
  }

  return report;
}

/**
 * The most trustworthy field naming any known value, and everything it names.
 *
 * Returning all of them rather than the first is what makes declining
 * possible: a description reading "Western Red Cedar ... cellular PVC" names
 * two materials, and the honest answer is that it does not say.
 */
interface Candidate {
  value: string;
  re: RegExp;
}

function firstNaming(
  text: Map<string, string>,
  candidates: Candidate[],
): { field: string; values: string[] } | null {
  for (const [field, content] of text) {
    if (!content) continue;
    const hits = candidates.filter((c) => c.re.test(content)).map((c) => c.value);
    if (!hits.length) continue;
    return { field, values: longestOnly(hits) };
  }
  return null;
}

/**
 * Drop values contained in a longer match.
 *
 * "Primed White" and "White" would otherwise both fire on the same words and
 * look like a disagreement, costing a recovery that was never ambiguous.
 */
function longestOnly(values: string[]): string[] {
  return values.filter((value) => !values.some(
    (other) => other !== value
      && other.length > value.length
      && phrase(value).test(other),
  ));
}

/** Word-boundary phrase match, so "PVC" does not fire inside a part number. */
function phrase(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu');
}

/**
 * A value worth learning from.
 *
 * Bare numbers, codes and single letters are either measurements — handled
 * separately — or identifiers nobody types as a feature. Matching text against
 * them would fire constantly and mean nothing.
 */
function usableValue(value: string): boolean {
  if (value.length < 3 || value.length > 60) return false;
  if (!/\p{L}{3}/u.test(value)) return false;
  // Something like "4 in" or "12-ft": a measurement, not a feature word.
  if (/^\d[\d\s./-]*\p{L}{0,6}$/u.test(value)) return false;
  return true;
}

function dimensionColumnsOf(mapping: FieldMapping): Map<string, string> {
  const columns = new Map<string, string>();
  for (const key of DIMENSION_KEYS) {
    const column = mapping.attributes[key];
    if (column) columns.set(key, column);
  }
  return columns;
}

/** `6"W x 8"H` and its spellings, the way a millwork title states a section. */
const CROSS_SECTION_IN_TEXT =
  /(\d+(?:[.\-/]\d+)*)\s*(?:"|in\b|inch(?:es)?\b)?\s*W\s*[x×]\s*(\d+(?:[.\-/]\d+)*)\s*(?:"|in\b|inch(?:es)?\b)?\s*H/i;

/**
 * Width and height stated in a title.
 *
 * Only the labelled form is read. A bare `4x6` in a title could be a section,
 * a pack count or part of a model name, and assigning an axis to it on a guess
 * would put wrong numbers into dimensional search — where they are worse than
 * missing ones, because a filter silently excludes rather than fails.
 */
function dimensionsFrom(
  text: Map<string, string>,
  columns: Map<string, string>,
  row: SourceRow,
): { key: string; column: string; value: string }[] {
  const width = columns.get('width');
  const height = columns.get('height');
  if (!width || !height) return [];
  if ((row[width] ?? '').trim() && (row[height] ?? '').trim()) return [];

  const match = (text.get('title') ?? '').match(CROSS_SECTION_IN_TEXT);
  if (!match) return [];

  const out: { key: string; column: string; value: string }[] = [];
  for (const [key, column, raw] of [
    ['width', width, match[1]!], ['height', height, match[2]!],
  ] as const) {
    if ((row[column] ?? '').trim()) continue;
    const n = parseMeasurement(raw);
    if (n === null) continue;
    out.push({ key, column, value: `${round(toInches(n, 'in'))} in` });
  }
  return out;
}

const round = (n: number) => Math.round(n * 16) / 16;

/**
 * `MATERIAL: PVC  FRAME: Standard` — attributes that exist nowhere but prose.
 *
 * The pass above recovers a value for a column some products already fill in.
 * It is helpless when the column does not exist at all, because it induces its
 * vocabulary from that column: no populated cells anywhere means no vocabulary
 * and nothing to match.
 *
 * That is not a corner case. A real NetSuite export of 711 gable vents has
 * columns for internal id, record type, description, name and three variant
 * options — and states the material, the style, the vent type and the frame
 * only inside the description, as labelled pairs. Four product attributes that
 * every shopper filters on, invisible to search, with no column to recover
 * them into. So the column gets created.
 *
 * Deliberately narrow, because inventing product attributes out of punctuation
 * is the most destructive thing in this file:
 *
 *   - **The label must be shouted.** ALL CAPS immediately before the colon.
 *     Prose does not do this; ERP description templates always do. A
 *     lower-case "note:" or a time like "12:30" cannot become an attribute.
 *   - **Only the last word before the colon is the label.** In
 *     `MATERIAL: PVC  FRAME: Standard`, `PVC` is the previous value, not part
 *     of the next label.
 *   - **It has to be a pattern, not an accident.** A label is only believed
 *     once enough products use it, so one stray colon in one description
 *     cannot add a column to the catalogue.
 *   - **Template placeholders are not values.** `SIZE: __"W X __"H` is a form
 *     waiting to be filled in, and 26 of those 711 rows carry it.
 */
function readLabelledPairs(
  rows: SourceRow[],
  mapping: FieldMapping,
  textColumns: [string, string][],
  skuColumn: string,
  report: LearnReport,
  options: LearnOptions,
): void {
  const minRows = options.minLabelledRows ?? Math.max(5, Math.ceil(rows.length * 0.01));

  // Pass one: which labels are used often enough to be part of the feed's
  // shape rather than a coincidence.
  const seen = new Map<string, number>();
  for (const row of rows) {
    for (const [, column] of textColumns) {
      for (const { key } of labelledPairsIn(row[column] ?? '')) {
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
  }

  const claimed = new Set(Object.keys(mapping.attributes));
  const create: string[] = [];
  for (const [key, n] of seen) {
    if (n < minRows) continue;
    // An attribute the feed already has a column for is filled by the pass
    // above, on its own vocabulary. Creating a second column for the same name
    // would split the facet in two.
    if (claimed.has(key)) continue;
    create.push(key);
  }
  if (!create.length) return;

  // Pass two: give each discovered attribute a column, and fill it.
  for (const key of create) {
    mapping.attributes[key] = `learned:${key}`;
    if (!mapping.facetable?.includes(key)) mapping.facetable = [...(mapping.facetable ?? []), key];
  }
  const wanted = new Set(create);
  for (const row of rows) {
    for (const [field, column] of textColumns) {
      for (const { key, value } of labelledPairsIn(row[column] ?? '')) {
        if (!wanted.has(key)) continue;
        const target = `learned:${key}`;
        if ((row[target] ?? '').trim()) continue;
        row[target] = value;
        report.filled++;
        report.discovered[key] = (report.discovered[key] ?? 0) + 1;
        report.byKey[key] = (report.byKey[key] ?? 0) + 1;
        report.bySource[field] = (report.bySource[field] ?? 0) + 1;
        if (report.samples.length < (options.maxSamples ?? 500)) {
          report.samples.push({ sku: (row[skuColumn] ?? '').trim(), key, value, source: field });
        }
      }
    }
  }
}

/**
 * The label is the shouted word immediately before the colon, optionally with
 * a parenthetical qualifier — `SIZE (RO):`. The value runs to the next label
 * or the end of the text.
 */
const LABELLED_PAIR = /\b([A-Z][A-Z0-9_-]{1,19})(\s*\([A-Z]{1,6}\))?\s*:\s*/g;

function labelledPairsIn(text: string): { key: string; value: string }[] {
  if (!text || !text.includes(':')) return [];
  const found = [...text.matchAll(LABELLED_PAIR)];
  const out: { key: string; value: string }[] = [];
  for (let i = 0; i < found.length; i++) {
    const match = found[i]!;
    const start = match.index! + match[0].length;
    const end = i + 1 < found.length ? found[i + 1]!.index! : text.length;
    const value = text.slice(start, end).trim().replace(/\s+/g, ' ');
    const key = match[1]!.toLowerCase();
    // A placeholder is a form, not a value; and a value long enough to be a
    // sentence is prose that happened to follow a colon.
    if (!value || value.length > 60 || value.includes('__')) continue;
    if (!/[a-z0-9]/i.test(value)) continue;
    out.push({ key, value });
  }
  return out;
}
