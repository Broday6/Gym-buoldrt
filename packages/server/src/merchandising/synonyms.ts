import type { Db } from '../db/pool.js';
import { normalise, singularise, tokenise } from '../query/normalize.js';

/**
 * Synonyms.
 *
 * Applied as query expansion rather than index expansion: "sofa" searches for
 * (sofa OR couch) instead of every couch document gaining the word "sofa". That
 * keeps the index honest — a document's text stays what the merchandiser wrote
 * — and it means a synonym edit takes effect on the next query rather than
 * needing a reindex.
 */

export type SynonymKind = 'two_way' | 'one_way';

export interface SynonymRule {
  id: number;
  siteId: string;
  kind: SynonymKind;
  /** one_way only: the terms that trigger the expansion. */
  fromTerms: string[];
  terms: string[];
  enabled: boolean;
  note?: string;
}

export interface SynonymExpansion {
  /** Alternative token sequences for a matched span of the query. */
  alternatives: string[][];
  /** The rule that produced it, for the explainability panel. */
  ruleId: number;
  /** Query tokens the rule consumed. */
  span: { start: number; length: number };
}

/** Compiled lookup: phrase (space-joined, singularised) -> expansions. */
export class SynonymSet {
  private byPhrase = new Map<string, { ruleId: number; alternatives: string[][] }[]>();
  private maxPhraseLength = 1;

  constructor(rules: SynonymRule[]) {
    for (const rule of rules) {
      if (!rule.enabled) continue;
      const triggers = rule.kind === 'two_way' ? rule.terms : rule.fromTerms;
      for (const trigger of triggers) {
        const key = canonicalPhrase(trigger);
        if (!key) continue;
        // A two-way rule expands to its siblings; a one-way rule to its targets.
        const targets = rule.kind === 'two_way'
          ? rule.terms.filter((t) => canonicalPhrase(t) !== key)
          : rule.terms;
        const alternatives = targets.map((t) => tokenise(t).map(singularise)).filter((t) => t.length);
        if (alternatives.length === 0) continue;
        const length = key.split(' ').length;
        if (length > this.maxPhraseLength) this.maxPhraseLength = length;
        const existing = this.byPhrase.get(key);
        if (existing) existing.push({ ruleId: rule.id, alternatives });
        else this.byPhrase.set(key, [{ ruleId: rule.id, alternatives }]);
      }
    }
  }

  get size(): number {
    return this.byPhrase.size;
  }

  /**
   * Find every synonym that applies to a token sequence. Longest phrase wins at
   * a given position, so "crown moulding" beats a rule on "crown" alone.
   */
  expand(tokens: string[]): SynonymExpansion[] {
    const out: SynonymExpansion[] = [];
    let i = 0;
    while (i < tokens.length) {
      let matched = false;
      for (let length = Math.min(this.maxPhraseLength, tokens.length - i); length >= 1; length--) {
        const key = tokens.slice(i, i + length).join(' ');
        const rules = this.byPhrase.get(key);
        if (!rules?.length) continue;
        for (const rule of rules) {
          out.push({ alternatives: rule.alternatives, ruleId: rule.ruleId, span: { start: i, length } });
        }
        i += length;
        matched = true;
        break;
      }
      if (!matched) i++;
    }
    return out;
  }
}

function canonicalPhrase(phrase: string): string {
  return tokenise(normalise(phrase)).map(singularise).join(' ');
}

/** Loads and caches per-site synonym sets; invalidated on write. */
export class SynonymStore {
  private cache = new Map<string, { set: SynonymSet; expires: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  async get(siteId: string): Promise<SynonymSet> {
    const cached = this.cache.get(siteId);
    if (cached && cached.expires > Date.now()) return cached.set;
    let rows: {
      id: number; kind: SynonymKind; from_terms: string[]; terms: string[]; enabled: boolean;
    }[];
    try {
      ({ rows } = await this.db.query(
        'SELECT id, kind, from_terms, terms, enabled FROM synonyms WHERE site_id = $1 AND enabled',
        [siteId],
      ));
    } catch (err) {
      // The retrieval index is independent of this database. A config store
      // outage must degrade search — no synonyms — not take the storefront
      // down with it. Serve the last known set if there is one.
      console.error({ err: (err as Error).message, site: siteId }, 'synonyms unavailable');
      if (cached) return cached.set;
      const empty = new SynonymSet([]);
      this.cache.set(siteId, { set: empty, expires: Date.now() + 5_000 });
      return empty;
    }
    const set = new SynonymSet(
      rows.map((r) => ({
        id: r.id, siteId, kind: r.kind, fromTerms: r.from_terms, terms: r.terms, enabled: r.enabled,
      })),
    );
    this.cache.set(siteId, { set, expires: Date.now() + this.ttlMs });
    return set;
  }

  invalidate(siteId?: string): void {
    if (siteId) this.cache.delete(siteId);
    else this.cache.clear();
  }

  async list(siteId: string): Promise<SynonymRule[]> {
    const { rows } = await this.db.query(
      'SELECT id, kind, from_terms, terms, enabled, note FROM synonyms WHERE site_id = $1 ORDER BY id',
      [siteId],
    );
    return rows.map((r) => ({
      id: r.id, siteId, kind: r.kind, fromTerms: r.from_terms, terms: r.terms,
      enabled: r.enabled, note: r.note ?? undefined,
    }));
  }

  async create(
    siteId: string,
    input: { kind: SynonymKind; fromTerms?: string[]; terms: string[]; note?: string; author?: string },
  ): Promise<SynonymRule> {
    if (input.kind === 'two_way' && input.terms.length < 2) {
      throw new Error('a two-way synonym needs at least two terms');
    }
    if (input.kind === 'one_way' && !input.fromTerms?.length) {
      throw new Error('a one-way synonym needs at least one `from` term');
    }
    const { rows } = await this.db.query(
      `INSERT INTO synonyms (site_id, kind, from_terms, terms, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, from_terms, terms, enabled, note`,
      [siteId, input.kind, input.fromTerms ?? [], input.terms, input.note ?? null, input.author ?? null],
    );
    this.invalidate(siteId);
    const r = rows[0]!;
    return {
      id: r.id, siteId, kind: r.kind, fromTerms: r.from_terms, terms: r.terms,
      enabled: r.enabled, note: r.note ?? undefined,
    };
  }

  async remove(siteId: string, id: number): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'DELETE FROM synonyms WHERE site_id = $1 AND id = $2',
      [siteId, id],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }

  async setEnabled(siteId: string, id: number, enabled: boolean): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'UPDATE synonyms SET enabled = $3, updated_at = now() WHERE site_id = $1 AND id = $2',
      [siteId, id, enabled],
    );
    this.invalidate(siteId);
    return Boolean(rowCount);
  }
}
