# Readiness gaps

An audit of what stands between this platform and running a real storefront.
Everything here was checked against the code and, where a claim is testable,
demonstrated — not assessed from the spec.

Severity is about consequence, not effort:

- **P0** — will produce visibly wrong results or lose money in normal use.
- **P1** — will cause an outage, a security incident, or block routine operation.
- **P2** — needed before calling it finished; survivable for a pilot.
- **P3** — planned scope not yet built.

Items marked ✅ were found by this audit and fixed in the same pass; they are
kept here because they document how the system was verified, and what to
re-check after any change to the retrieval path.

---

## P0 — correctness

### ✅ Pagination returned partial and duplicated pages

**Found:** browsing a category of 192 products returned **19 products on page 1**
and **nothing at all from page 2 onward**, while reporting 8 pages.

**Cause:** the candidate window was measured in variants but pages are measured
in products. On a catalogue averaging six variants per product a 120-variant
window collapsed to ~19 cards. Sizing the window by page then made the ordering
depend on which page was asked for, so 31 of 192 products appeared on two
different pages and others appeared on none.

**Fixed:** the window is now measured in parent products and is a fixed size
independent of the page, so ordering is a property of the query alone. Verified:
192 hits across 8 full pages, 192 distinct products, 0 duplicates. Regression
tests cover a deliberately variant-heavy catalogue.

**Watch:** any future change to the candidate window has to preserve *page
independence*, or duplicates come straight back.

### ✅ An explicit sort was discarded twice

Found once in Phase 2 (the cascade re-ranked after the engine had sorted) and
again after the pagination change (groups were ordered by their cheapest variant
but the *representative* variant within each group was arbitrary, so a
price-sorted grid showed unsorted prices). Both fixed and covered by tests.

### ✅ A custom-attribute filter did not filter the total or the facets

The facet pass lifts each group's own selection so multi-select stays usable.
Custom attribute selections were being lifted too but never reapplied, so the
result count and every catalogue facet ignored them. Fixed and tested.

### ✅ The demo only worked with authentication disabled

**Found:** the documented command — `npm run demo` — returned **401 on every
request**. The storefront and the console never carried an API key, so the one
path a reader is told to follow was the one path that was broken. It had only
ever been exercised with `COMPASS_DEV_OPEN=1` set by hand, which is also the
flag that skips the auth layer entirely.

**Fixed:** the storefront fetches its site's public search key from
`/demo/config.json` and sends it on every request; the console asks for an admin
key once and keeps it in `localStorage`. The server never serves an admin key.
Verified: both smoke suites now pass against a server with no dev flag set, and
the console's key gate is covered in both directions — no key asks, a pasted key
gets in and survives a reload.

### ✅ A "clean" build was silently a no-op

`rm -rf packages/*/dist && tsc -b` exited 0 without emitting anything, because
the `.tsbuildinfo` files still claimed the outputs were current. Every
verification that relied on it was weaker than it looked. Clean builds now use
`tsc -b --force`; the tree compiles clean from scratch.

---

## P1 — availability and security

### ✅ A config-database outage took search down

**Found:** with Postgres stopped, `/search` and `/autocomplete` returned **500**,
even though the retrieval index is entirely independent of that database.

**Fixed:** synonyms, redirects and collection metadata now degrade to their last
known value, or to empty, and log. Verified: with Postgres stopped, search
returns 29 hits for "black shutter", autocomplete and browse return 200, and
`/health` reports `degraded`.

### ✅ No rate limiting

A public search key ships inside the storefront bundle and is visible to anyone
who views source. There was nothing stopping a client from issuing unlimited
queries. Fixed: fixed-window limiter, separate budgets for search and admin,
`429` with `Retry-After`. In-process by design — the real defence belongs at the
edge, and this must not become a component that can itself fall over.

### ✅ Shopper endpoints accepted 64MB bodies

One body limit covered both search and catalogue push. Fixed: catalogue
endpoints keep the large limit, everything else is capped at 32KB and returns
`413`.

### ✅ Admin endpoints were reachable cross-origin

CORS reflected any origin for every route, admin included. Fixed: an admin
request carrying an `Origin` header is refused.

### ✅ No way to add or remove one product without a full reindex

A discontinued product stayed searchable until the next nightly refresh. Fixed:
`POST`/`DELETE /v1/{site}/catalog/records`. Verified: upsert 3ms, delete 39ms.

### ✅ No request schema validation

**Found:** `{"q": 123}` returned a **500** carrying an internal error message —
`(request.q ?? "").trim is not a function` — straight to the caller.
`{"hitsPerPage": 99999}` and `{"page": "abc"}` were accepted and did the work.

**Fixed:** a JSON Schema per route, compiled once. Every field that costs work is
bounded. Admin writes reject unknown properties so a typo fails rather than
saving a record missing that field; shopper endpoints stay permissive so an older
storefront bundle keeps working. Errors report every problem at once and name the
path. A 500 no longer leaks its message — that goes to the log.

### ✅ No admin roles

**Fixed:** four ordered roles — `search` < `analyst` < `merchandiser` < `admin`.
Each endpoint names the least role that may call it, so a guard is one
comparison. Verified live: a search key gets 403 on the reports; an analyst reads
the reports and catalogue health but 403s on synonyms; a merchandiser writes
merchandising but 403s on a catalogue push. The console asks `/whoami` and hides
what the role cannot use — an analyst sees no merchandising screens, no
one-click synonym fix and no rebuild button.

**Also found and fixed while doing it:** `generateKey` only distinguished admin
from search, so an analyst or merchandiser key was minted as `ck_search_…` — a
private key that reads as the one designed to be public.

### ✅ Secrets and backups are undocumented

**Fixed.** `npm run backup` dumps, then **reads the dump back** and checks every
table that cannot be recomputed from the catalogue — `pg_dump` exiting 0 is not
proof a file can be restored, and an unreadable backup found during an incident
is the same as no backup. Retention keeps every daily for 14 days then one a
week. `npm run backup -- restore` refuses to run over a populated database
without `--force` and prints the row count of every restored table.

Verified against a real database: dumped, restored into a fresh one, and checked
the counts (7,420 events, 8 collections, 8 badges). Also verified the two failure
modes — an unreadable dump, and one missing required tables.

`npm run keys -- rotate <id>` issues a replacement with the same site, role and
label, links the two so the chain is auditable, and leaves the old key live for a
grace period; `--now` revokes immediately. Keys now record last use, so an
operator can tell a live key from a forgotten one. The whole procedure is in
`docs/OPERATIONS.md`.

---

## P2 — completeness

| Gap | Why it matters |
|---|---|
| **`TypesenseEngine` has never run against a live cluster** | No Docker daemon here and the Typesense download host is proxy-blocked. It implements the same interface and is written to the documented API, but it is unverified. This remains the single largest unknown. |
| **Scale is unproven above ~100k documents** | Measured to 104,396 variants. Broad faceted search misses the p95 target there on the dev engine. Nothing has been run at 2.3M SKUs. |
| ~~**No OpenAPI spec**~~ ✅ | Generated from Fastify's own route table and validation schemas, served at `/openapi.json`, browsable at `/docs`, checked into `docs/openapi.json`. A route with no documentation and a documented route that no longer exists both fail the test suite, and CI fails if the checked-in copy is stale. |
| ~~**No SSR or SEO mode**~~ ✅ | Responses carry canonical, robots, title, description and a schema.org `ItemList`. Category and collection URLs are served as fully rendered HTML — verified with JavaScript disabled: 24 products, real anchors, working pagination — and the app takes the page over cleanly on load. `/v1/:site/sitemap.xml` lists landing pages only. |
| ~~**No accessibility audit**~~ ◐ | `npm run a11y` runs axe-core over 10 states of both surfaces in **both themes**, against WCAG 2.1 A and AA. It found real defects — the dark theme used one accent for both text and button backgrounds, and the query-match highlight was light-on-light — now fixed and clean. Automated rules catch roughly a third of real problems: a screen-reader pass is still owed. |
| ~~**Analytics aggregates are never computed**~~ ✅ | Fixed. `AnalyticsService.rollup` fills `daily_query_stats` and `daily_product_stats`, and the console dashboard reads them. Revenue is attributed across every query in a session that led to the purchase, not only the last. |
| ~~**No CI**~~ ✅ | `.github/workflows/ci.yml`: typecheck, unit tests and the spec drift check in one job; seed, both browser suites, the accessibility audit, the latency benchmark and a backup/restore round trip in another. |
| **`docs/OPERATIONS.md` did not exist** | Referenced by `docker-compose.yml`. Now written. |
| **Result cache is per instance** | Correct but unshared: N instances mean N cold caches and N copies. Fine to a handful of instances. |
| ~~**The analytics rollup is not scheduled**~~ ✅ | Runs in the API process, leased through the database so exactly one instance runs it however many are up. A failure releases the claim and retries; `/health` reports the last outcome per job. |
| **No index-rebuild scheduling** | The scheduler exists and takes jobs; the rebuild is not registered as one because it needs a NetSuite export drop to run against. |
| ~~**The console has no undo**~~ ✅ | A History screen showing who changed what, the fields that moved, and a one-click undo. Reverting is recorded as a new change with its sides reversed, so it is itself auditable and itself revertible. Required fixing the trail first: every write recorded the change but not the prior state. |

---

## P3 — planned scope not yet built

Phase 3 is delivered: the console, the visual drag-to-pin merchandiser,
scheduling, badges, the analytics dashboard and recommendations all exist.

What remains:

- **Query-triggered rules.** Everything binds to a *product set* today
  (collections, badges). Binding a consequence to a *query* — pin these three
  for "beams", swap the facet set, show a banner — is the missing half.
- **Semantic retrieval.** `semanticWeight` is plumbed and set to 0. The one
  open acceptance criterion depends on it.
- **Personalisation and A/B testing.**
- **A screen-reader pass** on top of the automated audit, and **load testing at
  full scale**.

---

## What was verified, and how

| Claim | How it was checked |
|---|---|
| Pagination is complete and stable | Paged through three query shapes end to end; counted distinct products |
| Search survives a config-store outage | Stopped Postgres, issued live requests |
| Rate limiting works | Set the limit to 5, issued 7 requests, observed 429 |
| Oversized bodies are refused | Posted a 40KB search body, observed 413 |
| Admin is not reachable cross-origin | Sent an `Origin` header to an admin route, observed 403 |
| Single-record upsert and delete | Added and removed a product, searched for it either side |
| Collections span categories | Browsed a collection, counted the distinct top-level categories on the page |
| Custom attributes filter and count | Applied two custom filters at once, checked the total and the facet counts |
| Variant-scoped labels | Browsed a finish-based collection; confirmed the dark variant is the one shown |
| The storefront works | 31 browser checks at desktop and mobile widths |
| The console works | 36 browser checks, including that every screen shows computed data rather than zeros, and that each role sees only what it can use |
| Both surfaces authenticate | Ran both suites against a server with no dev flag set; checked that the console asks for a key when it has none |
| Roles are enforced, not decorative | Issued one key per role and probed six endpoints with each; drove the console as each role and counted what it offers |
| Malformed requests are refused | Posted wrongly typed, oversized and misspelled bodies; checked the status and the message |
| The API description matches the API | Generated from the route table; drift in either direction fails the suite |
| Backups restore | Dumped, restored into a fresh database, counted the rows; checked an unreadable dump and one missing tables |
| The scheduler runs once, not once per instance | Three simulated instances ticking all day; counted the runs |
| Crawlable pages have content | Loaded a category page with JavaScript disabled |
| Both themes meet WCAG 2.1 AA | axe-core over 10 states in light and dark |
| The repository is a complete handoff | Cloned the pushed branch into an empty directory three times, on a fresh database each time: `npm ci`, build, tests, seed, run, every suite. It found two console checks that only passed on an install someone had already used |
| Dashboard numbers are computed, not fixtures | Traffic is generated against the live index; the rollup is re-run and the console read back |

Reproduce with `npm test`, `npm run ui-smoke`, `npm run ui-smoke:admin`,
`npm run a11y`, `npm run openapi -- --check` and `npm run bench` — or push, and
let CI do all of it.
