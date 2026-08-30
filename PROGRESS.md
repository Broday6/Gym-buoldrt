# Progress

## Phase 1 — Core search MVP ✅ complete
## Phase 1.5 — Performance refinement ✅ complete
## Phase 2 — Discovery UX ✅ complete
## Phase 2.5 — Collections, custom attributes, readiness audit ✅ complete

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
| Ingestion | NetSuite-aware field mapping, normalisation, variant rollup, data-quality report, zero-downtime swap, sub-second partial updates | `packages/server/src/ingest/` |
| API | search · browse · autocomplete · directory · events · synonyms · redirects · catalog batch/updates/status · health; scoped search vs admin keys | `packages/server/src/routes/` |
| Analytics | Buffered append-only event collector incl. rescue path and effective query; aggregate + audit schema | `packages/server/src/events/`, `src/db/` |
| Storefront SDK | Client, results grid, ARIA-combobox autocomplete with mobile takeover, faceted navigation with desktop/mobile split, themable CSS | `packages/sdk/` |
| Demo | 520-product messy catalogue per site, placeholder product imagery, full storefront page | `packages/demo/` |
| Tooling | `query` (ranking explainer), `bench` (cold + cached latency), `keys`, `reindex`, `ui-smoke` (24 browser checks) | `packages/server/src/cli/`, `packages/demo/` |

**142 unit tests + 24 browser checks, all passing.**

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
| Ranking explainability says why X outranks Y | ✅ (API + CLI) | `--explain`; admin UI is Phase 3 |
| Zero-results never dead-end, and the shopper is told | ✅ | rescue cascade; `ui-smoke` |
| A natural-language query with zero keyword overlap | ⏳ Phase 4 | needs the vector half |
| Pin 3 products for "beams", schedule for next weekend | ⏳ Phase 3 | rules engine |
| Deactivating a campaign changes results within seconds | ⏳ Phase 3 | cache invalidation hook already in place |
| Dashboard zero-result row → one-click fix | ⏳ Phase 4 | events already record the rescue path |
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
| search | 9.3ms | 38.0ms | < 100ms | ✅ |
| search + facet filter | 15.5ms | 84.2ms | < 100ms | ✅ |
| browse | 7.0ms | 10.4ms | < 120ms | ✅ |
| browse, deep page | 50.3ms | 58.4ms | < 120ms | ✅ |
| search, cached | 0ms | 0.01ms | < 100ms | ✅ |

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
4. **No rules, campaigns, pinning or banners.** Phase 3.
5. **No admin console.** Phase 3. Synonyms and redirects are API-only today.
6. **No analytics dashboard.** Phase 4. Events, including the rescue path taken,
   are being recorded now.
7. **No A/B testing.** Phase 4.
8. **Facet swatch colours are inferred from finish names.** A real deployment
   should map finishes to hex values in the admin console.

---

## Phase 3 — Merchandiser control (proposed next)

Collections and custom attributes are the structural half of this phase and are
now delivered; the rules engine reuses the same selector language.


1. **Rules engine** — trigger (query match / category / filter state / site),
   optional conditions (date window, segment, device, inventory), stackable
   consequences (pin, boost, bury, hide, hidden filter, facet swap, banner,
   redirect, query rewrite). Evaluated at query time, cached with the
   invalidation hook that already exists.
2. **Visual merchandiser** — type a query or pick a category, see the live grid,
   drag to pin, click to hide/boost/bury, save as a rule. Raw JSON editor
   available but never the only path.
3. **Campaigns** — named bundles with start/end datetimes, preview before live,
   one-click activate, automatic expiry, calendar view.
4. **Category page control** — banner slot, SEO text, default sort, facet set,
   products per page.
5. **Versioning and rollback** — every rule change already writes to
   `audit_log`; this adds the diff view and one-click revert.
6. **Admin console** — the React SPA these screens live in, with the persistent
   "test a query" panel and the explainability toggle wired to `explain: true`.

The cache invalidation hook, the audit log, the explainability payload and the
`rulesApplied` field on every response were all built in Phases 1–2 specifically
so Phase 3 is additive rather than a refactor.
