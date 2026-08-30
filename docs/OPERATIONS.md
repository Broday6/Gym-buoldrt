# Operations

What it takes to run Compass Search in production, and what to do when it
misbehaves. `docker-compose.yml` is a development topology; this is the rest.

## Production topology

```
        CDN / WAF  ──►  load balancer  ──►  api ×N (stateless)
      (rate limits,                              │
       TLS, caching)                             ├──►  Typesense cluster
                                                 └──►  PostgreSQL (primary + replica)
```

**api** is stateless and horizontally scalable: everything durable lives in
Typesense or Postgres, and the result cache is per instance and disposable.
Scale on CPU — retrieval is CPU-bound, not IO-bound.

**Typesense** holds one collection per site behind an alias. Size RAM to the
index, not the disk: the working set is memory-resident. At ~2.3M variant
documents budget generously and measure before committing — see "Capacity"
below.

**PostgreSQL** holds configuration and analytics. It is not on the search path
(see "Failure modes"), but it is the only home of merchandiser-authored work.

The in-process rate limiter is a floor, not the defence. It limits per instance,
so N instances means N times the configured budget. Put real limits at the edge.

## Capacity

Retrieval is memory-bound at the engine and CPU-bound at the API. The two things
that actually move latency:

- **Document count is variant count, not product count.** The index is at the
  variant level so that a query for "black shutter" can return the black
  variant. A 500k-product catalogue with 4–5 variants each is a 2–2.5M document
  index.
- **Faceting cost scales with the matched set, not the catalogue.** A broad
  query matching 200k documents costs far more than a narrow one matching 200,
  regardless of catalogue size. Watch p95 on your broadest queries.

`npm run bench` reports uncached and cached latency separately. Run it against a
production-sized index before committing to hardware; the numbers in PROGRESS.md
are from a development engine and are a floor, not a forecast.

## Deploying

```bash
docker compose up -d           # or your orchestrator
npm run keys -- create <site> search "storefront"
npm run reindex -- <site> ./catalog.csv
```

A full reindex builds a new physical index and swaps the alias atomically, so it
is safe to run against a live site at any time. It does not interrupt traffic.

### Catalogue refresh

| Change | Endpoint | Latency |
|---|---|---|
| Full catalogue | `POST /v1/{site}/catalog/batch`, or `npm run reindex` | Minutes; zero downtime |
| One or more products | `POST /v1/{site}/catalog/records` | Milliseconds |
| Remove products | `DELETE /v1/{site}/catalog/records` | Milliseconds |
| Price and stock only | `POST /v1/{site}/catalog/updates` | Milliseconds; meets the <60s target with room to spare |

Schedule the full reindex nightly against a NetSuite saved-search export, and
wire price/stock to a more frequent job or a webhook. Merchandiser-authored
labels are recomputed on every ingest, so a refresh never erases them.

### After a merchandising change

Synonyms, redirects and collection *metadata* take effect on the next query —
the caches carrying them expire in 30 seconds and every write purges the result
cache immediately.

**Collection and custom-attribute membership is different.** It is stamped into
the index at ingest, so a new collection, a changed rule, or a hand-picked
product needs a reindex before shoppers see it. Those endpoints return
`reindexRequired: true` to say so. Run `npm run reindex` after a batch of
merchandising work, or let the nightly rebuild pick it up.

## Backups

The retrieval index is disposable — it rebuilds from the catalogue at any time.
**PostgreSQL is not.** It is the only home of every collection, custom
attribute, synonym, redirect, API key and analytics event.

```bash
pg_dump --format=custom "$DATABASE_URL" > compass-$(date +%F).dump
```

Nightly, off-host, with restores tested. Losing this database means losing every
merchandising decision anyone has made.

## Monitoring

| Endpoint | Purpose | Behaviour |
|---|---|---|
| `/health` | Liveness | Always 200 while the process is up; body reports `degraded` when a dependency is failing |
| `/health/ready` | Readiness | 503 when the instance has no documents indexed — point the load balancer here |
| `/metrics` | Per-route request counts, error counts, p50/p95/p99 | JSON |

Alert on: `/health/ready` returning 503, p95 on `POST /v1/:site/search` above
target, error rate above zero on any route, and the zero-result rate from the
events table trending up (that one is a merchandising problem, not an ops one).

## Failure modes

**PostgreSQL is down.** Search keeps serving. Synonyms, redirects and custom
facet labels degrade to their last known value or to empty; collection
membership is unaffected because it is already in the index. Analytics events
buffer in memory and flush when the database returns, up to 50,000 events, after
which the oldest are dropped rather than the process. `/health` reports
`degraded`. **Verified by stopping Postgres against a live instance.**

**Typesense is down.** Search fails. There is no fallback; this is the one hard
dependency. Run it clustered.

**A reindex fails partway.** The live index is untouched — a rebuild writes to a
new physical index and only swaps on success. Fix the input and re-run.

**Latency climbs after a catalogue grows.** Check `/metrics` for which route,
then run `npm run bench` against the same index. Faceting on broad queries is
the usual cause; the cheapest fix is narrowing the default facet set for the
affected category.

**Results look stale after a merchandising change.** If it was a collection or
custom attribute, it needs a reindex — see above. If it was a synonym or
redirect, check the result cache purged: every write calls `invalidate`, and
`/health` reports cache statistics.

## Configuration

Beyond `.env.example`:

| Variable | Default | Notes |
|---|---|---|
| `COMPASS_RATE_SEARCH` | `600` | Search requests per minute per client, per instance |
| `COMPASS_RATE_ADMIN` | `60` | Admin requests per minute |
| `COMPASS_MAX_SEARCH_BODY_BYTES` | `32768` | Shopper endpoints; catalogue endpoints use the larger limit |
| `COMPASS_MAX_BODY_BYTES` | `67108864` | Ceiling for a catalogue push |
| `COMPASS_TRUST_PROXY` | `0` | Set to `1` only behind a proxy that sets `X-Forwarded-For`; otherwise clients can spoof their identity to the rate limiter |
| `COMPASS_CACHE_ENTRIES` | `2000` | Result cache size per instance |
| `COMPASS_CACHE_TTL_MS` | `60000` | Backstop only; correctness comes from invalidation |

Never set `COMPASS_DEV_OPEN=1` outside local development — it disables API-key
checks entirely.
