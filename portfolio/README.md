# Portfolio

Brody Simpson's personal site: a static page with an interactive 3D hero, and no build step.

```
portfolio/
├── index.html   page structure and section copy
├── content.js   capabilities, things built, commit log, email, links  ← edit this first
├── styles.css   design tokens at the top, then each section
├── app.js       renders content.js, query analyzer, pipeline simulation, scroll effects
└── hero3d.js    the three.js frame (loaded from cdnjs) and its capability pins
```

## Run it locally

```bash
cd portfolio
python3 -m http.server 8000   # or: npx serve .
```

Open http://localhost:8000. Opening `index.html` straight from disk also works.

## Before you publish

- Put your real address in `content.js` → `email`. It's a placeholder for now.
- Every number on the page comes from `content.js` and names its source (PROGRESS.md,
  the relevance baseline, `npm run bench`, git history). Update them there when they change.
- Check the hero sentence in `index.html` that names Ekena Millwork and Architectural Depot,
  and the capability and "Built" entries in `content.js`. They're drafted from your
  repository and workflow tooling, so trim anything you don't want public.

## What's on the page

| Section | What it does |
|---|---|
| Hero | A timber frame of oak beams and blueprint lines with a wire core inside. It assembles on load, tilts toward the cursor, can be dragged, and opens up as you scroll. Each capability is pinned to a corner. Hovering a pin or a capability card lights that corner's beams, and clicking a pin jumps to the card. |
| The receipts | Eight figures (tests, relevance cases, latency, cache hit rate, accessibility audits, commits, lines of code, skills), each naming its source. They count up as they scroll into view. |
| Capabilities | Six cards, each with a summary, five proof points and tools. A light follows the pointer. |
| Attributes | Six traits, each backed by a quote or fact and where it comes from. |
| Compass Search | The three-day build timeline from git history, a working query analyzer, a latency chart against targets, a before/after chart of performance fixes (log scale, with hover tooltips and a table view), acceptance checks, bugs caught before release, the architecture, and a ticker of real commit subjects. |
| AI creative pipeline | A simulated run: research → brief → generate → evaluate (fail, regenerate, pass) → deliver. |
| Toolbox | Languages, data, web, quality, AI and marketing tools, grouped. |
| Built | Every system in `content.js`, filterable by capability. |
| Rules, Contact | Four principles, then an email address with a copy button and a GitHub link. |

Motion is turned off under `prefers-reduced-motion`. Without WebGL, or if the CDN is
blocked, the hero falls back to a drawn version of the same frame with the same pins.

## Hosting

`.github/workflows/pages.yml` publishes this folder to GitHub Pages on every change to it on
the repository's default branch. Turn it on once under **Settings → Pages → Build and
deployment → Source: GitHub Actions**, then merge to the default branch or run the
workflow by hand. The site appears at `https://<user>.github.io/<repo>/`.

Some link-preview scrapers want an absolute image URL. Once you know the final address,
change `og:image` in `index.html` from `og.png` to the full URL.

The folder is self-contained, so Netlify Drop or Vercel work too.
