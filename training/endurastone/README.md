# Endura-Stone™ column training video

A narrated, 10½-minute product-training video for Endura-Stone columns, built entirely from code.
There is no stock footage and there are no images: every column, capital, plan diagram and
chart is drawn as SVG by `index.html`. The voiceover is an open-weight neural voice (Kokoro,
`af_heart`) reading the same fact-checked text as the on-screen captions.

| File | What it is |
|---|---|
| `endurastone-training.mp4` | The finished video with voiceover, 1920×1080, 30 fps. |
| `index.html` | The same video, interactive: play, scrub, jump to a chapter, voiceover on/off. Needs `vo-timing.js` and `voiceover.mp3` beside it. |
| `VOICEOVER_SCRIPT.md` | The narration script with timestamps, plus how each line is spoken where that differs. |
| `RESEARCH.md` | Fact sheet behind every claim, with confidence levels and sources. |
| `lexicon.json` | How the narrator pronounces names, codes and fractions (used by `../shared/voiceover.py`). |

## Chapters

1. Welcome · 2. What it is (rotocast FRP, hollow core) · 3. Built to last (lifetime limited warranty,
Class A / ASTM E84 Class 1) · 4. Shaft styles · 5. True entasis (= "Architectural Taper") ·
6. Sizes to scale · 7. Finishes (paint-grade ships unfinished; six pre-colored colors; Coral) ·
8. Capitals & bases (incl. Temple of Winds) · 9. Plan types A/B/C/D/Q/R and square E/F/G/K/L ·
10. Load ratings (6"–24", shaft-only, downward-only, 4× safety factor) · 11. Reading a part number
(incl. finish letters) · 12. Installation (ESINST, split kit) · 13. Our column family (Endura-Craft,
Endurathane, Endura-Lite, Endura-Lum, Endura-Classic) · 14. Other brands customers compare (Turncraft,
HB&G, Chadsworth, Fypon, AFCO) · 15. Practice scenarios · 16. Recap

## How the voiceover stays in sync

The narration says exactly what each caption says. Only the spoken form changes: "FRP" is
spoken as "F R P", "6½" as "six and a half", part numbers are spelled out, and Scamozzi,
Erechtheum, entasis, AFCO and pilaster get phonetic (IPA) overrides (all in `lexicon.json`). Each line is
synthesized separately. If a line needs more time than its caption slot, the slot is
stretched, and the animation inside it is stretched by the same factor, so every reveal
lands on the sentence that describes it. Nothing is sped up.

## Real product photos

Every drawing that shows the product is an image slot. Put a real Ekena photo in `images/`
named after its slot (the list is in [`images/README.md`](images/README.md)), then from
`training/shared` run `node images.mjs ../<this-folder>` and re-render.
Slots without a photo keep the drawing. No photos could be downloaded when this was built:
the network policy here blocks every retailer and Ekena image host.

## Rebuild

The narration and rendering tools live in [`../shared/`](../shared/); see [`../README.md`](../README.md).

To change a fact, update `RESEARCH.md` first, then the caption and scene in `index.html`,
then rebuild the narration and the video.

Before the video goes outside the team, spot-check the load table and plan-type drawings against
the current Endura-Stone spec sheet and the SKU line drawings (see the note in `RESEARCH.md`).
