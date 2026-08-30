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

### No request schema validation

Endpoints read `request.body` with a TypeScript type, which is a compile-time
claim, not a runtime check. A malformed body produces a 500 rather than a 400.
Fastify supports JSON Schema per route; the schemas need writing. **Not fixed.**

### No admin roles

The spec calls for Admin, Merchandiser and Analyst. Today there are two API-key
scopes, `search` and `admin`, and any admin key can do anything. Fine while the
only admin surface is the API; blocking once a console exists. **Not fixed.**

### Secrets and backups are undocumented

No key-rotation procedure, and no nightly backup of the configuration and
analytics store — which is now the only home of every collection, custom
attribute, synonym and redirect. The retrieval index is rebuildable; this
database is not. **Not fixed.** Highest-priority item on this list.

---

## P2 — completeness

| Gap | Why it matters |
|---|---|
| **`TypesenseEngine` has never run against a live cluster** | No Docker daemon here and the Typesense download host is proxy-blocked. It implements the same interface and is written to the documented API, but it is unverified. This remains the single largest unknown. |
| **Scale is unproven above ~100k documents** | Measured to 104,396 variants. Broad faceted search misses the p95 target there on the dev engine. Nothing has been run at 2.3M SKUs. |
| **No OpenAPI spec** | §4.13 requires one, kept current. |
| **No SSR or SEO mode** | §4.11: canonical tags on filtered URLs, `noindex` on facet permutations, server-render or `<noscript>` fallback. Collection pages make this more urgent — they are landing pages. |
| **No accessibility audit** | The autocomplete implements the ARIA combobox pattern and the mobile filter modal manages focus, both verified in a browser. Neither has been through a screen reader or an axe pass. |
| **Analytics aggregates are never computed** | Events are written, including which rescue path fired. `daily_query_stats` and `daily_product_stats` stay empty, so there is no dashboard. |
| **No CI** | Tests and the UI smoke test run by hand. |
| **`docs/OPERATIONS.md` did not exist** | Referenced by `docker-compose.yml`. Now written. |
| **Result cache is per instance** | Correct but unshared: N instances mean N cold caches and N copies. Fine to a handful of instances. |
| **No index-rebuild scheduling** | `npm run reindex` exists; nothing runs it. Needs a cron and a NetSuite export drop. |

---

## P3 — planned scope not yet built

Phase 3 (merchandiser control): rules engine, visual drag-to-pin merchandiser,
campaigns with scheduling, banners, admin console.
Phase 4 (intelligence): semantic retrieval, analytics dashboard,
personalisation, recommendations, A/B testing.
Phase 5 (hardening): SEO/SSR, accessibility audit, load testing at full scale.

Collections and custom attributes — delivered in this pass — are the structural
half of Phase 3. The rules engine reuses the same selector language.

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
| The UI works | 24 browser checks at desktop and mobile widths |

Reproduce with `npm test`, `npm run ui-smoke`, and `npm run bench`.
