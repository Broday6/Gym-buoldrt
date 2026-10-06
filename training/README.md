# Product training videos, built from code

Each folder is one training video. Every frame is drawn as SVG by the folder's `index.html`.
There is no stock footage. The narration is an open-weight neural voice reading the
on-screen captions, which are fact-checked against the folder's `RESEARCH.md`.

| Video | Runtime | Folder |
|---|---|---|
| Endura-Stone™ columns | 9:08 | [`endurastone/`](endurastone/) |
| Faux wood beams (Timberthane™ & Heritage Timber) | 8:16 | [`faux-wood-beams/`](faux-wood-beams/) |

Each folder holds the finished MP4, the interactive `index.html` player (scrub, chapters,
voiceover on/off), `VOICEOVER_SCRIPT.md`, `RESEARCH.md` and `lexicon.json` (how the
narrator pronounces product names, codes and fractions).

## Shared tools (`shared/`)

| Tool | Does |
|---|---|
| `captions.mjs` | Exports a video's timed captions to JSON. |
| `voiceover.py` | Builds `voiceover.wav`, `vo-timing.js` and `VOICEOVER_SCRIPT.md` from the captions and `lexicon.json`. Stretches a caption slot (and its animation) when the spoken line needs more time; never speeds the voice up. |
| `check_voiceover.py` | Transcribes the narration with Whisper and flags any line that doesn't match the script. |
| `render.mjs` | Renders the video frame by frame to MP4 and muxes in the narration. |

```bash
cd shared
node captions.mjs ../VIDEO captions.json
python voiceover.py --dir ../VIDEO --captions captions.json --model kokoro-v1.0.onnx --voices voices-v1.0.bin
ffmpeg -i ../VIDEO/voiceover.wav -c:a libmp3lame -b:a 128k ../VIDEO/voiceover.mp3
python check_voiceover.py --dir ../VIDEO --captions captions.json --whisper sherpa-onnx-whisper-small.en
node render.mjs ../VIDEO                  # -> ../VIDEO/VIDEO-training.mp4
node render.mjs ../VIDEO --stills 60,200  # review PNGs
```

Requirements: Node with Playwright (Chromium) and ffmpeg; Python with `kokoro-onnx soundfile`
(plus `sherpa-onnx num2words` for the check). Model files: Kokoro `kokoro-v1.0.onnx` and
`voices-v1.0.bin` from the thewh1teagle/kokoro-onnx GitHub release "model-files-v1.0";
Whisper `sherpa-onnx-whisper-small.en` from the k2-fsa/sherpa-onnx release "asr-models".

To make a new video: copy a folder, replace the scenes in `index.html` (each chapter is one
`S(chapter, seconds, captions, draw)` call), write its `RESEARCH.md` and `lexicon.json`,
then run the steps above.
