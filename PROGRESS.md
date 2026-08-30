# Progress

## Phase 1 — Core search MVP ✅ complete

Scope from the build order: ingestion (CSV + API), retrieval core with typo
tolerance and attribute weights, search and browse endpoints, a results-page
widget, and an event collector logging to Postgres.

### Delivered

| Area | What exists | Where |
|---|---|---|
| Retrieval | `SearchEngine` interface; Typesense engine (production); SQLite/FTS5 engine (dev + CI) | `packages/server/src/engine/` |
| Query analysis | Query router (part number / dimensional / natural language / keyword), dimension parser, unit + fraction normalisation, compound splitting, plural folding, typo budgets | `packages/server/src/query/` |
| Ranking | Five-criterion tie-breaking cascade, business composite applied within a relevance band, per-hit explanations | `packages/server/src/ranking/` |
| Grouping | Variant-level index collapsed to one card per parent, keeping the matching variant | `packages/server/src/ranking/group.ts` |
| Ingestion | NetSuite-aware field mapping, normalisation, variant rollup, data-quality report, zero-downtime index swap, sub-second partial price/inventory updates | `packages/server/src/ingest/` |
| API | `/search`, `/browse`, `/events`, `/catalog/batch`, `/catalog/updates`, `/catalog/status`, `/health`, `/v1/sites`; scoped search vs admin API keys | `packages/server/src/routes/` |
| Analytics | Buffered append-only event collector, Postgres schema incl. aggregate + audit tables | `packages/server/src/events/`, `src/db/` |
| Storefront SDK | Framework-agnostic client, results grid with facted sort/pagination, URL state, auto-instrumented click-position analytics, themable CSS | `packages/sdk/` |
| Demo | 520-product / ~2,160-variant messy millwork catalogue per site, seeder, demo storefront | `packages/demo/` |
| Tooling | `npm run query` (ranking explainer), `npm run bench` (NFR check), Docker Compose + Dockerfile | `packages/server/src/cli/`, root |

### Acceptance criteria — Phase 1 subset

| Criterion | Status | Evidence |
|---|---|---|
| "chandaleer" returns chandeliers | ✅ | `npm run query -- ekena chandaleer` → 84 products, typos=2 |
| A SKU query returns that exact product first, instantly | ✅ | `engine.test.ts` "a part number returns that exact product first" |
| "4x6 beam 12ft" parses dimensions, incl. `12'` / "12 foot" | ✅ | `dimensions.test.ts` (21 cases) |
| "black shutter" returns black shutters, not every sibling variant | ✅ | `engine.test.ts` "variant-level indexing with parent grouping" |
| Facet counts accurate, zero-count values never offered | ✅ | `engine.test.ts` "facet counts are parent counts and never zero" |
| Ranking explainability panel says why X outranks Y | ✅ (API + CLI) | `--explain` on `npm run query`; admin UI is Phase 3 |
| Deactivating a campaign changes results within seconds | ⏳ Phase 3 | — |
| Mobile full-screen filter modal | ⏳ Phase 2 | — |
| Dashboard zero-result row → one-click fix | ⏳ Phase 4 | — |
| Synonyms ("sofa" → couches) | ⏳ Phase 2 | — |
| Natural-language query with zero keyword overlap | ⏳ Phase 4 | needs the vector half |

### Measured

Tests: **81 passing**. Latency, 300 iterations, SQLite dev engine, 2,158 variant
documents, warm:

| Path | p50 | p95 | Target |
|---|---|---|---|
| search | 17.9ms | 35.3ms | < 100ms ✅ |
| search + facet filter | 11.8ms | 23.8ms | < 100ms ✅ |
| browse | 14.6ms | 16.7ms | < 120ms ✅ |
| browse, deep page | 37.1ms | 39.5ms | < 120ms ✅ |

Two performance bugs were found and fixed by this benchmark: a linear
vocabulary scan per query term (1752ms → 43ms) and a browse path that re-scanned
the index once per facet (7327ms → 18ms).

### Known gaps

1. **Scale is unproven.** The numbers above are 2,158 documents, not 2.3M. They
   demonstrate the pipeline has no accidental O(catalogue) work; they are not
   evidence at your catalogue size. Phase 5 load-tests properly.
2. **`TypesenseEngine` is untested against a live cluster.** No Docker daemon and
   the Typesense download host is blocked by this environment's proxy. The code
   is written to the documented API; the first task of any environment with
   Docker is `docker compose up` and re-running the engine test suite against it.
3. **No semantic retrieval yet.** `semanticWeight` is plumbed through and set to
   0. Natural-language queries currently fall back to keyword recall.
4. **No synonyms, redirects, rules, campaigns or analytics dashboard.** Phases 2–4.
5. **No admin console.** Phase 3. Configuration is `data/sites.json` plus the API.
6. **Autocomplete endpoint not built.** Phase 2.
7. **No result caching.** Phase 5, and it needs rule-aware invalidation, so it
   waits for the rules engine.
8. **Postgres aggregate tables are empty.** Events are written; rollups are Phase 4.

---

## Phase 2 — Discovery UX (proposed next)

1. **Autocomplete endpoint + widget** — multi-section dropdown (suggestions,
   products, categories, brands, redirects), < 50ms server-side, keyboard
   navigation, ARIA combobox, recent + trending searches, mobile full-screen
   takeover. Category suggestions route to the category page, not a search page.
2. **Faceted navigation UI** — desktop live-update sidebar, mobile full-screen
   modal with a sticky "Show N Results" button, removable filter chips, range
   slider with editable inputs, colour swatches, show-more truncation.
3. **Synonyms** — two-way, one-way and phrase, per site; applied at query time;
   admin CRUD endpoints.
4. **Redirects** — query pattern → URL, evaluated before retrieval.
5. **Zero-results rescue** — the cascade of §4.8: spell-correct and retry,
   relax the lowest-weight term, then popular products from the nearest
   category. The semantic-only step lands with Phase 4. Every rescue logged with
   the path taken.
6. **Sort options exposed** — already in the engine; needs the UI.

Estimated: the rescue cascade and synonyms are the highest-value items and the
cheapest, because retrieval and analysis are already in place.
