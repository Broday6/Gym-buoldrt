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

export function businessScore(
  doc: VariantDoc,
  weights: BusinessWeights,
  now = Date.now(),
  ctrBySku?: Map<string, number>,
): BusinessScore {
  const signals: Record<keyof BusinessWeights, number> = {
    salesVelocity: logNormalise(doc.salesVelocity ?? 0, VELOCITY_CEILING),
    margin: clamp01((doc.margin ?? 0) / 100),
    inventoryDepth: logNormalise(doc.inventory ?? 0, INVENTORY_CEILING),
    recency: recencyDecay(doc.dateAddedTs ?? 0, now),
    reviewScore: clamp01((doc.reviewScore ?? 0) / 5),
    ctr: clamp01(ctrBySku?.get(doc.sku) ?? 0),
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
