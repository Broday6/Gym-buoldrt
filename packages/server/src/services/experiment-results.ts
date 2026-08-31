/**
 * Reading an experiment.
 *
 * The hard part of A/B testing is not splitting traffic — that is a hash. It
 * is stopping people from believing a difference that is not there. Two habits
 * do most of the damage, and both are addressed here rather than left to
 * whoever reads the screen:
 *
 *   - **Watching until it looks good.** Checking a running experiment every
 *     day and stopping the moment it crosses a threshold turns a 5% false
 *     positive rate into something far worse, because every look is another
 *     chance to be fooled. This reports how much data it would take before the
 *     comparison means anything, and says plainly when there is not enough
 *     yet — rather than showing a confident-looking percentage from ninety
 *     sessions.
 *   - **Reading a p-value as a probability of being right.** It is not one.
 *     So the verdict here is a sentence, not a number: "better", "worse", "no
 *     difference yet", each with what it would take to be sure.
 *
 * The test is a two-proportion z-test on the session conversion rate. It
 * assumes sessions are independent, which is close enough for a storefront and
 * wrong for anything where the same person is counted twice.
 */
import type { Db } from '../db/pool.js';
import type { Experiment, Variant } from '../merchandising/experiments.js';

export interface ArmResult {
  variant: Variant;
  /** Distinct sessions that saw this arm — the unit the split is made on. */
  sessions: number;
  searches: number;
  clicks: number;
  addToCarts: number;
  purchases: number;
  revenue: number;
  /** Share of sessions that clicked a result. */
  clickRate: number;
  /** Share of sessions that reached the cart. */
  cartRate: number;
  revenuePerSession: number;
}

export type Verdict =
  | 'not_enough_data'
  | 'better'
  | 'worse'
  | 'no_difference';

export interface ExperimentResult {
  experiment: Experiment;
  control: ArmResult;
  treatment: ArmResult;
  /** Relative change in the cart rate, the metric closest to money. */
  liftPct: number | null;
  verdict: Verdict;
  /** What the verdict means, in a sentence a merchandiser can act on. */
  summary: string;
  /**
   * Roughly how many sessions per arm this comparison needs to detect a change
   * of the size currently observed. Present so "not enough data" is a number,
   * not a shrug.
   */
  sessionsNeeded: number | null;
  confidence: number | null;
}

/**
 * Below this, no arithmetic is worth doing.
 *
 * A z-test on a handful of sessions produces confident-looking output from
 * noise, and the confident-looking output is the dangerous part.
 */
const MIN_SESSIONS_PER_ARM = 100;

export async function experimentResult(
  db: Db,
  experiment: Experiment,
): Promise<ExperimentResult> {
  const { rows } = await db.query<{
    ab_variant: string; sessions: string; searches: string; clicks: string;
    carts: string; purchases: string; revenue: string;
  }>(
    `SELECT ab_variant,
            count(DISTINCT session_id)::text                        AS sessions,
            count(*) FILTER (WHERE type IN ('search','zero_result'))::text AS searches,
            count(DISTINCT session_id) FILTER (WHERE type = 'click')::text AS clicks,
            count(DISTINCT session_id) FILTER (WHERE type = 'add_to_cart')::text AS carts,
            count(DISTINCT session_id) FILTER (WHERE type = 'purchase')::text AS purchases,
            coalesce(sum(revenue) FILTER (WHERE type = 'purchase'), 0)::text AS revenue
       FROM events
      WHERE site_id = $1 AND ab_test_id = $2
        AND occurred_at >= $3
        AND ($4::timestamptz IS NULL OR occurred_at <= $4)
      GROUP BY ab_variant`,
    [experiment.siteId, String(experiment.id), experiment.startedAt, experiment.endedAt],
  );

  const arm = (variant: Variant): ArmResult => {
    const row = rows.find((r) => r.ab_variant === variant);
    const sessions = Number(row?.sessions ?? 0);
    const clicks = Number(row?.clicks ?? 0);
    const carts = Number(row?.carts ?? 0);
    const revenue = Number(row?.revenue ?? 0);
    return {
      variant,
      sessions,
      searches: Number(row?.searches ?? 0),
      clicks,
      addToCarts: carts,
      purchases: Number(row?.purchases ?? 0),
      revenue: round2(revenue),
      // Rates are per session, matching the unit traffic was split on. A rate
      // per search would let one shopper who searched forty times outweigh
      // forty shoppers who searched once.
      clickRate: sessions ? clicks / sessions : 0,
      cartRate: sessions ? carts / sessions : 0,
      revenuePerSession: sessions ? round2(revenue / sessions) : 0,
    };
  };

  const control = arm('control');
  const treatment = arm('treatment');
  return { experiment, control, treatment, ...judge(control, treatment) };
}

function judge(control: ArmResult, treatment: ArmResult): Pick<
  ExperimentResult, 'liftPct' | 'verdict' | 'summary' | 'sessionsNeeded' | 'confidence'
> {
  const thin = Math.min(control.sessions, treatment.sessions) < MIN_SESSIONS_PER_ARM;
  const liftPct = control.cartRate > 0
    ? round2(((treatment.cartRate - control.cartRate) / control.cartRate) * 100)
    : null;

  if (thin) {
    return {
      liftPct,
      verdict: 'not_enough_data',
      confidence: null,
      sessionsNeeded: MIN_SESSIONS_PER_ARM,
      summary: `Too early to tell — ${Math.min(control.sessions, treatment.sessions)} `
        + `sessions in the smaller group, and ${MIN_SESSIONS_PER_ARM} is the floor `
        + 'before a comparison means anything.',
    };
  }

  const { z, confidence } = twoProportionZ(
    treatment.addToCarts, treatment.sessions,
    control.addToCarts, control.sessions,
  );
  const needed = sessionsToDetect(control.cartRate, treatment.cartRate);

  // 95% two-sided, the convention. Stated as a threshold rather than hidden in
  // a comparison so it can be argued with.
  if (confidence < 0.95) {
    return {
      liftPct,
      verdict: 'no_difference',
      confidence: round2(confidence),
      sessionsNeeded: needed,
      summary: needed && needed > treatment.sessions
        ? `No clear difference yet. A change this size needs about `
          + `${needed.toLocaleString()} sessions per group to be sure; there are `
          + `${treatment.sessions.toLocaleString()}.`
        : 'No clear difference between the two. The change is not hurting, and '
          + 'is not measurably helping either.',
    };
  }

  const better = treatment.cartRate > control.cartRate;
  return {
    liftPct,
    verdict: better ? 'better' : 'worse',
    confidence: round2(confidence),
    sessionsNeeded: needed,
    summary: better
      ? `The change is winning: ${pct(treatment.cartRate)} of sessions reached the cart `
        + `against ${pct(control.cartRate)} without it.`
      : `The change is losing: ${pct(treatment.cartRate)} of sessions reached the cart `
        + `against ${pct(control.cartRate)} without it.`,
  };
}

/**
 * Two-proportion z-test.
 *
 * The pooled form, which is the right one for a null hypothesis of "these two
 * rates are the same" — using each arm's own variance instead quietly inflates
 * significance when the arms differ in size.
 */
export function twoProportionZ(
  successesA: number, trialsA: number,
  successesB: number, trialsB: number,
): { z: number; confidence: number } {
  if (trialsA <= 0 || trialsB <= 0) return { z: 0, confidence: 0 };
  const pA = successesA / trialsA;
  const pB = successesB / trialsB;
  const pooled = (successesA + successesB) / (trialsA + trialsB);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / trialsA + 1 / trialsB));
  if (se === 0) return { z: 0, confidence: 0 };
  const z = (pA - pB) / se;
  // Two-sided: a change that makes things worse is as much a result as one
  // that helps, and a one-sided test would hide half of them.
  return { z, confidence: 2 * normalCdf(Math.abs(z)) - 1 };
}

/**
 * Sessions per arm needed to detect the difference currently observed, at 95%
 * confidence and 80% power — the usual textbook pair.
 *
 * Reported so "not enough data" carries a number somebody can plan around: an
 * experiment that needs 40,000 sessions an arm on a store doing 400 a day is
 * one to abandon, not to wait for.
 */
export function sessionsToDetect(rateA: number, rateB: number): number | null {
  const delta = Math.abs(rateA - rateB);
  if (delta < 1e-9) return null;
  const p = (rateA + rateB) / 2;
  if (p <= 0 || p >= 1) return null;
  // (z(α/2) + z(β))² · 2p(1−p) / δ², with 1.96 and 0.84.
  const n = ((1.96 + 0.84) ** 2 * 2 * p * (1 - p)) / (delta * delta);
  return Math.ceil(n);
}

/** Abramowitz & Stegun 26.2.17: accurate to ~7.5e-8, which is far past enough. */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989422804014327 * Math.exp(-z * z / 2);
  const p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937
    + t * (-1.821255978 + t * 1.330274429))));
  return z >= 0 ? 1 - p : p;
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
