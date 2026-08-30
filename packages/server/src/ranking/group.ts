import type { Hit } from '@compass/shared';
import type { RankedCandidate } from './cascade.js';

/**
 * Collapse variant documents into one card per parent product.
 *
 * This is where "black shutter" behaves the way a shopper expects. Because the
 * index is at the variant level, the query matches the BLACK variants; grouping
 * then picks the best-ranked MATCHING variant as the card's representative and
 * lists only its matching siblings. The parent's white and bronze variants are
 * never pulled along just because they hang off the same product.
 */
export interface GroupOptions {
  /** Keep at most this many matched siblings on each card. */
  maxSiblings?: number;
  includeExplanations?: boolean;
}

export function groupByParent(
  ranked: RankedCandidate[],
  options: GroupOptions = {},
): Hit[] {
  const maxSiblings = options.maxSiblings ?? 8;
  const order: string[] = [];
  const groups = new Map<string, RankedCandidate[]>();

  for (const r of ranked) {
    const key = r.candidate.doc.parentId;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(r);
    } else {
      groups.set(key, [r]);
      order.push(key);
    }
  }

  return order.map((parentId) => {
    const members = groups.get(parentId)!;
    const [best, ...siblings] = members;
    const doc = best!.candidate.doc;
    const hit: Hit = {
      parentId,
      sku: doc.sku,
      title: doc.title,
      variantTitle: doc.variantTitle,
      brand: doc.brand,
      categoryPath: doc.categoryPath,
      image: doc.image,
      price: doc.price,
      salePrice: doc.salePrice,
      effectivePrice: doc.effectivePrice,
      inStock: doc.inStock,
      reviewScore: doc.reviewScore,
      reviewCount: doc.reviewCount,
      variantCount: doc.variantCount,
      matchedVariants: siblings.slice(0, maxSiblings).map((s) => ({
        sku: s.candidate.doc.sku,
        variantTitle: s.candidate.doc.variantTitle,
        price: s.candidate.doc.effectivePrice,
        image: s.candidate.doc.image,
      })),
    };
    // Carried through so the service can resolve badge labels without another
    // engine round trip.
    (hit as Hit & { labels?: string[] }).labels = doc.labels ?? [];
    if (options.includeExplanations) hit.explanation = best!.explanation;
    return hit;
  });
}

/** `<mark>` the matched surface forms so the widget can show why a hit matched. */
export function highlight(text: string, surfaces: string[]): string {
  if (!text || surfaces.length === 0) return text;
  const escaped = surfaces
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .sort((a, b) => b.length - a.length);
  if (escaped.length === 0) return text;
  return text.replace(new RegExp(`\\b(${escaped.join('|')})`, 'gi'), '<mark>$1</mark>');
}
