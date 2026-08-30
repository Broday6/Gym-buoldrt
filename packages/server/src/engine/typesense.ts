import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Client } from 'typesense';
import type { VariantDoc } from '@compass/shared';
import { editDistance, typoBudget } from '../query/normalize.js';
import {
  SORTABLE,
  type EngineCandidate,
  type EngineFacet,
  type EngineQuery,
  type EngineResult,
  nextIndexSuffix,
  type IndexHandle,
  type SearchEngine,
} from './types.js';

/**
 * Production retrieval core.
 *
 * Documents are indexed at the VARIANT level with the parent denormalised onto
 * every one, and queries `group_by` parentId. That combination is what makes
 * "black shutter" return the black variants of each shutter rather than every
 * variant hanging off a matching parent — the group's representative is the
 * variant that actually matched.
 */

export interface TypesenseOptions {
  host: string;
  port: number;
  protocol: string;
  apiKey: string;
  connectionTimeoutSeconds?: number;
  /** Where per-site vocabularies are cached for compound splitting. */
  vocabularyDir?: string;
}

/** Attribute keys projected into their own facetable columns. */
const FACET_ATTRIBUTES = [
  'finish', 'color', 'colour', 'material', 'style', 'size', 'profile', 'species', 'mount',
];
const NUMERIC_ATTRIBUTES = ['width_in', 'height_in', 'length_in', 'depth_in', 'thickness_in'];

function collectionSchema(name: string) {
  return {
    name,
    enable_nested_fields: false,
    fields: [
      { name: 'id', type: 'string' as const },
      { name: 'site', type: 'string' as const, facet: true },
      { name: 'sku', type: 'string' as const, infix: true },
      { name: 'mpn', type: 'string' as const, optional: true, infix: true },
      { name: 'parentId', type: 'string' as const, facet: true },
      { name: 'title', type: 'string' as const },
      { name: 'variantTitle', type: 'string' as const, optional: true },
      { name: 'description', type: 'string' as const, optional: true },
      { name: 'brand', type: 'string' as const, facet: true, optional: true },
      { name: 'categoryPath', type: 'string[]' as const, facet: true, optional: true },
      { name: 'categoryIds', type: 'string[]' as const, facet: true, optional: true },
      { name: 'attributeText', type: 'string[]' as const, optional: true },
      { name: 'price', type: 'float' as const },
      { name: 'salePrice', type: 'float' as const, optional: true },
      { name: 'effectivePrice', type: 'float' as const, facet: true },
      { name: 'discountPct', type: 'int32' as const, optional: true },
      { name: 'inventory', type: 'int32' as const },
      { name: 'inStock', type: 'bool' as const, facet: true },
      { name: 'discontinued', type: 'bool' as const, facet: true },
      { name: 'image', type: 'string' as const, optional: true, index: false },
      { name: 'reviewScore', type: 'float' as const, optional: true },
      { name: 'reviewCount', type: 'int32' as const, optional: true },
      { name: 'salesVelocity', type: 'float' as const, optional: true },
      { name: 'margin', type: 'float' as const, optional: true },
      { name: 'dateAddedTs', type: 'int64' as const, optional: true },
      { name: 'tags', type: 'string[]' as const, facet: true, optional: true },
      { name: 'variantCount', type: 'int32' as const, optional: true },
      ...FACET_ATTRIBUTES.map((a) => ({ name: a, type: 'string' as const, facet: true, optional: true })),
      ...NUMERIC_ATTRIBUTES.map((a) => ({ name: a, type: 'float' as const, facet: true, optional: true })),
    ],
    default_sorting_field: 'salesVelocity',
  };
}

/** Flatten the attrs bag into the typed columns the schema declares. */
function toTypesenseDoc(doc: VariantDoc): Record<string, unknown> {
  const flat: Record<string, unknown> = { ...doc };
  delete flat.attrs;
  delete flat.attributeKeys;
  for (const key of [...FACET_ATTRIBUTES, ...NUMERIC_ATTRIBUTES]) {
    const value = doc.attrs?.[key];
    if (value !== undefined && value !== null && value !== '') flat[key] = value;
  }
  return flat;
}

export class TypesenseEngine implements SearchEngine {
  readonly kind = 'typesense' as const;
  private client: Client;
  private vocabularyDir: string;
  private pendingVocab = new Map<string, Set<string>>();

  constructor(private readonly options: TypesenseOptions) {
    this.client = new Client({
      nodes: [{ host: options.host, port: options.port, protocol: options.protocol }],
      apiKey: options.apiKey,
      connectionTimeoutSeconds: options.connectionTimeoutSeconds ?? 5,
      retryIntervalSeconds: 0.5,
      numRetries: 2,
    });
    this.vocabularyDir = options.vocabularyDir ?? process.env.COMPASS_VOCAB_DIR ?? './data/vocab';
  }

  async createIndex(site: string): Promise<IndexHandle> {
    const name = `${site}_${nextIndexSuffix()}`;
    await this.client.collections().create(collectionSchema(name) as never);
    this.pendingVocab.set(name, new Set());
    return { name, site };
  }

  async indexBatch(handle: IndexHandle, docs: VariantDoc[]): Promise<void> {
    if (docs.length === 0) return;
    const vocab = this.pendingVocab.get(handle.name) ?? new Set<string>();
    for (const d of docs) {
      for (const word of harvestVocabulary(d)) vocab.add(word);
    }
    this.pendingVocab.set(handle.name, vocab);

    const results = (await this.client
      .collections(handle.name)
      .documents()
      .import(docs.map(toTypesenseDoc), { action: 'upsert', batch_size: 500 })) as
      | { success: boolean; error?: string }[]
      | string;

    const rows = typeof results === 'string'
      ? results.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { success: boolean; error?: string })
      : results;
    const failures = rows.filter((r) => !r.success);
    if (failures.length) {
      throw new Error(
        `${failures.length}/${docs.length} documents rejected, first: ${failures[0]?.error ?? 'unknown'}`,
      );
    }
  }

  /**
   * Zero-downtime swap: point the site alias at the new collection, then drop
   * the collection it replaced. Readers resolve the alias per query, so no
   * request ever sees a partially built index.
   */
  async promote(handle: IndexHandle): Promise<void> {
    let previous: string | null = null;
    try {
      const alias = await this.client.aliases(handle.site).retrieve();
      previous = alias.collection_name;
    } catch {
      previous = null;
    }
    await this.client.aliases().upsert(handle.site, { collection_name: handle.name });
    this.persistVocabulary(handle.site, this.pendingVocab.get(handle.name) ?? new Set());
    this.pendingVocab.delete(handle.name);
    if (previous && previous !== handle.name) {
      try {
        await this.client.collections(previous).delete();
      } catch (err) {
        // A leaked collection costs disk, not correctness; never fail a promote.
        console.warn({ previous, err: (err as Error).message }, 'could not drop previous collection');
      }
    }
  }

  async partialUpdate(
    site: string,
    updates: { sku: string; price?: number; salePrice?: number; inventory?: number }[],
  ): Promise<number> {
    if (updates.length === 0) return 0;
    const docs = updates.map((u) => {
      const patch: Record<string, unknown> = { id: `${site}:${u.sku}` };
      if (u.price !== undefined) patch.price = u.price;
      if (u.salePrice !== undefined) patch.salePrice = u.salePrice;
      if (u.inventory !== undefined) {
        patch.inventory = u.inventory;
        patch.inStock = u.inventory > 0;
      }
      const effective = u.salePrice && u.salePrice > 0 ? u.salePrice : u.price;
      if (effective !== undefined) patch.effectivePrice = effective;
      return patch;
    });
    const results = (await this.client
      .collections(site)
      .documents()
      .import(docs, { action: 'emplace', batch_size: 500 })) as
      | { success: boolean }[]
      | string;
    const rows = typeof results === 'string'
      ? results.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { success: boolean })
      : results;
    return rows.filter((r) => r.success).length;
  }

  async search(query: EngineQuery): Promise<EngineResult> {
    const started = performance.now();
    const queryBy = query.weights
      .filter((w) => w.weight > 0)
      .map((w) => TYPESENSE_FIELD[w.field] ?? w.field);
    const queryByWeights = query.weights.filter((w) => w.weight > 0).map((w) => w.weight);

    const params: Record<string, unknown> = {
      q: query.terms.length ? query.terms.join(' ') : '*',
      query_by: queryBy.join(','),
      query_by_weights: queryByWeights.join(','),
      filter_by: buildFilterBy(query),
      facet_by: (query.facets ?? []).map((f) => TYPESENSE_FIELD[f] ?? f).join(','),
      max_facet_values: 200,
      // Collapse variants to one card per product, keeping the matching variant.
      group_by: 'parentId',
      group_limit: 8,
      per_page: Math.min(250, query.candidateLimit),
      page: 1,
      num_typos: query.exactOnly ? 0 : 2,
      min_len_1typo: query.typo.minWordLengthFor1Typo,
      min_len_2typo: query.typo.minWordLengthFor2Typos,
      typo_tokens_threshold: 1,
      prioritize_exact_match: true,
      highlight_full_fields: queryBy.join(','),
    };
    const sort = SORTABLE[query.sort];
    if (sort) params.sort_by = `${TYPESENSE_SORT[query.sort] ?? sort.column}:${sort.direction}`;

    const response = (await this.client
      .collections(query.site)
      .documents()
      .search(params as never)) as TypesenseSearchResponse;

    const candidates: EngineCandidate[] = [];
    for (const group of response.grouped_hits ?? []) {
      for (const hit of group.hits) {
        candidates.push({
          doc: fromTypesenseDoc(hit.document),
          retrievalScore: Number(hit.text_match ?? 0),
          matchedTerms: matchedTermsFromHighlights(query, hit),
        });
      }
    }

    const facets: EngineFacet[] = (response.facet_counts ?? []).map((f) => ({
      field: REVERSE_FIELD[f.field_name] ?? f.field_name,
      values: f.counts.map((c) => ({ value: c.value, count: c.count })),
      stats: f.stats && f.stats.min !== undefined && f.stats.max !== undefined
        ? { min: f.stats.min, max: f.stats.max }
        : undefined,
    }));

    return {
      candidates,
      totalGroups: response.found_docs ?? response.found ?? 0,
      facets,
      tookMs: performance.now() - started,
    };
  }

  async documentCount(site: string): Promise<number> {
    try {
      const collection = await this.client.collections(site).retrieve();
      return collection.num_documents ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Typesense exposes no vocabulary endpoint, so the term set is harvested at
   * index time and cached on disk. It feeds compound splitting and, from Phase
   * 2, "did you mean" spelling correction.
   */
  async vocabulary(site: string): Promise<Set<string>> {
    const path = this.vocabPath(site);
    if (!existsSync(path)) return new Set();
    try {
      return new Set(JSON.parse(readFileSync(path, 'utf8')) as string[]);
    } catch {
      return new Set();
    }
  }

  private persistVocabulary(site: string, vocab: Set<string>): void {
    const path = this.vocabPath(site);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify([...vocab]));
  }

  private vocabPath(site: string): string {
    return join(this.vocabularyDir, `${site}.json`);
  }

  async close(): Promise<void> {
    // The Typesense client holds no persistent connections to release.
  }
}

/** Schema-field names differ where the doc model nests; map both ways. */
const TYPESENSE_FIELD: Record<string, string> = {
  attributes: 'attributeText',
  material: 'material',
  finish: 'finish',
  color: 'color',
  style: 'style',
  size: 'size',
  in_stock: 'inStock',
  price: 'effectivePrice',
  brand: 'brand',
};
const REVERSE_FIELD: Record<string, string> = Object.fromEntries(
  Object.entries(TYPESENSE_FIELD).map(([k, v]) => [v, k]),
);
const TYPESENSE_SORT: Record<string, string> = {
  best_selling: 'salesVelocity',
  newest: 'dateAddedTs',
  price_asc: 'effectivePrice',
  price_desc: 'effectivePrice',
  top_rated: 'reviewScore',
  discount: 'discountPct',
};

function buildFilterBy(query: EngineQuery): string {
  const clauses: string[] = [];
  if (query.sku) clauses.push(`sku:=${escapeValue(query.sku)}`);
  if (query.categoryId) clauses.push(`categoryIds:=${escapeValue(query.categoryId)}`);
  if (query.excludeSkus?.length) {
    clauses.push(`sku:!=[${query.excludeSkus.map(escapeValue).join(',')}]`);
  }
  for (const [field, values] of Object.entries(query.filters ?? {})) {
    if (!values?.length) continue;
    const name = TYPESENSE_FIELD[field] ?? field;
    // `:=[a,b]` is OR within the group; separate clauses AND across groups.
    clauses.push(`${name}:=[${values.map((v) => escapeValue(String(v))).join(',')}]`);
  }
  for (const r of query.ranges ?? []) {
    const name = TYPESENSE_FIELD[r.field] ?? r.field;
    if (r.min !== undefined) clauses.push(`${name}:>=${r.min}`);
    if (r.max !== undefined) clauses.push(`${name}:<=${r.max}`);
  }
  for (const c of query.constraints) {
    if (c.kind !== 'dimension' && c.kind !== 'unit') continue;
    const value = Number(c.value);
    if (!Number.isFinite(value)) continue;
    if (c.field === 'any_dimension_in') {
      clauses.push(`(width_in:=${value} || height_in:=${value} || length_in:=${value})`);
    } else {
      clauses.push(`${c.field}:=${value}`);
    }
  }
  return clauses.join(' && ');
}

function escapeValue(value: string): string {
  return `\`${value.replace(/`/g, '')}\``;
}

interface TypesenseHit {
  document: Record<string, unknown>;
  text_match?: number;
  highlights?: { field: string; matched_tokens?: (string | string[])[] }[];
}
interface TypesenseSearchResponse {
  found?: number;
  found_docs?: number;
  grouped_hits?: { group_key: unknown[]; hits: TypesenseHit[] }[];
  facet_counts?: {
    field_name: string;
    counts: { value: string; count: number }[];
    stats?: { min?: number; max?: number };
  }[];
}

function fromTypesenseDoc(raw: Record<string, unknown>): VariantDoc {
  const attrs: Record<string, string | number> = {};
  for (const key of [...FACET_ATTRIBUTES, ...NUMERIC_ATTRIBUTES]) {
    const value = raw[key];
    if (value !== undefined && value !== null) attrs[key] = value as string | number;
  }
  return { ...(raw as unknown as VariantDoc), attrs };
}

/** Turn Typesense highlight tokens into the cascade's matched-term signals. */
function matchedTermsFromHighlights(query: EngineQuery, hit: TypesenseHit): EngineCandidate['matchedTerms'] {
  const surfaces = new Set<string>();
  for (const h of hit.highlights ?? []) {
    for (const token of h.matched_tokens ?? []) {
      if (Array.isArray(token)) token.forEach((t) => surfaces.add(String(t).toLowerCase()));
      else surfaces.add(String(token).toLowerCase());
    }
  }
  const out: EngineCandidate['matchedTerms'] = [];
  for (const term of query.terms) {
    if (surfaces.has(term)) {
      out.push({ term, matched: term, distance: 0, prefix: false });
      continue;
    }
    const budget = query.exactOnly ? 0 : typoBudget(term, query.typo);
    let best: { matched: string; distance: number; prefix: boolean } | null = null;
    for (const surface of surfaces) {
      const prefix = surface.startsWith(term);
      const distance = prefix ? 0 : editDistance(term, surface, Math.max(budget, 1));
      if (!prefix && distance > budget) continue;
      if (!best || distance < best.distance) best = { matched: surface, distance, prefix };
    }
    if (best) out.push({ term, ...best });
  }
  return out;
}

/** Index-time vocabulary harvest, used for compounds and spelling correction. */
function harvestVocabulary(doc: VariantDoc): string[] {
  return [doc.title, doc.brand, doc.variantTitle, doc.categoryPath.join(' '), doc.attributeText.join(' ')]
    .join(' ')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3);
}
