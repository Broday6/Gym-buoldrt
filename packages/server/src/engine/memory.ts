/**
 * In-memory retrieval engine.
 *
 * A third implementation of the same contract as Typesense and SQLite, for the
 * one place neither can go: a browser. Everything above this interface — the
 * tie-breaking cascade, query analysis, dimension parsing, grouping by parent,
 * merchandising labels, badges, the rescue path — runs unchanged, which is the
 * point of having the interface at all. A demo that reimplemented the ranking
 * would be a drawing of the product rather than the product.
 *
 * Deliberately simple where the other engines are clever. SQLite dictionary-
 * encodes facet values and indexes vocabulary bigrams because it answers over
 * 100k documents; at the few thousand a browser can hold, a linear scan with a
 * `Map` is faster than the machinery to avoid one, and far easier to read
 * against the SQL it mirrors.
 *
 * It is read-only. Ingest belongs to a server: this engine is handed documents
 * that a real index already produced.
 */
import type { VariantDoc } from '@compass/shared';
import {
  SORTABLE,
  type EngineCandidate,
  type EngineFacet,
  type EngineQuery,
  type EngineResult,
  type IndexDirectory,
  type IndexHandle,
  type SearchEngine,
} from './types.js';
import { DICTIONARY_FACETS } from './facets.js';

interface Expansion {
  matched: string;
  distance: number;
  prefix: boolean;
}

/** Fields a range filter may address, mirroring the SQLite column map. */
const RANGE_FIELDS: Record<string, (d: VariantDoc) => number> = {
  price: (d) => d.effectivePrice,
  review_score: (d) => d.reviewScore,
  // A product sold by one number — a medallion's diameter, a fan's span — is
  // that wide and that tall, so `size` is the last resort on both axes. Without
  // it, "24 inch wide ceiling medallion" filters on a column medallions do not
  // have and finds none of the 52 the catalogue stocks.
  width_in: (d) => dimension(d, 'width_in', 'width', 'size_in', 'size'),
  height_in: (d) => dimension(d, 'height_in', 'height', 'depth_in', 'size_in', 'size'),
  length_in: (d) => dimension(d, 'length_in', 'length'),
  size_in: (d) => dimension(d, 'size_in', 'size', 'diameter_in'),
};

const SORT_VALUES: Record<string, (d: VariantDoc) => number> = {
  sales_velocity: (d) => d.salesVelocity,
  date_added_ts: (d) => d.dateAddedTs,
  effective_price: (d) => d.effectivePrice,
  review_score: (d) => d.reviewScore,
  discount_pct: (d) => d.discountPct,
};

/**
 * The value a document carries for a facet field.
 *
 * Brand and availability are not attributes — brand is its own column and
 * `in_stock` is derived from inventory — so they are read explicitly rather
 * than looked up in the attribute bag, exactly as the other engines project
 * them into dedicated columns. Availability is 0/1 here because that is what
 * the response layer expects to relabel as "In Stock" / "Out of Stock".
 */
function facetValue(doc: VariantDoc, field: string): string | number | undefined {
  if (field === 'brand') return doc.brand;
  if (field === 'in_stock') return doc.inStock ? 1 : 0;
  return doc.attrs?.[field];
}

function dimension(doc: VariantDoc, ...keys: string[]): number {
  for (const key of keys) {
    const value = doc.attrs?.[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return -1;
}

/** Every word a document contributes, which is also its searchable surface. */
function wordsOf(doc: VariantDoc): Set<string> {
  const haystack = [
    doc.title, doc.variantTitle, doc.sku, doc.mpn, doc.brand,
    doc.categoryPath.join(' '), doc.attributeText.join(' '), doc.description,
  ].join(' ').toLowerCase();
  return new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
}

/** Bounded edit distance: stops as soon as it cannot come in under `max`. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < best) best = value;
    }
    if (best > max) return max + 1;
    previous = current;
  }
  return previous[b.length]!;
}

interface SiteIndex {
  docs: VariantDoc[];
  words: Set<string>[];
  vocabulary: string[];
  directory: IndexDirectory | null;
}

export class MemoryEngine implements SearchEngine {
  readonly kind = 'memory' as const;
  private readonly sites = new Map<string, SiteIndex>();

  /** Load a site's documents. The only way anything gets in. */
  load(site: string, docs: VariantDoc[]): void {
    const words = docs.map(wordsOf);
    const vocabulary = new Set<string>();
    for (const set of words) for (const word of set) vocabulary.add(word);
    this.sites.set(site, {
      docs,
      words,
      vocabulary: [...vocabulary].sort(),
      directory: null,
    });
  }

  async search(query: EngineQuery): Promise<EngineResult> {
    const started = performance.now();
    const index = this.sites.get(query.site);
    if (!index) return { candidates: [], totalGroups: 0, facets: [], tookMs: 0 };

    // Expand each term once, then reuse the expansions for matching and for
    // reporting which one actually landed — the cascade counts typos from that.
    const expansions = new Map<string, Expansion[]>();
    for (const term of query.terms) {
      expansions.set(term, this.expand(index, term, query.typo, query.exactOnly));
    }

    const matched: number[] = [];
    for (let i = 0; i < index.docs.length; i++) {
      if (!this.matchesText(index.words[i]!, query, expansions)) continue;
      if (!this.matchesFilters(index.docs[i]!, query)) continue;
      matched.push(i);
    }

    const candidates = this.window(index, matched, query, expansions);
    const facets = (query.facets ?? []).length ? this.facets(index, query) : [];
    const totalGroups = new Set(matched.map((i) => index.docs[i]!.parentId)).size;

    return { candidates, totalGroups, facets, tookMs: performance.now() - started };
  }

  /**
   * A document matches when EVERY term does — the same AND-of-ORs the SQLite
   * engine builds as an FTS expression, and the same three ways a term can
   * land: exactly, through an expansion, or as a prefix from three characters.
   */
  private matchesText(
    words: Set<string>,
    query: EngineQuery,
    expansions: Map<string, Expansion[]>,
  ): boolean {
    if (query.sku) return true;
    for (const term of query.terms) {
      if (words.has(term)) continue;
      const hit = (expansions.get(term) ?? []).some((e) => words.has(e.matched));
      if (hit) continue;
      if (term.length >= 3 && [...words].some((w) => w.startsWith(term))) continue;
      return false;
    }
    return true;
  }

  private matchesFilters(doc: VariantDoc, query: EngineQuery, skipFacet?: string): boolean {
    if (query.sku && doc.sku.toUpperCase() !== query.sku.toUpperCase()) return false;
    if (query.categoryId && !doc.categoryIds.includes(query.categoryId)) return false;
    // Collection membership narrows exactly like a category does.
    if (query.collection && !doc.labels.includes(`collection:${query.collection}`)) return false;
    if (query.excludeSkus?.length && query.excludeSkus.includes(doc.sku)) return false;

    for (const [key, values] of Object.entries(query.labelFilters ?? {})) {
      if (!values?.length || skipFacet === `label:${key}`) continue;
      if (!values.some((v) => doc.labels.includes(`${key}:${v}`))) return false;
    }

    // OR within a facet group, AND across groups.
    for (const [field, values] of Object.entries(query.filters ?? {})) {
      if (!values?.length || field === skipFacet) continue;
      const actual = facetValue(doc, field);
      if (actual === undefined || !values.some((v) => String(v) === String(actual))) return false;
    }

    for (const range of query.ranges ?? []) {
      const read = RANGE_FIELDS[range.field];
      if (!read) continue;
      const value = read(doc);
      if (range.min !== undefined && value < range.min) return false;
      if (range.max !== undefined && value > range.max) return false;
    }

    for (const constraint of query.constraints) {
      if (constraint.kind !== 'dimension' && constraint.kind !== 'unit') continue;
      const wanted = Number(constraint.value);
      if (!Number.isFinite(wanted)) continue;
      const near = (v: number) => Math.abs(v - wanted) < 0.03;
      if (constraint.field === 'any_dimension_in') {
        // A lone size with no axis named matches whichever axis carries it —
        // including `size`, which is the only one a product sold by a single
        // number (a medallion's diameter) has.
        if (!near(dimension(doc, 'width_in', 'width'))
          && !near(dimension(doc, 'height_in', 'height', 'depth_in'))
          && !near(dimension(doc, 'length_in', 'length'))
          && !near(dimension(doc, 'size_in', 'size', 'diameter_in'))) return false;
      } else if (RANGE_FIELDS[constraint.field]) {
        if (!near(RANGE_FIELDS[constraint.field]!(doc))) return false;
      }
    }
    return true;
  }

  /**
   * The candidate window, measured in parent products.
   *
   * Results are grouped by parent, so the window has to be too: sizing it in
   * variants makes the number of cards on a page depend on how many variants
   * those products happen to have. Picks the top N parents by their best
   * variant, then returns every matching variant belonging to them.
   */
  private window(
    index: SiteIndex,
    matched: number[],
    query: EngineQuery,
    expansions: Map<string, Expansion[]>,
  ): EngineCandidate[] {
    const sort = SORTABLE[query.sort];
    const read = sort ? SORT_VALUES[sort.column] : null;
    const scoreOf = (i: number) => (read ? read(index.docs[i]!) : this.relevance(index, i, query));

    const best = new Map<string, number>();
    for (const i of matched) {
      const parent = index.docs[i]!.parentId;
      const value = scoreOf(i);
      const current = best.get(parent);
      // For an ascending sort the group's representative is its cheapest
      // variant; for a descending one, its most expensive; for relevance, its
      // best-scoring.
      if (current === undefined
        || (sort?.direction === 'asc' ? value < current : value > current)) {
        best.set(parent, value);
      }
    }

    const parents = [...best.entries()]
      .sort((a, b) => (sort?.direction === 'asc' ? a[1] - b[1] : b[1] - a[1]))
      .slice(0, query.groupWindow)
      .map(([parent]) => parent);
    const wanted = new Set(parents);

    const out: EngineCandidate[] = [];
    for (const i of matched) {
      if (out.length >= query.candidateLimit) break;
      const doc = index.docs[i]!;
      if (!wanted.has(doc.parentId)) continue;
      out.push({
        doc,
        retrievalScore: this.relevance(index, i, query),
        matchedTerms: this.matchedTerms(index.words[i]!, query.terms, expansions),
      });
    }
    return out;
  }

  /**
   * Retrieval score, used only to choose the window.
   *
   * Not BM25: the cascade above re-ranks everything it is given, so this only
   * has to be good enough to decide which products get considered. Weighted by
   * where the term hit, which is the signal that survives into that decision.
   */
  private relevance(index: SiteIndex, i: number, query: EngineQuery): number {
    if (query.terms.length === 0) return index.docs[i]!.salesVelocity;
    const doc = index.docs[i]!;
    const weights = new Map(query.weights.map((w) => [w.field, w.weight]));
    const fields: [string, string][] = [
      ['title', doc.title], ['variantTitle', doc.variantTitle], ['sku', doc.sku],
      ['brand', doc.brand], ['categoryPath', doc.categoryPath.join(' ')],
      ['attributes', doc.attributeText.join(' ')], ['description', doc.description],
    ];
    let score = 0;
    for (const term of query.terms) {
      for (const [field, text] of fields) {
        if (text?.toLowerCase().includes(term)) score += weights.get(field) ?? 1;
      }
    }
    return score;
  }

  /** Which expansion actually landed in the document, for typo counting. */
  private matchedTerms(
    words: Set<string>,
    terms: string[],
    expansions: Map<string, Expansion[]>,
  ): EngineCandidate['matchedTerms'] {
    const out: EngineCandidate['matchedTerms'] = [];
    for (const term of terms) {
      if (words.has(term)) {
        out.push({ term, matched: term, distance: 0, prefix: false });
        continue;
      }
      let best: Expansion | null = null;
      for (const e of expansions.get(term) ?? []) {
        if (!words.has(e.matched)) continue;
        if (!best || e.distance < best.distance
          || (e.distance === best.distance && !e.prefix && best.prefix)) best = e;
      }
      if (best) out.push({ term, matched: best.matched, distance: best.distance, prefix: best.prefix });
    }
    return out;
  }

  /**
   * Facet counts, in products rather than variants.
   *
   * A group excludes its own selection from its own counts, so that having
   * picked "PVC" you can still see how many products the other materials
   * would give you. Every other group's selection still applies.
   */
  private facets(index: SiteIndex, query: EngineQuery): EngineFacet[] {
    const out: EngineFacet[] = [];
    for (const field of query.facets ?? []) {
      const parentsByValue = new Map<string, Set<string>>();
      let min = Infinity;
      let max = -Infinity;
      const numeric = Boolean(RANGE_FIELDS[field]);

      for (let i = 0; i < index.docs.length; i++) {
        const doc = index.docs[i]!;
        if (!this.matchesText(index.words[i]!, query, new Map())) continue;
        if (!this.matchesFilters(doc, query, field)) continue;
        if (numeric) {
          const value = RANGE_FIELDS[field]!(doc);
          if (value >= 0) {
            if (value < min) min = value;
            if (value > max) max = value;
          }
          continue;
        }
        const raw = facetValue(doc, field);
        if (raw === undefined || raw === null || raw === '') continue;
        const key = String(raw);
        let parents = parentsByValue.get(key);
        if (!parents) parentsByValue.set(key, (parents = new Set()));
        parents.add(doc.parentId);
      }

      if (numeric) {
        out.push({
          field,
          values: [],
          ...(Number.isFinite(min) ? { stats: { min, max } } : {}),
        });
        continue;
      }
      out.push({
        field,
        values: [...parentsByValue.entries()]
          .map(([value, parents]) => ({ value, count: parents.size }))
          .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value))),
      });
    }
    return out;
  }

  /**
   * Terms within typo distance of one that is actually indexed.
   *
   * Linear over the vocabulary. SQLite filters candidates through a bigram
   * index first because it holds a vocabulary two orders of magnitude larger;
   * here the scan costs less than the index would.
   */
  private expand(
    index: SiteIndex,
    term: string,
    typo: EngineQuery['typo'],
    exactOnly: boolean,
  ): Expansion[] {
    if (exactOnly) return [];
    const budget = term.length >= typo.minWordLengthFor2Typos ? 2
      : term.length >= typo.minWordLengthFor1Typo ? 1 : 0;
    if (budget === 0) return [];

    const out: Expansion[] = [];
    for (const candidate of index.vocabulary) {
      if (candidate === term) continue;
      const distance = editDistance(term, candidate, budget);
      if (distance <= budget) out.push({ matched: candidate, distance, prefix: false });
    }
    // Closest first, so the typo count the cascade reads is the best available.
    return out.sort((a, b) => a.distance - b.distance).slice(0, 12);
  }

  async vocabulary(site: string): Promise<Set<string>> {
    return new Set(this.sites.get(site)?.vocabulary ?? []);
  }

  async directory(site: string): Promise<IndexDirectory> {
    const index = this.sites.get(site);
    if (!index) return { categories: [], brands: [] };
    if (index.directory) return index.directory;

    const categories = new Map<string, { path: string[]; parents: Set<string> }>();
    const brands = new Map<string, Set<string>>();
    for (const doc of index.docs) {
      doc.categoryIds.forEach((id, depth) => {
        let entry = categories.get(id);
        if (!entry) categories.set(id, (entry = { path: doc.categoryPath.slice(0, depth + 1), parents: new Set() }));
        entry.parents.add(doc.parentId);
      });
      if (doc.brand) {
        let parents = brands.get(doc.brand);
        if (!parents) brands.set(doc.brand, (parents = new Set()));
        parents.add(doc.parentId);
      }
    }

    index.directory = {
      categories: [...categories.entries()]
        .map(([id, e]) => ({ id, path: e.path, products: e.parents.size }))
        .sort((a, b) => a.id.localeCompare(b.id)),
      brands: [...brands.entries()]
        .map(([name, parents]) => ({ name, products: parents.size }))
        .sort((a, b) => b.products - a.products),
    };
    return index.directory;
  }

  async documentCount(site: string): Promise<number> {
    return this.sites.get(site)?.docs.length ?? 0;
  }

  async getByParentIds(site: string, parentIds: string[]): Promise<VariantDoc[]> {
    const index = this.sites.get(site);
    if (!index) return [];
    const first = new Map<string, VariantDoc>();
    for (const doc of index.docs) if (!first.has(doc.parentId)) first.set(doc.parentId, doc);
    return parentIds.map((id) => first.get(id)).filter((d): d is VariantDoc => Boolean(d));
  }

  async sampleDocuments(site: string, limit: number): Promise<{ docs: VariantDoc[]; total: number }> {
    const index = this.sites.get(site);
    if (!index) return { docs: [], total: 0 };
    const total = new Set(index.docs.map((d) => d.parentId)).size;
    const seen = new Set<string>();
    const docs: VariantDoc[] = [];
    for (const doc of index.docs) {
      if (seen.size >= limit && !seen.has(doc.parentId)) break;
      seen.add(doc.parentId);
      docs.push(doc);
    }
    return { docs, total };
  }

  // ---- write path -----------------------------------------------------------
  //
  // Ingest belongs to a server. This engine is handed documents a real index
  // already produced, so the write half of the contract refuses rather than
  // pretending: a silent no-op here would look like a successful reindex.

  async createIndex(): Promise<IndexHandle> {
    throw new Error('MemoryEngine is read-only: load() documents that a server already indexed');
  }

  async indexBatch(): Promise<void> {
    throw new Error('MemoryEngine is read-only: use load()');
  }

  async promote(): Promise<void> {
    throw new Error('MemoryEngine is read-only');
  }

  async partialUpdate(): Promise<number> {
    throw new Error('MemoryEngine is read-only');
  }

  async upsertDocuments(): Promise<number> {
    throw new Error('MemoryEngine is read-only');
  }

  async deleteBySku(): Promise<number> {
    throw new Error('MemoryEngine is read-only');
  }

  async close(): Promise<void> {}
}

/** Facet fields this engine can count, mirroring the other two. */
export const MEMORY_FACETS = DICTIONARY_FACETS;
