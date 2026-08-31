/**
 * Judging a result page.
 *
 * There are 305 unit tests in this repository and not one of them asks whether
 * searching works. They test synonym expansion, the dimension parser, the
 * tie-breaking cascade — components, in isolation, with hand-built inputs. All
 * of them can pass while `black pvc shutter` returns chandeliers.
 *
 * That gap makes every ranking change unfalsifiable. Fixing the way `corbel`
 * behaves could quietly ruin `beam`, and the first person to find out would be
 * a shopper who did not buy anything. So: a fixed set of queries, a statement
 * of what each one should return, and a number that moves when the answer gets
 * worse.
 *
 * **Judgments are predicates, not lists of SKUs.** The usual golden set pairs a
 * query with the ids of the documents that should come back, which is precise
 * and useless here — the demo catalogue is generated, so every id churns when
 * the seed or the product count changes, and none of them exist in the real
 * NetSuite export this will eventually run against. A predicate ("every result
 * is a shutter, black, in PVC") survives both, and states the shopper's intent
 * rather than one particular satisfaction of it.
 */
import type { Hit, SearchResponse, VariantDoc } from '@compass/shared';

/**
 * What a correct result looks like. Every field present must hold; an empty
 * judgment matches everything.
 */
export interface Judgment {
  /**
   * Satisfied when any one of these is. For "this really is a chandelier" on a
   * catalogue where some products are missing their category: the taxonomy is
   * the best evidence when it is there, and the title is the fallback when it
   * is not. Without this the suite would punish the engine for correctly
   * finding a product whose category column is blank.
   */
  anyOf?: Judgment[];
  /** A segment of the category path, matched case-insensitively. */
  category?: string;
  /** Attribute values, each either exact or one of several acceptable ones. */
  attr?: Record<string, string | string[]>;
  /** Regular expression over the title and variant title together. */
  title?: string;
  brand?: string;
  inStock?: boolean;
}

export interface RelevanceCase {
  /** Stable across catalogue regeneration — the baseline is keyed on it. */
  id: string;
  query: string;
  /** Why this case exists, in a sentence. Printed when it fails. */
  intent: string;
  /** Results considered. Ten is a screenful; a shopper rarely goes further. */
  k?: number;
  /**
   * Every one of the top k must satisfy this. The graded metric — the share
   * that do is this case's precision, and the number the baseline tracks.
   */
  expect?: Judgment;
  /** At least n of the top k must satisfy it. For "the range should be here". */
  atLeast?: { n: number; of: Judgment };
  /** None of the top k may satisfy it. */
  forbid?: Judgment;
  minResults?: number;
  /** Constraint values the analyser should have lifted out of the text. */
  understands?: string[];
  /**
   * Whether the query should have needed rescuing. Set false for a query that
   * ought to work outright: a page that arrives only because the engine
   * relaxed it is a different, weaker outcome than one that matched.
   */
  rescued?: boolean;
}

export interface CaseResult {
  id: string;
  query: string;
  intent: string;
  /** Share of the top k satisfying `expect`; 1 when the case sets none. */
  precision: number;
  /** How many of the top k satisfied it, and how many were judged. */
  matched: number;
  judged: number;
  totalHits: number;
  pass: boolean;
  /** Why it failed, in words. Empty when it passed. */
  failures: string[];
  /** The first few results, so a failure can be read without a debugger. */
  top: string[];
}

export interface SuiteResult {
  cases: CaseResult[];
  /** Mean precision across cases. The suite's single number. */
  score: number;
  passed: number;
  failed: number;
}

/** Resolve a hit back to the document it came from, for attribute judging. */
export type DocLookup = (sku: string) => VariantDoc | undefined;

export function matches(doc: VariantDoc, judgment: Judgment): boolean {
  if (judgment.anyOf && !judgment.anyOf.some((j) => matches(doc, j))) return false;
  if (judgment.category) {
    const wanted = judgment.category.toLowerCase();
    const path = doc.categoryPath.map((c) => c.toLowerCase());
    if (!path.some((c) => c === wanted || c.includes(wanted))) return false;
  }
  if (judgment.brand && doc.brand.toLowerCase() !== judgment.brand.toLowerCase()) return false;
  if (judgment.inStock !== undefined && doc.inStock !== judgment.inStock) return false;
  if (judgment.title) {
    const text = `${doc.title} ${doc.variantTitle}`;
    if (!new RegExp(judgment.title, 'i').test(text)) return false;
  }
  for (const [key, allowed] of Object.entries(judgment.attr ?? {})) {
    const actual = doc.attrs?.[key];
    if (actual === undefined) return false;
    const options = Array.isArray(allowed) ? allowed : [allowed];
    const value = String(actual).toLowerCase();
    if (!options.some((o) => o.toLowerCase() === value)) return false;
  }
  return true;
}

export function scoreCase(
  testCase: RelevanceCase,
  response: SearchResponse,
  lookup: DocLookup,
): CaseResult {
  const k = testCase.k ?? 10;
  const top = response.hits.slice(0, k);
  const docs = top.map((hit) => lookup(hit.sku)).filter((d): d is VariantDoc => Boolean(d));
  const failures: string[] = [];

  // A hit whose document cannot be resolved is a harness bug, not a relevance
  // finding, and silently scoring it as a miss would blame the engine for it.
  if (docs.length !== top.length) {
    failures.push(`${top.length - docs.length} of ${top.length} results are not in the corpus`);
  }

  let matched = docs.length;
  if (testCase.expect) {
    matched = docs.filter((d) => matches(d, testCase.expect!)).length;
    if (matched < docs.length) {
      const wrong = docs.filter((d) => !matches(d, testCase.expect!));
      failures.push(`${wrong.length} of ${docs.length} results are not ${describe(testCase.expect)}`
        + ` — e.g. ${describeHit(wrong[0]!)}`);
    }
  }
  const precision = docs.length ? matched / docs.length : 0;

  if (testCase.atLeast) {
    const n = docs.filter((d) => matches(d, testCase.atLeast!.of)).length;
    if (n < testCase.atLeast.n) {
      failures.push(`only ${n} of the top ${k} are ${describe(testCase.atLeast.of)},`
        + ` wanted at least ${testCase.atLeast.n}`);
    }
  }

  if (testCase.forbid) {
    const bad = docs.filter((d) => matches(d, testCase.forbid!));
    if (bad.length) {
      failures.push(`${bad.length} result(s) should not be here — ${describeHit(bad[0]!)}`
        + ` is ${describe(testCase.forbid)}`);
    }
  }

  if (testCase.minResults !== undefined && response.totalHits < testCase.minResults) {
    failures.push(`${response.totalHits} results, wanted at least ${testCase.minResults}`);
  }

  if (testCase.understands) {
    const lifted = (response.parsedFilters ?? []).map((f) => String(f.value).toLowerCase());
    const missing = testCase.understands.filter((u) => !lifted.includes(u.toLowerCase()));
    if (missing.length) {
      failures.push(`did not understand ${missing.join(', ')}`
        + (lifted.length ? ` (understood ${lifted.join(', ')})` : ' (understood nothing)'));
    }
  }

  if (testCase.rescued !== undefined) {
    const rescued = Boolean(response.rescue && response.rescue.strategy !== 'none');
    if (rescued !== testCase.rescued) {
      failures.push(rescued
        ? `needed rescuing (${response.rescue!.strategy}) — it should have matched outright`
        : 'was expected to need rescuing and did not');
    }
  }

  return {
    id: testCase.id,
    query: testCase.query,
    intent: testCase.intent,
    precision: round3(precision),
    matched,
    judged: docs.length,
    totalHits: response.totalHits,
    pass: failures.length === 0,
    failures,
    top: top.slice(0, 5).map((hit) => hitLabel(hit)),
  };
}

export function summarise(cases: CaseResult[]): SuiteResult {
  const score = cases.length
    ? cases.reduce((sum, c) => sum + c.precision, 0) / cases.length
    : 0;
  return {
    cases,
    score: round3(score),
    passed: cases.filter((c) => c.pass).length,
    failed: cases.filter((c) => !c.pass).length,
  };
}

function describe(judgment: Judgment): string {
  const parts: string[] = [];
  if (judgment.anyOf) parts.push(`(${judgment.anyOf.map(describe).join(' or ')})`);
  for (const [key, value] of Object.entries(judgment.attr ?? {})) {
    parts.push(`${key}=${Array.isArray(value) ? value.join('|') : value}`);
  }
  if (judgment.category) parts.push(`in ${judgment.category}`);
  if (judgment.brand) parts.push(`by ${judgment.brand}`);
  if (judgment.title) parts.push(`titled /${judgment.title}/`);
  if (judgment.inStock !== undefined) parts.push(judgment.inStock ? 'in stock' : 'out of stock');
  return parts.join(' ') || 'anything';
}

function describeHit(doc: VariantDoc): string {
  return `${doc.sku} "${doc.title}"`;
}

function hitLabel(hit: Hit): string {
  return `${hit.sku} ${hit.title}${hit.variantTitle ? ` (${hit.variantTitle})` : ''}`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
