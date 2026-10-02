#!/usr/bin/env python3
"""Listen to the delivered narration and compare it with the script, scene by scene.

    python transcribe_check.py <project> <version> [--cut 16x9] [--model small.en]
    python transcribe_check.py <project> <version> --words words.json   # reuse a transcript

Transcribes the finished file with local Whisper, using faster-whisper if it is installed and
openai-whisper otherwise. For every scene with narration it reports what was heard in that
scene's time, how much of the scripted line was heard there, and whether the line drifted into
a neighbouring scene. It also checks that every key term in the manifest is heard clearly.

--words takes a word list instead of transcribing: [{"word","start","end"}, …], or {"words": […]}.

Writes review/<version>/eval/narration.json. If no speech model is installed it still measures
the audio of every narrated scene (momentary loudness over time) and flags scenes that are silent
or as steady as a tone, which speech never is. It records {"available": false, "reason": …,
"audio_activity": …} and exits 0.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evalkit import EvalError, cut_path, load_version, run, tool, write_json  # noqa: E402

MOMENTARY_RE = re.compile(r"t:\s*([\d.]+)\s+TARGET:.*?M:\s*(-?[\d.]+|-inf)")

NUMBERS = {"0": "zero", "1": "one", "2": "two", "3": "three", "4": "four", "5": "five", "6": "six",
           "7": "seven", "8": "eight", "9": "nine", "10": "ten", "11": "eleven", "12": "twelve"}


def norm_tokens(text: str) -> list[str]:
    text = text.lower().replace("’", "'")
    text = re.sub(r"[-–—/]", " ", text)
    text = re.sub(r"[^\w' ]+", " ", text)
    toks = [t.strip("'") for t in text.split()]
    return [NUMBERS.get(t, t) for t in toks if t]


def same(a: str, b: str) -> bool:
    if a == b:
        return True
    if min(len(a), len(b)) < 4:
        return False
    return difflib.SequenceMatcher(None, a, b).ratio() >= 0.8


def recall(expected: list[str], heard: list[str]) -> float:
    if not expected:
        return 1.0
    pool = list(heard)
    hit = 0
    for e in expected:
        for i, h in enumerate(pool):
            if same(e, h):
                hit += 1
                del pool[i]
                break
    return hit / len(expected)


def stem(tok: str) -> str:
    """Joist/joists and block/blocks are the same key term; mounting/mountain are not."""
    return tok[:-1] if len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss") else tok


def contains(seq: list[str], sub: list[str]) -> bool:
    seq, sub = [stem(t) for t in seq], [stem(t) for t in sub]
    n = len(sub)
    return n > 0 and any(seq[i:i + n] == sub for i in range(len(seq) - n + 1))


def term_variants(entry) -> tuple[str, list[list[str]]]:
    """A key term is a string, or {"term": "Shutter-Loks", "heard_as": ["shutter locks"]}.
    Key terms match exactly: a near miss like "mountain block" for "mounting block" is the
    mispronunciation this check exists to catch."""
    if isinstance(entry, dict):
        name = entry.get("term", "")
        forms = [name] + list(entry.get("heard_as") or [])
    else:
        name, forms = entry, [entry]
    return name, [t for t in (norm_tokens(f) for f in forms) if t]


def transcribe(path: Path, model_name: str) -> tuple[list[dict], str]:
    try:
        from faster_whisper import WhisperModel  # type: ignore
        model = WhisperModel(model_name, device="auto", compute_type="auto")
        segments, _info = model.transcribe(str(path), word_timestamps=True, vad_filter=False)
        words = [{"word": w.word, "start": float(w.start), "end": float(w.end)}
                 for seg in segments for w in (seg.words or [])]
        return words, f"faster-whisper {model_name}"
    except ImportError:
        pass
    try:
        import whisper  # type: ignore
        model = whisper.load_model(model_name)
        res = model.transcribe(str(path), word_timestamps=True)
        words = [{"word": w["word"], "start": float(w["start"]), "end": float(w["end"])}
                 for seg in res.get("segments", []) for w in seg.get("words", [])]
        return words, f"openai-whisper {model_name}"
    except ImportError:
        raise EvalError("no speech model installed (pip install faster-whisper, or openai-whisper)")


def audio_activity(m: dict, path: Path, ffmpeg: str) -> dict:
    """Without a speech model: is there anything voice-like in each narrated scene at all?
    Speech rises and falls by several LU every second; a missing voice leaves silence, a steady
    bed or a test tone."""
    proc = run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn",
                "-af", "ebur128=framelog=info", "-f", "null", "-"], check=False)
    series = [(float(t), float(v)) for t, v in MOMENTARY_RE.findall(proc.stderr) if v != "-inf"]
    fps = m["fps"]
    out = []
    for s in m["scenes"]:
        if not s.get("narration"):
            continue
        t0, t1 = s["start_frame"] / fps, s["end_frame"] / fps
        vals = [v for t, v in series if t0 + 0.4 <= t <= t1]  # M is a 400 ms window
        flag = None
        if not vals or max(vals) < -45:
            mean = sd = None
            flag = "Near silence where the script has a narration line"
        else:
            mean = sum(vals) / len(vals)
            sd = (sum((v - mean) ** 2 for v in vals) / len(vals)) ** 0.5
            if sd < 1.0 and t1 - t0 >= 1.0:
                flag = (f"Audio level is flat (±{sd:.1f} LU) through a narrated scene — "
                        "speech varies far more, so the voice may be missing")
        out.append({"scene": s["id"], "mean_lufs": None if mean is None else round(mean, 1),
                    "variation_lu": None if sd is None else round(sd, 2), "flag": flag,
                    "frames": [s["start_frame"], s["end_frame"] - 1]})
    return {"method": "momentary loudness (EBU R128, 400 ms) per narrated scene", "scenes": out}


def words_in(words: list[dict], t0: float, t1: float) -> list[dict]:
    return [w for w in words if t0 <= (w["start"] + w["end"]) / 2 < t1]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--cut", help="which cut to listen to (default: the first; they share one mix)")
    ap.add_argument("--model", default="small.en")
    ap.add_argument("--words", type=Path, help="use this word list instead of transcribing")
    ap.add_argument("--slack", type=float, default=0.25, help="seconds either side of a scene that still count as in it")
    ap.add_argument("--min-match", type=float, default=0.7, help="share of the scripted line that must be heard in its scene")
    ap.add_argument("--out", type=Path)
    ap.add_argument("--ffmpeg")
    args = ap.parse_args(argv)
    try:
        m, vdir = load_version(args.project, args.version)
    except EvalError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    out = args.out or (vdir / "eval" / "narration.json")
    cut = next((c for c in m["cuts"] if c["id"] == args.cut), None) if args.cut else m["cuts"][0]
    if cut is None:
        print(f"ERROR: no cut {args.cut!r}", file=sys.stderr)
        return 2
    try:
        if args.words:
            raw = json.loads(args.words.read_text(encoding="utf-8"))
            words = raw["words"] if isinstance(raw, dict) else raw
            engine = f"word list {args.words.name}"
        else:
            print(f"transcribing {cut['file']} …", flush=True)
            words, engine = transcribe(cut_path(args.project, cut), args.model)
    except EvalError as exc:
        report = {"available": False, "reason": str(exc), "cut": cut["id"]}
        try:
            report["audio_activity"] = audio_activity(m, cut_path(args.project, cut), tool("ffmpeg", args.ffmpeg))
        except EvalError as exc2:
            report["audio_activity"] = {"error": str(exc2)}
        write_json(out, report)
        print(f"transcription skipped: {exc}")
        for r in (report["audio_activity"].get("scenes") or []):
            print(f"  {'✗' if r['flag'] else '✓'} {r['scene']}: "
                  + (r["flag"] if r["flag"] else f"level varies ±{r['variation_lu']} LU (speech-like)"))
        print(f"wrote {out}")
        return 0

    fps = m["fps"]
    sc = m["scenes"]
    results, all_ok = [], True
    for i, s in enumerate(sc):
        if not s.get("narration"):
            continue
        t0, t1 = s["start_frame"] / fps, s["end_frame"] / fps
        here = words_in(words, t0 - args.slack, t1 + args.slack)
        heard_text = "".join(w["word"] for w in here).strip()
        exp = norm_tokens(s["narration"])
        heard = norm_tokens(heard_text)
        match = recall(exp, heard)
        flag = None
        if match < args.min_match:
            best = None
            for j in (i - 1, i + 1):
                if 0 <= j < len(sc):
                    n = sc[j]
                    nh = norm_tokens("".join(w["word"] for w in words_in(words, n["start_frame"] / fps, n["end_frame"] / fps)))
                    r = recall(exp, nh)
                    if r >= match + 0.25 and (best is None or r > best[1]):
                        best = (n["id"], r)
            flag = (f"line is heard mostly during {best[0]} ({round(best[1] * 100)}%), not its own scene"
                    if best else "scripted line not heard clearly in this scene")
            all_ok = False
        missing = []
        for entry in m.get("key_terms") or []:
            name, forms = term_variants(entry)
            if any(contains(exp, f) for f in forms) and not any(contains(heard, f) for f in forms):
                missing.append(name)
        if missing:
            all_ok = False
        results.append({"scene": s["id"], "expected": s["narration"], "heard": heard_text,
                        "match": round(match, 3), "flag": flag, "missing_terms": missing,
                        "frames": [s["start_frame"], s["end_frame"] - 1]})
    all_heard = norm_tokens("".join(w["word"] for w in words))
    terms = []
    for entry in m.get("key_terms") or []:
        name, forms = term_variants(entry)
        ok = any(contains(all_heard, f) for f in forms)
        terms.append({"term": name, "heard": ok})
        all_ok = all_ok and ok
    report = {"available": True, "engine": engine, "cut": cut["id"], "pass": all_ok,
              "transcript": "".join(w["word"] for w in words).strip(), "scenes": results, "key_terms": terms}
    write_json(out, report)
    for r in results:
        mark = "✓" if not r["flag"] and not r["missing_terms"] else "✗"
        extra = (f" — {r['flag']}" if r["flag"] else "") + (f" — not heard: {', '.join(r['missing_terms'])}" if r["missing_terms"] else "")
        print(f"  {mark} {r['scene']}: {round(r['match'] * 100)}% of the line heard{extra}")
    for t in terms:
        if not t["heard"]:
            print(f"  ✗ key term never heard: {t['term']}")
    print(f"{'PASS' if all_ok else 'CHECK'} — wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
