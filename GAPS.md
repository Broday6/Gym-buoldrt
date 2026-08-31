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

### ✅ The result cache would have served one shopper's experiment arm to everyone

**Found:** with an experiment running, all fourteen test sessions saw the
treatment. Assignment worked; the cache did not know about it. The key
deliberately excludes shopper identity — otherwise it degenerates into one
entry per visitor — and an experiment arm is shopper-specific state that had
been assigned deep in the pipeline, well after the cache had already answered.

This is the worst shape a bug in an experiment can take: the split exists, both
arms report numbers, and one of them was never shown to anybody. Nothing looks
broken.

**Fixed:** assignment moved to the top of the request, before the cache is
consulted, and the arm is part of the key. That costs one extra entry per query
per running experiment — not one per visitor, which is the thing the exclusion
was protecting.

**Watch:** anything else that varies a response by shopper has to go in the key
or after the cache, never in between. Personalisation takes the second route
for the same reason.

### ✅ Most of the catalogue never made it into the index

**Found:** `inferMapping` kept a source column only if its heading matched a
list of sixteen words or carried NetSuite's custom-field prefix. Everything
else was dropped silently. A ninety-column export arrives as six, and nobody
discovers the omission until a shopper searches for something that was in the
feed all along.

**Fixed:** every column is kept. The word list was demoted to deciding which
attributes get a facet group without being asked, which is a much narrower
question than what to store. Plumbing columns — internal ids, row timestamps —
are still dropped, because they can never be searched for usefully.

**And separately:** keeping everything must not mean searching everything. A
carton weight or an accounting code in the searchable body lets a shopper
typing "12" match on a number nobody was looking for, so a value reaches the
relevance score only if it reads like something a shopper would say — words,
not bare identifiers — or its column was marked facet-worthy. Storage is cheap;
relevance is not.

### ✅ A shopper describing a product got a text search

**Found:** brands and product types were lifted out of a query and applied as
filters, but the words shoppers actually use to describe a product — "black",
"polyurethane", "rustic" — were still matched as free text. That asks a much
weaker question: does this document mention black anywhere. A white corbel
whose description says "also available in black" answers yes.

**Fixed:** the entity dictionary now also holds the values each facet actually
carries, built by asking the engine to count them — a facet-only query, so it
works identically on all three engines with no fourth implementation. Up to
three features per query are lifted; past that the extra matches are far more
likely to be describing words colliding with a catalogue value than a shopper
narrowing five ways at once, and every lifted feature is a filter that can
empty the page.

Typing "black shutter" is now the same operation as searching "shutter" and
clicking Black — including the facet panel still offering the other finishes,
which is what lets a shopper change their mind without retyping.

**Watch:** the rescue path had to learn about features too. "Black polyurethane
corbel" in a catalogue with no black polyurethane anything used to fall
through to best sellers, throwing away the two things the shopper said that the
catalogue does understand. It now relaxes features one at a time, keeping the
first named, and says which it dropped.

### ✅ An unbuyable product could hold the top slot

Every other business signal is a shade of better-or-worse; stock is a fact
about whether the shopper can buy the thing. Averaged into the composite, a
product with excellent margin, velocity and reviews could outrank an in-stock
rival and lead the page while being unbuyable — the most expensive result a
search can return. It is now a multiplier rather than a term: out of stock
sinks, discontinued sinks further, neither disappears.

### ✅ The merchandiser could arrange a category and not keep it

The Category mode previewed a catcode's grid and let a merchandiser drag it
into the order they wanted, then refused to save: a rule was keyed by typed
text and a category page has none. A rule now binds to either, and everything
else about it is unchanged — the same pins, buries and hides, the same preview,
the same history and undo. When both could fire, the typed words win: a search
made inside a category is the more specific intent.

### ✅ Session state outlived the session

`safeStorage()` took a store and then ignored it, always returning
`localStorage`. The "session" store was a second handle on the persistent one,
so anything scoped to a visit quietly outlived it, across tabs and restarts.
Found while adding personalisation, where it would have turned a hint about
this visit into a permanent profile.

### ✅ Click-through was measured against nothing

**Found:** the ranking composite has a `ctr` signal, `businessScore` takes a
`ctrBySku` map, and **nothing ever passed one** — the weight was 0 and the
parameter had no caller. Following it back, the reason was worse: the analytics
rollup wrote `0 AS impressions` for every product, because no impression was
ever recorded anywhere. Clicks were being collected and thrown away, every rate
the system could compute was 0/0, and the only signals affecting rank were ones
somebody had typed into a spreadsheet.

**Fixed.** Impressions are counted server-side as results are served — the
server already knows exactly what it returned, and a client-side beacon is the
first thing an ad blocker stops, which would have biased the denominator toward
whoever does not run one. The rollup now full-outer-joins impressions against
clicks, so the product shown a thousand times and never clicked gets a row; an
inner join would have dropped exactly the row a click-through rate exists to
find, and computed the site average over clicked products only.

Rates are shrunk toward the site average in proportion to how thin the evidence
is, and scored relative to that average rather than absolutely. A product
nobody has measured scores as an average one, not last — ranking the unmeasured
below everything is how a catalogue freezes.

**Watch:** this is a feedback loop. Whatever ranks first gets the impressions,
so an early accident can entrench itself. The shrinkage damps it and the weight
is below sales velocity on purpose; any increase to that weight should be
argued for with a measurement, not a hunch.

### ✅ The container image had no console in it

**Found:** `Dockerfile` copies `packages/demo/public` and `packages/sdk/src`
into the runtime image but never `packages/admin/public`. The API resolves the
console from that directory at boot, so a container built from this file serves
the storefront and 404s every admin screen — which reads as a broken deploy
rather than a missing `COPY`.

**Fixed.** Also moved Typesense behind a compose profile: it is the one
component here that has never run against a live cluster, and `docker compose
up` should not quietly make it the retrieval core.

**Not verified:** there is no Docker daemon in this environment, so the image
still has not been built or run. The compose file parses and resolves to the
right service set; that is all that has been checked.

### ✅ The results page named a filter the results did not obey

**Found:** searching "timberthane beams" in a catalogue where Timberthane makes
no beams correctly falls back to showing all beams and says so — but the
response went on reporting `brand: Timberthane` in both `appliedFilters` and
`parsedFilters`. The storefront prints those. The page told the shopper it had
filtered by a brand it had just stopped filtering by, and the brand facet
beside it disagreed.

**Cause:** the rescue delegates to a fresh search, and the outer response
overwrote that search's own `appliedFilters` with the *original* request's —
re-asserting the constraint the rescue existed to drop.

**Fixed:** the rescued response's own filters stand, and a rescue branch
reports which constraints survived it. Covered by a test and by the hosted
demo's smoke suite, which asserts the page stops naming the dropped brand.

**Watch:** anything that composes a response from a delegated search has to
take the filters from the search that ran, not from the one that was asked for.

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

- ~~**Query-triggered rules.**~~ ✅ A rule binds to a query as well as to a
  product set: pin, bury and hide, applied to the whole ranked window so a pin
  at slot one lands on page one. The console merchandises the live grid by
  dragging results, and a pin names a product whether or not the query ever
  reached it.
- ~~**Personalisation**~~ ◐ Two halves are built. Ranking adapts to what
  shoppers on the site do; and within a visit, the page re-orders toward the
  finishes and materials this shopper has been clicking. Deliberately bounded:
  it re-orders the page they were getting and never re-selects it, so the
  count, the facets and the pagination stay true and nobody is walled into a
  narrower catalogue by their own history. A merchandiser's arrangement is
  never overruled by it. Cross-visit profiles are not built, and the affinity
  is session-scoped on purpose.
- ~~**A/B testing.**~~ ✅ A rule can be split: half the sessions see it, half
  see the page as it would have been, and both are measured. Assignment is a
  hash of the session id, so it needs no storage, holds across a visit and
  across instances. The result is reported as a sentence — winning, losing, no
  difference, too early — with how many more sessions it would take when the
  answer is "not yet".
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
| A blocked step says which step, and what to do | Driven on Linux: dependencies not installed, Postgres running but no login accepted (both the prompt and the non-interactive message), a busy port, a seeded database whose key file is gone. Each names the one command that fixes it |
| The one command works on Windows too | Reviewed rather than run — there is no Windows here. `npx` is `npx.cmd`, which Node has refused to spawn without a shell since the 2024 command-injection fix, so every child now goes through `node --import tsx`; the tick marks fall back to ASCII outside Windows Terminal; and `npm test` and `npm run a11y` no longer depend on shell globbing or `VAR=value cmd`, neither of which cmd.exe does |
| Behaviour reaches ranking, end to end | Seeded a month of traffic, checked the rollup: 23,836 impressions, 831 clicks, 5,314 products shown and never clicked. Before this the same query returned 0 impressions for everything |
| A recommendation changes the results | Read the proposals off a live server, applied one through the API, and watched the top three results for "beam" change to the three products shoppers had been reaching for from position 12 |
| An automatic change is as visible as a manual one | Applied a proposal, then read `audit_log`: one row, actor recorded, before and after captured, revertible from History like any other change |
| The console explains itself | A Guide screen walks the five jobs with screenshots taken from this console against a real catalogue, and defines every term the UI uses. Its screenshots are asserted to load, so a renamed file fails the suite rather than shipping a broken page |
| A blank screen offers a way in | The merchandiser lists your busiest searches and the vocabulary screen lists the ones that found nothing; picking either fills the form. Both covered by the console suite |
| Features typed as words become filters | "black pvc shutter" on a live server: finish and material lifted, category understood, 7 products, all of them black PVC shutters. "black polyurethane corbel", a combination the catalogue does not hold, relaxes to 29 black products and says so |
| A category can be merchandised and kept | Saved a rule against `exterior/brackets` through the API: the pinned product took slot one, the hidden one left, and a different category was untouched |
| The page tilts toward this visit | Drove a real browser: clicked a Hunter Green shutter, searched again, and the same products came back led by Hunter Green — stored in sessionStorage, absent from localStorage |
| An experiment actually splits, and measures | Fourteen sessions against a live server: control saw the natural top result, treatment saw the pinned one, each session stable. 600 sessions of tagged events then produced a per-arm report |
| It refuses to call a result it cannot support | 300 sessions a side, 12.7% against 11.7% to cart — an apparent 8.6% lift. Reported as no clear difference, with the ~16,757 sessions per arm it would take to be sure, and no percentage shown next to the verdict |
| Discarding a change switches it off, not away | Ended an experiment as discarded: the rule went disabled, its arrangement survived, and the shopper page returned to the unpinned order |
| One command stands the whole thing up | `npm install && npm run app` in a clean tree with **no database at all**: it created one, applied the schema, seeded, started the API, and printed the admin key. Both browser suites then passed against that instance. Also checked the paths that go wrong — no Postgres anywhere, a port already in use, a second run reusing what is there, and `--reseed` |
| Dashboard numbers are computed, not fixtures | Traffic is generated against the live index; the rollup is re-run and the console read back |
| The hosted demo is a shop, not a harness | 32 checks over `file://` at desktop and phone: the grid, the departments, a misspelling landing on the right products, a brand-plus-type query read as both, and its own axe-core pass in both themes |
| The page never claims a filter the results ignore | Searched a brand that makes none of the product asked for; asserted the rescue drops the brand *and* stops reporting it |

Reproduce with `npm test`, `npm run ui-smoke`, `npm run ui-smoke:admin`,
`npm run browser-smoke`, `npm run a11y`, `npm run openapi -- --check` and
`npm run bench` — or push, and let CI do all of it.
