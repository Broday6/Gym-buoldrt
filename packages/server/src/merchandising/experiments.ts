/**
 * Does this change actually help?
 *
 * Every merchandising rule in this system has been applied on faith. A
 * merchandiser pins three products to the top of "beam" and the products move;
 * whether anyone bought more beams is unknown, and stays unknown, because
 * there is nothing to compare against. The autopilot made that worse by
 * proposing changes faster than anyone could evaluate them.
 *
 * An experiment splits traffic for one rule: some sessions get it, the rest
 * get the page as it would have been. Both are measured, and the difference is
 * the answer.
 *
 * Three decisions worth stating, because each rules out a subtler mistake:
 *
 *   - **Assignment is a hash of the session id, not a stored coin flip.** No
 *     table to write on the request path, no coordination between instances,
 *     and — most importantly — a shopper gets the same variant on every page
 *     of a visit. A shopper who saw the pinned grid, went to page two, and got
 *     the unpinned one would be in both arms of the experiment at once.
 *   - **The split is by session, not by search.** Conversion happens across
 *     several searches, so splitting per search would put the search that
 *     showed the product and the search that led to the purchase in different
 *     arms.
 *   - **Control is the rule switched off.** Not a second speculative
 *     arrangement: "did this help" is the question, and answering it against
 *     another guess answers something else.
 */
import type { Db } from '../db/pool.js';

export type ExperimentStatus = 'running' | 'stopped' | 'adopted' | 'discarded';
export type Variant = 'control' | 'treatment';

export interface Experiment {
  id: number;
  siteId: string;
  name: string;
  hypothesis: string | null;
  ruleId: number;
  /** Percentage of sessions that see the rule. */
  exposure: number;
  status: ExperimentStatus;
  startedAt: Date;
  endedAt: Date | null;
  outcomeNote: string | null;
}

export interface ExperimentInput {
  name: string;
  hypothesis?: string;
  ruleId: number;
  exposure?: number;
  author?: string;
}

/**
 * Which arm this session is in.
 *
 * A hash rather than a random draw, so the answer is the same every time it is
 * asked — across requests, across processes, and after a restart — without
 * anything being stored. Salted with the experiment id so a session that is
 * unlucky in one experiment is not systematically unlucky in the next.
 */
export function assign(experimentId: number, sessionId: string, exposure: number): Variant {
  if (!sessionId) return 'control';
  return bucketOf(experimentId, sessionId) < exposure ? 'treatment' : 'control';
}

/** Which of a hundred buckets this session falls in for this experiment. */
export function bucketOf(experimentId: number, sessionId: string): number {
  return hash32(`${experimentId}:${sessionId}`) % 100;
}

/**
 * A 32-bit string hash, in plain arithmetic.
 *
 * Not SHA-256, deliberately. Bucketing is not a security problem — nobody
 * gains anything by predicting which half of an experiment they land in — and
 * a cryptographic hash costs a platform dependency this does not need. The
 * same module runs in the hosted browser build, where `node:crypto` does not
 * exist and pulling it in broke the bundle.
 *
 * FNV-1a for accumulation, then MurmurHash3's finalizer to avalanche the
 * result: FNV alone leaves the low bits correlated for inputs sharing a
 * prefix, which is exactly what session ids do. The uniformity that matters —
 * that a 10/50/90 split lands within a point or two of its target across
 * thousands of sessions — is asserted in the tests.
 */
function hash32(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    // The FNV prime, as shifts: Math.imul keeps this in 32-bit integer space
    // where a plain multiply would lose precision past 2^53.
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class ExperimentStore {
  private cache: { experiments: Experiment[]; expires: number } | null = null;

  constructor(private readonly db: Db, private readonly ttlMs = 15_000) {}

  async list(siteId: string): Promise<Experiment[]> {
    const { rows } = await this.db.query<Row>(
      `SELECT * FROM experiments WHERE site_id = $1 ORDER BY started_at DESC`, [siteId],
    );
    return rows.map(toExperiment);
  }

  async get(siteId: string, id: number): Promise<Experiment | null> {
    const { rows } = await this.db.query<Row>(
      'SELECT * FROM experiments WHERE site_id = $1 AND id = $2', [siteId, id],
    );
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  /**
   * Experiments running right now, cached briefly.
   *
   * On the query path, so it degrades like the rest of the merchandising: an
   * analytics outage costs experiments, not the ability to search. Failing
   * closed is the safe direction — with no answer, every shopper sees the
   * rule, which is what they would have seen without experiments at all.
   */
  async running(siteId: string): Promise<Experiment[]> {
    if (this.cache && this.cache.expires > Date.now()) return this.cache.experiments;
    try {
      const { rows } = await this.db.query<Row>(
        `SELECT * FROM experiments WHERE site_id = $1 AND status = 'running'`, [siteId],
      );
      const experiments = rows.map(toExperiment);
      this.cache = { experiments, expires: Date.now() + this.ttlMs };
      return experiments;
    } catch {
      return this.cache?.experiments ?? [];
    }
  }

  async create(siteId: string, input: ExperimentInput): Promise<Experiment> {
    const exposure = Math.round(input.exposure ?? 50);
    if (exposure < 1 || exposure > 99) {
      // Not a clamp: somebody asking for 100% wants no control group, and
      // silently giving them 99% would produce a result they would read as
      // "everyone saw it" when it is not what happened.
      throw new Error('exposure must be between 1 and 99 percent');
    }
    if (!input.name.trim()) throw new Error('an experiment needs a name');

    try {
      const { rows } = await this.db.query<Row>(
        `INSERT INTO experiments (site_id, name, hypothesis, rule_id, exposure, created_by)
         VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [siteId, input.name.trim(), input.hypothesis?.trim() || null,
          input.ruleId, exposure, input.author ?? null],
      );
      this.cache = null;
      return toExperiment(rows[0]!);
    } catch (err) {
      if (String((err as Error).message).includes('experiments_one_running_per_rule')) {
        throw new Error('that rule is already being tested');
      }
      throw err;
    }
  }

  /**
   * End an experiment.
   *
   * `adopted` and `discarded` are recorded rather than inferred, because the
   * decision is not always the one the numbers suggest — a change can be kept
   * for a reason the metrics do not carry — and six weeks later nobody
   * remembers which way it went or why.
   */
  async end(
    siteId: string,
    id: number,
    status: Exclude<ExperimentStatus, 'running'>,
    note?: string,
  ): Promise<Experiment | null> {
    const { rows } = await this.db.query<Row>(
      `UPDATE experiments
          SET status = $3, ended_at = now(), outcome_note = $4
        WHERE site_id = $1 AND id = $2 AND status = 'running'
      RETURNING *`,
      [siteId, id, status, note?.trim() || null],
    );
    this.cache = null;
    return rows[0] ? toExperiment(rows[0]) : null;
  }

  invalidate(): void {
    this.cache = null;
  }
}

interface Row {
  id: string; site_id: string; name: string; hypothesis: string | null;
  rule_id: string; exposure: number; status: ExperimentStatus;
  started_at: Date; ended_at: Date | null; outcome_note: string | null;
}

function toExperiment(row: Row): Experiment {
  return {
    id: Number(row.id),
    siteId: row.site_id,
    name: row.name,
    hypothesis: row.hypothesis,
    ruleId: Number(row.rule_id),
    exposure: row.exposure,
    status: row.status,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    outcomeNote: row.outcome_note,
  };
}
