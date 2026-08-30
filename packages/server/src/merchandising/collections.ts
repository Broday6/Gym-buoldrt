import type { Db } from '../db/pool.js';
import {
  isLive,
  loadLabelPlan,
  type CollectionDefinition,
  type CustomAttributeDefinition,
  type LabelPlan,
} from './labels.js';
import { describeSelector, validateSelector, type Selector } from './selector.js';
import type { BadgeDefinition } from './labels.js';

/**
 * Collections and custom attributes: merchandiser-authored structure that cuts
 * across the catalogue taxonomy.
 *
 * A category says what a product IS and comes from the feed. A collection says
 * what it is FOR — and routinely spans categories with nothing else in common.
 * Both are stored outside the catalogue, so an overnight refresh cannot erase
 * them, and both are reapplied to the index on every ingest.
 */

export interface CollectionInput {
  slug?: string;
  name: string;
  description?: string;
  kind?: 'marketing' | 'internal';
  parentSlug?: string;
  selector?: Selector | null;
  banner?: unknown;
  seoText?: string;
  defaultSort?: string;
  facetSet?: string[];
  startsAt?: string | null;
  endsAt?: string | null;
  position?: number;
  author?: string;
}

export interface CustomAttributeInput {
  key: string;
  label: string;
  displayType?: 'checkbox' | 'swatch' | 'grid' | 'slider';
  description?: string;
  position?: number;
  collapsed?: boolean;
  truncateAt?: number;
  sortBy?: 'count' | 'alpha' | 'custom';
  customOrder?: string[];
  values?: { value: string; selector?: Selector | null }[];
  author?: string;
}

export interface CollectionSummary {
  id: number;
  slug: string;
  name: string;
  description?: string;
  kind: string;
  parentSlug?: string;
  live: boolean;
  enabled: boolean;
  startsAt?: string;
  endsAt?: string;
  /** Plain-English rendering of the selector, for the admin list view. */
  rule?: string;
  manualIncludes: number;
  manualExcludes: number;
  defaultSort?: string;
  facetSet?: string[];
  seoText?: string;
  banner?: unknown;
}

export class CollectionStore {
  private cache = new Map<string, { plan: LabelPlan; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  /** The full label plan for a site, used at ingest and at query time. */
  async plan(siteId: string): Promise<LabelPlan> {
    const cached = this.cache.get(siteId);
    if (cached && cached.expires > Date.now()) return cached.plan;
    let plan: LabelPlan;
    try {
      plan = await loadLabelPlan(this.db, siteId);
    } catch (err) {
      // Collection membership is already baked into the index; only the facet
      // metadata comes from here. Losing this database costs custom facet
      // labels, not the ability to search.
      console.error({ err: (err as Error).message, site: siteId }, 'collections unavailable');
      if (cached) return cached.plan;
      const empty: LabelPlan = { collections: [], attributes: [], badges: [] };
      this.cache.set(siteId, { plan: empty, expires: Date.now() + 5_000 });
      return empty;
    }
    this.cache.set(siteId, { plan, expires: Date.now() + this.ttlMs });
    return plan;
  }

  invalidate(siteId?: string): void {
    if (siteId) this.cache.delete(siteId);
    else this.cache.clear();
  }

  async list(siteId: string, includeInternal = true): Promise<CollectionSummary[]> {
    const plan = await this.plan(siteId);
    const bySlug = new Map(plan.collections.map((c) => [c.id, c.slug]));
    return plan.collections
      .filter((c) => includeInternal || c.kind === 'marketing')
      .map((c) => this.summarise(c, bySlug));
  }

  /** Collections a shopper may browse: marketing, enabled and in schedule. */
  async browsable(siteId: string): Promise<CollectionSummary[]> {
    const plan = await this.plan(siteId);
    const bySlug = new Map(plan.collections.map((c) => [c.id, c.slug]));
    return plan.collections
      .filter((c) => c.kind === 'marketing' && isLive(c))
      .map((c) => this.summarise(c, bySlug));
  }

  async get(siteId: string, slug: string): Promise<CollectionSummary | null> {
    const plan = await this.plan(siteId);
    const found = plan.collections.find((c) => c.slug === slug);
    if (!found) return null;
    return this.summarise(found, new Map(plan.collections.map((c) => [c.id, c.slug])));
  }

  private summarise(
    c: CollectionDefinition,
    bySlug: Map<number, string>,
  ): CollectionSummary {
    return {
      id: c.id,
      slug: c.slug,
      name: c.name,
      description: c.description,
      kind: c.kind,
      parentSlug: c.parentId ? bySlug.get(c.parentId) : undefined,
      live: isLive(c),
      enabled: c.enabled,
      startsAt: c.startsAt?.toISOString(),
      endsAt: c.endsAt?.toISOString(),
      rule: c.selector ? describeSelector(c.selector) : undefined,
      manualIncludes: c.includes.size,
      manualExcludes: c.excludes.size,
      defaultSort: c.defaultSort,
      facetSet: c.facetSet,
      seoText: c.seoText,
      banner: c.bannerJson,
    };
  }

  async create(siteId: string, input: CollectionInput): Promise<CollectionSummary> {
    if (!input.name?.trim()) throw new Error('a collection needs a name');
    const slug = slugify(input.slug ?? input.name);
    if (!slug) throw new Error('a collection needs a usable slug');
    if (input.selector) validateSelector(input.selector);

    let parentId: number | null = null;
    if (input.parentSlug) {
      const { rows } = await this.db.query<{ id: number }>(
        'SELECT id FROM collections WHERE site_id = $1 AND slug = $2',
        [siteId, input.parentSlug],
      );
      if (!rows[0]) throw new Error(`no parent collection "${input.parentSlug}"`);
      parentId = rows[0].id;
    }

    await this.db.query(
      `INSERT INTO collections
         (site_id, slug, name, description, kind, parent_id, selector, banner, seo_text,
          default_sort, facet_set, starts_at, ends_at, position, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (site_id, slug) DO UPDATE SET
         name = EXCLUDED.name, description = EXCLUDED.description, kind = EXCLUDED.kind,
         parent_id = EXCLUDED.parent_id, selector = EXCLUDED.selector,
         banner = EXCLUDED.banner, seo_text = EXCLUDED.seo_text,
         default_sort = EXCLUDED.default_sort, facet_set = EXCLUDED.facet_set,
         starts_at = EXCLUDED.starts_at, ends_at = EXCLUDED.ends_at,
         position = EXCLUDED.position, updated_at = now()`,
      [siteId, slug, input.name, input.description ?? null, input.kind ?? 'marketing', parentId,
       input.selector ? JSON.stringify(input.selector) : null,
       input.banner ? JSON.stringify(input.banner) : null,
       input.seoText ?? null, input.defaultSort ?? null, input.facetSet ?? null,
       input.startsAt ?? null, input.endsAt ?? null, input.position ?? 0, input.author ?? null],
    );
    this.invalidate(siteId);
    const created = await this.get(siteId, slug);
    if (!created) throw new Error('collection could not be read back after writing');
    return created;
  }

  async setEnabled(siteId: string, slug: string, enabled: boolean): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE collections SET enabled = $3, updated_at = now() WHERE site_id = $1 AND slug = $2',
      [siteId, slug, enabled],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  async remove(siteId: string, slug: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM collections WHERE site_id = $1 AND slug = $2',
      [siteId, slug],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  /**
   * Add, pin, or exclude products by hand.
   *
   * Manual assignment beats the selector in both directions, which is what lets
   * a merchandiser fix one wrong product without rewriting a rule that is
   * otherwise doing its job.
   */
  async setMembers(
    siteId: string,
    slug: string,
    members: { parentId: string; mode?: 'include' | 'exclude'; position?: number | null }[],
    author?: string,
  ): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      'SELECT id FROM collections WHERE site_id = $1 AND slug = $2',
      [siteId, slug],
    );
    const collection = rows[0];
    if (!collection) throw new Error(`no collection "${slug}"`);

    for (const member of members) {
      if (!member.parentId) continue;
      await this.db.query(
        `INSERT INTO collection_members (collection_id, parent_id, mode, position, added_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (collection_id, parent_id) DO UPDATE SET
           mode = EXCLUDED.mode, position = EXCLUDED.position, added_by = EXCLUDED.added_by`,
        [collection.id, member.parentId, member.mode ?? 'include', member.position ?? null,
         author ?? null],
      );
    }
    this.invalidate(siteId);
    return members.length;
  }

  async removeMembers(siteId: string, slug: string, parentIds: string[]): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      'SELECT id FROM collections WHERE site_id = $1 AND slug = $2',
      [siteId, slug],
    );
    if (!rows[0]) throw new Error(`no collection "${slug}"`);
    const { rowCount } = await this.db.query(
      'DELETE FROM collection_members WHERE collection_id = $1 AND parent_id = ANY($2)',
      [rows[0].id, parentIds],
    );
    this.invalidate(siteId);
    return rowCount ?? 0;
  }

  // ---- custom attributes -------------------------------------------------

  async listAttributes(siteId: string): Promise<CustomAttributeDefinition[]> {
    return (await this.plan(siteId)).attributes;
  }

  async createAttribute(siteId: string, input: CustomAttributeInput): Promise<{ key: string }> {
    const key = slugify(input.key).replace(/-/g, '_');
    if (!key) throw new Error('a custom attribute needs a key');
    // Reserved so a custom attribute can never shadow a built-in facet field.
    if (RESERVED_KEYS.has(key)) throw new Error(`"${key}" is a built-in field`);
    if (!input.label?.trim()) throw new Error('a custom attribute needs a label');
    for (const value of input.values ?? []) {
      if (!value.value?.trim()) throw new Error('every attribute value needs a name');
      if (value.selector) validateSelector(value.selector);
    }

    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO custom_attributes
         (site_id, key, label, display_type, description, position, collapsed, truncate_at,
          sort_by, custom_order, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (site_id, key) DO UPDATE SET
         label = EXCLUDED.label, display_type = EXCLUDED.display_type,
         description = EXCLUDED.description, position = EXCLUDED.position,
         collapsed = EXCLUDED.collapsed, truncate_at = EXCLUDED.truncate_at,
         sort_by = EXCLUDED.sort_by, custom_order = EXCLUDED.custom_order, updated_at = now()
       RETURNING id`,
      [siteId, key, input.label, input.displayType ?? 'checkbox', input.description ?? null,
       input.position ?? 100, input.collapsed ?? false, input.truncateAt ?? 8,
       input.sortBy ?? 'count', input.customOrder ?? null, input.author ?? null],
    );
    const attributeId = rows[0]!.id;

    for (const [index, value] of (input.values ?? []).entries()) {
      await this.db.query(
        `INSERT INTO custom_attribute_values (attribute_id, value, selector, position)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (attribute_id, value) DO UPDATE SET
           selector = EXCLUDED.selector, position = EXCLUDED.position`,
        [attributeId, value.value, value.selector ? JSON.stringify(value.selector) : null, index],
      );
    }
    this.invalidate(siteId);
    return { key };
  }

  async removeAttribute(siteId: string, key: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM custom_attributes WHERE site_id = $1 AND key = $2',
      [siteId, key],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  // ---- badges ------------------------------------------------------------

  async listBadges(siteId: string): Promise<BadgeDefinition[]> {
    return (await this.plan(siteId)).badges;
  }

  async createBadge(
    siteId: string,
    input: {
      key: string; label: string;
      tone?: 'neutral' | 'sale' | 'new' | 'scarcity' | 'praise';
      selector: Selector; priority?: number;
      startsAt?: string | null; endsAt?: string | null; author?: string;
    },
  ): Promise<{ key: string }> {
    const key = slugify(input.key).replace(/-/g, '_');
    if (!key) throw new Error('a badge needs a key');
    if (!input.label?.trim()) throw new Error('a badge needs a label');
    validateSelector(input.selector);
    await this.db.query(
      `INSERT INTO badges (site_id, key, label, tone, selector, priority, starts_at, ends_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       ON CONFLICT (site_id, key) DO UPDATE SET
         label = EXCLUDED.label, tone = EXCLUDED.tone, selector = EXCLUDED.selector,
         priority = EXCLUDED.priority, starts_at = EXCLUDED.starts_at,
         ends_at = EXCLUDED.ends_at, updated_at = now()`,
      [siteId, key, input.label, input.tone ?? 'neutral', JSON.stringify(input.selector),
       input.priority ?? 100, input.startsAt ?? null, input.endsAt ?? null, input.author ?? null],
    );
    this.invalidate(siteId);
    return { key };
  }

  async removeBadge(siteId: string, key: string): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM badges WHERE site_id = $1 AND key = $2',
      [siteId, key],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  /** Assign products to a custom attribute value by hand. */
  async assign(
    siteId: string,
    key: string,
    value: string,
    parentIds: string[],
    mode: 'include' | 'exclude' = 'include',
    author?: string,
  ): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `SELECT v.id FROM custom_attribute_values v
       JOIN custom_attributes a ON a.id = v.attribute_id
       WHERE a.site_id = $1 AND a.key = $2 AND v.value = $3`,
      [siteId, key, value],
    );
    if (!rows[0]) throw new Error(`no value "${value}" on attribute "${key}"`);
    for (const parentId of parentIds) {
      await this.db.query(
        `INSERT INTO custom_attribute_assignments (value_id, parent_id, mode, added_by)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (value_id, parent_id) DO UPDATE SET mode = EXCLUDED.mode`,
        [rows[0].id, parentId, mode, author ?? null],
      );
    }
    this.invalidate(siteId);
    return parentIds.length;
  }
}

/** Field names a custom attribute may not take, to avoid shadowing built-ins. */
const RESERVED_KEYS = new Set([
  'price', 'brand', 'in_stock', 'finish', 'color', 'colour', 'material', 'style', 'size',
  'profile', 'species', 'mount', 'collection', 'sku', 'title', 'category',
]);

export function slugify(text: string): string {
  return String(text ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}
