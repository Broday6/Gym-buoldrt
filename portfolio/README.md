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
- Check the hero sentence in `index.html` that names Ekena Millwork and Architectural Depot,
  and the capability and "Built" entries in `content.js`. They're drafted from your
  repository and workflow tooling, so trim anything you don't want public.

## What's on the page

| Section | What it does |
|---|---|
| Hero | A timber frame of oak beams and drafting lines with a wire core inside. It assembles on load, tilts toward the cursor, can be dragged, and opens up as you scroll. Each capability is pinned to a corner. Hovering a pin or a capability card lights that corner's beams, and clicking a pin jumps to the card. |
| Capabilities | Six cards, each with a summary, proof points and tools. A light follows the pointer. |
| Compass Search | Stats that count up when they scroll into view, a working query analyzer (sizes, fractions, typos, synonyms, part numbers), the architecture layers, and a ticker of real commit subjects. |
| AI creative pipeline | A simulated run: research → brief → generate → evaluate (fail, regenerate, pass) → deliver. |
| Built | Every system in `content.js`, filterable by capability. |
| How I work, Contact | Four principles, then an email address with a copy button and a GitHub link. |

Motion is turned off under `prefers-reduced-motion`. Without WebGL, or if the CDN is
blocked, the hero falls back to a drawn version of the same frame with the same pins.

## Hosting

The folder is self-contained. Drag it into Netlify Drop, point Vercel at it, or serve it
with GitHub Pages from a branch or an Actions workflow.
