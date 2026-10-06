# Faux wood beam training video

A narrated, 8¼-minute product-training video for Ekena faux wood beams (Timberthane™ and Heritage
Timber), built from code. Product images (the four shapes, all eight Timberthane textures, 24 of 26
finishes, every Heritage texture and finish, end caps, straps, the collection pieces and mantels)
are Ekena's own; cross-sections, the install sequence and part-number breakdowns are drawn as SVG
by `index.html`. The voiceover is an open-weight neural voice (Kokoro, `af_heart`) reading the
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
3. Why faux (no rot/warp, interior & exterior, limited lifetime warranty) ·
4. Four Timberthane shapes (plank, L-beam, U-beam, box beam; optional end caps) ·
5. Eight Timberthane textures · 6. 26 Timberthane finishes (codes; OT = Oatmeal vs Primed Tan) ·
7. Heritage Timber (quick ship, six textures, finishes, nominal sizing, end caps) · 8. Sizes to scale ·
9. Reading a part number · 10. Installation · 11. Accessories & the Timberthane collection
(straps, corbels, braces, outlookers, rafter tails, gable vents, shutters, mantels, real wood and
faux steel beams) · 12. Competitors (Barron Designs, AZ Faux, Fypon, Volterra, real wood) ·
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
