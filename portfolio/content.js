/*
 * Everything the portfolio says lives in this file.
 * Edit the text here; index.html, app.js and hero3d.js read from it.
 * Numbers marked "source" come from the Compass Search repository
 * (PROGRESS.md, relevance-baseline.json, git history).
 */
window.PORTFOLIO = {
  name: "Brody Simpson",
  email: "you@yourdomain.com", // ← replace with the address you want people to use
  github: "https://github.com/broday6",

  // The proof band near the top. `value` is what shows at rest; counters animate up to it.
  proof: [
    { value: 229, label: "Unit tests passing", note: "plus 67 browser checks", source: "PROGRESS.md" },
    { value: 129, of: 129, label: "Relevance cases passing", note: "typos, sizes, synonyms, aisles", source: "relevance-baseline.json" },
    { value: 9.9, decimals: 1, unit: "ms", label: "Median search time", note: "p95 39 ms against a 100 ms target", source: "npm run bench" },
    { value: 96, unit: "%", label: "Cache hit rate", note: "on repeated shopper traffic", source: "npm run bench" },
    { value: 20, label: "Accessibility audits", note: "WCAG 2.1 A and AA, both themes", source: "npm run a11y" },
    { value: 36, label: "Commits in three days", note: "MVP to readiness audit", source: "git log" },
    { value: 29, unit: "k", label: "Lines of code", note: "TypeScript and JavaScript", source: "packages/" },
    { value: 20, unit: "+", label: "Agent skills written", note: "research, creative, ads, data", source: "skill library" },
  ],

  // Each capability is pinned to a corner of the 3D frame in the hero.
  capabilities: [
    {
      id: "search",
      pin: "Search engineering",
      title: "Search & discovery engineering",
      summary:
        "I designed and built Compass Search, a self-hosted replacement for Algolia and Searchspring: query understanding, ranking, merchandising, analytics and a storefront SDK.",
      proof: [
        "Reads “4x6 beam 12ft” as a cross-section and a length",
        "129 of 129 relevance cases pass, from typos to “ceiling beams”",
        "Median search 9.9 ms, p95 39 ms on the demo catalogue",
        "229 unit tests, 67 browser checks, 20 accessibility audits",
        "One deployment serves every brand, each fully scoped",
      ],
      tools: ["TypeScript", "Node", "PostgreSQL", "Typesense", "SQLite FTS5", "Playwright"],
    },
    {
      id: "creative",
      pin: "AI creative",
      title: "AI creative pipelines",
      summary:
        "Product carousels and video, run end to end: research, brief, generation, an independent evaluator, then delivery to the right task.",
      proof: [
        "Every image is graded against the real product photos",
        "Failed slides regenerate with instructions before anything ships",
        "Seven or fourteen slides, each product slide in a different real room",
        "Video motion comes from real Veo clips, never animated stills",
        "A hook in the first two seconds and captions on every cut",
      ],
      tools: ["Claude", "ChatGPT images", "Google Flow / Veo", "Asana"],
    },
    {
      id: "media",
      pin: "Paid media",
      title: "Paid media operations",
      summary:
        "A weekly hygiene pass across Google and Microsoft Ads, plus spend allocation grounded in what shoppers actually search for.",
      proof: [
        "Search terms for every campaign, keywords for every Search campaign",
        "Negatives, keyword waste and conflicts, exact-match harvesting",
        "Merchant Center disapprovals, broken landing pages, low-rated assets",
        "Spend positioned group by group against caps and growth targets",
        "Recommend-only, and never judged by ROAS alone",
      ],
      tools: ["Google Ads", "Microsoft Ads", "Merchant Center", "Marketing portal"],
    },
    {
      id: "catalog",
      pin: "Catalog data",
      title: "Catalog & product data",
      summary:
        "Live listings checked against NetSuite as the source of truth, with findings ranked by what costs money first.",
      proof: [
        "Price drift and spec mismatches caught before they cause returns",
        "Missing images, thin descriptions and stale content flagged",
        "Unlisted products and discontinued ones still selling, found",
        "Rules for parent, child or separate listing, and broken variant families",
        "Saved-search pulls from NetSuite to CSV or Excel",
      ],
      tools: ["NetSuite", "Miva", "Amazon", "CSV / JSON"],
    },
    {
      id: "launch",
      pin: "Launch ops",
      title: "Product launch operations",
      summary:
        "A launch board that carries each product from research to ready-to-launch, with each stage run by the system that owns it.",
      proof: [
        "Research, assets, marketing and launch on one board",
        "Each stage hands off through a single run-state file",
        "Assets pass an evaluator before marketing sees them",
        "SEO and FAQ copy, announcement email, Instagram post, ad structure",
        "Go and no-go calls stay with people",
      ],
      tools: ["Asana", "Claude", "Email", "Instagram"],
    },
    {
      id: "agents",
      pin: "Agent design",
      title: "Agent & workflow design",
      summary:
        "I write the operating manuals that let AI agents do real work reliably: skills, hand-offs, guardrails, and graders with no stake in the output.",
      proof: [
        "A library of 20+ reusable skills across research, creative, ads and data",
        "Orchestrators call stages; they never replace them",
        "Graders kept separate from generators so they can be harsh",
        "Browser automation picks up where APIs stop",
        "Agents stop and say what they need instead of shipping less",
      ],
      tools: ["Claude Code", "Skills", "MCP connectors", "Browser automation"],
    },
  ],

  // Traits, each backed by something you can check.
  attributes: [
    { title: "Ships end to end", text: "First commit to roles, backups, OpenAPI, SEO and undo in three days.", evidence: "36 commits between Aug 30 and Sep 1, 2026", source: "git log" },
    { title: "Measures, then claims", text: "Latency is reported cached and uncached, side by side.", evidence: "“Reporting only one would misrepresent the system in one direction or the other.”", source: "PROGRESS.md" },
    { title: "Chases root causes", text: "Pages came back short and duplicated. The fix went to the cause, not the symptom.", evidence: "“The candidate window was measured in variants while pages are measured in products.”", source: "PROGRESS.md" },
    { title: "Thinks like the shopper", text: "Shoppers write sizes a dozen ways. Search has to read all of them.", evidence: "Seven different ways of writing twelve feet all find the same beam", source: "relevance-baseline.json" },
    { title: "Honest about limits", text: "Every claim names its boundary, and the open gaps are listed next to the wins.", evidence: "“Scale is proven to 104k variant documents on the dev engine, not to 2.3M.”", source: "PROGRESS.md" },
    { title: "Bridges marketing and engineering", text: "The same person audits the ad spend, keeps the catalogue honest and builds the search.", evidence: "Ads audits, listing audits and a search engine, all for one catalogue", source: "capabilities above" },
  ],

  // Compass Search: acceptance checks from PROGRESS.md. `open` marks work still to do.
  checks: [
    { text: "“chandaleer” returns chandeliers", evidence: "typo tolerance, two edits" },
    { text: "A part number returns that exact product first", evidence: "engine.test.ts" },
    { text: "“4x6 beam 12ft” parses, including 12' and “12 foot”", evidence: "21 test cases" },
    { text: "“black shutter” returns black shutters, not every sibling variant", evidence: "finish facet returns only Black" },
    { text: "Facet counts are exact and no filter click dead-ends", evidence: "zero-count values never emitted" },
    { text: "Ranking explains why one product outranks another", evidence: "per-result cascade in the console" },
    { text: "Zero-result searches never dead-end, and the shopper is told", evidence: "rescue cascade, browser-tested" },
    { text: "Turning off a campaign changes results within seconds", evidence: "cache invalidated on write" },
    { text: "A failing query on the dashboard has a one-click fix", evidence: "inline “add synonym”" },
    { text: "A collection can span categories", evidence: "“Dark Finishes”: beams, shutters, lighting" },
    { text: "Paging returns every product exactly once", evidence: "category, collection and sorted queries" },
    { text: "A query with no keyword overlap still finds the product", evidence: "next phase: vector search", open: true },
  ],

  // p50 / p95 in ms against the target, demo catalogue (520 products, 2,158 variant documents).
  latency: [
    { path: "Search", p50: 9.9, p95: 39.4, target: 100 },
    { path: "Search + filter", p50: 16.0, p95: 43.4, target: 100 },
    { path: "Browse", p50: 7.6, p95: 10.8, target: 120 },
    { path: "Browse, deep page", p50: 48.8, p95: 54.5, target: 120 },
  ],

  // Fixes found by measuring, before → after in ms.
  speedups: [
    { what: "Browse candidate set", before: 7327, after: 18 },
    { what: "Typo term expansion", before: 1752, after: 43 },
    { what: "Facet counts at 104k documents", before: 814, after: 65 },
    { what: "Top-N product fetch", before: 27.7, after: 0.9 },
    { what: "Zero-result rescue, p95", before: 792, after: 460 },
  ],

  // Bugs caught by tests and audits before a shopper saw them.
  bugs: [
    { title: "Pages came back short and duplicated", text: "A 192-product category showed 19 results, then nothing. The window counted variants; pages count products." },
    { title: "“Price: low to high” was ignored", text: "Ranking re-sorted after the engine had sorted. The browser test caught what a two-product unit test missed." },
    { title: "A settings outage took search down", text: "Search now keeps serving when the database behind the settings is down." },
    { title: "Missing prices showed as $0.00", text: "A missing price is a data defect, not a free product. It now reads “Price unavailable”." },
  ],

  // How Compass was built, from the commit history.
  timeline: [
    { day: "Aug 30", commits: 4, title: "Phases 1 to 3", text: "Core search, discovery UX, collections, the merchandiser console, analytics and recommendations." },
    { day: "Aug 31", commits: 22, title: "Readiness", text: "Roles, validation, backups, OpenAPI, SEO, undo, phone layouts, one-command setup on Windows, relevance measured." },
    { day: "Sep 1", commits: 10, title: "Real feeds", text: "Feeds in any shape, attributes recovered from prose, a hosted database, and a page built from a real catalogue." },
  ],

  toolbox: [
    { group: "Languages & runtime", items: ["TypeScript", "JavaScript", "Node 22", "SQL"] },
    { group: "Search & data", items: ["PostgreSQL", "Typesense", "SQLite FTS5", "NetSuite", "CSV / JSON feeds"] },
    { group: "Web", items: ["Fastify", "OpenAPI 3.1", "JSON Schema", "ARIA", "three.js"] },
    { group: "Quality", items: ["node:test", "Playwright", "axe-core", "GitHub Actions", "Benchmarks"] },
    { group: "AI", items: ["Claude Code", "Agent skills", "MCP connectors", "ChatGPT images", "Google Flow / Veo"] },
    { group: "Marketing & commerce", items: ["Google Ads", "Microsoft Ads", "Merchant Center", "Miva", "Amazon", "Asana"] },
  ],

  // Things built. `cap` matches a capability id above.
  shipped: [
    { cap: "search", title: "Compass Search", text: "Self-hosted e-commerce search, merchandising and discovery. Three phases plus a readiness audit, multi-tenant from the start." },
    { cap: "search", title: "Search in a single file", text: "The storefront baked into one HTML page that runs the real search pipeline in the browser, checked against the server engine result for result." },
    { cap: "search", title: "Merchandiser console", text: "Query tester with per-result explanations, visual rule builder, collections, badges, and a change history where every edit can be undone." },
    { cap: "creative", title: "Carousel pipeline", text: "Seven or fourteen slides per product, every product slide in a different real room solving a different customer problem." },
    { cap: "creative", title: "Hero video system", text: "Cinematic product films with a hook in two seconds and captions on every cut. It refuses to ship a slideshow." },
    { cap: "creative", title: "Independent evaluators", text: "Separate image and video graders that read only from disk and return pass or fail with regeneration instructions." },
    { cap: "media", title: "Weekly ads audit", text: "Every campaign's search terms and every Search campaign's keywords, plus feed disapprovals, dead landing pages and low-rated assets." },
    { cap: "media", title: "Spend optimizer", text: "Reads where each group's spend comes from, then sizes reallocation moves grounded in that category's search terms." },
    { cap: "catalog", title: "Listing audit", text: "Storefront and marketplace listings compared with NetSuite, ranked by what costs money first." },
    { cap: "catalog", title: "Catalog structure rules", text: "A decision guide for variant families, plus an audit for broken families, wrong lead times and bad pricing." },
    { cap: "launch", title: "Product launch pipeline", text: "One board, research through ready-to-launch, with each stage run by the skill that owns it." },
    { cap: "launch", title: "Fireplace mantels line", text: "Owned end to end with locked conventions, a session ritual and go-live gates." },
    { cap: "agents", title: "Creative standards", text: "The Job Test: every asset shows a customer problem and the fix, using real photos wherever they exist." },
    { cap: "agents", title: "Morning brief", text: "A styled daily brief that renders on demand or on a weekday schedule." },
  ],

  // Real commit subjects from the Compass Search repository.
  commits: [
    "Read “ceiling beams” as beams, not as the ceiling aisle",
    "Find the same beam however the shopper asks for its length",
    "Recover attributes that exist nowhere but in prose",
    "Read a feed in whatever shape it arrives in",
    "Measure whether search actually works, and fix what that found",
    "Measure whether a merchandising change helped",
    "Let behaviour rank the catalogue, and propose the rest",
    "Say which step is blocked, and what fixes it",
    "Make the one command work on Windows",
    "Understand brands and product types instead of matching them as text",
    "Make both surfaces work on a phone, and fix three defects found doing it",
    "Find a product by part of its number, and a colour by what it is called",
  ],
};
