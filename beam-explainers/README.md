# Beam explainer videos (fully coded)

Four marketing videos for Ekena's two faux wood beam lines, built entirely in code. There is no
stock footage, no AI video and no editing software; ffmpeg only encodes the result.

| Video | Length | What it shows |
|---|---|---|
| **Heritage or Timberthane? Which beam do you need?** (`which-one`) | 96.7 s | What the two lines share, lead time, sizes (both drawn to the same scale), shapes, textures and finishes, details, and which to pick |
| **Heritage Timber: Finish & Size Explorer** (`heritage`) | 80.0 s | 6 textures, 6 stained finishes plus Primed, every texture × finish combination, 8 sizes to scale, the inside opening, 4–24 ft lengths, Quick Ship |
| **Heritage Timber: hero edit** (`heritage-hero`) | 61.3 s | The flagship: a problem-led edit ("the timber look, without the weight") with full-bleed room photos and texture close-ups, kinetic type, wipes between scenes, captions burned in, and a score that hits each scene change |
| **Timberthane: Finish & Size Explorer** (`timberthane`) | 70.8 s | 4 shapes, 8 textures, 28 hand-finished colours, any size from 3 to 24 in, 2–30 ft, endcaps, made to order in the USA |

Each video comes in 1920×1080 and 1080×1920 at 60 fps, H.264, −14 LUFS.

**Every product, texture and finish on screen is a real Ekena product photo or swatch**, taken from
the store's own listings. `img/assets.json` records the source URL of each one. Things that aren't
the beams are coded models: ceilings, mounting blocks, calendars, the person for scale, sliders and
the endcap selector. Every fact comes from the store's product data; see
`research/beam-lines-facts.md`, and the `claims` in `scripts/*.json` cite a source for each line.

## Brand

`render/brand.json` and `render/brand/` hold the real Ekena logo (colour and white versions) and the
brand colours: sage `#8E9C5D` and grey `#828486`. Both come from the header of Ekena's own Heritage +
TimberThane install guide (`research/INSTALL_BMU.pdf`). Small green text uses a darker sage
(`greenText`), because sage itself is too light to read on the cream page.

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

The hero edit adds two steps: `python tools/cutout.py <photos> --out img/heritage/cutout` (and
`--keep-frame` into `img/heritage/cutout-frame` for the Salvaged Timber finish set) cuts the real
product shots out of their white backgrounds, and `python tools/music.py out/heritage-hero --hits`
adds the scene-change swells. It also uses the 1200 px swatches in `img/heritage/swatch-hi/`.

`node render/build.mjs <video> <cut> --stills dir` writes preview frames, and `--frames a:b` renders
just a range for a splice re-render.

## How it's put together

- `scripts/<video>.json`: each scene's on-screen card, narration, claim ids and key terms.
- `tools/narrate.py`: Kokoro `am_michael` (a script can pick another voice; the hero edit uses
  `af_heart`), with phonetic overrides (Ekena = EE-ken-uh, Mena,
  Resawn). Whisper then has to hear every key term, or the line fails.
- `tools/timeline.py`: each scene's length is lead-in + its line + tail, and never shorter than the
  card's reading time. It keeps word timestamps, so each texture or finish appears as it's named.
- `tools/music.py`: a D-major pad, pluck, bass and light percussion, synthesized in numpy and
  ducked 12 dB under the voice, then normalised in two passes to −14 LUFS / −1.5 dBTP.
- `render/lib/core.mjs`: shared drawing code. Product shots on white are multiplied onto the page,
  so the white drops out. Crossfades between photos of one set share one frame, so only the finish
  changes. Cross-sections are drawn to scale and filled with the real texture photo. Every frame
  moves slightly, so nothing reads as a freeze.
- `render/videos/<video>.mjs`: the scenes, with 16:9 and 9:16 layouts each. A module can export
  `drawFrame` to own the whole frame; the hero edit does, for its wipes and captions. Its captions
  use the script's own spelling, timed from Whisper's word times.

## Review

The videos go through the same loop as the install videos: `projects/<project>/review/vN/` holds
the manifest, the independent evaluator's report and Brody's feedback. `publish_gate.py` must clear
the exact files before anything is published.
