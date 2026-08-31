import type { BusinessWeights, VariantDoc } from '@compass/shared';

/**
 * Business ranking: a weighted composite of merchandiser-chosen signals,
 * every one normalised to 0..1 first so the weights mean what they look like.
 * Applied only within a textual-relevance band — never across bands, or a
 * high-margin mismatch would outrank an exact-title hit.
 */

const VELOCITY_CEILING = 1000;
const INVENTORY_CEILING = 500;
const RECENCY_HALF_LIFE_DAYS = 180;

export interface BusinessScore {
  score: number;
  breakdown: Record<string, number>;
}

/** Measured click-through, and what an average product on the site earns. */
export interface ClickSignals {
  bySku: Map<string, number>;
  mean: number;
}

export function businessScore(
  doc: VariantDoc,
  weights: BusinessWeights,
  now = Date.now(),
  clicks?: ClickSignals,
): BusinessScore {
  const signals: Record<keyof BusinessWeights, number> = {
    salesVelocity: logNormalise(doc.salesVelocity ?? 0, VELOCITY_CEILING),
    margin: clamp01((doc.margin ?? 0) / 100),
    inventoryDepth: logNormalise(doc.inventory ?? 0, INVENTORY_CEILING),
    recency: recencyDecay(doc.dateAddedTs ?? 0, now),
    reviewScore: clamp01((doc.reviewScore ?? 0) / 5),
    ctr: relativeCtr(clicks?.bySku.get(doc.sku), clicks?.mean ?? 0),
  };

  let total = 0;
  let weightSum = 0;
  const breakdown: Record<string, number> = {};
  for (const [key, weight] of Object.entries(weights) as [keyof BusinessWeights, number][]) {
    if (!weight) continue;
    const contribution = signals[key] * weight;
    breakdown[key] = round4(contribution);
    total += contribution;
    weightSum += weight;
  }
  return { score: weightSum > 0 ? round4(total / weightSum) : 0, breakdown };
}

/**
 * Click-through, scored against the site rather than in the abstract.
 *
 * A 4% click-through is excellent on one catalogue and poor on another, so an
 * absolute rate on a 0..1 scale would make this signal both incomparable
 * between sites and, at realistic rates, far too small to matter next to
 * signals that use their whole range. Scored relative to the site average
 * instead: average is 0.5, twice average saturates at 1, none is 0.
 *
 * A product nobody has measured scores the same as an average one. Ranking it
 * last for the crime of being new is how a catalogue freezes.
 */
function relativeCtr(ctr: number | undefined, mean: number): number {
  if (ctr === undefined || mean <= 0) return 0.5;
  return clamp01(0.5 * (ctr / mean));
}

/** Diminishing returns: the 900th sale should not matter like the 9th. */
function logNormalise(value: number, ceiling: number): number {
  if (value <= 0) return 0;
  return clamp01(Math.log1p(value) / Math.log1p(ceiling));
}

function recencyDecay(timestamp: number, now: number): number {
  if (!timestamp) return 0;
  const days = (now - timestamp) / 86_400_000;
  if (days < 0) return 1;
  return clamp01(Math.pow(0.5, days / RECENCY_HALF_LIFE_DAYS));
}

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
