#!/usr/bin/env python3
"""Scene timing for one video, from its narration.

    python tools/timeline.py scripts/heritage.json out/heritage
    python tools/timeline.py scripts/heritage-hero.json out/heritage-hero --beats music/peaceful-beats.json --anchor 55.79

With --beats (a music track's beat times) every scene change is moved to the nearest beat that still
leaves room for the line, and the track is offset so that the end card starts exactly on --anchor
(a track time, e.g. where the music opens up). The offset is stored as music_offset_s.

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
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--beats", type=Path)
    ap.add_argument("--anchor", type=float, help="track time the last scene should start on")
    a = ap.parse_args()
    script = json.loads(a.script.read_text(encoding="utf-8"))
    out = a.out
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

    durs, mins = [], []
    for i, s in enumerate(script["scenes"]):
        vo = lines[s["id"]]["duration_s"]
        lead = LEAD["first"] if i == 0 else LEAD["default"]
        tail = TAIL["end"] if s.get("kind") == "end" else TAIL["default"]
        words = sum(1 for w in s["card"].split() if any(c.isalnum() for c in w))
        floor = max(1.0 + words / 3.0 + 0.3, s.get("min_s", 0))
        durs.append(max(lead + vo + tail, floor))
        mins.append(max(lead + vo + 0.3, floor))
    offset = None
    if a.beats:
        beats = json.loads(a.beats.read_text())["beats"]
        starts = [sum(durs[:i]) for i in range(len(durs))]
        offset = a.anchor - starts[-1]
        for _ in range(4):  # snap, re-anchor, repeat until the end card sits on the anchor
            grid = [b - offset for b in beats if b - offset > 0]
            snapped = [0.0]
            for i in range(1, len(durs)):
                lo = snapped[-1] + mins[i - 1]
                want = snapped[-1] + durs[i - 1]
                cands = [g for g in grid if g >= lo]
                snapped.append(min(cands, key=lambda g: abs(g - want)) if cands else want)
            new = a.anchor - snapped[-1]
            if abs(new - offset) < 1e-6:
                break
            offset = new
        durs = [snapped[i + 1] - snapped[i] for i in range(len(snapped) - 1)] + [durs[-1]]
    scenes, f = [], 0
    for i, s in enumerate(script["scenes"]):
        vo = lines[s["id"]]["duration_s"]
        lead = LEAD["first"] if i == 0 else LEAD["default"]
        dur = durs[i]
        n = round(dur * FPS) if a.beats and i + 1 < len(durs) else math.ceil(dur * FPS)
        scenes.append({"id": s["id"], "title": s["title"], "kind": s.get("kind", "other"), "card": s["card"],
                       "start_frame": f, "end_frame": f + n, "vo_start_s": round(lead, 3), "vo_duration_s": vo,
                       "vo_wav": f"narration/{lines[s['id']]['wav']}",
                       "words": [{**w, "t0": round(w["t0"] + lead, 3), "t1": round(w["t1"] + lead, 3)} for w in cache[s["id"]]["words"]]})
        f += n
    tl = {"fps": FPS, "frames": f, "seconds": round(f / FPS, 3), "bpm": 92, "scenes": scenes}
    if offset is not None:
        tl["music_offset_s"] = round(offset, 4)
        tl["bpm"] = round(60 / ((beats[-1] - beats[0]) / (len(beats) - 1)), 2)
    (out / "timeline.json").write_text(json.dumps(tl, indent=1, ensure_ascii=False), encoding="utf-8")
    print(f"{out.name}: {len(scenes)} scenes, {f} frames, {f / FPS:.1f}s")
    for s in scenes:
        print(f"  {s['id']:10} f{s['start_frame']:5}-{s['end_frame']:5}  {(s['end_frame'] - s['start_frame']) / FPS:5.2f}s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
