# Endura-Stone™ column training video

A narrated, 9-minute product-training video for Endura-Stone columns, built entirely from code.
There is no stock footage and there are no images: every column, capital, plan diagram and
chart is drawn as SVG by `index.html`. The voiceover is an open-weight neural voice (Kokoro,
`af_heart`) reading the same fact-checked text as the on-screen captions.

| File | What it is |
|---|---|
| `endurastone-training.mp4` | The finished video with voiceover, 1920×1080, 30 fps. |
| `index.html` | The same video, interactive: play, scrub, jump to a chapter, voiceover on/off. Needs `vo-timing.js` and `voiceover.mp3` beside it. |
| `VOICEOVER_SCRIPT.md` | The narration script with timestamps, plus how each line is spoken where that differs. |
| `RESEARCH.md` | Fact sheet behind every claim, with confidence levels and sources. |
| `voiceover.py` | Builds the narration (`voiceover.mp3`) and the re-timing file (`vo-timing.js`). |
| `check_voiceover.py` | Transcribes the narration with Whisper and flags any line that doesn't match the script. |
| `render.mjs` | Exports the video to MP4 frame by frame and muxes in the narration. |

## Chapters

1. Welcome · 2. What it is (rotocast FRP, hollow core) · 3. Built to last (warranty, Class A) ·
4. Shaft styles · 5. True entasis (= "Architectural Taper") · 6. Sizes to scale ·
7. Capitals & bases · 8. Plan types A/B/C/D/Q/R/E/K/L · 9. Load ratings ·
10. Reading a part number · 11. Installation · 12. Our column family (Endura-Craft, Endurathane,
Endura-Lite, Endura-Lum) · 13. Competitors (Turncraft, HB&G, Chadsworth, Fypon, AFCO) ·
14. Practice scenarios · 15. Recap

## How the voiceover stays in sync

The narration says exactly what each caption says. Only the spoken form changes: "FRP" is
spoken as "F R P", "6½" as "six and a half", part numbers are spelled out, and Scamozzi,
Erechtheum, entasis, AFCO and pilaster get phonetic (IPA) overrides. Each line is
synthesized separately. If a line needs more time than its caption slot, the slot is
stretched, and the animation inside it is stretched by the same factor, so every reveal
lands on the sentence that describes it. Nothing is sped up.

## Rebuild

```bash
# 1. Narration (Python; pip install kokoro-onnx soundfile; model files from
#    github.com/thewh1teagle/kokoro-onnx releases "model-files-v1.0")
#    captions.json comes from window.__captions in index.html
python voiceover.py --captions captions.json --model kokoro-v1.0.onnx --voices voices-v1.0.bin
ffmpeg -i voiceover.wav -c:a libmp3lame -b:a 128k voiceover.mp3

# 2. Optional accuracy check (pip install sherpa-onnx num2words; Whisper small.en from
#    github.com/k2-fsa/sherpa-onnx releases "asr-models")
python check_voiceover.py --captions captions.json --whisper sherpa-onnx-whisper-small.en

# 3. Video (Node + Playwright + ffmpeg)
node render.mjs                      # -> endurastone-training.mp4 with narration
node render.mjs --audio none         # silent version
node render.mjs --stills 60,200      # review PNGs at given seconds
```

To change a fact, update `RESEARCH.md` first, then the caption and scene in `index.html`,
then rebuild the narration and the video.

Before the video goes outside the team, spot-check the load table and plan-type drawings against
the current Endura-Stone spec sheet and the SKU line drawings (see the note in `RESEARCH.md`).
