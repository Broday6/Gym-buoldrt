# Progress

## Phase 1 — Core search MVP ✅ complete
## Phase 1.5 — Performance refinement ✅ complete
## Phase 2 — Discovery UX ✅ complete
## Phase 2.5 — Collections, custom attributes, readiness audit ✅ complete
## Phase 3 — Merchandiser console, badges, analytics, recommendations ✅ complete

A full readiness audit is in **[GAPS.md](GAPS.md)** — what was found, what was
fixed, what remains, and how each claim was verified.

---

## What exists

| Area | What exists | Where |
|---|---|---|
| Retrieval | `SearchEngine` interface; Typesense engine (production); SQLite/FTS5 engine (dev + CI) with per-index FTS scoping, dictionary-encoded facets and a prepared-statement cache | `packages/server/src/engine/` |
| Query analysis | Router (part number / dimensional / natural language / keyword), dimension parser, unit + fraction normalisation, compound splitting, plural folding, typo budgets, spelling correction | `packages/server/src/query/` |
| Ranking | Five-criterion tie-breaking cascade, business composite within a relevance band, per-hit explanations, explicit-sort passthrough | `packages/server/src/ranking/` |
| Merchandising | Synonyms (two-way, one-way, phrase), redirects (exact / starts-with / contains / regex, prioritised), audit log on every change | `packages/server/src/merchandising/` |
| Structure | Cross-category collections (rule-based, hand-picked or both; nestable, schedulable) and merchandiser-defined custom attributes that filter and count like catalogue facets | `packages/server/src/merchandising/collections.ts`, `selector.ts`, `labels.ts` |
| Operations | Rate limiting, per-endpoint body limits, cross-origin lockdown on admin, readiness endpoint, `/metrics`, graceful degradation when Postgres is down, single-record upsert/delete | `packages/server/src/routes/guards.ts`, `docs/OPERATIONS.md` |
| Discovery | Autocomplete (suggestions, products, categories, brands, redirects, trending), zero-results rescue cascade, result cache | `packages/server/src/services/` |
| Badges | Merchandiser-authored, variant-scoped, scheduled, priority-ordered; capped at two per card | `packages/server/src/merchandising/labels.ts` |
| Recommendations | Similar, frequently-bought-together, recently-viewed, trending; every rail degrades to top sellers and says which served it | `packages/server/src/services/recommend.ts` |
| Analytics | Nightly rollup, 30-day overview, top and failing queries, facet usage, product performance, multi-touch query revenue attribution | `packages/server/src/services/analytics.ts` |
| Rule preview | Counts what a selector would catch before it is saved, exact under 5,000 products and explicit when it estimated | `packages/server/src/services/preview.ts` |
| Ingestion | NetSuite-aware field mapping, normalisation, variant rollup, data-quality report, zero-downtime swap, sub-second partial updates | `packages/server/src/ingest/` |
| API | search · browse · autocomplete · directory · events · synonyms · redirects · catalog batch/updates/status · health; scoped search vs admin keys | `packages/server/src/routes/` |
| Analytics | Buffered append-only event collector incl. rescue path and effective query; aggregate + audit schema | `packages/server/src/events/`, `src/db/` |
| Storefront SDK | Client, results grid, ARIA-combobox autocomplete with mobile takeover, faceted navigation with desktop/mobile split, themable CSS | `packages/sdk/` |
| Console | Dashboard, query tester with per-hit explainability, visual rule builder, collections, badges, vocabulary, change history with undo, catalog health — plain ES modules, no build step, served by the API process | `packages/admin/` |
| Roles | Four ordered roles enforced per endpoint and reflected in the console; role in the key prefix; rotation with a grace period | `packages/server/src/routes/auth.ts` |
| Validation | JSON Schema per route: bounded sizes, strict admin writes, permissive shopper endpoints, every problem reported at once | `packages/server/src/routes/schemas.ts` |
| API description | OpenAPI 3.1 generated from the route table, served at `/openapi.json`, browsable at `/docs`, drift-tested | `packages/server/src/routes/openapi.ts` |
| SEO | Canonical/robots/title/description and schema.org `ItemList` per page, sitemap of landing pages, server-rendered category and collection pages | `packages/server/src/services/seo.ts` |
| History | Every merchandising change with its prior state, a field-level diff, and an undo recorded as a new change | `packages/server/src/services/history.ts` |
| Maintenance | Scheduled rollup leased through the database; backup, verify and restore with row counts | `packages/server/src/services/scheduler.ts`, `cli/backup.ts` |
| Demo | 520-product messy catalogue per site, placeholder imagery, full storefront, 30 days of simulated traffic generated against the live index | `packages/demo/` |
| Tooling | `query`, `bench`, `keys` (list/create/rotate/revoke/roles), `backup`, `openapi`, `reindex`, `ui-smoke`, `ui-smoke:admin`, `a11y` | `packages/server/src/cli/`, `packages/demo/`, `packages/admin/` |
| CI | Typecheck, tests and spec drift; then seed, both browser suites, the accessibility audit, the benchmark and a backup/restore round trip | `.github/workflows/ci.yml` |

**221 unit tests + 31 storefront browser checks + 36 console browser checks + 20 accessibility audits, all passing.**

---

## Acceptance criteria

| Criterion | Status | Evidence |
|---|---|---|
| "chandaleer" returns chandeliers | ✅ | typo tolerance, 2 edits |
| "sofa" returns couches via synonym | ✅ | `discovery.test.ts`; live: `louver` → 65 shutters |
| A SKU query returns that exact product first, instantly | ✅ | `engine.test.ts` |
| "4x6 beam 12ft" parses dimensions incl. `12'` / "12 foot" | ✅ | `dimensions.test.ts`, 21 cases |
| "black shutter" returns black shutters, not every sibling variant | ✅ | `engine.test.ts`; finish facet returns only `Black` |
| Facet counts accurate; no facet click can dead-end | ✅ | zero-count values never emitted; `ui-smoke` |
| Mobile filters use a full-screen modal + "Show N Results" | ✅ | `ui-smoke`: staged, previewed, applied |
| Ranking explainability says why X outranks Y | ✅ | `--explain`; the console's query tester shows the cascade per hit |
| Zero-results never dead-end, and the shopper is told | ✅ | rescue cascade; `ui-smoke` |
| A natural-language query with zero keyword overlap | ⏳ Phase 4 | needs the vector half |
| Pin 3 products for "beams", schedule for next weekend | ◐ | hand-picking, scheduling and drag-to-reorder are built; query-triggered campaigns are not |
| Deactivating a campaign changes results within seconds | ✅ | disabling a collection or badge invalidates the result cache on write |
| Dashboard zero-result row → one-click fix | ✅ | failing-query rows carry an inline "add synonym" action |
| A merchandiser-defined structure spanning categories | ✅ | `collections.test.ts`; live: "Dark Finishes" spans Beams, Shutters and Lighting |
| A merchandiser-invented filter applied across categories | ✅ | "Room" and "Budget" facets, authored outside the feed |
| Paging through a result set returns every product once | ✅ | verified across category, collection and sorted queries |

---

## Measured latency

Benchmarked with `npm run bench`, which reports **uncached** (the retrieval path
itself) and **cached** (what a shopper on a popular query actually waits for)
separately — reporting only one would misrepresent the system in one direction
or the other.

**Demo catalogue — 520 products / 2,158 variant documents**

| Path | p50 | p95 | Target | |
|---|---|---|---|---|
| search | 9.9ms | 39.4ms | < 100ms | ✅ |
| search + facet filter | 16.0ms | 43.4ms | < 100ms | ✅ |
| browse | 7.6ms | 10.8ms | < 120ms | ✅ |
| browse, deep page | 48.8ms | 54.5ms | < 120ms | ✅ |
| search, cached | 0ms | 0.01ms | < 100ms | ✅ |
| browse, cached | 0.01ms | 0.01ms | < 120ms | ✅ |

96% cache hit rate on the benchmark's repeated traffic.

Latency rose from the 8.6ms p95 measured in Phase 2, and the cause is worth
stating plainly: **correct pagination costs something.** Every query now ranks a
fixed window of products regardless of which page was asked for, because a
window that grew with the page produced duplicate and missing products. The
window size is the single knob trading latency against pagination depth:

| `COMPASS_RANKING_WINDOW` | search p95 | Pages of 24 |
|---|---|---|
| 120 | 28ms | 5 |
| **240 (default)** | **38ms** | **10** |
| 500 | 76ms | 20 |

**Stress catalogue — 25,000 products / 104,396 variant documents, SQLite dev engine**

Broad faceted search misses the p95 target at this size on the development
engine; browse passes. See GAPS.md — this is the boundary the two-engine design
exists for, and verifying §7 at 2.3M SKUs remains a Typesense task.

### What the refinement changed

Each of these was found by measuring, not by guessing, and each is documented in
DECISIONS.md:

| Fix | Effect |
|---|---|
| Facet counts tallied in one pass over dictionary-encoded integer columns instead of one `COUNT(DISTINCT)` per group | 814ms → ~65ms of a faceted query at 104k docs |
| `CROSS JOIN` to stop SQLite leading with the 104k-row document table | 5–10x on every candidate and facet query |
| Sort the candidate table before touching documents | top-N fetch 27.7ms → 0.9ms |
| Full-text match scoped to one index inside FTS | halves the match set on a two-site deployment |
| Prepared-statement cache | removes per-query SQL recompilation |
| Bigram-filtered term expansion, replacing a linear vocabulary scan | 1752ms → 43ms (found in Phase 1) |
| Browse materialises its candidate set like search does | 7327ms → 18ms (found in Phase 1) |
| Rescue probes without facets; fallbacks route through the cache | zero-result p95 792ms → 460ms |
| Result cache with event-based invalidation | 94% hit rate on repeated traffic; ~0ms |

### Bugs found and fixed by the readiness audit

- **Pagination was returning partial and duplicated pages.** A category of 192
  products gave 19 results on page 1 and nothing from page 2 on. The candidate
  window was measured in variants while pages are measured in products. Fixed,
  and the window is now page-independent so ordering is stable.
- **A custom-attribute filter did not filter the total or the catalogue facets.**
- **A config-store outage took search down** — 500s with Postgres stopped, even
  though the retrieval index does not depend on it.
- **No rate limiting, one 64MB body limit for every endpoint, and admin routes
  reachable cross-origin.**
- **No way to add or remove a single product without a full reindex.**

### Bugs found and fixed earlier

- **An explicit sort was silently discarded.** The relevance cascade re-ranked
  the candidate window after the engine had already ordered it by price, so
  "Price: Low to High" returned an arbitrary order. Found by the browser smoke
  test, not by the unit tests — the Phase 1 sort test used a two-product fixture
  where the coincidental order passed. Both are fixed.
- **Autocomplete rendered transparent.** The CSS tokens were scoped to
  `.compass-root`, but the dropdown mounts beside the storefront's own search
  box, which is in the site header, outside that subtree.
- **`$0.00` shown for products with no price.** A missing price is a catalogue
  defect, not a free product; it now reads "Price unavailable".
- **Index names could collide** when two rebuilds landed in the same millisecond
  (Phase 1).

---

## Known gaps

1. **Scale is proven to 104k variant documents on the dev engine, not to 2.3M.**
   See the table above. Typesense is the answer and is untested here.
2. **`TypesenseEngine` has never run against a live cluster.** No Docker daemon,
   and the Typesense download host is blocked by this environment's proxy. It is
   written to the documented API and implements the same interface, which the
   whole layered design depends on. First task in any environment with Docker:
   `docker compose up`, then re-run the engine suite against it.
3. **No semantic retrieval.** `semanticWeight` is plumbed and set to 0.
4. **No query-triggered rules engine.** Collections, badges, hand-picking,
   drag-to-reorder and scheduling are built and share one selector language.
   What is missing is the trigger half: "when the query is *beams*, pin these
   three" — boosts, buries, banners and query rewrites bound to a query rather
   than to a product set.
5. **No A/B testing.**
6. **Facet swatch colours are inferred from finish names.** A real deployment
   should map finishes to hex values in the console.
7. **Recommendations are co-occurrence and popularity only.** No embeddings, so
   "similar products" means *bought or viewed alongside*, not *looks like*.
8. **Roles are coarse.** Four ordered roles, not per-resource permissions: there
   is no way to express "can edit synonyms but not collections".
9. **The accessibility audit is automated only.** Clean against WCAG 2.1 A/AA in
   both themes, but automated rules catch roughly a third of real problems. A
   screen-reader pass is still owed.

---

## What Phase 3 delivered

| | |
|---|---|
| **Merchandiser console** | Six screens — dashboard, query tester, collections, badges, vocabulary, catalog health. No screen requires raw JSON, and no admin action exists only as an API call. |
| **Visual rule builder** | Pick a field, a comparator and a value; the match count updates as you type and the matching products are shown. The same selector language backs collections and badges. |
| **Badges** | Variant-scoped, scheduled, priority-ordered, capped at two per card. "Only 3 left" lands on the variant that is nearly out, not on the product. |
| **Analytics** | Nightly rollup and a 30-day overview: volume, zero-result rate, click-through, average click position, top and failing queries, facet usage, product performance, and multi-touch query→revenue attribution. |
| **Zero-result workflow** | A failing query on the dashboard carries an inline "add synonym" action, so the report is a place to fix things rather than a place to read about them. |
| **Recommendations** | Four kinds, each degrading to top sellers rather than vanishing, and each reporting which strategy actually served it. |
| **Simulated traffic** | 30 days of shopper sessions generated against the live index, head-heavy and position-decayed, so the dashboard shows computed numbers rather than fixtures. |
| **Real authentication on both surfaces** | The storefront carries a public search key; the console asks for an admin key once. Neither runs with auth disabled. |
| **Roles, validation, SEO, history and CI** | Delivered in the hardening pass that followed; see GAPS.md for what each one fixed and how it was checked. |

---

## Phase 4 — proposed next

1. **Query-triggered rules** — trigger (query match / category / filter state /
   site), optional conditions (date window, segment, device, inventory),
   stackable consequences (pin, boost, bury, hide, hidden filter, facet swap,
   banner, redirect, query rewrite). The selector language, the cache
   invalidation hook, the audit log and the `rulesApplied` field on every
   response were all built for this.
2. **Semantic retrieval** — `semanticWeight` is plumbed and set to 0. This is
   what the last open acceptance criterion needs: a natural-language query with
   zero keyword overlap.
3. **A/B testing** — two ranking configurations, traffic split, measured on the
   attribution that is already computed.
4. **Personalisation** — the event stream and the shopper/session identifiers
   are already recorded; nothing reads them per shopper yet.
5. **Scale** — `TypesenseEngine` against a live cluster, and load testing at
   2.3M SKUs. Still the largest unknown.
