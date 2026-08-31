import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Request guards: rate limiting, body size, and per-endpoint metrics.
 *
 * A public search key ships inside a storefront bundle, so it is visible to
 * anyone who views source. That is by design, but it means the search endpoints
 * are effectively open to the internet and have to be defended as such.
 */

export interface RateLimitOptions {
  /** Requests allowed per window, per client. */
  max: number;
  windowMs: number;
  /** Endpoints exempt from limiting, e.g. health checks. */
  skip?: (request: FastifyRequest) => boolean;
}

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Fixed-window counter, in process.
 *
 * Deliberately not a distributed limiter: with several API instances behind a
 * balancer this limits per instance, which is the right trade for a first line
 * of defence — it needs no Redis, cannot itself fall over, and the real
 * protection against a determined attacker belongs at the edge anyway. The
 * documented production topology puts a CDN or WAF in front.
 */
export class RateLimiter {
  private buckets = new Map<string, Bucket>();
  private lastSweep = Date.now();

  constructor(private readonly options: RateLimitOptions) {}

  check(key: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    this.sweep(now);
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.options.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count++;
    return {
      allowed: bucket.count <= this.options.max,
      remaining: Math.max(0, this.options.max - bucket.count),
      resetAt: bucket.resetAt,
    };
  }

  /** Drop expired buckets so a wide spread of client keys cannot leak memory. */
  private sweep(now: number): void {
    if (now - this.lastSweep < this.options.windowMs) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * Identify the caller.
 *
 * The API key first, because it is the unit that is actually rate-limited and
 * it survives NAT. Falls back to the forwarded client address; only the first
 * hop is trusted, and only when the deployment says a proxy sets it.
 */
export function clientKey(request: FastifyRequest, trustProxy: boolean): string {
  const header = request.headers['x-compass-key'];
  const key = Array.isArray(header) ? header[0] : header;
  if (key) return `k:${key.slice(0, 24)}`;
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
    if (first) return `ip:${first}`;
  }
  return `ip:${request.ip}`;
}

/** Latency and error counters, exposed at /metrics. */
export class Metrics {
  private counts = new Map<string, number>();
  private errors = new Map<string, number>();
  private latencies = new Map<string, number[]>();
  private readonly maxSamples = 2_000;
  readonly startedAt = Date.now();

  record(route: string, statusCode: number, durationMs: number): void {
    this.counts.set(route, (this.counts.get(route) ?? 0) + 1);
    if (statusCode >= 500) this.errors.set(route, (this.errors.get(route) ?? 0) + 1);
    let samples = this.latencies.get(route);
    if (!samples) {
      samples = [];
      this.latencies.set(route, samples);
    }
    // A reservoir rather than an unbounded list: a long-lived process must not
    // accumulate one number per request forever.
    if (samples.length < this.maxSamples) samples.push(durationMs);
    else samples[Math.floor(Math.random() * this.maxSamples)] = durationMs;
  }

  snapshot(): Record<string, unknown> {
    const routes: Record<string, unknown> = {};
    for (const [route, count] of this.counts) {
      const samples = [...(this.latencies.get(route) ?? [])].sort((a, b) => a - b);
      routes[route] = {
        requests: count,
        errors: this.errors.get(route) ?? 0,
        p50: percentile(samples, 50),
        p95: percentile(samples, 95),
        p99: percentile(samples, 99),
      };
    }
    return {
      uptimeSeconds: Math.round((Date.now() - this.startedAt) / 1000),
      memoryMb: Math.round(process.memoryUsage().rss / 1024 / 1024),
      routes,
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[index]! * 100) / 100;
}

export interface GuardOptions {
  search: RateLimiter;
  admin: RateLimiter;
  metrics: Metrics;
  trustProxy: boolean;
  /** Largest body accepted on a shopper-facing endpoint. */
  maxSearchBodyBytes: number;
  /** Classifies a URL as an admin API route; see app.ts. */
  isAdminApi: (url: string) => boolean;
}

/** Install rate limiting, body-size checks and metrics on every route. */
export function registerGuards(app: FastifyInstance, options: GuardOptions): void {
  // Registered here, beside the collector that fills it, so the endpoint and
  // its data cannot drift apart — and so it appears in the generated API
  // description like any other route.
  app.get('/metrics', async () => options.metrics.snapshot());

  app.addHook('onRequest', async (request, reply) => {
    const url = request.url;
    // Static assets — the console and the storefront SDK — are not rate limited:
    // one page load fetches a dozen of them.
    if (!url.startsWith('/v1/')) return;

    const limiter = options.isAdminApi(url) ? options.admin : options.search;
    const result = limiter.check(clientKey(request, options.trustProxy));

    reply.header('x-ratelimit-remaining', String(result.remaining));
    if (!result.allowed) {
      const retryAfter = Math.max(1, Math.ceil((result.resetAt - Date.now()) / 1000));
      await reply
        .header('retry-after', String(retryAfter))
        .code(429)
        .send({ error: 'rate limit exceeded', retryAfterSeconds: retryAfter });
    }
  });

  // A search body is a few hundred bytes; a catalogue push is megabytes. One
  // limit for both would either reject real ingests or let a shopper-facing
  // endpoint accept a payload big enough to be a denial-of-service on its own.
  app.addHook('preValidation', async (request, reply) => {
    if (request.url.includes('/catalog/')) return;
    const declared = Number(request.headers['content-length'] ?? 0);
    if (declared > options.maxSearchBodyBytes) {
      await reply.code(413).send({
        error: `request body exceeds ${options.maxSearchBodyBytes} bytes on this endpoint`,
      });
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    // Group by route pattern, not by URL, or per-site paths explode the keys.
    const route = request.routeOptions?.url ?? request.url;
    options.metrics.record(`${request.method} ${route}`, reply.statusCode, reply.elapsedTime);
  });
}
