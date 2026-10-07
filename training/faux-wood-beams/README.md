# Faux wood beam training video

A narrated product-training video for Ekena faux wood beams (Timberthane™ and Heritage
Timber), built from code. Every chapter uses Ekena's own imagery: real room and shop photos, Ekena's A+
banners (finish chart, 8 textures / 5 styles, custom sizes, Heritage textures, colors and measurements),
the figures from Ekena's 2026 installation guide, accessory and mantel photos, and competitor product
photos from each brand's site. Photos move with a slow zoom; cross-sections and part-number breakdowns
are drawn as SVG by `index.html`. The voiceover is an open-weight neural voice (Kokoro, `af_heart`) reading the
same fact-checked text as the on-screen captions.

| File | What it is |
|---|---|
| `faux-wood-beams-training.mp4` | The finished video with voiceover, 1920×1080, 30 fps. |
| `index.html` | The same video, interactive: play, scrub, jump to a chapter, voiceover on/off. Needs `vo-timing.js` and `voiceover.mp3` beside it. |
| `VOICEOVER_SCRIPT.md` | The narration script with timestamps, plus how each line is spoken where that differs. |
| `RESEARCH.md` | Fact sheet behind every claim, with confidence levels and sources. |
| `lexicon.json` | How the narrator pronounces names, codes and fractions (used by `../shared/voiceover.py`). |

## Chapters

1. Welcome · 2. What they are (molded from real wood, hand-finished, hollow, decorative) ·
3. Why faux (no rot/warp, interior & exterior, pro-rated limited lifetime warranty) ·
4. Four Timberthane shapes (plank, L-beam, U-beam, box beam; optional end caps) ·
5. Eight Timberthane textures (Rustic Smooth primed only) · 6. Over 20 Timberthane finishes (Ekena's chart; OT =
Oatmeal vs Primed Tan) · 7. Heritage Timber (quick ship, six textures, colors, nominal sizes, end caps) ·
8. Sizes (stock and custom) · 9. Reading a part number · 10. Installation (Ekena's 2026 guide and figures) ·
11. Accessories & the collection (straps, corbels, brackets, outlookers, braces, rafter tails, shutters, mantels,
AmeriCraft, ForgeCraft, log beams) · 12. Competitors (Barron Designs, AZ Faux, Fypon, Volterra, real wood) ·
13. Practice scenarios · 14. Recap

Swatches are Ekena's listing images, which are mostly renders; the video tells reps to order a sample
to show a customer the real color.

## Real product photos

Every product picture is an image slot filled from `images/` (list in
[`images/README.md`](images/README.md), sources in `images/SOURCES.md`). To swap one, replace the
file with the same slot name, run `node images.mjs ../faux-wood-beams` from `training/shared`,
and re-render. Charcoal Grey and Burnished Graphite are still drawn: no accurate Ekena image was found.

## Rebuild

The narration and rendering tools live in [`../shared/`](../shared/); see [`../README.md`](../README.md).

Before the video goes outside the team, spot-check the finish codes, size range and install spacing
against the current Ekena install guide and listings, and confirm the pronunciations of Ekena, Mena
and AZ Faux (see `RESEARCH.md`).
