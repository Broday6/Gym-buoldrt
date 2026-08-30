import { editDistance, typoBudget } from './normalize.js';

/**
 * Spelling correction for the zero-results rescue.
 *
 * This is deliberately separate from the engine's typo tolerance. Typo
 * tolerance widens a query that is already finding things; correction fires
 * only when a query found nothing at all, and it rewrites the query the shopper
 * sees ("showing results for …"). Rewriting text on screen deserves a higher
 * bar than quietly matching a fuzzy token, so a correction has to be a clearly
 * better candidate, not merely a reachable one.
 */

export interface Correction {
  terms: string[];
  changed: boolean;
  /** The rewritten query to show as "did you mean". */
  suggestion: string;
  /** Per-term replacements, for the explainability panel. */
  replacements: { from: string; to: string; distance: number }[];
}

export interface SpellingOptions {
  typo: { minWordLengthFor1Typo: number; minWordLengthFor2Typos: number };
  /** Vocabulary of the live index, as returned by the engine. */
  vocabulary: Set<string>;
}

export function suggestCorrection(terms: string[], options: SpellingOptions): Correction {
  const { vocabulary, typo } = options;
  const replacements: Correction['replacements'] = [];
  const corrected: string[] = [];

  // A sorted vocabulary lets a correction prefer the shortest, earliest
  // candidate at equal distance, which keeps the choice deterministic.
  const candidates = vocabulary.size > 0 ? [...vocabulary] : [];

  for (const term of terms) {
    if (vocabulary.has(term) || candidates.length === 0) {
      corrected.push(term);
      continue;
    }
    const budget = typoBudget(term, typo);
    if (budget === 0) {
      corrected.push(term);
      continue;
    }

    let best: { word: string; distance: number } | null = null;
    for (const candidate of candidates) {
      if (Math.abs(candidate.length - term.length) > budget) continue;
      // The first character carries most of the signal in a typo; requiring it
      // to survive stops "beam" from being "corrected" to "team".
      if (candidate[0] !== term[0]) continue;
      const distance = editDistance(term, candidate, budget);
      if (distance > budget) continue;
      if (
        !best ||
        distance < best.distance ||
        (distance === best.distance && candidate.length < best.word.length) ||
        (distance === best.distance && candidate.length === best.word.length && candidate < best.word)
      ) {
        best = { word: candidate, distance };
      }
    }

    if (best) {
      corrected.push(best.word);
      replacements.push({ from: term, to: best.word, distance: best.distance });
    } else {
      corrected.push(term);
    }
  }

  return {
    terms: corrected,
    changed: replacements.length > 0,
    suggestion: corrected.join(' '),
    replacements,
  };
}

/**
 * Drop the least useful term from a query so a near-miss can still find
 * something. The longest term is kept: on a millwork catalogue the long word is
 * almost always the product noun ("moulding") and the short one the qualifier
 * ("mdf"), so dropping the shortest loses the least intent.
 */
export function relaxTerms(terms: string[]): string[] | null {
  if (terms.length < 2) return null;
  let shortestIndex = 0;
  for (let i = 1; i < terms.length; i++) {
    if (terms[i]!.length < terms[shortestIndex]!.length) shortestIndex = i;
  }
  return terms.filter((_, i) => i !== shortestIndex);
}
