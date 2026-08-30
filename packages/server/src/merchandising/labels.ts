import type { Product } from '@compass/shared';
import type { Db } from '../db/pool.js';
import { matches, validateSelector, type Selector } from './selector.js';

/**
 * Labels: the bridge between merchandiser-authored structure and the index.
 *
 * Collections and custom attributes are authored in Postgres, but they have to
 * be filterable and facetable, which means they have to reach the retrieval
 * engine. They do that as *labels* — `collection:farmhouse`, `room:kitchen` —
 * attached to every matching document at index time.
 *
 * The catalogue feed is overwritten on every ingest, so labels are recomputed
 * from Postgres on every ingest too. That is what keeps a merchandiser's work
 * from being silently erased by a nightly catalogue refresh.
 */

export interface CollectionDefinition {
  id: number;
  siteId: string;
  slug: string;
  name: string;
  kind: 'marketing' | 'internal';
  parentId: number | null;
  selector: Selector | null;
  enabled: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  position: number;
  description?: string;
  bannerJson?: unknown;
  seoText?: string;
  defaultSort?: string;
  facetSet?: string[];
  /** Explicit membership, keyed by parent product id. */
  includes: Map<string, number | null>;
  excludes: Set<string>;
}

export interface CustomAttributeDefinition {
  id: number;
  siteId: string;
  key: string;
  label: string;
  displayType: 'checkbox' | 'swatch' | 'grid' | 'slider';
  position: number;
  collapsed: boolean;
  truncateAt: number;
  sortBy: 'count' | 'alpha' | 'custom';
  customOrder: string[] | null;
  enabled: boolean;
  values: {
    id: number;
    value: string;
    selector: Selector | null;
    includes: Set<string>;
    excludes: Set<string>;
  }[];
}

export interface LabelPlan {
  collections: CollectionDefinition[];
  attributes: CustomAttributeDefinition[];
}

/** `collection:<slug>` and `<key>:<value>`, the wire form of a label. */
export function collectionLabel(slug: string): string {
  return `collection:${slug}`;
}

export function attributeLabel(key: string, value: string): string {
  return `${key}:${value}`;
}

/**
 * A collection is live when it is enabled and inside its schedule. A scheduled
 * collection is still built into the index — it just is not offered — so that
 * activating it is a configuration change rather than a reindex.
 */
export function isLive(collection: CollectionDefinition, now = new Date()): boolean {
  if (!collection.enabled) return false;
  if (collection.startsAt && collection.startsAt > now) return false;
  if (collection.endsAt && collection.endsAt <= now) return false;
  return true;
}

/**
 * Compute labels for a product, per variant.
 *
 * Membership is decided at the product level — a product is in "Farmhouse
 * Kitchen" — but the label is attached only to the variants that actually
 * satisfy the rule. That is the same principle that makes "black shutter"
 * return the black variant: browsing "Dark Finishes" has to show the dark
 * option, not whichever variant happened to sort first, and a product in
 * "Under $100" has to show its cheap variant rather than its $340 one.
 *
 * When a rule says nothing about variants, every variant carries the label, so
 * a purely product-level collection behaves exactly as before.
 *
 * Manual assignment beats the selector in both directions: an explicit include
 * adds a product the rule missed, an explicit exclude removes one it caught.
 * That lets a merchandiser fix one wrong product without rewriting a rule that
 * is otherwise doing its job.
 */
export function labelsFor(product: Product, plan: LabelPlan): Map<string, string[]> {
  const perVariant = new Map<string, string[]>();
  for (const variant of product.variants) perVariant.set(variant.sku, []);

  const assign = (label: string, selector: Selector | null, manual: boolean) => {
    // A hand-picked product carries the label on every variant: the
    // merchandiser chose the product, not one of its options.
    const scoped = manual || selector === null ? null : matchingVariants(product, selector);
    for (const variant of product.variants) {
      if (scoped && !scoped.has(variant.sku)) continue;
      perVariant.get(variant.sku)!.push(label);
    }
  };

  for (const collection of plan.collections) {
    if (collection.excludes.has(product.parentId)) continue;
    const manual = collection.includes.has(product.parentId);
    if (!manual && (collection.selector === null || !matches(product, collection.selector))) continue;
    assign(collectionLabel(collection.slug), collection.selector, manual);
  }

  for (const attribute of plan.attributes) {
    if (!attribute.enabled) continue;
    for (const value of attribute.values) {
      if (value.excludes.has(product.parentId)) continue;
      const manual = value.includes.has(product.parentId);
      if (!manual && (value.selector === null || !matches(product, value.selector))) continue;
      assign(attributeLabel(attribute.key, value.value), value.selector, manual);
    }
  }

  return perVariant;
}

/**
 * Which variants satisfy a selector on their own.
 *
 * Evaluated by re-running the selector against the product as if it owned only
 * that one variant, so a rule mixing product and variant conditions ("category
 * contains Beams AND finish is Walnut") resolves correctly without the rule
 * language needing a separate variant mode.
 */
function matchingVariants(product: Product, selector: Selector): Set<string> | null {
  if (!mentionsVariant(selector)) return null;
  const matching = new Set<string>();
  for (const variant of product.variants) {
    if (matches({ ...product, variants: [variant] }, selector)) matching.add(variant.sku);
  }
  // A rule that mentions variants but matches none of them individually can
  // still have matched the product through an aggregate such as minPrice; fall
  // back to the whole product rather than dropping it from the collection.
  return matching.size > 0 ? matching : null;
}

const VARIANT_AGGREGATES = new Set([
  'minPrice', 'maxPrice', 'inStock', 'totalInventory', 'onSale', 'variantCount',
]);

function mentionsVariant(selector: Selector): boolean {
  const clauses = [...(selector.all ?? []), ...(selector.any ?? []), ...(selector.none ?? [])];
  return clauses.some((clause) =>
    'field' in clause
      ? clause.field.startsWith('variant.') || VARIANT_AGGREGATES.has(clause.field)
      : mentionsVariant(clause),
  );
}

/** Curated position within a collection, when the merchandiser set one. */
export function pinnedPositions(
  product: Product,
  plan: LabelPlan,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const collection of plan.collections) {
    const position = collection.includes.get(product.parentId);
    if (position !== null && position !== undefined) {
      out[collectionLabel(collection.slug)] = position;
    }
  }
  return out;
}

/** Load every collection and custom attribute for a site, ready to apply. */
export async function loadLabelPlan(db: Db, siteId: string): Promise<LabelPlan> {
  const { rows: collectionRows } = await db.query(
    `SELECT id, slug, name, kind, parent_id, selector, enabled, starts_at, ends_at, position,
            description, banner, seo_text, default_sort, facet_set
     FROM collections WHERE site_id = $1 ORDER BY position, id`,
    [siteId],
  );

  const collections: CollectionDefinition[] = [];
  for (const row of collectionRows) {
    const { rows: members } = await db.query(
      'SELECT parent_id, mode, position FROM collection_members WHERE collection_id = $1',
      [row.id],
    );
    const includes = new Map<string, number | null>();
    const excludes = new Set<string>();
    for (const m of members) {
      if (m.mode === 'exclude') excludes.add(m.parent_id);
      else includes.set(m.parent_id, m.position ?? null);
    }
    collections.push({
      id: row.id, siteId, slug: row.slug, name: row.name, kind: row.kind,
      parentId: row.parent_id, selector: row.selector ?? null, enabled: row.enabled,
      startsAt: row.starts_at, endsAt: row.ends_at, position: row.position,
      description: row.description ?? undefined, bannerJson: row.banner ?? undefined,
      seoText: row.seo_text ?? undefined, defaultSort: row.default_sort ?? undefined,
      facetSet: row.facet_set ?? undefined,
      includes, excludes,
    });
  }

  const { rows: attributeRows } = await db.query(
    `SELECT id, key, label, display_type, position, collapsed, truncate_at, sort_by,
            custom_order, enabled
     FROM custom_attributes WHERE site_id = $1 ORDER BY position, id`,
    [siteId],
  );

  const attributes: CustomAttributeDefinition[] = [];
  for (const row of attributeRows) {
    const { rows: valueRows } = await db.query(
      `SELECT v.id, v.value, v.selector,
              COALESCE(json_agg(json_build_object('parent_id', a.parent_id, 'mode', a.mode))
                       FILTER (WHERE a.parent_id IS NOT NULL), '[]') AS assignments
       FROM custom_attribute_values v
       LEFT JOIN custom_attribute_assignments a ON a.value_id = v.id
       WHERE v.attribute_id = $1
       GROUP BY v.id ORDER BY v.position, v.id`,
      [row.id],
    );
    attributes.push({
      id: row.id, siteId, key: row.key, label: row.label, displayType: row.display_type,
      position: row.position, collapsed: row.collapsed, truncateAt: row.truncate_at,
      sortBy: row.sort_by, customOrder: row.custom_order ?? null, enabled: row.enabled,
      values: valueRows.map((v) => {
        const assignments = (v.assignments ?? []) as { parent_id: string; mode: string }[];
        return {
          id: v.id,
          value: v.value,
          selector: v.selector ?? null,
          includes: new Set(assignments.filter((a) => a.mode === 'include').map((a) => a.parent_id)),
          excludes: new Set(assignments.filter((a) => a.mode === 'exclude').map((a) => a.parent_id)),
        };
      }),
    });
  }

  return { collections, attributes };
}

/** An empty plan, for ingests that run with no database reachable. */
export const EMPTY_LABEL_PLAN: LabelPlan = { collections: [], attributes: [] };

/**
 * Apply a plan to a catalogue, returning the products with labels attached and
 * a per-structure count so an ingest can report what each rule actually caught.
 */
export function applyLabels(
  products: Product[],
  plan: LabelPlan,
): { products: Product[]; counts: Record<string, number> } {
  const counts: Record<string, number> = {};
  const labelled = products.map((product) => {
    const perVariant = labelsFor(product, plan);
    // Counts are per product, which is what a merchandiser means by "how many
    // products did this rule catch".
    const distinct = new Set<string>();
    for (const labels of perVariant.values()) for (const label of labels) distinct.add(label);
    for (const label of distinct) counts[label] = (counts[label] ?? 0) + 1;

    if (distinct.size === 0) return product;
    const positions = pinnedPositions(product, plan);
    return {
      ...product,
      collectionPositions: positions,
      variants: product.variants.map((v) => ({ ...v, labels: perVariant.get(v.sku) ?? [] })),
    };
  });
  return { products: labelled, counts };
}

export { validateSelector };
