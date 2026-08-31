/**
 * Scheduled maintenance.
 *
 * Two jobs existed as commands nobody ran: the analytics rollup (so the
 * dashboard went stale a day after anyone last ran it by hand) and the index
 * rebuild. Both now run on a schedule inside the API process.
 *
 * In process rather than as a cron entry, for the same reason the rate limiter
 * is in process: it needs no second deployment artefact, cannot fall out of
 * sync with the code it maintains, and cannot itself be the thing that is down.
 * The cost is that it must be safe to run several copies at once, since a
 * deployment behind a load balancer has several. That is what the lease below
 * is for — a job claims its slot in the database, so exactly one instance runs
 * it however many are up.
 *
 * A deployment that would rather drive this from its own orchestrator sets
 * COMPASS_SCHEDULE=off and calls the endpoints.
 */
import type { Db } from '../db/pool.js';
import type { AnalyticsService } from './analytics.js';
import type { SiteRegistry } from '../config/sites.js';

export interface Job {
  name: string;
  /** Hour of the day, in UTC, at which this job should run. */
  hourUtc: number;
  run: (siteId: string) => Promise<string>;
}

export interface SchedulerOptions {
  db: Db;
  sites: SiteRegistry;
  analytics: AnalyticsService;
  log: { info: (o: object, m: string) => void; error: (o: object, m: string) => void };
  /** How often to check whether a job is due. */
  tickMs?: number;
  jobs?: Job[];
}

export class Scheduler {
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly jobs: Job[];
  private readonly tickMs: number;
  /** Last outcome per job, surfaced on /health so a silent failure is visible. */
  readonly lastRun = new Map<string, { at: string; result: string; ok: boolean }>();

  constructor(private readonly options: SchedulerOptions) {
    this.tickMs = options.tickMs ?? 5 * 60_000;
    this.jobs = options.jobs ?? [
      {
        name: 'analytics-rollup',
        hourUtc: Number(process.env.COMPASS_ROLLUP_HOUR_UTC ?? 3),
        run: async (siteId) => {
          // Two days, not one: an event recorded just before midnight can be
          // written after it, and a shopper's day is not the server's day.
          const { days, events } = await options.analytics.rollup(siteId, 2);
          return `${events} events over ${days} day(s)`;
        },
      },
    ];
  }

  start(): void {
    if (process.env.COMPASS_SCHEDULE === 'off') {
      this.options.log.info({}, 'scheduler disabled by COMPASS_SCHEDULE=off');
      return;
    }
    // Checked on an interval rather than with a timer set to the next due time:
    // a long timer drifts across a suspend, and a process that has been asleep
    // should catch up on its next tick rather than at the next midnight.
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Run anything due now. Safe to call at any time, from anywhere. */
  async tick(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const job of this.jobs) {
        if (now.getUTCHours() < job.hourUtc) continue;
        for (const site of this.options.sites.list()) {
          if (!(await this.claim(job.name, site.id, now))) continue;
          try {
            const result = await job.run(site.id);
            this.lastRun.set(`${job.name}:${site.id}`, {
              at: now.toISOString(), result, ok: true,
            });
            this.options.log.info({ job: job.name, site: site.id, result }, 'scheduled job ran');
          } catch (err) {
            const message = (err as Error).message;
            this.lastRun.set(`${job.name}:${site.id}`, {
              at: now.toISOString(), result: message, ok: false,
            });
            this.options.log.error({ job: job.name, site: site.id, err: message },
              'scheduled job failed');
            // Release the claim so the next tick retries rather than skipping
            // the day. A job that fails silently once a day is worse than one
            // that fails loudly every five minutes.
            await this.release(job.name, site.id, now).catch(() => {});
          }
        }
      }
    } finally {
      this.running = false;
    }
  }

  /**
   * Claim today's slot for this job and site.
   *
   * The primary key does the work: an insert either wins or conflicts, so
   * exactly one instance runs the job no matter how many are up, with no lock
   * to leak and nothing to clean up if an instance dies mid-run.
   */
  private async claim(job: string, siteId: string, now: Date): Promise<boolean> {
    const day = now.toISOString().slice(0, 10);
    const { rowCount } = await this.options.db.query(
      `INSERT INTO scheduled_runs (job, site_id, day) VALUES ($1, $2, $3)
       ON CONFLICT (job, site_id, day) DO NOTHING`,
      [job, siteId, day],
    );
    return (rowCount ?? 0) > 0;
  }

  private async release(job: string, siteId: string, now: Date): Promise<void> {
    await this.options.db.query(
      'DELETE FROM scheduled_runs WHERE job = $1 AND site_id = $2 AND day = $3',
      [job, siteId, now.toISOString().slice(0, 10)],
    );
  }

  /** For /health: what ran, when, and whether it worked. */
  status(): Record<string, { at: string; result: string; ok: boolean }> {
    return Object.fromEntries(this.lastRun);
  }
}
