# Beam explainer videos (fully coded)

Three marketing videos for Ekena's two faux wood beam lines, built entirely in code. There is no
stock footage, no AI video and no editing software; ffmpeg only encodes the result.

| Video | Length | What it shows |
|---|---|---|
| **Heritage or Timberthane? Which beam do you need?** (`which-one`) | 96.7 s | What the two lines share, lead time, sizes (both drawn to the same scale), shapes, textures and finishes, details, and which to pick |
| **Heritage Timber: Finish & Size Explorer** (`heritage`) | 80.0 s | 6 textures, 6 stained finishes plus Primed, every texture × finish combination, 8 sizes to scale, the inside opening, 4–24 ft lengths, Quick Ship |
| **Timberthane: Finish & Size Explorer** (`timberthane`) | 70.8 s | 4 shapes, 8 textures, 28 hand-finished colours, any size from 3 to 24 in, 2–30 ft, endcaps, made to order in the USA |

Each video comes in 1920×1080 and 1080×1920 at 60 fps, H.264, −14 LUFS.

**Every product, texture and finish on screen is a real Ekena product photo or swatch**, taken from
the store's own listings. `img/assets.json` records the source URL of each one. Things that aren't
the beams are coded models: ceilings, mounting blocks, calendars, the person for scale, sliders and
the endcap selector. Every fact comes from the store's product data; see
`research/beam-lines-facts.md`, and the `claims` in `scripts/*.json` cite a source for each line.

## Before these go out: brand files

`render/brand.json` holds the logo and colours. The cloud build couldn't reach Ekena's site, so it
uses a Poppins wordmark and a stand-in green (`#2A5240`). On the PC, set `"logo"` to the real logo
(a transparent PNG inside `render/`) and `"green"` to the exact Ekena green from the beam install
project. Then render a new version and put it through review. The evaluator is right to flag the
stand-in logo, and the publish gate won't clear a version that hasn't been approved.

## Build

```
pip install numpy pillow soundfile kokoro-onnx faster-whisper     # Python 3.10+
cd render && npm install && cd ..                                  # @napi-rs/canvas + Poppins/Figtree
python tools/harvest.py .                                          # real product images -> img/ (≈40 MB)
# Kokoro model: models/kokoro-v1.0.onnx and models/voices-v1.0.bin
#   from github.com/thewh1teagle/kokoro-onnx/releases (model-files-v1.0)

python tools/narrate.py scripts/heritage.json out/heritage/narration   # voice + Whisper key-term check
python tools/timeline.py scripts/heritage.json out/heritage            # scene timing from the narration
python tools/music.py out/heritage                                     # score, 12 dB duck, -14 LUFS mix
node render/build.mjs heritage 16x9 projects/heritage-explorer/renders/v2/ekena-heritage-explorer-16x9.mp4
node render/build.mjs heritage 9x16 projects/heritage-explorer/renders/v2/ekena-heritage-explorer-9x16.mp4
python tools/publish_review.py heritage v2 --previous v1               # review/v2/manifest.json
```

`node render/build.mjs <video> <cut> --stills dir` writes preview frames, and `--frames a:b` renders
just a range for a splice re-render.

## How it's put together

- `scripts/<video>.json`: each scene's on-screen card, narration, claim ids and key terms.
- `tools/narrate.py`: Kokoro `am_michael`, with phonetic overrides (Ekena = EE-ken-uh, Mena,
  Resawn). Whisper then has to hear every key term, or the line fails.
- `tools/timeline.py`: each scene's length is lead-in + its line + tail, and never shorter than the
  card's reading time. It keeps word timestamps, so each texture or finish appears as it's named.
- `tools/music.py`: a D-major pad, pluck, bass and light percussion, synthesized in numpy and
  ducked 12 dB under the voice, then normalised in two passes to −14 LUFS / −1.5 dBTP.
- `render/lib/core.mjs`: shared drawing code. Product shots on white are multiplied onto the page,
  so the white drops out. Crossfades between photos of one set share one frame, so only the finish
  changes. Cross-sections are drawn to scale and filled with the real texture photo. Every frame
  moves slightly, so nothing reads as a freeze.
- `render/videos/<video>.mjs`: the scenes, with 16:9 and 9:16 layouts each.

## Review

The videos go through the same loop as the install videos: `projects/<project>/review/vN/` holds
the manifest, the independent evaluator's report and Brody's feedback. `publish_gate.py` must clear
the exact files before anything is published.
