# Compass Search

Self-hosted e-commerce site search, merchandising and product discovery — a
functional replacement for Algolia and Searchspring, owned end to end.

Multi-tenant from the ground up: one deployment serves every brand, and every
index, rule, synonym set and analytics view is scoped to a site.

> **Status: shopper storefront and merchandiser console both operational.**
> See [PROGRESS.md](PROGRESS.md) for what is delivered and measured, and
> [GAPS.md](GAPS.md) for an audit of what still stands between this and running
> a real storefront.

## Run it

Two prerequisites: **Node 22 or newer** and a **PostgreSQL** you can reach.
Then, from the repository:

```bash
npm install
npm run app
```

That is the whole thing: it finds a database (creating one, or starting the
Postgres container from `docker-compose.yml` if Docker is running), applies the
schema, generates and indexes a catalogue if the database is empty, starts the
API, and prints the URLs and the admin key the console will ask for.

No Postgres anywhere? `npm run app` says so and gives you the one line to fix
it on your platform, rather than failing with a connection error. Have one
somewhere else? `DATABASE_URL=postgres://… npm run app`.

Re-running it reuses what is there. `npm run app -- --reseed` starts the demo
data over.

### On Windows

Neither Node nor Postgres ships with Windows, and Windows PowerShell does not
accept `&&` as a separator — use `;`, or one command per line:

```powershell
winget install OpenJS.NodeJS.LTS
winget install PostgreSQL.PostgreSQL.16

# reopen PowerShell so the new PATH takes effect, then:
cd $HOME\Gym-buoldrt
git checkout claude/ecommerce-search-platform-59qlo2
npm install
npm run app
```

If `npm` reports that **running scripts is disabled on this system**, that is
PowerShell's execution policy refusing `npm.ps1`. Either use the batch shim,
which the policy does not cover — `npm.cmd install`, `npm.cmd run app` — or
allow local scripts once, which needs no administrator:

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

Nothing else is needed — not `psql`, not a database created by hand. The
Postgres installer asks you to set a superuser password; if it was not
`postgres`, `npm run app` notices that Postgres is running but will not let it
in, asks for the password once, and remembers it in `data/db-url.txt`.

| | |
|---|---|
| **Storefront** | http://localhost:3100/demo/ — instant search, facets, collections, badges, recommendation rails |
| **Console** | http://localhost:3100/admin/ — analytics, query tester with ranking explainability, visual rule builder, change history with undo |
| **API reference** | http://localhost:3100/docs — generated from the running server's routes |

The seed generates a month of simulated shopper sessions *against the index it
just built*, so every number on the dashboard is computed from events the system
actually recorded rather than from fixtures.

Both surfaces authenticate like a real deployment. The storefront picks up its
public **search key** automatically — that key is meant to be visible and ships
inside every storefront bundle. The console asks for an **admin key** the first
time you open it; the seed prints one per site:

```
  ekena       admin key: ck_admin_…
  archdepot   admin key: ck_admin_…
```

`npm run app` prints one for you. Paste it once and it is remembered in that
browser. The seed also issues an
`analyst` and a `merchandiser` key per site — open the console with one of those
(they are in `data/demo/keys.json`) and the screens and buttons change with the
role. `npm run keys -- roles` explains what each one can do.

### Hosted, with no install

`npm run build:browser` bakes the storefront into one self-contained HTML file:
the demo catalogue, plus a browser bundle of the real search pipeline running
against a third implementation of the engine interface, `MemoryEngine`. Query
analysis, the ranking cascade, dimension parsing, grouping by parent, facets,
collections, badges and the rescue path are the same modules the server runs —
a differential test indexes one catalogue into both engines and asserts they
return the same products, the same counts and the same top result.

The page is a shop, not a harness: a store header, departments, collections,
filters and a grid, with a fictional storefront's name on it and a footer that
says plainly that every listing is generated. Where the engine does something
a shopper would not expect — reading "volterra beams" as a brand and a product
type, correcting a misspelling — the page says so above the grid, and offers a
way back to the literal words.

What genuinely needs a server is absent rather than faked: ingest, the
merchandiser console, analytics and recommendations.

## Quick start

Needs **Node 22+** (the dev engine uses the built-in `node:sqlite`) and a
**PostgreSQL 16**. Nothing else.

```bash
git clone <this repo>
cd compass-search
npm install
npm run app                     # http://localhost:3100
```

The steps `npm run app` takes for you, if you would rather take them yourself:

```bash
docker compose up -d postgres   # or install Postgres however you like
export DATABASE_URL=postgres://compass:compass@localhost:5432/compass

npm run migrate                 # apply the schema
npm run seed                    # a messy 520-product catalogue per site, indexed
npm run dev                     # the API, with reload
```

`docker compose up` also runs the API itself in a container. Typesense is
behind a `--profile typesense` flag: it is the one component here that has
never been run against a live cluster, so `up` does not quietly make it the
retrieval core.

Then open **http://localhost:3100/demo/** and try `chandaleer`, `black shutter`,
`4x6 beam 12ft`, `crownmoulding`.

Nothing under `data/` is committed — the catalogues, the retrieval index, the
demo API keys and the backups are all generated. `npm run seed` rebuilds the lot
on a new machine, and prints fresh keys.

```bash
npm test                # 222 tests: ranking, dimensions, ingestion, discovery, merchandising, roles, history
npm run bench           # latency, reported uncached and cached
npm run query -- ekena "black shutter" --explain    # why each hit ranks where it does
npm run keys -- roles                               # what each role can do
npm run keys -- create ekena merchandiser "merch team"
npm run reindex -- ekena ./catalog.csv              # full rebuild, atomic swap
npm run backup                                      # dump, verify, prune
```

The browser suites need a Chromium once per machine:

```bash
npx playwright install chromium

npm run ui-smoke        # 34 storefront checks, desktop and phone
npm run ui-smoke:admin  # 49 console checks, including every role and phone width
npm run a11y            # axe-core over both surfaces, light and dark

npm run build:browser   # then:
npm run browser-smoke   # 32 checks against the single-file demo, over file://
```

`browser-smoke` is the only suite that needs neither a database nor a server —
it drives the built file the way anyone with the link will open it, and carries
its own axe-core pass in both themes.

All of it runs in CI on every push — see `.github/workflows/ci.yml`.

## How it works

```
                  ┌──────────────┐
   catalogue ───► │  Ingestion   │  field mapping → normalise → variant docs
  (CSV / API /    └──────┬───────┘  → new index → atomic alias swap
   webhook)              │
                         ▼
                  ┌──────────────┐
                  │  Retrieval   │  Typesense (prod) │ SQLite FTS5 (dev)
                  └──────┬───────┘  recall · filters · facet counts
                         │  bounded candidate window
                         ▼
   query ──► analyse ──► cascade re-rank ──► business rank ──► group by parent ──► response
             │                                                      │
             │ part number / dimensions / natural language           │ one card per product,
             │ synonyms · compounds · plurals · typo budget          │ showing the variant that matched
             ▼                                                      ▼
        ┌─────────────┐                                      ┌─────────────┐
        │   Events    │ ──► Postgres (append-only) ──► aggregates ──► dashboard
        └─────────────┘
```

### The shopper-facing UX

**Autocomplete** fires on every keystroke and returns query suggestions (ranked
by real search volume), products with thumbnails, categories, brands and
redirects. It implements the ARIA combobox pattern properly — the input keeps
focus, the active option is pointed at by `aria-activedescendant` — because a
search box that traps a keyboard user is worse than no autocomplete at all. On
narrow screens it becomes a full-screen takeover.

**Faceted navigation** is one widget with two deliberate behaviours. On desktop
a tick updates the grid immediately, because the grid is right there. On mobile
the filters take over the screen, selections are staged, and a sticky
**"Show N Results"** button applies them — live-updating a grid the shopper
cannot see is disorienting, and the count is what tells them whether the filter
was a good idea before they commit. Zero-count values are never offered, so a
facet click can never dead-end.

**Collections and custom attributes** let a merchandiser build structure the
catalogue does not have. A category says what a product *is*; a collection says
what it is *for* — "Farmhouse Kitchen", "Contractor Value" — and routinely spans
categories with nothing else in common. Membership is a rule, a hand-picked
list, or both, and a custom attribute ("Room", "Budget") becomes a facet that
filters and counts exactly like a catalogue field. Both are authored outside the
feed, so a nightly refresh cannot erase them. ([D19–D21](DECISIONS.md))

**Nothing ever returns an empty page.** On zero results the engine spell-corrects,
then relaxes the least informative term, then falls back to the nearest matching
category, then to best sellers — and always tells the shopper which happened,
with a link back to their literal query.

### Two design choices carry most of the weight

**Variant-level indexing with parent grouping.** One document per buyable SKU.
A search for `black shutter` matches only the black rows; grouping then collapses
them into one product card whose image, price and title are the black variant's.
A parent-level index cannot do this — it would match the parent as a whole and
show whichever variant happened to be first. ([D2](DECISIONS.md))

**Ranking is a cascade, not a blended score.** Typos, then words matched, then
attribute weight, then proximity, then exactness — each criterion decides only
when everything above it ties. Business signals (margin, velocity, inventory,
recency, reviews) order results *within* a band of textually-equivalent hits, so
a high-margin near-miss can never outrank an exact title match. That is what
makes the "why does X outrank Y" panel able to give a true answer. ([D4](DECISIONS.md))

## Repository layout

```
packages/
  shared/   TypeScript contracts shared by the server, SDK and admin console
  server/   API, retrieval engines, query analysis, ranking, ingestion, events
    src/engine/    SearchEngine interface + Typesense and SQLite implementations
    src/query/     query router, dimension parser, normalisation
    src/ranking/   tie-breaking cascade, business ranking, parent grouping
    src/ingest/    field mapping, normalisation, data-quality report, pipeline
    src/routes/    HTTP API and scoped API-key auth
    test/          ranking, dimensions, ingestion and end-to-end suites
    src/merchandising/  synonyms, redirects, collections, custom attributes, selectors
    src/services/       search pipeline, autocomplete, result cache
  sdk/      storefront client, results grid, autocomplete, facets, recommendations, theme CSS
  admin/    merchandiser console — plain ES modules, no build step
  demo/     catalogue generator, traffic simulator, seeder, storefront page, UI smoke test
```

## API

JSON in and out, scoped by site. The full description is generated from the
running server and served at `/docs`, or as OpenAPI 3.1 at `/openapi.json` —
`docs/openapi.json` is the checked-in copy, and CI fails if it drifts.

Every endpoint names the least role that may call it.

| Endpoint | Role | Purpose |
|---|---|---|
| `/v1/{site}/search` | search | Full search. Query analysis, ranking, facets, rescue. |
| `/v1/{site}/browse` | search | Category and collection browse through the same pipeline. |
| `/v1/{site}/autocomplete` | search | Multi-section suggestions. Sub-50ms. |
| `/v1/{site}/directory` | search | Categories, brands and collections, for nav. |
| `/v1/{site}/collections` | search | Collections a shopper may browse right now. |
| `/v1/{site}/recommend` | search | Similar, bought-together, recently-viewed, trending. |
| `/v1/{site}/events` | search | Behavioural events, batched (max 100 per call). |
| `/v1/{site}/sitemap.xml` | search | Landing pages worth ranking. |
| `/v1/{site}/whoami` | search | What this key may do. |
| `/v1/{site}/analytics/*` | analyst | Overview, top and failing queries, trends, facet usage. |
| `/v1/{site}/history` | analyst | Who changed what, when, and what it was before. |
| `/v1/{site}/catalog/status` | analyst | Recent ingest runs and data-quality reports. |
| `/v1/{site}/synonyms` | merchandiser | Two-way, one-way and phrase synonyms. |
| `/v1/{site}/redirects` | merchandiser | Query patterns that navigate instead of searching. |
| `/v1/{site}/admin/collections` | merchandiser | Cross-category collections: rules, membership, scheduling. |
| `/v1/{site}/admin/attributes` | merchandiser | Merchandiser-defined facets and their values. |
| `/v1/{site}/admin/badges` | merchandiser | Rule-driven product badges. |
| `/v1/{site}/admin/collections/preview` | merchandiser | Count what a rule would catch, before saving. |
| `/v1/{site}/history/{id}/revert` | merchandiser | Undo one change; recorded as a change of its own. |
| `/v1/{site}/catalog/batch` | admin | Full ingest from `rows[]` or `csv`. Builds and swaps an index. |
| `/v1/{site}/catalog/records` | admin | Upsert or delete individual products, no reindex. |
| `/v1/{site}/catalog/updates` | admin | Price/inventory deltas against the live index. |
| `/v1/sites`, `/health`, `/metrics`, `/openapi.json` | — | No key required. |

### Roles

Authenticate with `x-compass-key`. Roles are ordered, and each one includes the
last — so a guard is one comparison, and a key's prefix says what it can do
without a lookup.

| Prefix | Can | Safe in a browser |
|---|---|---|
| `ck_search_…` | Read search endpoints, post shopper events | **Yes** — designed to ship in a storefront bundle |
| `ck_analyst_…` | The above, plus reports, history and catalogue health. Read-only | No |
| `ck_merchandiser_…` | The above, plus collections, badges, attributes, synonyms, redirects | No |
| `ck_admin_…` | Everything, including catalogue pushes and reindexing | No |

Issue the narrowest role that does the job:

```bash
npm run keys -- roles
npm run keys -- create ekena merchandiser "merch team"
npm run keys -- rotate 7        # replacement now, old key live until you revoke it
```

```bash
curl -XPOST localhost:3100/v1/ekena/search \
  -H 'content-type: application/json' \
  -H 'x-compass-key: ck_search_…' \
  -d '{"q":"black shutter","filters":{"material":["PVC"]},"hitsPerPage":24}'
```

Every request body is validated against a schema before it reaches a handler, so
a malformed request is a `400` naming each problem rather than a `500`.

### SEO

Pass `"seo": true` on a search or browse call and the response carries
`canonical`, `robots`, `title`, `description` and a schema.org `ItemList`. A
faceted catalogue generates a combinatorial number of URLs that are the same
products in a different order; the rules keep a crawler on the pages worth
ranking:

- internal search results are never indexed;
- a category or collection with no filters is the canonical page;
- **one** value from an allow-listed facet stays indexable on its own URL;
- anything more canonicalises to the clean page as `noindex, follow`;
- sort never appears in a canonical URL, and page 2+ is self-canonical.

Category and collection URLs are also served as fully rendered HTML, so a
crawler — or a shopper with JavaScript disabled — gets real content. Set
`COMPASS_SEO_BASE_URL` to your storefront's origin.

## Storefront install

One script tag against any storefront template, Miva included:

```html
<link rel="stylesheet" href="https://search.example.com/sdk/styles.css">
<div id="search-results" class="compass-root"></div>

<script type="module">
  import { init } from 'https://search.example.com/sdk/index.js';
  init({
    site: 'ekena',
    baseUrl: 'https://search.example.com',
    apiKey: 'ck_search_…',
    searchInput: '#storefront-search-box',  // autocomplete attaches here
    results: '#search-results',             // grid, sort, pagination
    facets: '#search-facets',               // sidebar on desktop, modal on mobile
    productUrl: (hit) => `/products/${hit.parentId}`,
    categoryUrl: (c) => `/categories/${c.id}`,
    onAddToCart: (sku) => myStore.addToCart(sku),
  });
</script>
```

Every widget is also independently constructible (`AutocompleteWidget`,
`ResultsWidget`, `FacetsWidget`) if you want a different arrangement. Every DOM
template is overridable via `templates`, all colour and spacing comes from CSS
variables, and the JSON API is available directly for storefronts that render
their own markup. Clicks are instrumented with their result position, so
CTR-by-position analysis works without extra wiring.

## Catalogue ingestion

The field mapper already understands NetSuite saved-search headings
(`Item Name/Number`, `Base Price`, `Custom Item Field: Finish`, …) and generic
feed headings, so an unmapped export ingests as-is; anything it guesses wrong is
overridable per column.

Every ingest returns a data-quality report — missing images, thin descriptions,
uncategorised products, duplicate SKUs, missing prices, and each rejected row
with its line number. Bad rows are reported, never silently dropped.

## Configuration

| Variable | Default | Notes |
|---|---|---|
| `DATABASE_URL` | — | Required. Config + analytics store. |
| `TYPESENSE_HOST` | unset | When unset, the SQLite/FTS5 dev engine is used. |
| `TYPESENSE_API_KEY` | — | Required when Typesense is configured. |
| `PORT` | `3100` | |
| `COMPASS_DEV_OPEN` | `0` | Disables API-key checks. Local development only. |
| `COMPASS_CACHE_ENTRIES` | `2000` | Result cache size. |
| `COMPASS_CACHE_TTL_MS` | `60000` | Cache TTL backstop; correctness comes from invalidation. |

Per-site search configuration (attribute weights, typo thresholds, business
weights, facet layout, default sort) lives in `data/sites.json` and is served
from the `SiteRegistry`; the Phase 3 admin console edits it.
