import type { Product, VariantDoc } from '@compass/shared';
import type { SearchEngine } from '../engine/types.js';
import { describeSelector, matches, validateSelector, type Selector } from '../merchandising/selector.js';

/**
 * Rule preview.
 *
 * Counts how many products a selector would catch, before it is saved. A rule
 * a merchandiser cannot see the effect of is a rule they will not trust, so
 * this runs on every keystroke in the builder and has to feel instant — hence
 * the bounded sample, and hence saying plainly when it sampled.
 */

export interface PreviewResult {
  matched: number;
  total: number;
  sampled: number;
  /** True when the whole catalogue was evaluated, not a sample. */
  exact: boolean;
  description: string;
  examples: { parentId: string; title: string; image: string; variantTitle: string }[];
}

const SAMPLE_LIMIT = Number(process.env.COMPASS_PREVIEW_SAMPLE ?? 5_000);

export class PreviewService {
  constructor(private readonly engine: SearchEngine) {}

  async preview(siteId: string, rawSelector: unknown, limit = SAMPLE_LIMIT): Promise<PreviewResult> {
    const selector = validateSelector(rawSelector) as Selector;
    const { docs, total } = await this.engine.sampleDocuments(siteId, limit);
    const products = regroup(docs);

    let matched = 0;
    const examples: PreviewResult['examples'] = [];
    for (const product of products) {
      if (!matches(product, selector)) continue;
      matched++;
      if (examples.length < 8) {
        const variant = product.variants[0];
        examples.push({
          parentId: product.parentId,
          title: product.title,
          image: variant?.image ?? '',
          variantTitle: variant?.variantTitle ?? '',
        });
      }
    }

    const exact = products.length >= total;
    return {
      matched: exact ? matched : Math.round((matched / Math.max(products.length, 1)) * total),
      total,
      sampled: products.length,
      exact,
      description: describeSelector(selector) + (exact ? '' : ` (estimated from ${products.length} products)`),
      examples,
    };
  }
}

/** Rebuild parent products from the flattened variant documents. */
function regroup(docs: VariantDoc[]): Product[] {
  const byParent = new Map<string, Product>();
  for (const doc of docs) {
    let product = byParent.get(doc.parentId);
    if (!product) {
      product = {
        parentId: doc.parentId,
        title: doc.title,
        description: doc.description,
        brand: doc.brand,
        categoryPath: doc.categoryPath,
        categoryIds: doc.categoryIds,
        image: doc.image,
        reviewScore: doc.reviewScore,
        reviewCount: doc.reviewCount,
        salesVelocity: doc.salesVelocity,
        margin: doc.margin,
        dateAdded: doc.dateAddedTs ? new Date(doc.dateAddedTs).toISOString().slice(0, 10) : undefined,
        tags: doc.tags,
        variants: [],
      };
      byParent.set(doc.parentId, product);
    }
    product.variants.push({
      sku: doc.sku,
      mpn: doc.mpn,
      parentId: doc.parentId,
      variantTitle: doc.variantTitle,
      price: doc.price,
      salePrice: doc.salePrice || undefined,
      inventory: doc.inventory,
      image: doc.image,
      attributes: doc.attrs ?? {},
      discontinued: doc.discontinued,
    });
  }
  return [...byParent.values()];
}
