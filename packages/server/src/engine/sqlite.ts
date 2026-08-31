import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { VariantDoc } from '@compass/shared';
import { editDistance, typoBudget } from '../query/normalize.js';
import { DICTIONARY_FACETS, attributeColumn, isDictionaryFacet } from './facets.js';
import {
  SORTABLE,
  type EngineCandidate,
  type EngineFacet,
  type EngineQuery,
  type EngineResult,
  nextIndexSuffix,
  type IndexDirectory,
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
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private encoders = new Map<string, FacetEncoder>();
  /** Index the in-flight query is reading; set once per search. */
  private currentIndex = '';
  private dictCache = new Map<string, FacetDictionary>();
  private directoryCache = new Map<string, IndexDirectory>();

  constructor(path = './data/compass.db') {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA synchronous = NORMAL');
    this.migrate();
  }

  /**
   * SQLite recompiles a statement on every `prepare`, which at 100k documents
   * cost more than the query itself. Statement text is fully parameterised, so
   * caching by SQL is safe.
   */
  private stmt(sql: string): ReturnType<DatabaseSync['prepare']> {
    let cached = this.statements.get(sql);
    if (!cached) {
      cached = this.db.prepare(sql);
      this.statements.set(sql, cached);
    }
    return cached;
  }

  private migrate(): void {
    // The index is disposable and rebuildable from the catalogue at any time,
    // so a layout change drops and recreates rather than migrating in place.
    const version = (this.db.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version;
    if (version !== SCHEMA_VERSION) {
      for (const table of ['docs_fts', 'facet_dict', 'index_vocab', 'index_categories',
        'doc_labels', 'doc_categories', 'doc_attrs', 'docs', 'indexes']) {
        this.db.exec(`DROP TABLE IF EXISTS ${table}`);
      }
      this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
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
        idx TEXT NOT NULL,
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
        width_in REAL, height_in REAL, length_in REAL, size_in REAL,
        parent_ord INTEGER NOT NULL,
        ${DICTIONARY_FACETS.map((a) => `${attributeColumn(a)} INTEGER`).join(', ')},
        doc TEXT NOT NULL,
        UNIQUE (index_name, id)
      );
      CREATE INDEX IF NOT EXISTS docs_idx_parent ON docs (index_name, parent_id);
      CREATE INDEX IF NOT EXISTS docs_idx_parent_ord ON docs (index_name, parent_ord);
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
      -- Merchandiser labels: collection membership and custom attribute values.
      -- Dictionary-encoded like every other facet, so filtering and counting on
      -- a merchandiser-invented attribute costs the same as a catalogue one.
      CREATE TABLE IF NOT EXISTS doc_labels (
        doc_rowid INTEGER NOT NULL,
        index_name TEXT NOT NULL,
        label_key TEXT NOT NULL,
        value_id INTEGER NOT NULL,
        parent_ord INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS doc_labels_lookup ON doc_labels (index_name, label_key, value_id);
      CREATE INDEX IF NOT EXISTS doc_labels_by_doc ON doc_labels (doc_rowid);
      CREATE TABLE IF NOT EXISTS doc_categories (
        doc_rowid INTEGER NOT NULL,
        index_name TEXT NOT NULL,
        category_id TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS doc_categories_idx ON doc_categories (index_name, category_id);
      -- One row per distinct category, carrying the human breadcrumb. The
      -- searchable category_text is space-joined for FTS and cannot be split
      -- back into levels, so the display path is stored explicitly.
      CREATE TABLE IF NOT EXISTS index_categories (
        index_name TEXT NOT NULL,
        category_id TEXT NOT NULL,
        path_json TEXT NOT NULL,
        PRIMARY KEY (index_name, category_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS facet_dict (
        index_name TEXT NOT NULL,
        field TEXT NOT NULL,
        value_id INTEGER NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (index_name, field, value_id)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS index_vocab (
        index_name TEXT NOT NULL,
        term TEXT NOT NULL,
        PRIMARY KEY (index_name, term)
      ) WITHOUT ROWID;
      -- The idx column carries a per-index token so a MATCH is scoped to one
      -- index inside FTS itself. Without it every match spans every site's
      -- documents and has to be filtered out afterwards against a 100k-row table.
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5 (
        idx, title, variant_title, sku, mpn, brand, category_text, attribute_text, description,
        content='docs', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2'
      );
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
    const attrColumns = DICTIONARY_FACETS.map(attributeColumn);
    const idxToken = indexToken(handle.name);
    const encoder = this.encoderFor(handle.name);
    const insertDoc = this.db.prepare(`
      INSERT INTO docs (
        index_name, idx, id, site, sku, mpn, parent_id, title, variant_title, description, brand,
        category_text, attribute_text, price, sale_price, effective_price, discount_pct,
        inventory, in_stock, discontinued, review_score, review_count, sales_velocity, margin,
        date_added_ts, variant_count, width_in, height_in, length_in, size_in, parent_ord,
        ${attrColumns.join(', ')}, doc
      ) VALUES (${new Array(31 + attrColumns.length + 1).fill('?').join(',')})
      ON CONFLICT (index_name, id) DO NOTHING
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO docs_fts (
        rowid, idx, title, variant_title, sku, mpn, brand, category_text, attribute_text, description
      ) VALUES (?,?,?,?,?,?,?,?,?,?)
    `);
    const insertVocab = this.db.prepare(
      'INSERT OR IGNORE INTO index_vocab (index_name, term) VALUES (?, ?)',
    );
    const insertAttr = this.db.prepare(
      'INSERT INTO doc_attrs (doc_rowid, index_name, key, value_text, value_num) VALUES (?,?,?,?,?)',
    );
    const insertCat = this.db.prepare(
      'INSERT INTO doc_categories (doc_rowid, index_name, category_id) VALUES (?,?,?)',
    );
    const insertCategoryPath = this.db.prepare(
      'INSERT OR IGNORE INTO index_categories (index_name, category_id, path_json) VALUES (?,?,?)',
    );
    const insertLabel = this.db.prepare(
      `INSERT INTO doc_labels (doc_rowid, index_name, label_key, value_id, parent_ord)
       VALUES (?,?,?,?,?)`,
    );

    this.db.exec('BEGIN');
    try {
      for (const d of docs) {
        const categoryText = d.categoryPath.join(' ');
        const attributeText = d.attributeText.join(' ');
        const dims = numericDimensions(d);
        const res = insertDoc.run(
          handle.name, idxToken, d.id, d.site, d.sku, d.mpn ?? '', d.parentId, d.title,
          d.variantTitle ?? '', d.description ?? '', d.brand ?? '',
          categoryText, attributeText, d.price, d.salePrice, d.effectivePrice, d.discountPct,
          d.inventory, d.inStock ? 1 : 0, d.discontinued ? 1 : 0, d.reviewScore, d.reviewCount,
          d.salesVelocity, d.margin, d.dateAddedTs, d.variantCount,
          dims.width, dims.height, dims.length, dims.size,
          encoder.parentOrd(d.parentId),
          ...DICTIONARY_FACETS.map((field) => {
            const value = field === 'brand' ? d.brand : d.attrs?.[field];
            return value === undefined || value === null || value === ''
              ? null
              : encoder.valueId(field, String(value));
          }),
          JSON.stringify(d),
        );
        const rowid = Number(res.lastInsertRowid);
        if (!rowid) continue;
        insertFts.run(
          rowid, idxToken, d.title, d.variantTitle ?? '', d.sku, d.mpn ?? '', d.brand ?? '',
          categoryText, attributeText, d.description ?? '',
        );
        // Vocabulary is harvested per index rather than read back from a
        // global fts5vocab table, so one site's terms never leak into
        // another's spelling correction or compound splitting.
        for (const term of harvestTerms(d.title, d.brand, d.variantTitle, categoryText, attributeText)) {
          insertVocab.run(handle.name, term);
        }
        for (const [key, value] of Object.entries(d.attrs ?? {})) {
          if (value === undefined || value === null || value === '') continue;
          insertAttr.run(
            rowid, handle.name, key,
            typeof value === 'number' ? String(value) : value,
            typeof value === 'number' ? value : null,
          );
        }
        for (const label of d.labels ?? []) {
          const separator = label.indexOf(':');
          if (separator <= 0) continue;
          const key = label.slice(0, separator);
          const value = label.slice(separator + 1);
          if (!value) continue;
          insertLabel.run(
            rowid, handle.name, key, encoder.valueId(`label:${key}`, value),
            encoder.parentOrd(d.parentId),
          );
        }
        d.categoryIds.forEach((cid, level) => {
          insertCat.run(rowid, handle.name, cid);
          insertCategoryPath.run(handle.name, cid, JSON.stringify(d.categoryPath.slice(0, level + 1)));
        });
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** Atomic swap: flip the live flag, then drop the index it replaced. */
  async promote(handle: IndexHandle): Promise<void> {
    this.persistDictionary(handle.name);
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
    this.dictCache.delete(handle.name);
    if (previous) this.dictCache.delete(previous);
    this.directoryCache.delete(handle.site);
  }

  /** Per-index encoder, built during ingest and persisted on promote. */
  private encoderFor(indexName: string): FacetEncoder {
    let encoder = this.encoders.get(indexName);
    if (!encoder) {
      encoder = new FacetEncoder();
      this.encoders.set(indexName, encoder);
    }
    return encoder;
  }

  private persistDictionary(indexName: string): void {
    const encoder = this.encoders.get(indexName);
    if (!encoder) return;
    const insert = this.db.prepare(
      'INSERT OR REPLACE INTO facet_dict (index_name, field, value_id, value) VALUES (?,?,?,?)',
    );
    this.db.exec('BEGIN');
    try {
      for (const [field, values] of encoder.dictionary()) {
        values.forEach((value, id) => insert.run(indexName, field, id, value));
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    this.encoders.delete(indexName);
  }

  /**
   * Drop a replaced index. The document rows go first, then the full-text index
   * is rebuilt from what remains — an external-content FTS table cannot be
   * deleted from row by row without the original column values to hand.
   */
  private dropIndex(name: string): void {
    this.db.prepare('DELETE FROM doc_labels WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM index_categories WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM facet_dict WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM index_vocab WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM doc_attrs WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM doc_categories WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM docs WHERE index_name = ?').run(name);
    this.db.prepare('DELETE FROM indexes WHERE name = ?').run(name);
    this.db.exec("INSERT INTO docs_fts (docs_fts) VALUES ('rebuild')");
    this.statements.clear();
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

  /**
   * Upsert whole documents into the LIVE index.
   *
   * Unlike a full ingest this writes in place, so a webhook can add or change
   * one product without a rebuild. Existing rows for the same ids are removed
   * first, because an FTS row cannot be updated in place.
   */
  async upsertDocuments(site: string, docs: VariantDoc[]): Promise<number> {
    const index = this.liveIndex(site);
    if (!index || docs.length === 0) return 0;
    await this.deleteByIds(index, docs.map((d) => d.id));
    await this.indexBatch({ name: index, site }, docs);
    // The dictionary gained entries for any new facet value in these docs.
    this.persistDictionary(index);
    this.dictCache.delete(index);
    this.directoryCache.delete(site);
    this.vocabCache.delete(site);
    this.expansionCache.clear();
    return docs.length;
  }

  /** Remove products from the live index by SKU. */
  async deleteBySku(site: string, skus: string[]): Promise<number> {
    const index = this.liveIndex(site);
    if (!index || skus.length === 0) return 0;
    const placeholders = skus.map(() => '?').join(',');
    const rows = this.db
      .prepare(`SELECT id FROM docs WHERE index_name = ? AND sku IN (${placeholders})`)
      .all(index, ...skus) as { id: string }[];
    if (rows.length === 0) return 0;
    await this.deleteByIds(index, rows.map((r) => r.id));
    this.directoryCache.delete(site);
    return rows.length;
  }

  private async deleteByIds(index: string, ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    const rowids = this.db
      .prepare(`SELECT rowid FROM docs WHERE index_name = ? AND id IN (${placeholders})`)
      .all(index, ...ids) as { rowid: number }[];
    if (rowids.length === 0) return;

    const rowPlaceholders = rowids.map(() => '?').join(',');
    const values = rowids.map((r) => r.rowid);
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM doc_attrs WHERE doc_rowid IN (${rowPlaceholders})`).run(...values);
      this.db.prepare(`DELETE FROM doc_labels WHERE doc_rowid IN (${rowPlaceholders})`).run(...values);
      this.db.prepare(`DELETE FROM doc_categories WHERE doc_rowid IN (${rowPlaceholders})`).run(...values);
      this.db.prepare(`DELETE FROM docs WHERE rowid IN (${rowPlaceholders})`).run(...values);
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    // An external-content FTS table cannot be deleted from row by row without
    // the original column values, so it is rebuilt from what remains.
    this.db.exec("INSERT INTO docs_fts (docs_fts) VALUES ('rebuild')");
    this.statements.clear();
  }

  async getByParentIds(site: string, parentIds: string[]): Promise<VariantDoc[]> {
    const index = this.liveIndex(site);
    if (!index || parentIds.length === 0) return [];
    const placeholders = parentIds.map(() => '?').join(',');
    const rows = this.db
      .prepare(
        `SELECT parent_id, doc, MIN(rowid) AS r FROM docs
         WHERE index_name = ? AND parent_id IN (${placeholders})
         GROUP BY parent_id`,
      )
      .all(index, ...parentIds) as { parent_id: string; doc: string }[];
    const byParent = new Map(rows.map((r) => [r.parent_id, JSON.parse(r.doc) as VariantDoc]));
    // Preserve the caller's order: it is usually a ranking (most co-purchased,
    // most recently viewed) and re-sorting would throw that away.
    return parentIds.map((id) => byParent.get(id)).filter((d): d is VariantDoc => Boolean(d));
  }

  async sampleDocuments(site: string, limit: number): Promise<{ docs: VariantDoc[]; total: number }> {
    const index = this.liveIndex(site);
    if (!index) return { docs: [], total: 0 };
    const total = (this.db
      .prepare('SELECT COUNT(DISTINCT parent_ord) AS n FROM docs WHERE index_name = ?')
      .get(index) as { n: number }).n;
    // Ordered by parent so a partial sample is whole products, never a product
    // missing half its variants — which would make a variant rule misfire.
    const rows = this.db
      .prepare(
        `SELECT d.doc FROM docs d
         WHERE d.index_name = ? AND d.parent_ord < ?
         ORDER BY d.parent_ord`,
      )
      .all(index, limit) as { doc: string }[];
    return { docs: rows.map((r) => JSON.parse(r.doc) as VariantDoc), total };
  }

  async documentCount(site: string): Promise<number> {
    const index = this.liveIndex(site);
    if (!index) return 0;
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM docs WHERE index_name = ?')
      .get(index) as { n: number };
    return row.n;
  }

  /** Decoded facet dictionary for one physical index, cached. */
  private dictionary(indexName: string): FacetDictionary {
    const cached = this.dictCache.get(indexName);
    if (cached) return cached;
    const rows = this.db
      .prepare('SELECT field, value_id, value FROM facet_dict WHERE index_name = ?')
      .all(indexName) as { field: string; value_id: number; value: string }[];
    const dict: FacetDictionary = { toValue: new Map(), toId: new Map() };
    for (const row of rows) {
      let values = dict.toValue.get(row.field);
      if (!values) {
        values = new Map();
        dict.toValue.set(row.field, values);
        dict.toId.set(row.field, new Map());
      }
      values.set(row.value_id, row.value);
      dict.toId.get(row.field)!.set(row.value, row.value_id);
    }
    this.dictCache.set(indexName, dict);
    return dict;
  }

  /**
   * Category and brand directory. Read once and cached: it changes only when an
   * index is promoted, and autocomplete needs it on every keystroke.
   */
  async directory(site: string): Promise<IndexDirectory> {
    const cached = this.directoryCache.get(site);
    if (cached) return cached;
    const index = this.liveIndex(site);
    if (!index) return { categories: [], brands: [] };

    const categoryRows = this.db
      .prepare(
        `SELECT c.category_id AS id, COUNT(DISTINCT d.parent_ord) AS products,
                (SELECT ic.path_json FROM index_categories ic
                 WHERE ic.index_name = c.index_name AND ic.category_id = c.category_id) AS path_json
         FROM doc_categories c CROSS JOIN docs d ON d.rowid = c.doc_rowid
         WHERE c.index_name = ?
         GROUP BY c.category_id ORDER BY products DESC`,
      )
      .all(index) as { id: string; products: number; path_json: string | null }[];

    const dict = this.dictionary(index).toValue.get('brand');
    const brandRows = this.db
      .prepare(
        `SELECT d.f_brand AS id, COUNT(DISTINCT d.parent_ord) AS products
         FROM docs d WHERE d.index_name = ? AND d.f_brand IS NOT NULL
         GROUP BY d.f_brand ORDER BY products DESC`,
      )
      .all(index) as { id: number; products: number }[];

    const directory: IndexDirectory = {
      categories: categoryRows.map((r) => ({
        id: r.id,
        path: parsePath(r.path_json) ?? prettifySlug(r.id),
        products: r.products,
      })),
      brands: brandRows
        .map((r) => ({ name: dict?.get(r.id) ?? '', products: r.products }))
        .filter((b) => b.name),
    };
    this.directoryCache.set(site, directory);
    return directory;
  }

  async vocabulary(site: string): Promise<Set<string>> {
    return this.loadVocab(site).set;
  }

  private loadVocab(site: string): Vocabulary {
    const cached = this.vocabCache.get(site);
    if (cached) return cached;
    const index = this.liveIndex(site);
    const rows = index
      ? (this.db
          .prepare('SELECT term FROM index_vocab WHERE index_name = ? ORDER BY term')
          .all(index) as { term: string }[])
      : [];
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

    const matchExpr = buildMatchExpression(query, expansions, index);
    // One narrowing pass per query, materialised into a temp table that the
    // count and the facet tally then read. Without it every one of those
    // re-ran the full-text match or re-scanned the category.
    const narrowed = this.materialiseCandidates(matchExpr, query, index);

    const { sql: filterSql, params: filterParams } = this.buildFilters(query, index, undefined, narrowed);
    // Rows in the candidate table are already scoped to this index, so the
    // downstream queries neither filter nor join on index_name. CROSS JOIN
    // pins the join order: without it SQLite leads with the 100k-row docs
    // table and probes the candidate set once per row.
    const base = narrowed.materialised
      ? `FROM _match m CROSS JOIN docs d ON d.rowid = m.rowid WHERE 1=1 ${filterSql}`
      : `FROM docs d WHERE d.index_name = ? ${filterSql}`;
    const baseParams = narrowed.materialised ? filterParams : [index, ...filterParams];

    this.currentIndex = index;
    const rows = this.fetchCandidates(query, narrowed, base, baseParams, filterSql, filterParams);

    const candidates: EngineCandidate[] = rows.map((r) => {
      const doc = JSON.parse(r.doc) as VariantDoc;
      return {
        doc,
        // FTS5 bm25 is negative-better; flip it so higher is better everywhere.
        retrievalScore: -r.score,
        matchedTerms: matchedTermsFor(doc, query.terms, expansions),
      };
    });

    const { facets, totalGroups } = (query.facets ?? []).length
      ? this.computeFacetsAndTotal(query, index, narrowed)
      : { facets: [], totalGroups: this.countGroups(base, baseParams, narrowed, filterSql) };
    if (narrowed.materialised) this.db.exec('DROP TABLE IF EXISTS temp._match');

    return { candidates, totalGroups, facets, tookMs: performance.now() - started };
  }

  /**
   * The candidate window, measured in parent products.
   *
   * Results are grouped by parent, so the window has to be too. This picks the
   * top N parents (by best variant score, or by the sort column) and then
   * fetches only the matching variants belonging to them. Sizing the window in
   * variants instead — which is what this used to do — makes the number of
   * cards on a page depend on how many variants those products happen to have.
   */
  private fetchCandidates(
    query: EngineQuery,
    narrowed: CandidateSet,
    base: string,
    baseParams: (string | number)[],
    filterSql: string,
    filterParams: (string | number)[],
  ): { doc: string; score: number }[] {
    const sort = SORTABLE[query.sort];
    // For an ascending sort the group's representative is its cheapest variant;
    // for a descending one, its most expensive. For relevance it is the best
    // scoring variant, and FTS5 bm25 is negative-better, so MIN wins there too.
    const aggregate = sort
      ? `${sort.direction === 'asc' ? 'MIN' : 'MAX'}(d.${sort.column})`
      : narrowed.scored ? 'MIN(m.score)' : 'MAX(d.sales_velocity)';
    const direction = sort ? sort.direction.toUpperCase() : narrowed.scored ? 'ASC' : 'DESC';
    // Within a group the variants must be ordered by the same measure, or the
    // card's representative is an arbitrary variant of a correctly ranked
    // product — a price-sorted grid whose prices are not in order.
    const withinGroup = sort
      ? `d.${sort.column}`
      : narrowed.scored ? 'm.score' : 'd.sales_velocity';

    this.db.exec('DROP TABLE IF EXISTS temp._groups');
    this.db.exec('CREATE TEMP TABLE _groups (parent_ord INTEGER PRIMARY KEY, rank_value REAL)');
    this.stmt(
      `INSERT INTO temp._groups (parent_ord, rank_value)
       SELECT d.parent_ord, ${aggregate} AS rv ${base}
       GROUP BY d.parent_ord ORDER BY rv ${direction} LIMIT ?`,
    ).run(...baseParams, query.groupWindow);

    // The same filters apply again here. Selecting a parent does not select
    // every variant it owns: a query for "4x6 beam 12ft" picks the parent via
    // its 12ft variant, and the 10ft one must still be excluded.
    const rows = this.stmt(
      `SELECT d.doc AS doc, ${narrowed.scored ? 'm.score' : '0'} AS score
       FROM _groups g
       CROSS JOIN docs d ON d.index_name = ? AND d.parent_ord = g.parent_ord
       ${narrowed.materialised ? 'JOIN _match m ON m.rowid = d.rowid' : ''}
       WHERE 1=1 ${filterSql}
       ORDER BY g.rank_value ${direction}, ${withinGroup} ${direction}
       LIMIT ?`,
    ).all(this.currentIndex, ...filterParams, query.candidateLimit) as
      { doc: string; score: number }[];

    this.db.exec('DROP TABLE IF EXISTS temp._groups');
    return rows;
  }

  /** Integer id of one label value, or undefined when nothing carries it. */
  private labelValueId(index: string, key: string, value: string): number | undefined {
    return this.dictionary(index).toId.get(`label:${key}`)?.get(value);
  }

  /** Translate facet filter values into their integer ids for this index. */
  private encodeFilterValues(
    index: string,
    field: string,
    values: (string | number)[],
  ): number[] {
    if (field === 'in_stock') {
      return values.map((v) => (String(v) === '1' || String(v).toLowerCase() === 'true' ? 1 : 0));
    }
    const dict = this.dictionary(index).toId.get(field);
    if (!dict) return [];
    const ids: number[] = [];
    for (const value of values) {
      const id = dict.get(String(value));
      if (id !== undefined) ids.push(id);
    }
    return ids;
  }

  /** Distinct-parent count for requests that asked for no facets at all. */
  private countGroups(
    base: string,
    baseParams: (string | number)[],
    narrowed: CandidateSet,
    filterSql: string,
  ): number {
    // With nothing left to filter, the count comes straight off the candidate
    // table and never reads a document row.
    if (narrowed.materialised && !filterSql) {
      return (
        this.stmt(
          `SELECT COUNT(DISTINCT d.parent_ord) AS n
           FROM _match m CROSS JOIN docs d ON d.rowid = m.rowid`,
        ).get() as { n: number }
      ).n;
    }
    return (
      this.stmt(`SELECT COUNT(DISTINCT d.parent_ord) AS n ${base}`).get(...baseParams) as { n: number }
    ).n;
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
      // The match expression carries this index's token, so the result is
      // already scoped and needs no join against docs to filter it.
      this.stmt(
        `INSERT INTO temp._match (rowid, score)
         SELECT rowid, bm25(docs_fts, ${ftsColumnWeights(query)}) FROM docs_fts WHERE docs_fts MATCH ?`,
      ).run(matchExpr);
      // The category stays an ordinary filter; it is indexed and the set is
      // already small by the time it is applied.
      return { materialised: true, scored: true, categoryHandled: false };
    }

    // Browse: the category index is the narrowing pass, and it is index-scoped.
    this.stmt(
      `INSERT INTO temp._match (rowid, score)
       SELECT c.doc_rowid, 0 FROM doc_categories c WHERE c.index_name = ? AND c.category_id = ?`,
    ).run(index, query.categoryId!);
    return { materialised: true, scored: false, categoryHandled: true };
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
    // Collection membership narrows exactly like a category does.
    if (query.collection) {
      const id = this.labelValueId(index, 'collection', query.collection);
      if (id === undefined) {
        parts.push('AND 1 = 0');
      } else {
        parts.push(
          `AND EXISTS (SELECT 1 FROM doc_labels l WHERE l.doc_rowid = d.rowid
             AND l.label_key = 'collection' AND l.value_id = ?)`,
        );
        params.push(id);
      }
    }

    // Custom attributes filter like catalogue attributes: OR within a key,
    // AND across keys. Lifted out for the facet pass, same as built-in facets.
    for (const [key, values] of Object.entries(query.labelFilters ?? {})) {
      if (!values?.length) continue;
      // Only a label group's OWN selection is lifted, and only when counting
      // that group. ALL_FACETS lifts the column-backed selections because those
      // are re-applied per row in the in-memory tally; label selections are not
      // in that tally, so lifting them here would leave the total and every
      // built-in facet count ignoring the filter entirely.
      if (skipFacetField === `label:${key}`) continue;
      const ids = values
        .map((v) => this.labelValueId(index, key, v))
        .filter((id): id is number => id !== undefined);
      if (ids.length === 0) {
        parts.push('AND 1 = 0');
        continue;
      }
      parts.push(
        `AND EXISTS (SELECT 1 FROM doc_labels l WHERE l.doc_rowid = d.rowid
           AND l.label_key = ? AND l.value_id IN (${ids.map(() => '?').join(',')}))`,
      );
      params.push(key, ...ids);
    }

    if (query.excludeSkus?.length) {
      parts.push(`AND d.sku NOT IN (${query.excludeSkus.map(() => '?').join(',')})`);
      params.push(...query.excludeSkus);
    }

    // OR within a facet group, AND across groups. The ALL_FACETS sentinel
    // lifts every selection out, for the single-pass facet tally.
    for (const [field, values] of Object.entries(query.filters ?? {})) {
      if (!values?.length || field === skipFacetField) continue;
      if (skipFacetField === ALL_FACETS && facetColumn(field)) continue;
      const column = facetColumn(field);
      if (column) {
        // Facet values are stored as dense integer ids, so a selection is
        // translated through the dictionary before it reaches SQL.
        const ids = this.encodeFilterValues(index, field, values);
        if (ids.length === 0) {
          // A value that is not in the dictionary matches nothing, and saying
          // so explicitly beats silently dropping the filter.
          parts.push('AND 1 = 0');
          continue;
        }
        parts.push(`AND d.${column} IN (${ids.map(() => '?').join(',')})`);
        params.push(...ids);
      } else {
        // An attribute nobody declared facetable still filters, just slowly.
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
        parts.push('AND (ABS(d.width_in - ?) < 0.03 OR ABS(d.height_in - ?) < 0.03'
          + ' OR ABS(d.length_in - ?) < 0.03 OR ABS(d.size_in - ?) < 0.03)');
        params.push(value, value, value, value);
      } else if (DIMENSION_COLUMNS[c.field]) {
        // Width and height fall back to size, so a product sold by a single
        // number answers to both. Mirrors the memory engine exactly.
        const column = DIMENSION_COLUMNS[c.field]!;
        if (column === 'width_in' || column === 'height_in') {
          parts.push(`AND ABS(COALESCE(NULLIF(d.${column}, -1), d.size_in) - ?) < 0.03`);
        } else {
          parts.push(`AND ABS(d.${column} - ?) < 0.03`);
        }
        params.push(value);
      }
    }

    void index;
    return { sql: parts.join(' '), params };
  }

  /**
   * Facet counts and the result total, computed in one pass.
   *
   * Every facet needs a slightly different filter set — a group excludes its
   * own selection from its own counts, so multi-select stays usable — which
   * naively means one query per facet. Instead this scans the candidate set
   * once with the non-facet filters applied, and tallies in memory: a row
   * failing no selection counts everywhere, a row failing exactly one counts
   * only toward that one group, and a row failing two or more counts nowhere.
   *
   * That is the standard technique, and it is what took faceted search at 100k
   * documents from ~600ms to double digits. Zero-count values are never
   * emitted, so a facet click can never land on an empty result set.
   */
  private computeFacetsAndTotal(
    query: EngineQuery,
    index: string,
    narrowed: CandidateSet,
  ): { facets: EngineFacet[]; totalGroups: number } {
    const fields = query.facets ?? [];
    const dict = this.dictionary(index);
    const selections = facetSelections(query, dict);

    // Only the filters that are NOT facet selections go into SQL; selections
    // are applied per row so each group can lift out its own.
    const { sql, params } = this.buildFilters(query, index, ALL_FACETS, narrowed);

    const projected = new Map<string, string>();
    const counted: string[] = [];
    for (const field of fields) {
      const column = facetColumn(field);
      if (!column) continue;
      projected.set(field, column);
      counted.push(field);
    }
    for (const field of selections.keys()) {
      const column = facetColumn(field);
      if (column) projected.set(field, column);
    }
    const order = [...projected.keys()];

    // Every projected column is an integer: a dense parent ordinal and dense
    // facet value ids. Nothing in this scan marshals a string.
    const projection = [
      'd.parent_ord AS p',
      'd.effective_price AS price',
      ...order.map((field, i) => `d.${projected.get(field)} AS c${i}`),
    ];

    const rows = (
      narrowed.materialised
        ? this.stmt(`SELECT ${projection.join(', ')} ${this.lead(narrowed)} WHERE 1=1 ${sql}`).all(...params)
        : this.stmt(
            `SELECT ${projection.join(', ')} ${this.lead(narrowed)} WHERE d.index_name = ? ${sql}`,
          ).all(index, ...params)
    ) as Record<string, number | null>[];

    const selectionByColumn = order.map((field) => selections.get(field) ?? null);
    const countedColumns = counted.map((field) => order.indexOf(field));
    const tallies = countedColumns.map(() => new Map<number, Set<number>>());
    const totalParents = new Set<number>();
    let priceMin = Number.POSITIVE_INFINITY;
    let priceMax = Number.NEGATIVE_INFINITY;

    for (const row of rows) {
      const parentOrd = row.p as number;

      // How many selected groups does this row fail, and which one?
      let misses = 0;
      let missedColumn = -1;
      for (let i = 0; i < selectionByColumn.length; i++) {
        const allowed = selectionByColumn[i];
        if (!allowed) continue;
        const value = row[`c${i}`];
        if (value === null || value === undefined || !allowed.has(value)) {
          misses++;
          missedColumn = i;
          if (misses > 1) break;
        }
      }

      if (misses === 0) {
        totalParents.add(parentOrd);
        const price = row.price as number;
        if (price !== null && Number.isFinite(price)) {
          if (price < priceMin) priceMin = price;
          if (price > priceMax) priceMax = price;
        }
      }
      if (misses > 1) continue;

      for (let t = 0; t < countedColumns.length; t++) {
        const column = countedColumns[t]!;
        // A row counts toward a facet when it satisfies every OTHER selection.
        if (misses === 1 && missedColumn !== column) continue;
        const value = row[`c${column}`];
        if (value === null || value === undefined) continue;
        const bucket = tallies[t]!;
        const parents = bucket.get(value);
        if (parents) parents.add(parentOrd);
        else bucket.set(value, new Set([parentOrd]));
      }
    }

    // Only the values that survived are decoded back to text.
    const facets: EngineFacet[] = [];
    for (const field of fields) {
      if (field === 'price') {
        if (priceMin <= priceMax) {
          facets.push({ field, values: [], stats: { min: priceMin, max: priceMax } });
        }
        continue;
      }
      const t = counted.indexOf(field);
      if (t < 0) continue;
      const decode = dict.toValue.get(field);
      const values = [...tallies[t]!.entries()]
        .map(([id, parents]) => ({
          value: field === 'in_stock' ? String(id) : (decode?.get(id) ?? String(id)),
          count: parents.size,
        }))
        .filter((v) => v.count > 0)
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)))
        .slice(0, 200);
      if (values.length) facets.push({ field, values });
    }

    for (const facet of this.labelFacets(query, index, narrowed)) facets.push(facet);
    return { facets, totalGroups: totalParents.size };
  }

  /**
   * Counts for merchandiser-defined attributes.
   *
   * These live in their own table rather than a column, because a merchandiser
   * can invent one at any time and columns cannot be added without a reindex.
   * The counting rule is the same: a group excludes its own selection so
   * multi-select stays usable, and zero-count values are never emitted.
   */
  private labelFacets(
    query: EngineQuery,
    index: string,
    narrowed: CandidateSet,
  ): EngineFacet[] {
    const keys = query.labelFacets ?? [];
    if (keys.length === 0) return [];
    const dict = this.dictionary(index).toValue;
    const out: EngineFacet[] = [];

    for (const key of keys) {
      const { sql, params } = this.buildFilters(query, index, `label:${key}`, narrowed);
      const rows = this.stmt(
        `SELECT l.value_id AS id, COUNT(DISTINCT l.parent_ord) AS count
         FROM doc_labels l
         CROSS JOIN docs d ON d.rowid = l.doc_rowid
         ${narrowed.materialised ? 'JOIN _match m ON m.rowid = d.rowid' : ''}
         WHERE l.index_name = ? AND l.label_key = ? ${sql}
         GROUP BY l.value_id ORDER BY count DESC LIMIT 200`,
      ).all(index, key, ...params) as { id: number; count: number }[];

      const decode = dict.get(`label:${key}`);
      const values = rows
        .filter((r) => r.count > 0)
        .map((r) => ({ value: decode?.get(r.id) ?? String(r.id), count: r.count }))
        .sort((a, b) => b.count - a.count || String(a.value).localeCompare(String(b.value)));
      if (values.length) out.push({ field: key, values });
    }
    return out;
  }

  private lead(narrowed: CandidateSet): string {
    return narrowed.materialised
      ? 'FROM _match m CROSS JOIN docs d ON d.rowid = m.rowid'
      : 'FROM docs d';
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

/** Facet fields served directly by a docs column rather than the attrs table. */
/**
 * Ingest-time dictionary builder.
 *
 * Assigns dense integer ids to parent products and to each facet value, so the
 * columns the facet scan reads are all integers.
 */
class FacetEncoder {
  private parents = new Map<string, number>();
  private fields = new Map<string, Map<string, number>>();

  parentOrd(parentId: string): number {
    let ord = this.parents.get(parentId);
    if (ord === undefined) {
      ord = this.parents.size;
      this.parents.set(parentId, ord);
    }
    return ord;
  }

  valueId(field: string, value: string): number {
    let values = this.fields.get(field);
    if (!values) {
      values = new Map();
      this.fields.set(field, values);
    }
    let id = values.get(value);
    if (id === undefined) {
      id = values.size;
      values.set(value, id);
    }
    return id;
  }

  /** field -> id -> value, for persisting. */
  dictionary(): Map<string, Map<number, string>> {
    const out = new Map<string, Map<number, string>>();
    for (const [field, values] of this.fields) {
      const inverted = new Map<number, string>();
      for (const [value, id] of values) inverted.set(id, value);
      out.set(field, inverted);
    }
    return out;
  }
}

interface FacetDictionary {
  /** field -> id -> value */
  toValue: Map<string, Map<number, string>>;
  /** field -> value -> id */
  toId: Map<string, Map<string, number>>;
}

const RANGE_COLUMNS: Record<string, string> = {
  price: 'effective_price',
  review_score: 'review_score',
  width_in: 'width_in',
  height_in: 'height_in',
  length_in: 'length_in',
  size_in: 'size_in',
};

const DIMENSION_COLUMNS: Record<string, string> = {
  width_in: 'width_in',
  height_in: 'height_in',
  length_in: 'length_in',
  size_in: 'size_in',
};

function numericDimensions(
  d: VariantDoc,
): { width: number; height: number; length: number; size: number } {
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
    // Products sold by a single number — a medallion's diameter, a fan's
    // span — carry it here rather than on an axis.
    size: read('size_in', 'size', 'diameter_in'),
  };
}

/** FTS5 column weights, ordered to match the docs_fts column list. */
function ftsColumnWeights(query: EngineQuery): string {
  const byField = new Map(query.weights.map((w) => [w.field, w.weight]));
  const order = [
    'title', 'variantTitle', 'sku', 'mpn', 'brand', 'categoryPath', 'attributes', 'description',
  ];
  // The leading 0.0 is the `idx` scoping column, which must not affect scoring.
  return ['0.0', ...order.map((f) => (byField.get(f) ?? 1).toFixed(1))].join(', ');
}

function parsePath(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as string[];
    return Array.isArray(parsed) && parsed.length ? parsed : null;
  } catch {
    return null;
  }
}

/** Last-resort display path, from the slug id, when no breadcrumb was stored. */
function prettifySlug(id: string): string[] {
  return id.split('/').map((slug) => slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()));
}

/** A single FTS-safe token identifying one physical index. */
function indexToken(indexName: string): string {
  return `zx${indexName.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}

/** Terms worth keeping in a per-index vocabulary. */
function harvestTerms(...parts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const word of parts.join(' ').toLowerCase().split(/[^a-z0-9]+/)) {
    if (word.length >= 3) out.add(word);
  }
  return out;
}

/** `(term OR expansion OR prefix*) AND (…)` — AND across terms, OR within. */
function buildMatchExpression(
  query: EngineQuery,
  expansions: Map<string, Expansion[]>,
  index: string,
): string {
  if (query.terms.length === 0) return '';
  // Scope the match to this index inside FTS, so the result set never contains
  // another site's documents that would have to be filtered out afterwards.
  const groups: string[] = [`(idx : ${indexToken(index)})`];
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

// 8: docs.size_in, so a lone measurement can match a product sold by a single
// number. An existing index predates the column and would fail every insert
// against it; the drop-and-rebuild above is what this counter is for.
const SCHEMA_VERSION = 8;
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


/** Sentinel telling buildFilters to leave every facet selection out of the SQL. */
const ALL_FACETS = ' all-facets';

/** The docs column backing a facet field, or null if it is not column-backed. */
function facetColumn(field: string): string | null {
  if (field === 'price') return null;
  if (field === 'in_stock') return 'in_stock';
  return isDictionaryFacet(field) ? attributeColumn(field) : null;
}

/** Active facet selections as id sets, for the integer tally. */
function facetSelections(query: EngineQuery, dict: FacetDictionary): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>();
  for (const [field, values] of Object.entries(query.filters ?? {})) {
    if (!values?.length || !facetColumn(field)) continue;
    const ids = new Set<number>();
    if (field === 'in_stock') {
      for (const v of values) ids.add(String(v) === '1' || String(v).toLowerCase() === 'true' ? 1 : 0);
    } else {
      const lookup = dict.toId.get(field);
      for (const v of values) {
        const id = lookup?.get(String(v));
        if (id !== undefined) ids.add(id);
      }
    }
    out.set(field, ids);
  }
  return out;
}
