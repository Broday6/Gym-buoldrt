#!/usr/bin/env python3
"""Scene timing for one video, from its narration.

    python tools/timeline.py scripts/heritage.json out/heritage

Each scene runs  lead-in + its spoken line + tail, and never less than the card's reading time
(1 s + 1 s per 3 words, the evaluator's rule) or the scene's own `min_s`. Word timestamps from
Whisper are kept per scene so the picture can reveal each texture or finish as its name is said.
Writes <out>/timeline.json (frames at 60 fps; a scene's end_frame is exclusive).
"""
import json
import math
import sys
from pathlib import Path

FPS = 60
LEAD = {"default": 0.55, "first": 0.9}
TAIL = {"default": 0.6, "end": 2.6}
ROOT = Path(__file__).resolve().parent.parent


def main() -> int:
    script = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    lines = json.loads((out / "narration" / "lines.json").read_text(encoding="utf-8"))
    words_cache = out / "narration" / "words.json"
    cache = json.loads(words_cache.read_text()) if words_cache.is_file() else {}

    need = [s["id"] for s in script["scenes"] if cache.get(s["id"], {}).get("text") != lines[s["id"]]["text"]
            or cache.get(s["id"], {}).get("duration_s") != lines[s["id"]]["duration_s"]]
    if need:
        from faster_whisper import WhisperModel
        asr = WhisperModel("small.en", device="cpu", compute_type="int8", download_root=str(ROOT / "models/whisper"))
        for sid in need:
            segs, _ = asr.transcribe(str(out / "narration" / lines[sid]["wav"]), beam_size=5, word_timestamps=True)
            words = [{"w": w.word.strip(), "t0": round(w.start, 3), "t1": round(w.end, 3)} for s in segs for w in s.words]
            cache[sid] = {"text": lines[sid]["text"], "duration_s": lines[sid]["duration_s"], "words": words}
        words_cache.write_text(json.dumps(cache, indent=1), encoding="utf-8")

    # Whisper's word starts can be off by a tenth of a second or two; snap each one to the nearest
    # real speech onset in the wav (energy above a floor after at least 60 ms of quiet).
    import numpy as np
    import soundfile as sf

    def onsets(wav):
        a, sr = sf.read(wav)
        hop = int(sr * 0.01)
        e = np.array([np.sqrt(np.mean(a[i:i + hop] ** 2)) for i in range(0, len(a) - hop, hop)])
        out, quiet = [], 6
        for i, v in enumerate(e):
            if v > 0.02 and quiet >= 6:
                out.append(i * 0.01)
            quiet = 0 if v > 0.02 else quiet + 1
        return out

    for sid in cache:
        ons = onsets(out / "narration" / lines[sid]["wav"])
        for w in cache[sid]["words"]:
            near = [o for o in ons if abs(o - w["t0"]) <= 0.25]
            if near:
                w["t0"] = round(min(near, key=lambda o: abs(o - w["t0"])), 3)

    scenes, f = [], 0
    for i, s in enumerate(script["scenes"]):
        vo = lines[s["id"]]["duration_s"]
        lead = LEAD["first"] if i == 0 else LEAD["default"]
        tail = TAIL["end"] if s.get("kind") == "end" else TAIL["default"]
        words = sum(1 for w in s["card"].split() if any(c.isalnum() for c in w))
        dur = max(lead + vo + tail, 1.0 + words / 3.0 + 0.3, s.get("min_s", 0))
        n = math.ceil(dur * FPS)
        scenes.append({"id": s["id"], "title": s["title"], "kind": s.get("kind", "other"), "card": s["card"],
                       "start_frame": f, "end_frame": f + n, "vo_start_s": round(lead, 3), "vo_duration_s": vo,
                       "vo_wav": f"narration/{lines[s['id']]['wav']}",
                       "words": [{**w, "t0": round(w["t0"] + lead, 3), "t1": round(w["t1"] + lead, 3)} for w in cache[s["id"]]["words"]]})
        f += n
    tl = {"fps": FPS, "frames": f, "seconds": round(f / FPS, 3), "bpm": 92, "scenes": scenes}
    (out / "timeline.json").write_text(json.dumps(tl, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{out.name}: {len(scenes)} scenes, {f} frames, {f / FPS:.1f}s")
    for s in scenes:
        print(f"  {s['id']:10} f{s['start_frame']:5}-{s['end_frame']:5}  {(s['end_frame'] - s['start_frame']) / FPS:5.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
