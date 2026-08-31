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
    filled: 0, rowsChanged: 0, byKey: {}, bySource: {},
    declined: 0, vocabulary: {}, samples: [],
  };

  const textColumns: [string, string][] = TEXT_FIELDS
    .map((field) => [field, mapping.fields[field] ?? ''] as [string, string])
    .filter(([, column]) => Boolean(column));
  if (!textColumns.length) return report;

  const skuColumn = mapping.fields.sku ?? '';
  const categoryColumn = mapping.fields.categoryPath ?? '';
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
