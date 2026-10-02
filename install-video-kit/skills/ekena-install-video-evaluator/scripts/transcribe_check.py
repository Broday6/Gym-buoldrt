#!/usr/bin/env python3
"""Listen to the delivered narration and compare it with the script, scene by scene.

    python transcribe_check.py <project> <version> [--cut 16x9] [--model small.en]
    python transcribe_check.py <project> <version> --words words.json   # reuse a transcript

Transcribes the finished file with local Whisper, using faster-whisper if it is installed and
openai-whisper otherwise. For every scene with narration it reports what was heard in that
scene's time, how much of the scripted line was heard there, and whether the line drifted into
a neighbouring scene. It also checks that every key term in the manifest is heard clearly.

--words takes a word list instead of transcribing: [{"word","start","end"}, …], or {"words": […]}.

Writes review/<version>/eval/narration.json. If no speech model is installed it writes
{"available": false, "reason": …} and exits 0, so the evaluator can say the check was skipped.
"""
from __future__ import annotations

import argparse
import difflib
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evalkit import EvalError, cut_path, load_version, write_json  # noqa: E402

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
        write_json(out, {"available": False, "reason": str(exc)})
        print(f"skipped: {exc} — wrote {out}")
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
