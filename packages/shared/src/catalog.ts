/**
 * Catalog domain model.
 *
 * The platform indexes at the VARIANT level and groups by parent at query time.
 * That is the single most important modelling decision in the system: a query
 * for "black shutter" must surface the black variants of a shutter parent, not
 * the parent with its full variant set rolled up behind it. See DECISIONS.md.
 */

/** A merchandisable option on a variant, e.g. finish=Walnut, length=12 ft. */
export interface VariantAttributes {
  [key: string]: string | number | undefined;
}

/** One buyable SKU. This is what gets indexed as a document. */
export interface Variant {
  /** Stable unique id, namespaced by site. */
  sku: string;
  mpn?: string;
  /** Parent grouping key. All variants of one product share it. */
  parentId: string;
  /** Variant-distinguishing label, e.g. "Walnut / 12 ft". */
  variantTitle?: string;
  price: number;
  salePrice?: number;
  inventory: number;
  /** Variant-level image; falls back to the parent image when absent. */
  image?: string;
  attributes: VariantAttributes;
  discontinued?: boolean;
}

/** The product a shopper perceives; the grouping unit in result sets. */
export interface Product {
  parentId: string;
  title: string;
  description?: string;
  brand?: string;
  /** Ordered path, root first: ["Millwork", "Beams", "Faux Wood Beams"]. */
  categoryPath: string[];
  categoryIds: string[];
  image?: string;
  images?: string[];
  /** Business-ranking signals, all optional and all normalised at index time. */
  reviewScore?: number;
  reviewCount?: number;
  salesVelocity?: number;
  margin?: number;
  dateAdded?: string;
  tags?: string[];
  variants: Variant[];
}

/**
 * A flattened variant document as stored in the retrieval engine. Parent fields
 * are denormalised onto every variant so a single-collection query can match on
 * either level and still return a coherent card.
 */
export interface VariantDoc {
  id: string;
  site: string;
  sku: string;
  mpn: string;
  parentId: string;
  title: string;
  variantTitle: string;
  description: string;
  brand: string;
  categoryPath: string[];
  categoryIds: string[];
  /** Flattened "key:value" attribute pairs, searchable and facetable. */
  attributeText: string[];
  attributeKeys: string[];
  price: number;
  salePrice: number;
  effectivePrice: number;
  discountPct: number;
  inventory: number;
  inStock: boolean;
  discontinued: boolean;
  image: string;
  reviewScore: number;
  reviewCount: number;
  salesVelocity: number;
  margin: number;
  dateAddedTs: number;
  tags: string[];
  /** Per-variant attribute values, projected into facetable columns. */
  attrs: Record<string, string | number>;
  /** Number of variants on the parent, used for "N options" affordances. */
  variantCount: number;
}

export interface DataQualityReport {
  site: string;
  totalProducts: number;
  totalVariants: number;
  missingImages: string[];
  emptyDescriptions: string[];
  uncategorised: string[];
  duplicateSkus: string[];
  missingPrice: string[];
  /** Rows the ingester could not turn into a variant at all. */
  rejected: { row: number; reason: string }[];
  generatedAt: string;
}
