/*
 * Everything the portfolio says lives in this file.
 * Edit the text here; index.html, app.js and hero3d.js read from it.
 */
window.PORTFOLIO = {
  name: "Brody Simpson",
  email: "you@yourdomain.com", // ← replace with the address you want people to use
  github: "https://github.com/broday6",

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
        "Failed slides regenerate before anything ships",
        "Video motion comes from real Veo clips, never animated stills",
      ],
      tools: ["Claude", "ChatGPT images", "Google Flow / Veo", "Asana"],
    },
    {
      id: "media",
      pin: "Paid media",
      title: "Paid media operations",
      summary:
        "A weekly hygiene pass across Google and Microsoft Ads: search terms, negatives, keyword conflicts, Merchant Center disapprovals, broken landing pages and weak assets.",
      proof: [
        "Campaigns judged by type, never by ROAS alone",
        "Spend positioned group by group against caps and growth targets",
        "Recommend-only: a person approves every change",
      ],
      tools: ["Google Ads", "Microsoft Ads", "Merchant Center", "Marketing portal"],
    },
    {
      id: "catalog",
      pin: "Catalog data",
      title: "Catalog & product data",
      summary:
        "Live listings checked against NetSuite as the source of truth: price drift, spec mismatches, missing images, stale copy, orphaned and discontinued products.",
      proof: [
        "Findings arrive prioritized and ready to assign",
        "Clear rules for parent, child or separate listing",
        "Runs on exports today and on live APIs when wired",
      ],
      tools: ["NetSuite", "Miva", "Amazon", "CSV / JSON"],
    },
    {
      id: "launch",
      pin: "Launch ops",
      title: "Product launch operations",
      summary:
        "A launch board that carries each product from research to ready-to-launch: assets, SEO and FAQ copy, the announcement email, social posts and ad structure.",
      proof: [
        "Each stage hands off through a single run-state file",
        "Assets pass an evaluator before marketing sees them",
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
        "Agents stop and say what they need instead of shipping less",
      ],
      tools: ["Claude Code", "Skills", "MCP connectors", "Browser automation"],
    },
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
