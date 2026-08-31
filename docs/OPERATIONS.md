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

## Secrets

Three secrets exist. Nothing else in the system is confidential.

| Secret | Where it lives | If it leaks |
|---|---|---|
| `DATABASE_URL` | Environment only, never a file in the repo | Full read/write to every tenant's configuration and analytics |
| API keys | Only their SHA-256 hashes are stored; the plaintext is shown once at creation | Bounded by the key's role — see below |
| `TYPESENSE_API_KEY` | Environment only | Direct access to the retrieval index |

A key's role is in its prefix, so a key found in a commit, a log or a support
ticket announces what it can do without a lookup:

| Prefix | Can | Safe in a browser |
|---|---|---|
| `ck_search_…` | Read search endpoints, post shopper events | **Yes** — this is designed to ship in a storefront bundle |
| `ck_analyst_…` | The above, plus reports and catalogue health. Read-only | No |
| `ck_merchandiser_…` | The above, plus collections, badges, attributes, synonyms, redirects | No |
| `ck_admin_…` | Everything, including catalogue pushes and reindexing | No |

Issue the narrowest role that does the job. A reporting integration wants
`analyst`; the console for a merchandising team wants `merchandiser`; only the
ingest pipeline needs `admin`.

```bash
npm run keys -- roles                              # what each role can do
npm run keys -- create ekena merchandiser "sarah"
npm run keys -- list ekena                         # includes last-used dates
```

### Rotation

Rotate on a schedule, and immediately on any suspicion of exposure. `rotate`
issues a replacement with the same site, role and label, and records which key
replaced which, so the chain is auditable afterwards.

```bash
npm run keys -- rotate 7          # old key stays live; deploy the new one
npm run keys -- list ekena        # confirm traffic has moved (last-used column)
npm run keys -- revoke 7          # then close the old one
```

The grace period is the point: revoking first takes the integration down, and an
operator under that pressure makes worse decisions. On a confirmed leak, skip it:

```bash
npm run keys -- rotate 7 --now    # revokes immediately
```

Revocation takes effect within the key cache TTL, 30 seconds by default.

## Backups

The retrieval index is disposable — it rebuilds from the catalogue at any time.
**PostgreSQL is not.** It is the only home of every collection, custom
attribute, synonym, redirect, badge, API key hash and analytics event — every
merchandising decision anyone has made.

```bash
npm run backup              # dump, verify, prune
npm run backup -- list
```

Each run dumps in custom format, then **reads the dump back** and checks that
every table that cannot be recomputed from the catalogue is present. `pg_dump`
exiting 0 is not proof the file can be restored, and an unreadable backup
discovered during an incident is the same as no backup. A dump missing a
required table fails loudly rather than being reported as a smaller success —
that case is almost always `DATABASE_URL` pointing somewhere unexpected.

Retention is every daily for 14 days, then one per week for eight weeks
(`COMPASS_BACKUP_KEEP_DAYS`). Corruption and bad merchandising changes are often
noticed late, so retention has to reach back further than the daily window.

Run it nightly, and **put the output somewhere that is not this host** —
`data/backups` is a staging area, not a backup:

```
0 3 * * *  cd /srv/compass && npm run backup && aws s3 sync data/backups s3://…
```

### Restoring

```bash
createdb compass_restore
DATABASE_URL=postgres://…/compass_restore npm run backup -- restore <file>
npm run reindex                 # rebuild the retrieval index from the catalogue
```

Restore refuses to run against a database that already has tables unless you
pass `--force`; it is the one irreversible operation here. It prints the row
count of every restored table, because a restore that "succeeded" into an empty
database is the failure mode worth catching early.

**Test this quarterly.** A restore procedure nobody has run is a hypothesis.

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
| `COMPASS_RATE_ADMIN` | `600` | Admin requests per minute. A console screen is several calls; 60 rate-limited ordinary use. |
| `COMPASS_SCHEDULE` | on | Set to `off` to run maintenance from your own orchestrator instead |
| `COMPASS_ROLLUP_HOUR_UTC` | `3` | Hour, UTC, at which the analytics rollup runs |
| `COMPASS_BACKUP_DIR` | `./data/backups` | Where `npm run backup` writes |
| `COMPASS_BACKUP_KEEP_DAYS` | `14` | Dailies kept in full; weeklies kept four times as long |
| `COMPASS_SEO_BASE_URL` | — | Storefront origin used in canonical URLs and the sitemap |
| `COMPASS_SEO_INDEXABLE_FACETS` | `material,finish,style,color` | Facets whose single-value pages stay indexable |
| `COMPASS_MAX_SEARCH_BODY_BYTES` | `32768` | Shopper endpoints; catalogue endpoints use the larger limit |
| `COMPASS_MAX_BODY_BYTES` | `67108864` | Ceiling for a catalogue push |
| `COMPASS_TRUST_PROXY` | `0` | Set to `1` only behind a proxy that sets `X-Forwarded-For`; otherwise clients can spoof their identity to the rate limiter |
| `COMPASS_CACHE_ENTRIES` | `2000` | Result cache size per instance |
| `COMPASS_CACHE_TTL_MS` | `60000` | Backstop only; correctness comes from invalidation |

Never set `COMPASS_DEV_OPEN=1` outside local development — it disables API-key
checks entirely.
