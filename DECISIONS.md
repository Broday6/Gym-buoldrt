# Decisions

Running log of the choices this build makes, why, and what would change them.
Ambiguities in the spec are resolved in favour of the merchandiser persona.

---

## D1 — Retrieval core: Typesense, with a SQLite/FTS5 dev engine behind one interface

**Decision.** Typesense is the production retrieval core. A second engine backed
by SQLite FTS5 implements the same `SearchEngine` interface for local
development, CI and the demo.

**Why.** At ~2.3M SKUs the catalogue sits well under the point where OpenSearch's
extra operational weight pays for itself, and Typesense gives typo tolerance,
faceting, `group_by` and hybrid vector search natively.

The second engine exists because the build environment could not reach the
Typesense image or binary. Rather than stub retrieval out, the dev engine uses
SQLite's FTS5 (BM25 built in) — a proven index, not a hand-rolled one, so the
"no custom inverted index" rule holds. Everything that differentiates the
product — the ranking cascade, business ranking, grouping, facet assembly,
rules — lives *above* the interface and is identical on both.

**Consequence.** `TypesenseEngine` is written against the documented API but has
not been integration-tested against a live cluster in this environment. That is
the single largest verification gap in Phase 1; see PROGRESS.md.

---

## D2 — Index at the variant level, group by parent at query time

**Decision.** One document per buyable SKU, with the parent's fields
denormalised onto each. Queries `group_by` parent and return the **matching**
variant as the card's representative.

**Why.** This came directly from a requirement: *"if someone types black shutter
I want the data to pull for black shutters, not all the variants even if they
are attached to that parent."*

Parent-level indexing with rolled-up variant attributes cannot do this. A parent
carrying seven finishes matches "black" as a whole, so the card shows whatever
image and price the parent happens to carry. Indexing variants means "black"
matches only the black rows; grouping then collapses them to one card whose
image, price and title are the black variant's.

**Consequence.** Document count equals SKU count (~2.3M), not product count.
That is the sizing number for Typesense memory. Result counts are counts of
*distinct parents*, computed over the full filtered set rather than the
re-ranking window, so they stay stable as pagination moves.

**Verified by** `packages/server/test/engine.test.ts` → "variant-level indexing
with parent grouping".

---

## D3 — Backend: Node.js + TypeScript (Fastify)

**Decision.** One language across the API, the storefront SDK and (from Phase 3)
the admin console.

**Why.** Both integration targets are neutral on the choice — Miva embeds a
JavaScript SDK whatever the backend is, and NetSuite is reached over plain HTTPS
(saved-search CSV, RESTlet, SuiteQL). So the tie-breaker is internal: the rule
schema, the search response and the event shape are shared types in
`@compass/shared` rather than three hand-maintained copies.

**Revisit if** the Phase 4 embedding model must run in-process. Today the plan is
to run it as a separate service, which keeps this decision cheap to reverse.

---

## D4 — Ranking is a cascade, then business ranking within a band

**Decision.** Textual relevance is compared criterion by criterion — typos,
words matched, attribute weight, proximity, exactness — and only when all of
them tie does the business composite decide. Never a single blended score.

**Why.** Explainability is a first-class feature. "It won on words matched" is a
true, checkable statement; "it scored 0.87" is not. A blended score also lets a
high-margin near-miss outrank an exact title match, which is exactly the
behaviour a merchandiser cannot debug and does not want.

**Tunable.** `bandDepth` sets how many cascade criteria form a band. At the
default (all five) business ranking only breaks exact ties. Lowering it to 3
lets margin and velocity reorder results that differ only in proximity and
exactness — the knob to reach for when a merchandiser says "my best sellers
aren't surfacing".

---

## D5 — Bounded candidate window, full-set facet counts

**Decision.** The engine returns at most `candidateLimit` (default 500)
candidates for re-ranking. Facet counts and the total are computed by the engine
over the **entire** filtered set.

**Why.** Re-ranking is O(window), which is what keeps p95 flat as the catalogue
grows. Facet counts cannot be windowed — a count that shifted with pagination
would be visibly wrong, and dead-end facet values are the failure mode §4.4
exists to prevent.

---

## D6 — A bare number in a query is a search term, not a filter

**Decision.** `12 ft`, `12'` and `12 foot` all become a length filter of 144
inches. `beam 12` becomes a search for "beam 12" with no filter.

**Why.** Guessing a numeric filter from an unqualified number hides matching
products with no way for the shopper to see why. Under-filtering shows too much;
over-filtering shows nothing. The first is recoverable, the second is a lost
sale.

**Related.** A lone measurement under 24 inches with no axis named matches *any*
dimension (`any_dimension_in`), because "3-1/2 inch crown moulding" refers to
the profile face, not a specific axis.

---

## D7 — Bad ingest rows are reported, never silently dropped

**Decision.** Rows without a SKU or title, and duplicate SKUs, are rejected —
and every rejection lands in the data-quality report with its row number.

**Why.** A merchandiser needs to learn that 900 SKUs failed to ingest from a
report, not by noticing they cannot be found in search three weeks later.

---

## D8 — Full ingest builds a new index and swaps; partial updates go to the live one

**Decision.** Every full ingest writes to a fresh physical index and promotes it
atomically via alias. Price and inventory deltas are written straight to the
live index.

**Why.** A rebuild must never serve a half-populated catalogue, and the < 60s
inventory target cannot be met by rebuilding. Physical index names carry a
monotonic counter as well as a timestamp — two rebuilds inside the same
millisecond would otherwise collide on the name and silently merge.

---

## D9 — Conservative plural folding, no aggressive stemming

**Decision.** "beams" → "beam", "shutters" → "shutter". But "moulding" stays
"moulding".

**Why.** On a millwork catalogue over-stemming costs more precision than the
recall it buys. Compound splitting is likewise gated on both halves being real
words *in the index vocabulary*, so "endurathane" is never split.

---

## D10 — Search volume is recorded server-side

**Decision.** The `/search` endpoint records the search event itself; the SDK
only reports interactions it alone can see (clicks with position, add-to-cart).

**Why.** Search volume, zero-result rate and result counts are the backbone of
the analytics dashboard. A client-side beacon for them is eaten by ad blockers
and undercounts exactly the queries worth fixing.

---

## D11 — Facet counts are tallied in one pass over integer columns

**Decision.** Facet values and parent products are dictionary-encoded to dense
integers at index time. A faceted query scans the candidate set once, projecting
only integer columns, and tallies every facet group in memory.

**Why.** Faceting was the dominant cost at scale — 814ms of an 880ms query at
100k documents, because each of the seven facet groups ran its own
`COUNT(DISTINCT …)` against a key/value attribute table.

Three things fixed it, in order of value:

1. **One pass instead of seven.** A facet group excludes its own selection from
   its own counts so multi-select stays usable, which naively means a different
   filter set per group. Instead, one scan tallies them all: a row failing no
   selection counts everywhere, a row failing exactly one counts only toward
   that group, a row failing two or more counts nowhere.
2. **Integer columns.** Marshalling several hundred thousand short strings out
   of SQLite and hashing them into JavaScript Sets cost more than the scan.
   Dense ids marshal and hash several times faster, and the dictionary is
   consulted only for the few dozen values that survive into the response.
3. **Dedicated columns instead of a key/value join.**

Measured against SQL-side aggregation on the same data, the in-memory tally is
about three times faster, because SQLite's `COUNT(DISTINCT)` per group repeats
the scan once per facet.

**Consequence.** Adding a facetable attribute changes the index layout and
requires a reindex — the same constraint Typesense puts on a schema change.

---

## D12 — The full-text match is scoped to one index inside FTS

**Decision.** Every document carries a per-index token in a dedicated FTS
column, and every match expression ANDs it in.

**Why.** All sites share one FTS table, so a match for "beam" returned Ekena's
and Architectural Depot's documents and then filtered by index afterwards
against a 100k-row table. Scoping inside FTS halved the work on a two-site
deployment and removed a join from the hot path.

**Also.** `CROSS JOIN` is used deliberately where the candidate set must lead
the join. SQLite otherwise plans these queries by scanning the whole document
table and probing the candidate set once per row, which was a 5–10x penalty;
`CROSS JOIN` is SQLite's documented way to pin join order.

---

## D13 — Results are cached, invalidated by event rather than by expiry

**Decision.** A bounded LRU cache of complete search responses, purged whenever
an index is promoted, a price or stock update lands, or a synonym or redirect
changes. Shopper and session ids are excluded from the key.

**Why.** Search traffic is head-heavy: a handful of queries carry most of the
volume and every shopper who types them gets an identical response. Caching
those is worth more than any further micro-optimisation.

Correctness rests on invalidation, not a short TTL, because the acceptance
criteria require a merchandising change to be visible within seconds. The TTL
is a backstop, not the mechanism. When the rules engine lands in Phase 3, rule
and campaign writes hook the same `invalidate()` call.

**Excluded from the key:** shopper and session ids, or the cache would
degenerate into one entry per visitor and never hit.

---

## D14 — An explicit sort outranks the relevance cascade

**Decision.** When a shopper picks a sort other than Relevance, the engine's
ordering is preserved and the cascade only computes signals for the
explainability panel.

**Why.** This was a real bug: the cascade re-ranked the candidate window on
relevance after the engine had already ordered it by price, so "Price: Low to
High" returned an essentially arbitrary order. A sort the shopper chose
explicitly is an instruction, not a hint.

---

## D15 — Synonyms expand the query, never the index

**Decision.** "sofa" searches for (sofa OR couch); couch documents do not gain
the word "sofa".

**Why.** Two reasons. The index stays honest — a document's text remains what
the merchandiser wrote, so relevance explanations stay truthful. And a synonym
edit takes effect on the next query instead of requiring a reindex, which is
what makes it a no-code change.

Expansions are strictly additive: the original terms always remain, so a
synonym can only widen recall and can never move a shopper away from a literal
match.

---

## D16 — The rescue cascade never shows an empty page, and always says so

**Decision.** On zero results: spell-correct, then relax the least informative
term, then the nearest matching category, then site best sellers. Whichever
step fired is named in the response and shown to the shopper.

**Why.** A zero-results page is a conversion emergency, but silently showing
different results than the ones asked for is how a shopper stops trusting a
search box. Every rescue is announced, and a spelling correction offers a link
back to the literal query (`rescue: false` on the request).

**Note.** Spelling correction is deliberately stricter than the engine's typo
tolerance: it requires the first character to survive, so "beam" is never
"corrected" to "team". Rewriting text on screen deserves a higher bar than
quietly matching a fuzzy token. The semantic-only step of §4.8 lands with the
Phase 4 vectors.

---

## D17 — Desktop filters apply live; mobile filters are staged

**Decision.** One widget, two behaviours. On desktop a tick updates the grid
immediately. On mobile the filters take over the screen, selections are staged,
and a sticky "Show N Results" button applies them.

**Why.** This is the Baymard-validated split, and the reason is visibility: on
desktop the grid is beside the filters so the feedback is immediate and an
apply button is a wasted click. On mobile the grid is behind the panel, so
live-updating something the shopper cannot see is disorienting — the count on
the button is what tells them whether the filter was a good idea before they
commit.

The staged count is a separate hit-less query, so the button is honest about
what the shopper is about to get.

---

## D18 — The candidate window is measured in products, and is fixed per query

**Decision.** Retrieval brings back a fixed number of parent *products* — not
variants, and not a number that varies with the requested page.

**Why.** Both halves were bugs, and both were invisible until measured.

Measuring the window in variants meant the number of cards on a page depended on
how many variants those products happened to have. A 120-variant window on a
catalogue averaging six variants per product produced **19 cards for a 24-card
page, and nothing at all from page two onward**.

Sizing the window by page then made the ordering depend on which page was asked
for: the cascade re-ranks whatever it is given, so a wider window inserts
products ahead of ones already ranked. Paging through 192 products returned 31
duplicates and missed 31 others entirely. A fixed window makes the ordering a
property of the query alone, so pagination is stable by construction.

**Consequence.** Deep pagination is capped at the window (500 products by
default). That is what every hosted search engine does, for the same reason:
serving page 400 means ranking everything before it, and nobody paginates that
far — they refine. `totalHits` still reports the true count; `totalPages`
reports what can actually be reached, and `reachableHits` says when the two
differ so a storefront can stop rendering page links.

**Related.** Ordering the groups is not enough on its own: the representative
variant within each group has to be ordered by the same measure, or a
price-sorted grid shows correctly ranked products at arbitrary prices.

---

## D19 — Merchandiser structure lives outside the catalogue and is stamped in at ingest

**Decision.** Collections and custom attributes are authored in Postgres and
applied to the index as *labels* — `collection:farmhouse-kitchen`,
`room:Kitchen` — recomputed on every ingest.

**Why.** A category comes from the feed and says what a product **is**. A
collection says what it is **for** — "Farmhouse Kitchen", "Contractor Value",
"Black Friday" — and routinely spans categories with nothing else in common. The
same is true one level down: "Room" and "Budget" are facets a merchandiser
invents, not fields any source system supplies.

Storing them in the catalogue is not an option, because the feed is overwritten
on every ingest and a nightly refresh would silently erase a merchandiser's
work. Storing them only in Postgres is not an option either, because they have
to be filterable and facetable, which means they have to reach the retrieval
engine. Labels are the bridge: authored outside, reapplied on every ingest.

**Consequence.** Membership changes need a reindex to become visible. The API
says so explicitly (`reindexRequired: true`) rather than letting a merchandiser
believe a change is live when it is not. Metadata changes — a rename, enabling a
scheduled collection — take effect immediately, which is why scheduled
collections are built into the index up front and merely withheld from the
listing until they are live.

---

## D20 — Membership is decided per product, but labels are attached per variant

**Decision.** A product is in a collection, but the label goes only on the
variants that actually satisfy the rule.

**Why.** This is the "black shutter" principle again. Browsing "Dark Finishes"
has to show the *dark* option, not whichever variant sorted first; a product in
"Under $100" has to show its cheap variant, not its $340 one. Before this, both
showed the wrong variant — the product was correctly in the collection and the
card was misleading.

A rule that says nothing about variants labels every variant, so a purely
product-level collection behaves as you would expect. A rule that mentions
variant fields is re-evaluated against each variant individually, which also
makes mixed rules ("category contains Beams AND finish is Walnut") resolve
correctly without the rule language needing a separate variant mode.

**Exception.** A hand-picked product carries the label on every variant: the
merchandiser chose the product, not one of its options.

---

## D21 — Selectors are declarative structures, not expression strings

**Decision.** A rule is `{all: [{field, op, value}]}`, validated on write.

**Why.** A merchandiser builds these in a form, so every clause has to
round-trip cleanly to and from UI controls — which an expression string cannot
do. Validating on write means a malformed rule is a 400 at authoring time rather
than a surprise at 2am during the nightly ingest.

Two deliberate choices inside the language: an empty selector matches **nothing**
(a half-written rule must not sweep in the catalogue), and manual assignment
beats the selector in both directions, so a merchandiser can fix one wrong
product without rewriting a rule that is otherwise doing its job.

Aggregate fields — `minPrice`, `inStock`, `onSale`, `totalInventory` — exist
because that is how a merchandiser thinks about a product. "Under $100" means
its cheapest variant is.

---

## D22 — A configuration-store outage degrades search, it does not end it

**Decision.** Synonyms, redirects and custom-facet metadata fall back to their
last known value, or to empty, when Postgres is unreachable.

**Why.** The retrieval index is entirely independent of that database, so an
analytics and configuration store taking the storefront's search down with it is
a self-inflicted outage. Before this fix, stopping Postgres made `/search`
return 500.

Collection *membership* is unaffected either way, because it is already in the
index — which is a second argument for stamping labels in at ingest rather than
resolving them at query time.

---

## D23 — Badges reuse the collection rule language

**Decision.** A badge ("Best Seller", "Only 3 left", "Clearance") is a selector
plus a label and a tone, applied through the same label pipeline as collections
and custom attributes.

**Why.** Badges are the cheapest merchandising lever there is: they change what
a shopper notices without changing what ranks. Every competitor ships them, and
building them on a second, parallel rule system would have meant a merchandiser
learning two things that behave almost identically.

They inherit the variant scoping for free, which matters more than it sounds:
"Only 3 left" belongs on the variant that is nearly out, not on a product whose
other five finishes are fully stocked.

**Capped at two per card.** More than that stops being emphasis and becomes
noise — the whole point of a badge is that it is unusual.

---

## D24 — Recommendations degrade to top sellers, and say so

**Decision.** Five kinds — similar, bought-together, recently-viewed, trending,
top sellers — ordered by how much data they need. Anything that comes back empty
falls through to top sellers, and the response reports which kind actually
served it.

**Why.** An empty recommendation rail is worse than a generic one: it leaves a
hole in the page and tells the shopper the store has nothing to offer. But
silently substituting is how you end up unable to tell whether "similar
products" is working, so `servedBy` is on the response and in the DOM.

The ordering also means the feature works on day one. Similar products need only
a catalogue; bought-together needs orders; recently-viewed needs the shopper's
own history. A store with no traffic still gets a working rail.

---

## D25 — Simulated demo traffic, generated against the live index

**Decision.** The seed drives real searches against the index it just built and
records the resulting events, rather than inserting fixture rows.

**Why.** An analytics dashboard with no data demonstrates nothing, and
hand-written fixtures produce numbers that do not behave like real ones — every
figure comes out suspiciously round and no table tells you anything.

The generated traffic is deliberately shaped: head-heavy query volume, so the
top-queries table means something and the result cache is exercised;
click-through that decays steeply with position, so average click position is a
real signal; a realistic proportion of failing queries, so the zero-result
report has something to report; and bursty rather than uniform sessions, so
day-over-day trends move.

Every dashboard number is then *computed* from events the system actually
recorded, which is the only way the dashboard demonstrates the dashboard.

---

## D26 — Query-attributed revenue is split multi-touch across the session

**Decision.** A purchase carries no query — the shopper bought a product, not a
search — so its revenue is divided evenly across the distinct queries that
preceded it in the same session.

**Why.** Attributing the whole order to the last query before checkout
overstates whichever term happens to sit closest to the buy button, and
attributing it to the first overstates discovery. Even splitting across the
session is the honest granularity available for an anonymous shopper, and it is
what §4.9 asks for.

---

## D27 — The console is plain ES modules, served by the API process

**Decision.** No framework, no build step. Views are objects with a `render`
method; the shell owns a single delegated event listener.

**Why.** The same reasoning as the storefront SDK: it has to be servable
straight from the API process, and a merchandising console is a set of tables
and forms. A build step would add a toolchain to install, a bundle to keep in
sync with the API it talks to, and a deployment story, in exchange for
conveniences this does not need.

The single delegated listener is what makes a full re-render safe — there is
never a stale handler bound to an element that no longer exists.

---

## D28 — Rule previews count against a bounded sample, and say when they did

**Decision.** The visual builder counts matches on every edit, evaluating the
selector against up to 5,000 products and extrapolating beyond that.

**Why.** A rule a merchandiser cannot see the effect of is a rule they will not
trust — which is the whole reason the builder exists rather than a JSON field.
But the count runs on every keystroke, so it has to be bounded. Below the
threshold the count is exact and says so; above it, the response is explicit
that it estimated.

---

## D29 — The demo authenticates for real; the console asks for its key

**Decision.** The demo storefront fetches its site's **search-scoped** key from
`/demo/config.json` and sends it on every request. The console asks for an
**admin** key once and keeps it in `localStorage`. Neither surface runs with
authentication disabled, and the server never serves an admin key.

**Why.** The demo previously worked only with `COMPASS_DEV_OPEN=1`, which meant
the one path a reader is told to follow was the one path that never exercised
authentication — and `npm run demo`, which does not set that flag, returned 401
on every request. A demo that skips the auth layer is not a demo of the system.

The asymmetry between the two keys is the point of having two scopes. A search
key is designed to be public: it ships inside every storefront bundle, is
visible to anyone who views source, and can only read search endpoints and post
events — so publishing it on a demo route costs nothing that was not already
given away. An admin key can change the catalogue, so it is never served over
HTTP; the seed prints it, and it is pasted in once.

The gate is reactive rather than a login screen: the console asks only after the
API actually refuses a request, so a deployment that puts its own
authentication in front of the console never sees it. A stored key that stops
working is discarded rather than retried, because a console that silently shows
empty screens is worse than one that says it cannot get in.

**Cost.** The plaintext demo keys live in `data/demo/keys.json`, which is the
only copy — the database stores hashes. It is git-ignored, and if the file and
the database ever disagree the seed revokes what is on record and reissues, so
the two cannot drift into a state where nobody knows the working key.

---

## D30 — Four ordered roles, not a permission matrix

**Decision.** `search` < `analyst` < `merchandiser` < `admin`. Each endpoint
names the least role that may call it; a guard is one comparison. The role is in
the key's prefix — `ck_merchandiser_…` — and the console asks `/whoami` and hides
what the role cannot use.

**Why.** The jobs are genuinely ordered: an analyst reads what a shopper sees
plus the reports, a merchandiser also changes what shoppers see, an admin also
changes the catalogue and the keys. Encoding that as an order rather than a
matrix of resource×verb means there is no table for someone to forget to update
when they add an endpoint, and no way to express a role that can write something
it cannot read.

The prefix carries the role because the prefix is what a human sees. A key found
in a commit, a log or a support ticket has to announce what it can do without a
database lookup — and a merchandiser key that read `ck_search_…` would look like
the one that is safe to publish. That bug existed and this fixed it.

The console's gate is *reactive*: it hides controls the role cannot use, but the
server is the authority and refuses regardless. Hiding is about not showing
someone a button that 403s — which reads as a bug, not as a permission.

**Cost.** Four roles is coarser than per-resource permissions. A team that wants
"can edit synonyms but not collections" cannot express it. That is a real limit,
and the right time to add resource scoping is when someone asks for it, not
before.

---

## D31 — Schemas reject bad requests; the API is generated from them

**Decision.** Every endpoint carries a JSON Schema, compiled once by Fastify.
Bounded sizes on anything that costs work. `additionalProperties: false` on admin
writes, permissive on shopper endpoints. The OpenAPI document is generated from
that same route table, and CI fails if the checked-in copy is stale.

**Why.** Reading `request.body` through a TypeScript type is a compile-time claim
about a value that arrives at runtime from the internet. The consequences were
real and demonstrable: `{"q": 123}` returned a 500 carrying an internal error
message, and `{"hitsPerPage": 99999}` was accepted and did the work.

The asymmetry between admin and shopper endpoints is deliberate. A misspelled
field on an admin write must fail loudly, or it saves a record quietly missing
that field. A storefront bundle, meanwhile, outlives the server it was built
against: rejecting a field a newer server no longer reads would break the page
rather than the request.

Generating the spec from the routes is what makes §4.13's "kept current" true
rather than aspirational — including `x-required-role`, which reads the guard's
own value rather than a second copy that agrees by habit until it does not.

---

## D32 — Undo is a new change, never a deletion

**Decision.** Reverting a merchandising change writes the prior state back and
records the undo as its own audit entry, with its before and after reversed.
The log is append-only.

**Why.** The alternative — removing the entry being undone — produces a history
that cannot explain itself: someone sees a rule that is not what they remember
setting, and there is no record of the correction. Reverting as a new change
means an undo is itself auditable, itself revertible, and there is never a moment
where the log disagrees with the state it describes.

Making this work required fixing the trail first: every write recorded who
changed what, but not what it *was*. A log that says "someone changed the
clearance rule" without saying what it was is a record of an accident, not a way
back from one. Both sides are now read back from storage rather than taken from
the request body, so the diff compares like with like — a request body and a
stored record do not have the same shape, and diffing them invents changes to
fields nobody touched.

Entries written before that fix say so, and offer no button. An undo that
silently deletes what it claims to restore is worse than no undo.

---

## D33 — SEO is a directive the storefront applies, plus a rendered fallback

**Decision.** Search responses can carry `canonical`, `robots`, `title`,
`description` and a schema.org `ItemList`. The rules: internal search results are
never indexed; a category or collection with no filters is canonical; **one**
value from an allow-listed facet stays indexable on its own URL; anything more
canonicalises to the clean page as `noindex, follow`; sort never appears in a
canonical URL; page 2+ is self-canonical. Category and collection URLs are also
served as fully rendered HTML.

**Why.** A faceted catalogue generates a combinatorial number of URLs that are
the same products in a different order. Left alone, a crawler spends its budget
on `?material=PVC&finish=Black&sort=price_asc&page=7` and never reaches the
collection page that was supposed to rank.

`follow` throughout, never `nofollow`: a page not worth indexing is still a path
to products that are. And page 2 is deliberately *not* canonicalised to page 1 —
doing so hides every product past the first page from the index, which is the
most common way this gets it wrong.

The fallback is served at the same URL as the interactive page rather than as a
crawler-only view. A page served only to crawlers is cloaking; a page served only
to browsers is invisible.

**Cost.** The storefront has to apply the directives — the SDK does it when asked,
but a Miva template that renders its own head owns that itself. The alternative,
having the SDK always write into the document head, reaches into a page it does
not own.

---

## D34 — Maintenance runs in the API process, leased through the database

**Decision.** The analytics rollup runs on a schedule inside the API process. A
job claims its slot with an insert against a primary key of (job, site, day), so
exactly one instance runs it however many are up. A failure releases the claim so
the next tick retries.

**Why.** The rollup existed as a command nothing ran, so the dashboard went stale
a day after anyone last ran it by hand. In process rather than as a cron entry
for the same reason the rate limiter is in process: no second deployment artefact,
nothing to fall out of sync with the code it maintains, and it cannot itself be
the thing that is down.

The lease is an insert rather than a lock because there is nothing to leak: if an
instance dies mid-run there is no lock held open, and the retry-on-failure path
is a single delete. A job that fails silently once a day is worse than one that
fails loudly every five minutes, so failures release rather than hold.

`/health` reports the last outcome per job. A scheduled job that stops working is
otherwise invisible until someone notices the dashboard has not moved for a week.
