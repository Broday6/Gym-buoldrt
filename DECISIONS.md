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
