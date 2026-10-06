# Endura-Stone™ column training video

A 7-minute (6:59) product-training video for Endura-Stone columns, built entirely from code.
There is no stock footage and there are no images: every column, capital, plan diagram and
chart is drawn as SVG by `index.html`.

| File | What it is |
|---|---|
| `index.html` | The video. Open it in a browser to play it, scrub it, or jump to a chapter. Self-contained, no network needed. |
| `render.mjs` | Exports the video to MP4 frame by frame (exact, not a screen recording). |
| `RESEARCH.md` | Fact sheet behind every on-screen claim, with confidence levels and sources. |

## Chapters

1. Welcome · 2. What it is (rotocast FRP, hollow core) · 3. Built to last (warranty, Class A) ·
4. Shaft styles · 5. True entasis (= "Architectural Taper") · 6. Sizes to scale ·
7. Capitals & bases · 8. Plan types A/B/C/D/Q/R/E/K/L · 9. Load ratings ·
10. Reading a part number · 11. Installation · 12. Our column family (Endura-Craft, Endurathane,
Endura-Lite, Endura-Lum) · 13. Competitors (Turncraft, HB&G, Chadsworth, Fypon, AFCO) ·
14. Practice scenarios · 15. Recap

## Render the MP4

```bash
# needs Node, Playwright (Chromium) and ffmpeg
node render.mjs                      # -> endurastone-training.mp4, 1920x1080, 30 fps
node render.mjs --stills 60,200      # review PNGs at given seconds
```

## Editing

Each chapter is one `S(chapter, seconds, captions, draw)` call in `index.html`. Captions are
`[startSecond, text]` pairs. `draw(t)` returns SVG for scene-local time `t`. To change a fact,
update `RESEARCH.md` first, then the scene.

Before the video goes outside the team, spot-check the load table and plan-type drawings against
the current Endura-Stone spec sheet and the SKU line drawings (see the note in `RESEARCH.md`).
