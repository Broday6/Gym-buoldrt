import type { BusinessWeights, RankExplanation, SearchableAttribute, VariantDoc } from '@compass/shared';
import type { EngineCandidate } from '../engine/types.js';
import { businessScore, type ClickSignals } from './business.js';

/**
 * Textual relevance is a tie-breaking CASCADE, not a weighted sum: each
 * criterion is compared in order and only decides when everything above it is
 * equal. That is what makes ranking explainable — "it won on words matched" is
 * a true statement, which a blended score can never give you.
 *
 * Order (§5): typo count -> words matched -> attribute weight of the match
 * location -> word proximity -> exactness. Business ranking then orders within
 * a band of textually-equivalent results.
 */

/** Fields searched, in the order they appear on a document. */
export const SEARCHABLE_FIELDS = [
  'title', 'sku', 'mpn', 'brand', 'categoryPath', 'attributes', 'variantTitle', 'description',
] as const;
export type SearchableField = (typeof SEARCHABLE_FIELDS)[number];

export interface TextSignals {
  typos: number;
  wordsMatched: number;
  bestField: string;
  bestFieldWeight: number;
  /** Token span covering all matched terms in the best field. Lower is better. */
  proximity: number;
  /** 3 = whole field equals the query, 2 = all terms exact, 1 = prefix, 0 = fuzzy. */
  exactness: number;
}

export function fieldText(doc: VariantDoc, field: SearchableField): string {
  switch (field) {
    case 'title': return doc.title ?? '';
    case 'sku': return doc.sku ?? '';
    case 'mpn': return doc.mpn ?? '';
    case 'brand': return doc.brand ?? '';
    case 'categoryPath': return (doc.categoryPath ?? []).join(' ');
    case 'attributes': return (doc.attributeText ?? []).join(' ');
    case 'variantTitle': return doc.variantTitle ?? '';
    case 'description': return doc.description ?? '';
  }
}

function tokensOf(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

export function computeTextSignals(
  candidate: EngineCandidate,
  terms: string[],
  weights: SearchableAttribute[],
): TextSignals {
  const weightOf = new Map(weights.map((w) => [w.field, w.weight]));
  const matched = candidate.matchedTerms;

  if (terms.length === 0) {
    return { typos: 0, wordsMatched: 0, bestField: '', bestFieldWeight: 0, proximity: 0, exactness: 0 };
  }

  const typos = matched.reduce((sum, m) => sum + m.distance, 0);
  const wordsMatched = matched.length;
  const surfaceByTerm = new Map(matched.map((m) => [m.term, m.matched]));

  let bestField = '';
  let bestFieldWeight = -1;
  let bestProximity = Number.MAX_SAFE_INTEGER;
  let bestExactness = 0;

  for (const field of SEARCHABLE_FIELDS) {
    const weight = weightOf.get(field) ?? 0;
    if (weight <= 0) continue;
    const text = fieldText(candidate.doc, field);
    if (!text) continue;
    const tokens = tokensOf(text);
    const tokenSet = new Set(tokens);

    // A field only competes if it carries at least one matched term.
    const positions: number[] = [];
    let matchedHere = 0;
    for (const term of terms) {
      const surface = surfaceByTerm.get(term);
      if (!surface) continue;
      const idx = tokens.indexOf(surface);
      if (idx >= 0) {
        positions.push(idx);
        matchedHere++;
      }
    }
    if (matchedHere === 0) continue;

    const proximity = positions.length > 1
      ? Math.max(...positions) - Math.min(...positions) - (positions.length - 1)
      : 0;

    const allExact = terms.every((t) => tokenSet.has(t));
    const wholeFieldExact = allExact && tokens.length === terms.length;
    const anyFuzzy = matched.some((m) => m.distance > 0);
    const anyPrefix = matched.some((m) => m.prefix);
    const exactness = wholeFieldExact ? 3 : allExact && !anyFuzzy ? 2 : anyFuzzy ? 0 : anyPrefix ? 1 : 2;

    const better =
      weight > bestFieldWeight ||
      (weight === bestFieldWeight &&
        (proximity < bestProximity ||
          (proximity === bestProximity && exactness > bestExactness)));
    if (better) {
      bestField = field;
      bestFieldWeight = weight;
      bestProximity = proximity;
      bestExactness = exactness;
    }
  }

  return {
    typos,
    wordsMatched,
    bestField,
    bestFieldWeight: Math.max(bestFieldWeight, 0),
    proximity: bestProximity === Number.MAX_SAFE_INTEGER ? 0 : bestProximity,
    exactness: bestExactness,
  };
}

/** Ordered comparators. Truncating this list widens the band business ranking acts in. */
const CASCADE: { name: string; compare: (a: TextSignals, b: TextSignals) => number }[] = [
  { name: 'typos', compare: (a, b) => a.typos - b.typos },
  { name: 'wordsMatched', compare: (a, b) => b.wordsMatched - a.wordsMatched },
  { name: 'attributeWeight', compare: (a, b) => b.bestFieldWeight - a.bestFieldWeight },
  { name: 'proximity', compare: (a, b) => a.proximity - b.proximity },
  { name: 'exactness', compare: (a, b) => b.exactness - a.exactness },
];

export function compareTextRelevance(a: TextSignals, b: TextSignals, depth = CASCADE.length): number {
  for (let i = 0; i < Math.min(depth, CASCADE.length); i++) {
    const result = CASCADE[i]!.compare(a, b);
    if (result !== 0) return result;
  }
  return 0;
}

/**
 * The band key groups textually-equivalent results. Business ranking sorts
 * within a band only. `depth` lets a site loosen the band — depth 3 lets margin
 * and velocity reorder results that differ only in proximity and exactness.
 */
export function bandKey(signals: TextSignals, depth = CASCADE.length): string {
  const parts = [
    signals.typos,
    -signals.wordsMatched,
    -signals.bestFieldWeight,
    signals.proximity,
    -signals.exactness,
  ].slice(0, depth);
  return parts.join('|');
}

export interface RankedCandidate {
  candidate: EngineCandidate;
  signals: TextSignals;
  business: number;
  explanation: RankExplanation;
}

export interface RankOptions {
  terms: string[];
  weights: SearchableAttribute[];
  business: BusinessWeights;
  /** How many cascade criteria form a relevance band. */
  bandDepth?: number;
  now?: number;
  /** Measured behaviour, when the analytics store has any. */
  clicks?: ClickSignals;
  /**
   * Keep the engine's ordering instead of applying the cascade.
   *
   * When a shopper picks "Price: Low to High" the engine has already ordered by
   * price, and re-ranking on relevance would silently throw that away. Signals
   * and explanations are still computed, so the "why" panel keeps working.
   */
  preserveOrder?: boolean;
}

export function rankCandidates(
  candidates: EngineCandidate[],
  options: RankOptions,
): RankedCandidate[] {
  const depth = options.bandDepth ?? CASCADE.length;
  const ranked = candidates.map((candidate) => {
    const signals = computeTextSignals(candidate, options.terms, options.weights);
    const business = businessScore(candidate.doc, options.business, options.now, options.clicks);
    return {
      candidate,
      signals,
      business: business.score,
      explanation: {
        typos: signals.typos,
        wordsMatched: signals.wordsMatched,
        bestField: signals.bestField,
        bestFieldWeight: signals.bestFieldWeight,
        proximity: signals.proximity,
        exactness: signals.exactness,
        textScore: Math.round(candidate.retrievalScore * 1000) / 1000,
        businessScore: business.score,
        businessBreakdown: business.breakdown,
        finalScore: 0,
        rulesApplied: [],
      } satisfies RankExplanation,
    };
  });

  if (options.preserveOrder) {
    ranked.forEach((r, i) => {
      r.explanation.finalScore = Math.round((1 - i / Math.max(ranked.length, 1)) * 10_000) / 10_000;
    });
    return ranked;
  }

  ranked.sort((a, b) => {
    const text = compareTextRelevance(a.signals, b.signals, depth);
    if (text !== 0) return text;
    if (b.business !== a.business) return b.business - a.business;
    // Last resort: engine score, then sku, so ordering is fully deterministic.
    if (b.candidate.retrievalScore !== a.candidate.retrievalScore) {
      return b.candidate.retrievalScore - a.candidate.retrievalScore;
    }
    return a.candidate.doc.sku.localeCompare(b.candidate.doc.sku);
  });

  ranked.forEach((r, i) => {
    r.explanation.finalScore = Math.round((1 - i / Math.max(ranked.length, 1)) * 10_000) / 10_000;
  });
  return ranked;
}

export { CASCADE as RANKING_CASCADE, bandKey as relevanceBandKey };
