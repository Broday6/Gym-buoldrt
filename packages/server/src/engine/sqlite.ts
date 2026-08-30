import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
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
 * Local development / CI retrieval engine.
 *
 * Backed by SQLite's FTS5 (BM25 built in) rather than a hand-rolled index. It
 * exists so the platform is fully runnable without a Typesense cluster; the
 * production path is TypesenseEngine and both satisfy the same contract.
 * Fuzzy matching expands each term against FTS5's own vocabulary table.
 */
export class SqliteEngine implements SearchEngine {
  readonly kind = 'sqlite' as const;
  private db: DatabaseSync;
  private vocabCache = new Map<string, Vocabulary>();
  private expansionCache = new Map<string, Expansion[]>();

  constructor(path = './data/compass.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS indexes (
        name TEXT PRIMARY KEY,
        site TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        live INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS docs (
        rowid INTEGER PRIMARY KEY,
        index_name TEXT NOT NULL,
        id TEXT NOT NULL,
        site TEXT NOT NULL,
        sku TEXT NOT NULL,
        mpn TEXT,
        parent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        variant_title TEXT,
        description TEXT,
        brand TEXT,
        category_text TEXT,
        attribute_text TEXT,
        price REAL, sale_price REAL, effective_price REAL, discount_pct REAL,
        inventory INTEGER, in_stock INTEGER, discontinued INTEGER,
        review_score REAL, review_count INTEGER, sales_velocity REAL, margin REAL,
        date_added_ts INTEGER, variant_count INTEGER,
        width_in REAL, height_in REAL, length_in REAL,
        doc TEXT NOT NULL,
        UNIQUE (index_name, id)
      );
      CREATE INDEX IF NOT EXISTS docs_idx_parent ON docs (index_name, parent_id);
      CREATE INDEX IF NOT EXISTS docs_idx_sku ON docs (index_name, sku);
      CREATE TABLE IF NOT EXISTS doc_attrs (
        doc_rowid INTEGER NOT NULL,
        index_name TEXT NOT NULL,
        key TEXT NOT NULL,
        value_text TEXT,
        value_num REAL
      );
      CREATE INDEX IF NOT EXISTS doc_attrs_idx ON doc_attrs (index_name, key, value_text);
      CREATE INDEX IF NOT EXISTS doc_attrs_by_doc ON doc_attrs (doc_rowid);
      CREATE TABLE IF NOT EXISTS doc_categories (
        doc_rowid INTEGER NOT NULL,
        index_name TEXT NOT NULL,
        category_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS doc_categories_idx ON doc_categories (index_name, category_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (
        title, variant_title, sku, mpn, brand, category_text, attribute_text, description,
        content='docs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_vocab USING fts5vocab(docs_fts, row);
    `);
  }

  async createIndex(site: string): Promise<IndexHandle> {
    const name = `${site}_${nextIndexSuffix()}`;
    this.db
      .prepare('INSERT INTO indexes (name, site, created_at, live) VALUES (?, ?, ?, 0)')
      .run(name, site, Date.now());
    return { name, site };
  }

  /** Alias resolution: the one index flagged live for the site. */
  private liveIndex(site: string): string | null {
    const row = this.db
      .prepare('SELECT name FROM indexes WHERE site = ? AND live = 1 LIMIT 1')
      .get(site) as { name?: string } | undefined;
    return row?.name ?? null;
  }

  async indexBatch(handle: IndexHandle, docs: VariantDoc[]): Promise<void> {
    const insertDoc = this.db.prepare(`
      INSERT INTO docs (
        index_name, id, site, sku, mpn, parent_id, title, variant_title, description, brand,
        category_text, attribute_text, price, sale_price, effective_price, discount_pct,
        inventory, in_stock, discontinued, review_score, review_count, sales_velocity, margin,
        date_added_ts, variant_count, width_in, height_in, length_in, doc
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT (index_name, id) DO NOTHING
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO docs_fts (
        rowid, title, variant_title, sku, mpn, brand, category_text, attribute_text, description
      ) VALUES (?,?,?,?,?,?,?,?,?)
    `);
    const insertAttr = this.db.prepare(
      'INSERT INTO doc_attrs (doc_rowid, index_name, key, value_text, value_num) VALUES (?,?,?,?,?)',
    );
    const insertCat = this.db.prepare(
      'INSERT INTO doc_categories (doc_rowid, index_name, category_id) VALUES (?,?,?)',
    );

    this.db.exec('BEGIN');
    try {
      for (const d of docs) {
        const categoryText = d.categoryPath.join(' ');
        const attributeText = d.attributeText.join(' ');
        const dims = numericDimensions(d);
        const res = insertDoc.run(
          handle.name, d.id, d.site, d.sku, d.mpn ?? '', d.parentId, d.title,
          d.variantTitle ?? '', d.description ?? '', d.brand ?? '',
          categoryText, attributeText, d.price, d.salePrice, d.effectivePrice, d.discountPct,
          d.inventory, d.inStock ? 1 : 0, d.discontinued ? 1 : 0, d.reviewScore, d.reviewCount,
          d.salesVelocity, d.margin, d.dateAddedTs, d.variantCount,
          dims.width, dims.height, dims.length, JSON.stringify(d),
        );
        const rowid = Number(res.lastInsertRowid);
        if (!rowid) continue;
        insertFts.run(
          rowid, d.title, d.variantTitle ?? '', d.sku, d.mpn ?? '', d.brand ?? '',
          categoryText, attributeText, d.description ?? '',
        );
        for (const [key, value] of Object.entries(d.attrs ?? {})) {
          if (value === undefined || value === null || value === '') continue;
          insertAttr.run(
            rowid, handle.name, key,
            typeof value === 'number' ? String(value) : value,
            typeof value === 'number' ? value : null,
          );
        }
        for (const cid of d.categoryIds) insertCat.run(rowid, handle.name, cid);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Atomic swap: flip the live flag, then drop the index it replaced. */
  async promote(handle: IndexHandle): Promise<void> {
    const previous = this.liveIndex(handle.site);
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE indexes SET live = 0 WHERE site = ?').run(handle.site);
      this.db.prepare('UPDATE indexes SET live = 1 WHERE name = ?').run(handle.name);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    if (previous && previous !== handle.name) this.dropIndex(previous);
    this.vocabCache.delete(handle.site);
    this.expansionCache.clear();
  }

  private dropIndex(name: string): void {
    const rows = this.db
      .prepare('SELECT rowid FROM docs WHERE index_name = ?')
      .all(name) as { rowid: number }[];
    const delFts = this.db.prepare('INSERT INTO docs_fts (docs_fts, rowid) VALUES (?, ?)');
    this.db.exec('BEGIN');
    try {
      // FTS5 external-content tables need an explicit delete command per row.
      for (const r of rows) delFts.run('delete-all-placeholder', r.rowid);
      this.db.exec('COMMIT');
    } catch {
      this.db.exec('ROLLBACK');
    }
    this.db.prepare('DELETE FROM doc_attrs WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM doc_categories WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM docs WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM indexes WHERE name = ?').run(name);
    this.db.exec("INSERT INTO docs_fts (docs_fts) VALUES ('rebuild')");
  }

  async partialUpdate(
    site: string,
    updates: { sku: string; price?: number; salePrice?: number; inventory?: number }[],
  ): Promise<number> {
    const index = this.liveIndex(site);
    if (!index) return 0;
    // Price/inventory are not searchable text, so the FTS side never changes:
    // that is what keeps a partial update well under the 60s target.
    const stmt = this.db.prepare(`
      UPDATE docs SET
        price = COALESCE(?, price),
        sale_price = COALESCE(?, sale_price),
        inventory = COALESCE(?, inventory),
        effective_price = CASE
          WHEN COALESCE(?, sale_price) > 0 THEN COALESCE(?, sale_price)
          ELSE COALESCE(?, price) END,
        in_stock = CASE WHEN COALESCE(?, inventory) > 0 THEN 1 ELSE 0 END
      WHERE index_name = ? AND sku = ?
    `);
    let changed = 0;
    this.db.exec('BEGIN');
    try {
      for (const u of updates) {
        const p = u.price ?? null;
        const s = u.salePrice ?? null;
        const inv = u.inventory ?? null;
        const r = stmt.run(p, s, inv, s, s, p, inv, index, u.sku);
        changed += Number(r.changes);
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // Keep the stored JSON coherent with the columns the API reads back.
    this.db.exec(`
      UPDATE docs SET doc = json_set(doc,
        '$.price', price, '$.salePrice', sale_price,
        '$.effectivePrice', effective_price, '$.inventory', inventory,
        '$.inStock', json(CASE WHEN in_stock = 1 THEN 'true' ELSE 'false' END))
      WHERE index_name = '${index}'
    `);
    return changed;
  }

  async documentCount(site: string): Promise<number> {
    const index = this.liveIndex(site);
    if (!index) return 0;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM docs WHERE index_name = ?')
      .get(index) as { n: number };
    return row.n;
  }

  async vocabulary(site: string): Promise<Set<string>> {
    return this.loadVocab(site).set;
  }

  private loadVocab(site: string): Vocabulary {
    const cached = this.vocabCache.get(site);
    if (cached) return cached;
    const rows = this.db
      .prepare('SELECT term FROM docs_vocab WHERE cnt > 0 ORDER BY term')
      .all() as { term: string }[];
    const entry = buildVocabulary(rows.map((r) => r.term));
    this.vocabCache.set(site, entry);
    return entry;
  }

  /**
   * Expand a term to the vocabulary entries within its typo budget. Prefix
   * matches are kept separately so the cascade can rank exact above prefix.
   */
  private expandTerm(
    site: string,
    term: string,
    typo: EngineQuery['typo'],
    exactOnly: boolean,
  ): Expansion[] {
    const budget = exactOnly ? 0 : typoBudget(term, typo);
    const cacheKey = `${site}|${term}|${budget}`;
    const cached = this.expansionCache.get(cacheKey);
    if (cached) return cached;

    const vocab = this.loadVocab(site);
    const out: Expansion[] = [];
    if (vocab.set.has(term)) out.push({ matched: term, distance: 0, prefix: false });

    // Prefix matches come from a binary-searched range of the sorted vocabulary
    // rather than a full scan, which is what dominated tail latency before.
    if (term.length >= 3) {
      for (const candidate of prefixRange(vocab.terms, term, MAX_PREFIX_EXPANSIONS)) {
        if (candidate !== term) out.push({ matched: candidate, distance: 0, prefix: true });
      }
    }

    if (budget > 0) {
      // Only terms sharing enough character bigrams can be within the edit
      // budget, so the expensive distance check runs on a short list.
      for (const candidate of bigramCandidates(vocab, term, budget)) {
        if (candidate === term) continue;
        if (Math.abs(candidate.length - term.length) > budget) continue;
        const d = editDistance(term, candidate, budget);
        if (d <= budget) out.push({ matched: candidate, distance: d, prefix: false });
      }
    }

    out.sort((a, b) => a.distance - b.distance || a.matched.length - b.matched.length);
    const capped = dedupeExpansions(out).slice(0, MAX_EXPANSIONS);
    if (this.expansionCache.size > 5_000) this.expansionCache.clear();
    this.expansionCache.set(cacheKey, capped);
    return capped;
  }

  async search(query: EngineQuery): Promise<EngineResult> {
    const started = performance.now();
    const index = this.liveIndex(query.site);
    if (!index) return { candidates: [], totalGroups: 0, facets: [], tookMs: 0 };

    const expansions = new Map<string, Expansion[]>();
    for (const term of query.terms) {
      expansions.set(term, this.expandTerm(query.site, term, query.typo, query.exactOnly));
    }

    const matchExpr = buildMatchExpression(query, expansions);
    // One narrowing pass per query, materialised into a temp table that the
    // count and every facet query then join against. Without it each of the
    // eight queries re-ran the full-text match or re-scanned the category.
    const narrowed = this.materialiseCandidates(matchExpr, query, index);

    const { sql: filterSql, params: filterParams } = this.buildFilters(query, index, undefined, narrowed);
    const base = narrowed.materialised
      ? `FROM _match m JOIN docs d ON d.rowid = m.rowid WHERE d.index_name = ? ${filterSql}`
      : `FROM docs d WHERE d.index_name = ? ${filterSql}`;
    const baseParams = [index, ...filterParams];

    const orderBy = this.orderByFor(query, narrowed.scored);
    const rows = this.db
      .prepare(`SELECT d.doc AS doc, ${narrowed.scored ? 'm.score' : '0'} AS score ${base} ${orderBy} LIMIT ?`)
      .all(...baseParams, query.candidateLimit) as { doc: string; score: number }[];

    const totalRow = this.db
      .prepare(`SELECT COUNT(DISTINCT d.parent_id) AS n ${base}`)
      .get(...baseParams) as { n: number };

    const candidates: EngineCandidate[] = rows.map((r) => {
      const doc = JSON.parse(r.doc) as VariantDoc;
      return {
        doc,
        // FTS5 bm25 is negative-better; flip it so higher is better everywhere.
        retrievalScore: -r.score,
        matchedTerms: matchedTermsFor(doc, query.terms, expansions),
      };
    });

    const facets = this.computeFacets(query, index, narrowed);
    if (narrowed.materialised) this.db.exec('DROP TABLE IF EXISTS temp._match');

    return {
      candidates,
      totalGroups: totalRow.n,
      facets,
      tookMs: performance.now() - started,
    };
  }

  /**
   * Narrow to a candidate row set once, from whichever of the full-text match
   * and the category is present, and keep it in a temp table for the rest of
   * the query. `scored` says whether it carries a usable relevance score.
   */
  private materialiseCandidates(
    matchExpr: string,
    query: EngineQuery,
    index: string,
  ): CandidateSet {
    if (!matchExpr && !query.categoryId) {
      return { materialised: false, scored: false, categoryHandled: false };
    }
    this.db.exec('DROP TABLE IF EXISTS temp._match');
    this.db.exec('CREATE TEMP TABLE _match (rowid INTEGER PRIMARY KEY, score REAL)');

    if (matchExpr) {
      this.db
        .prepare(
          `INSERT INTO temp._match (rowid, score)
           SELECT rowid, bm25(docs_fts, ${ftsColumnWeights(query)}) FROM docs_fts WHERE docs_fts MATCH ?`,
        )
        .run(matchExpr);
      // The category stays an ordinary filter; it is indexed and the set is
      // already small by the time it is applied.
      return { materialised: true, scored: true, categoryHandled: false };
    }

    // Browse: the category index is the narrowing pass.
    this.db
      .prepare(
        `INSERT INTO temp._match (rowid, score)
         SELECT c.doc_rowid, 0 FROM doc_categories c
         WHERE c.index_name = ? AND c.category_id = ?`,
      )
      .run(index, query.categoryId!);
    return { materialised: true, scored: false, categoryHandled: true };
  }

  private orderByFor(query: EngineQuery, hasMatch: boolean): string {
    const sort = SORTABLE[query.sort];
    if (sort) return `ORDER BY d.${sort.column} ${sort.direction.toUpperCase()}`;
    // Relevance: pull the strongest BM25 candidates, then re-rank above.
    return hasMatch ? 'ORDER BY m.score' : 'ORDER BY d.sales_velocity DESC';
  }

  /** Equality, range, category and dimension filters, as SQL fragments. */
  private buildFilters(
    query: EngineQuery,
    index: string,
    skipFacetField?: string,
    candidates?: CandidateSet,
  ): { sql: string; params: (string | number)[] } {
    const parts: string[] = [];
    const params: (string | number)[] = [];

    if (query.sku) {
      parts.push('AND UPPER(d.sku) = ?');
      params.push(query.sku.toUpperCase());
    }
    if (query.categoryId && !candidates?.categoryHandled) {
      parts.push(
        'AND EXISTS (SELECT 1 FROM doc_categories c WHERE c.doc_rowid = d.rowid AND c.category_id = ?)',
      );
      params.push(query.categoryId);
    }
    if (query.excludeSkus?.length) {
      parts.push(`AND d.sku NOT IN (${query.excludeSkus.map(() => '?').join(',')})`);
      params.push(...query.excludeSkus);
    }

    // OR within a facet group, AND across groups.
    for (const [field, values] of Object.entries(query.filters ?? {})) {
      if (!values?.length || field === skipFacetField) continue;
      const column = COLUMN_FACETS[field];
      if (column) {
        parts.push(`AND d.${column} IN (${values.map(() => '?').join(',')})`);
        params.push(...values.map((v) => String(v)));
      } else {
        parts.push(
          `AND EXISTS (SELECT 1 FROM doc_attrs a WHERE a.doc_rowid = d.rowid AND a.key = ?
             AND a.value_text IN (${values.map(() => '?').join(',')}))`,
        );
        params.push(field, ...values.map((v) => String(v)));
      }
    }

    for (const r of query.ranges ?? []) {
      const column = RANGE_COLUMNS[r.field];
      if (!column) continue;
      if (r.min !== undefined) {
        parts.push(`AND d.${column} >= ?`);
        params.push(r.min);
      }
      if (r.max !== undefined) {
        parts.push(`AND d.${column} <= ?`);
        params.push(r.max);
      }
    }

    for (const c of query.constraints) {
      if (c.kind !== 'dimension' && c.kind !== 'unit') continue;
      const value = Number(c.value);
      if (!Number.isFinite(value)) continue;
      if (c.field === 'any_dimension_in') {
        // A lone size with no axis named matches whichever axis carries it.
        parts.push('AND (ABS(d.width_in - ?) < 0.03 OR ABS(d.height_in - ?) < 0.03 OR ABS(d.length_in - ?) < 0.03)');
        params.push(value, value, value);
      } else if (DIMENSION_COLUMNS[c.field]) {
        parts.push(`AND ABS(d.${DIMENSION_COLUMNS[c.field]} - ?) < 0.03`);
        params.push(value);
      }
    }

    void index;
    return { sql: parts.join(' '), params };
  }

  /**
   * Facet counts. A group's own selection is excluded from its own counts so
   * multi-select stays usable; every other filter still applies. Zero-count
   * values are never emitted, which is what prevents dead-end facet clicks.
   */
  private computeFacets(query: EngineQuery, index: string, narrowed: CandidateSet): EngineFacet[] {
    const out: EngineFacet[] = [];
    const lead = narrowed.materialised
      ? 'FROM _match m JOIN docs d ON d.rowid = m.rowid'
      : 'FROM docs d';
    for (const field of query.facets ?? []) {
      const { sql, params } = this.buildFilters(query, index, field, narrowed);
      const from = `${lead} WHERE d.index_name = ? ${sql}`;
      const baseParams = [index, ...params];

      if (field === 'price') {
        const row = this.db
          .prepare(`SELECT MIN(d.effective_price) AS lo, MAX(d.effective_price) AS hi ${from}`)
          .get(...baseParams) as { lo: number | null; hi: number | null };
        if (row.lo !== null && row.hi !== null) {
          out.push({ field, values: [], stats: { min: row.lo, max: row.hi } });
        }
        continue;
      }

      const column = COLUMN_FACETS[field];
      const rows = column
        ? (this.db
            .prepare(
              `SELECT d.${column} AS value, COUNT(DISTINCT d.parent_id) AS count ${from}
               AND d.${column} IS NOT NULL AND d.${column} != ''
               GROUP BY d.${column} ORDER BY count DESC, value ASC LIMIT 200`,
            )
            .all(...baseParams) as { value: string; count: number }[])
        : (this.db
            .prepare(
              `SELECT a.value_text AS value, COUNT(DISTINCT d.parent_id) AS count
               ${lead} JOIN doc_attrs a ON a.doc_rowid = d.rowid
               WHERE d.index_name = ? AND a.key = ? ${sql}
               GROUP BY a.value_text ORDER BY count DESC, value ASC LIMIT 200`,
            )
            .all(index, field, ...params) as { value: string; count: number }[]);

      out.push({ field, values: rows.filter((r) => r.count > 0) });
    }
    return out;
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Facet fields served directly by a docs column rather than the attrs table. */
const COLUMN_FACETS: Record<string, string> = {
  brand: 'brand',
  in_stock: 'in_stock',
};

const RANGE_COLUMNS: Record<string, string> = {
  price: 'effective_price',
  review_score: 'review_score',
  width_in: 'width_in',
  height_in: 'height_in',
  length_in: 'length_in',
};

const DIMENSION_COLUMNS: Record<string, string> = {
  width_in: 'width_in',
  height_in: 'height_in',
  length_in: 'length_in',
};

function numericDimensions(d: VariantDoc): { width: number; height: number; length: number } {
  const read = (...keys: string[]): number => {
    for (const k of keys) {
      const v = d.attrs?.[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return -1;
  };
  return {
    width: read('width_in', 'width'),
    height: read('height_in', 'height', 'depth_in'),
    length: read('length_in', 'length'),
  };
}

/** FTS5 column weights, ordered to match the docs_fts column list. */
function ftsColumnWeights(query: EngineQuery): string {
  const byField = new Map(query.weights.map((w) => [w.field, w.weight]));
  const order = [
    'title', 'variantTitle', 'sku', 'mpn', 'brand', 'categoryPath', 'attributes', 'description',
  ];
  return order.map((f) => (byField.get(f) ?? 1).toFixed(1)).join(', ');
}

/** `(term OR expansion OR prefix*) AND (…)` — AND across terms, OR within. */
function buildMatchExpression(query: EngineQuery, expansions: Map<string, Expansion[]>): string {
  if (query.terms.length === 0) return '';
  const groups: string[] = [];
  for (const term of query.terms) {
    const variants = new Set<string>([quote(term)]);
    for (const e of expansions.get(term) ?? []) variants.add(quote(e.matched));
    if (term.length >= 3) variants.add(`${quote(term)}*`);
    groups.push(`(${[...variants].join(' OR ')})`);
  }
  return groups.join(' AND ');
}

function quote(term: string): string {
  return `"${term.replace(/"/g, '""')}"`;
}

/** Which expansion actually landed in the document, for typo counting. */
function matchedTermsFor(
  doc: VariantDoc,
  terms: string[],
  expansions: Map<string, Expansion[]>,
): EngineCandidate['matchedTerms'] {
  const haystack = [
    doc.title, doc.variantTitle, doc.sku, doc.mpn, doc.brand,
    doc.categoryPath.join(' '), doc.attributeText.join(' '), doc.description,
  ]
    .join(' ')
    .toLowerCase();
  const words = new Set(haystack.split(/[^a-z0-9]+/).filter(Boolean));
  const out: EngineCandidate['matchedTerms'] = [];
  for (const term of terms) {
    if (words.has(term)) {
      out.push({ term, matched: term, distance: 0, prefix: false });
      continue;
    }
    let best: Expansion | null = null;
    for (const e of expansions.get(term) ?? []) {
      if (!words.has(e.matched)) continue;
      if (!best || e.distance < best.distance || (e.distance === best.distance && !e.prefix && best.prefix)) {
        best = e;
      }
    }
    if (best) out.push({ term, matched: best.matched, distance: best.distance, prefix: best.prefix });
  }
  return out;
}

/**
 * Vocabulary index for term expansion.
 *
 * `terms` is sorted so prefix matches are a binary-searched range, and
 * `bigrams` maps each character bigram to the terms containing it. A candidate
 * within edit distance d of a length-n term must share at least n-1-2d bigrams
 * with it, so the postings lists cheaply bound which terms are worth measuring.
 */
interface Vocabulary {
  terms: string[];
  set: Set<string>;
  bigrams: Map<string, number[]>;
  tally: Int32Array;
}

/** What the per-query narrowing pass produced. */
interface CandidateSet {
  /** A temp `_match` table exists and every query should join it. */
  materialised: boolean;
  /** The temp table carries a relevance score worth sorting on. */
  scored: boolean;
  /** The category filter is already applied by the temp table. */
  categoryHandled: boolean;
}

interface Expansion {
  matched: string;
  distance: number;
  prefix: boolean;
}

const MAX_EXPANSIONS = 12;
const MAX_PREFIX_EXPANSIONS = 8;

function bigramsOf(term: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < term.length - 1; i++) out.push(term.slice(i, i + 2));
  return out;
}

function buildVocabulary(sorted: string[]): Vocabulary {
  const bigrams = new Map<string, number[]>();
  sorted.forEach((term, index) => {
    for (const bigram of new Set(bigramsOf(term))) {
      const postings = bigrams.get(bigram);
      if (postings) postings.push(index);
      else bigrams.set(bigram, [index]);
    }
  });
  return { terms: sorted, set: new Set(sorted), bigrams, tally: new Int32Array(sorted.length) };
}

/** Terms in the sorted vocabulary that start with `prefix`, capped. */
function prefixRange(sorted: string[], prefix: string, limit: number): string[] {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < prefix) lo = mid + 1;
    else hi = mid;
  }
  const out: string[] = [];
  for (let i = lo; i < sorted.length && out.length < limit; i++) {
    if (!sorted[i]!.startsWith(prefix)) break;
    out.push(sorted[i]!);
  }
  return out;
}

function bigramCandidates(vocab: Vocabulary, term: string, budget: number): string[] {
  const grams = [...new Set(bigramsOf(term))];
  if (grams.length === 0) return [];
  // A term of length n has n-1 bigrams; each edit destroys at most 2 of them.
  const threshold = Math.max(1, grams.length - 2 * budget);
  const { tally, terms } = vocab;
  const touched: number[] = [];
  for (const gram of grams) {
    const postings = vocab.bigrams.get(gram);
    if (!postings) continue;
    for (const index of postings) {
      if (tally[index] === 0) touched.push(index);
      tally[index]!++;
    }
  }
  const out: string[] = [];
  for (const index of touched) {
    if (tally[index]! >= threshold) out.push(terms[index]!);
    tally[index] = 0;
  }
  return out;
}

/** Keep the best entry per surface form: exact beats fuzzy beats prefix. */
function dedupeExpansions(expansions: Expansion[]): Expansion[] {
  const best = new Map<string, Expansion>();
  for (const e of expansions) {
    const existing = best.get(e.matched);
    if (!existing || e.distance < existing.distance || (e.distance === existing.distance && !e.prefix)) {
      best.set(e.matched, e);
    }
  }
  return [...best.values()];
}
