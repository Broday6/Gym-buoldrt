#!/usr/bin/env python3
"""Narration for one video: Kokoro (am_michael) per scene line, with phonetic overrides for the
product names, then a local Whisper pass that fails the line if a key term isn't heard.

    python tools/narrate.py scripts/which-one.json out/which-one/narration [--speed 1.06]

Writes <out>/<scene>.wav (24 kHz mono, silence trimmed) and <out>/lines.json with each line's
duration and what Whisper heard.
"""
import argparse
import json
import re
import sys
from pathlib import Path

import numpy as np
import soundfile as sf
from kokoro_onnx import Kokoro

ROOT = Path(__file__).resolve().parent.parent
VOICE = "am_michael"  # default; a script can set "voice"
BEAT_S = 0.32
# Spoken forms Kokoro gets wrong on its own (checked by ear-substitute: Whisper).
PHONEMES = {
    "Ekena": "ˈiːkˌɛnə",        # EE-ken-uh, house rule
    "Mena": "mˈiːnə",
    "Resawn": "ɹˌiːsˈɔːn",
    "faux": "fˈoʊ",
    "endcaps": "ˈɛndkˌæps",
    "Endcaps": "ˈɛndkˌæps",
}
# The override word plus any punctuation right after it, so the pause after "Mena." survives.
WORD = re.compile(r"\b(" + "|".join(map(re.escape, PHONEMES)) + r")\b([.,!?;:]*)")


def to_phonemes(k: Kokoro, text: str) -> str:
    out, pos = [], 0
    for m in WORD.finditer(text):
        if m.start() > pos:
            out.append(k.tokenizer.phonemize(text[pos:m.start()], "en-us"))
        out.append(PHONEMES[m.group(1)] + m.group(2))
        pos = m.end()
    if pos < len(text):
        out.append(k.tokenizer.phonemize(text[pos:], "en-us"))
    return " ".join(p.strip() for p in out if p.strip())


def trim(a: np.ndarray, sr: int, thresh=0.004, pad_s=0.04) -> np.ndarray:
    idx = np.where(np.abs(a) > thresh)[0]
    if not len(idx):
        return a
    p = int(pad_s * sr)
    return a[max(0, idx[0] - p): min(len(a), idx[-1] + p)]


def norm(s: str) -> str:
    return re.sub(r"[^a-z0-9 ]+", " ", s.lower()).split().__str__()


def heard(term_forms: list[str], text: str) -> bool:
    t = " " + re.sub(r"[^a-z0-9]+", " ", text.lower()) + " "
    return any(" " + re.sub(r"[^a-z0-9]+", " ", f.lower()).strip() + " " in t for f in term_forms)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("script", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--speed", type=float, default=1.06)
    ap.add_argument("--only", nargs="*", help="regenerate only these scene ids")
    args = ap.parse_args()

    script = json.loads(args.script.read_text(encoding="utf-8"))
    PHONEMES.update(script.get("phonemes", {}))  # per-script overrides (a voice may need its own spelling)
    args.out.mkdir(parents=True, exist_ok=True)
    k = Kokoro(str(ROOT / "models/kokoro-v1.0.onnx"), str(ROOT / "models/voices-v1.0.bin"))
    from faster_whisper import WhisperModel
    asr = WhisperModel("small.en", device="cpu", compute_type="int8", download_root=str(ROOT / "models/whisper"))

    lines_path = args.out / "lines.json"
    lines = json.loads(lines_path.read_text()) if lines_path.is_file() else {}
    terms = [t if isinstance(t, dict) else {"term": t, "heard_as": [t]} for t in script.get("key_terms", [])]
    failed = []
    for sc in script["scenes"]:
        sid, text = sc["id"], sc["vo"]
        if args.only and sid not in args.only:
            continue
        # "|" in a line marks a deliberate beat (lists of textures, finishes, shapes): each part is
        # spoken on its own and joined with BEAT_S of silence, so every item gets time on screen.
        parts = [p.strip() for p in text.split("|") if p.strip()]
        chunks = []
        for p in parts:
            a, sr = k.create(to_phonemes(k, p), voice=script.get("voice", VOICE), speed=args.speed, lang="en-us", is_phonemes=True)
            chunks.append(trim(np.asarray(a, dtype=np.float32), sr))
        gap = np.zeros(int(BEAT_S * sr), dtype=np.float32)
        audio = np.concatenate([x for c in chunks for x in (c, gap)][:-1])
        text = " ".join(parts)
        wav = args.out / f"{sid}.wav"
        sf.write(wav, audio, sr)
        segs, _ = asr.transcribe(str(wav), beam_size=5)
        got = " ".join(s.text.strip() for s in segs)
        missing = [t["term"] for t in terms if heard([t["term"]], text) and not heard(t.get("heard_as") or [t["term"]], got)]
        lines[sid] = {"text": text, "wav": wav.name, "duration_s": round(len(audio) / sr, 3), "sr": sr, "heard": got, "missing_terms": missing}
        print(f"{sid:10} {len(audio)/sr:5.2f}s  {'OK ' if not missing else 'MISS ' + ','.join(missing)} | {got}")
        if missing:
            failed.append(sid)
    lines_path.write_text(json.dumps(lines, indent=1, ensure_ascii=False), encoding="utf-8")
    total = sum(v["duration_s"] for v in lines.values())
    print(f"total narration {total:.1f}s; {'all key terms heard' if not failed else 'MISSING in ' + ', '.join(failed)}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
