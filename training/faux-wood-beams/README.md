# Faux wood beam training video

A narrated, 7¾-minute product-training video for Ekena faux wood beams (Timberthane™ and Heritage
Timber), built entirely from code. There is no stock footage and there are no photos: the room,
beam cross-sections, the eight wood textures, finish swatches and install sequence are all drawn as
SVG by `index.html`. The voiceover is an open-weight neural voice (Kokoro, `af_heart`) reading the
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
3. Why faux (no rot/warp, interior & exterior, limited lifetime warranty) · 4. Profiles (U, L, plank) ·
5. Eight Timberthane textures · 6. Finishes (and Factory Prepped) · 7. Heritage Timber (nominal sizing) ·
8. Sizes to scale · 9. Reading a part number · 10. Installation · 11. Accessories & family
(straps, end caps, mantels, real wood) · 12. Competitors (Barron Designs, AZ Faux, Fypon, Volterra,
real wood) · 13. Practice scenarios · 14. Recap

The texture and finish swatches are illustrations, and the video says so: reps should order a
sample to show a customer the real thing.

## Rebuild

The narration and rendering tools live in [`../shared/`](../shared/); see [`../README.md`](../README.md).

Before the video goes outside the team, spot-check the finish codes, size range and install spacing
against the current Ekena install guide and listings, and confirm the pronunciations of Ekena, Mena
and AZ Faux (see `RESEARCH.md`).
