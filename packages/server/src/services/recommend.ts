import type { Hit, SiteConfig } from '@compass/shared';
import type { SearchEngine } from '../engine/types.js';
import type { Db } from '../db/pool.js';
import type { SearchService } from './search.js';

/**
 * Recommendations.
 *
 * Four kinds, in ascending order of how much data they need:
 *
 *   top_sellers    — nothing. Works on day one.
 *   similar        — the catalogue. Products sharing a category and attributes.
 *   bought_together— purchase co-occurrence. Needs orders.
 *   recently_viewed— the shopper's own event history.
 *
 * Everything degrades to top sellers rather than returning nothing, because an
 * empty recommendation strip is worse than a generic one: it leaves a hole in
 * the page and tells the shopper the site has nothing to offer.
 */

export type RecommendationKind =
  | 'similar'
  | 'bought_together'
  | 'recently_viewed'
  | 'top_sellers'
  | 'trending';

export interface RecommendRequest {
  kind: RecommendationKind;
  /** Anchor product, for similar and bought_together. */
  parentId?: string;
  sku?: string;
  categoryId?: string;
  collection?: string;
  limit?: number;
  shopperId?: string;
  sessionId?: string;
}

export interface RecommendResponse {
  kind: RecommendationKind;
  /** What actually produced these, when the requested kind had no data. */
  servedBy: RecommendationKind;
  hits: Hit[];
  processingTimeMs: number;
}

export class RecommendService {
  constructor(
    private readonly engine: SearchEngine,
    private readonly search: SearchService,
    private readonly db: Db,
  ) {}

  async recommend(site: SiteConfig, request: RecommendRequest): Promise<RecommendResponse> {
    const started = performance.now();
    const limit = Math.min(24, Math.max(1, request.limit ?? 8));

    let hits: Hit[] = [];
    let servedBy: RecommendationKind = request.kind;

    switch (request.kind) {
      case 'similar':
        hits = await this.similar(site, request, limit);
        break;
      case 'bought_together':
        hits = await this.boughtTogether(site, request, limit);
        break;
      case 'recently_viewed':
        hits = await this.recentlyViewed(site, request, limit);
        break;
      case 'trending':
        hits = await this.trending(site, request, limit);
        break;
      default:
        hits = [];
    }

    if (hits.length === 0) {
      // Never an empty strip: a hole in the page reads worse than a generic
      // recommendation, and top sellers always have data.
      hits = await this.topSellers(site, request, limit);
      servedBy = 'top_sellers';
    }

    return {
      kind: request.kind,
      servedBy,
      hits: hits.slice(0, limit),
      processingTimeMs: Math.round((performance.now() - started) * 100) / 100,
    };
  }

  /**
   * Similar products: same category, overlapping attributes, not itself.
   *
   * Content-based rather than behavioural, so it works on a catalogue that has
   * never taken an order. The Phase 4 vector index replaces the query text here
   * with an embedding neighbourhood; the shape of the call does not change.
   */
  private async similar(site: SiteConfig, request: RecommendRequest, limit: number): Promise<Hit[]> {
    const anchor = await this.anchor(site, request);
    if (!anchor) return [];

    // Search the anchor's own words within its deepest category. Title terms
    // carry the product type; attributes carry style and material.
    const terms = [
      ...anchor.title.split(/\s+/).slice(0, 6),
      String(anchor.attrs?.style ?? ''),
      String(anchor.attrs?.material ?? ''),
    ].filter(Boolean).join(' ');

    const response = await this.search.search(site, {
      q: terms,
      categoryId: anchor.categoryIds[anchor.categoryIds.length - 1],
      hitsPerPage: limit + 4,
      facets: [],
      rescue: false,
    });
    return response.hits.filter((h) => h.parentId !== anchor.parentId);
  }

  /**
   * Frequently bought together: purchase co-occurrence within a session.
   *
   * Session-scoped rather than order-scoped because anonymous shoppers have no
   * order id — the session is the honest unit for "these were bought together".
   */
  private async boughtTogether(
    site: SiteConfig,
    request: RecommendRequest,
    limit: number,
  ): Promise<Hit[]> {
    const anchor = await this.anchor(site, request);
    if (!anchor) return [];
    try {
      const { rows } = await this.db.query<{ parent_id: string; sessions: string }>(
        `SELECT b.parent_id, COUNT(DISTINCT b.session_id) AS sessions
         FROM events a
         JOIN events b ON b.session_id = a.session_id AND b.site_id = a.site_id
         WHERE a.site_id = $1 AND a.parent_id = $2
           AND a.type IN ('purchase', 'add_to_cart')
           AND b.type IN ('purchase', 'add_to_cart')
           AND b.parent_id IS NOT NULL AND b.parent_id <> a.parent_id
           AND a.occurred_at > now() - interval '90 days'
         GROUP BY b.parent_id
         HAVING COUNT(DISTINCT b.session_id) >= 2
         ORDER BY sessions DESC LIMIT $3`,
        [site.id, anchor.parentId, limit],
      );
      if (rows.length === 0) return [];
      return this.hitsForParents(site, rows.map((r) => r.parent_id), limit);
    } catch {
      // Co-occurrence is a nicety; losing the event store falls back below.
      return [];
    }
  }

  private async recentlyViewed(
    site: SiteConfig,
    request: RecommendRequest,
    limit: number,
  ): Promise<Hit[]> {
    if (!request.shopperId) return [];
    try {
      const { rows } = await this.db.query<{ parent_id: string }>(
        `SELECT parent_id, MAX(occurred_at) AS seen
         FROM events
         WHERE site_id = $1 AND shopper_id = $2 AND parent_id IS NOT NULL
           AND type IN ('product_view', 'click')
           AND occurred_at > now() - interval '30 days'
         GROUP BY parent_id ORDER BY seen DESC LIMIT $3`,
        [site.id, request.shopperId, limit + 1],
      );
      const parents = rows.map((r) => r.parent_id).filter((p) => p !== request.parentId);
      if (parents.length === 0) return [];
      return this.hitsForParents(site, parents, limit);
    } catch {
      return [];
    }
  }

  /** Products with the most clicks recently — what the store is hot on now. */
  private async trending(site: SiteConfig, request: RecommendRequest, limit: number): Promise<Hit[]> {
    try {
      const { rows } = await this.db.query<{ parent_id: string }>(
        `SELECT parent_id, COUNT(*) AS clicks
         FROM events
         WHERE site_id = $1 AND parent_id IS NOT NULL AND type = 'click'
           AND occurred_at > now() - interval '7 days'
         GROUP BY parent_id ORDER BY clicks DESC LIMIT $2`,
        [site.id, limit],
      );
      if (rows.length === 0) return [];
      return this.hitsForParents(site, rows.map((r) => r.parent_id), limit);
    } catch {
      return [];
    }
  }

  private async topSellers(
    site: SiteConfig,
    request: RecommendRequest,
    limit: number,
  ): Promise<Hit[]> {
    const response = await this.search.search(site, {
      categoryId: request.categoryId,
      collection: request.collection,
      sort: 'best_selling',
      hitsPerPage: limit + 1,
      facets: [],
    });
    return response.hits.filter((h) => h.parentId !== request.parentId);
  }

  /** Look up the anchor product's document, by parent id or by SKU. */
  private async anchor(site: SiteConfig, request: RecommendRequest) {
    if (request.parentId) {
      const [doc] = await this.engine.getByParentIds(site.id, [request.parentId]);
      if (doc) return doc;
    }
    if (request.sku) {
      const response = await this.search.search(site, {
        q: request.sku, hitsPerPage: 1, facets: [], rescue: false,
      });
      const hit = response.hits[0];
      if (hit) {
        const [doc] = await this.engine.getByParentIds(site.id, [hit.parentId]);
        if (doc) return doc;
      }
    }
    return null;
  }

  /** Resolve parent ids back into renderable cards, preserving their order. */
  private async hitsForParents(
    site: SiteConfig,
    parentIds: string[],
    limit: number,
  ): Promise<Hit[]> {
    const docs = await this.engine.getByParentIds(site.id, parentIds.slice(0, limit));
    return docs.map((doc) => ({
      parentId: doc.parentId,
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
      matchedVariants: [],
    }));
  }
}
