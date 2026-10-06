"""Round-trip check: transcribe each narrated line with Whisper and compare it to the script.

  python check_voiceover.py --wav voiceover.wav --captions captions.json --whisper DIR

DIR holds sherpa-onnx Whisper files (small.en-encoder.int8.onnx, ...). Lines whose
transcript differs from the script are printed for a human to judge. Spelled-out
part numbers (E S K ...) are expected to differ a little in formatting.
"""
import argparse, difflib, json, re
from pathlib import Path

import numpy as np
import sherpa_onnx
import soundfile as sf
from num2words import num2words

import voiceover as vo


def norm(s: str) -> list[str]:
    s = s.lower().replace("&", " and ").replace("eigh", "a").replace(".com", " dot com").replace("it's", "its")
    s = s.replace("½", " and a half").replace("¼", " quarter").replace("⅛", " eighth")
    s = re.sub(r"\b(\d{2})(\d{2})\b", r"\1 \2", s)          # 2024 -> 20 24 ("twenty twenty-four")
    s = re.sub(r"(\d),(\d)", r"\1\2", s)
    s = re.sub(r"\d+", lambda m: " " + num2words(int(m.group())) + " ", s)
    s = re.sub(r"[^a-z' ]+", " ", s).replace("'", "")
    words = s.split()
    out, run = [], ""
    for w in words:                      # glue spelled letters: "e s k" == "esk"
        if len(w) == 1 and w not in ("a",):
            run += w
        else:
            if run: out.append(run); run = ""
            out.append(w)
    if run: out.append(run)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--wav", default="voiceover.wav")
    ap.add_argument("--captions", required=True)
    ap.add_argument("--whisper", required=True)
    ap.add_argument("--timing", default="vo-timing.js")
    a = ap.parse_args()
    d = Path(a.whisper)
    rec = sherpa_onnx.OfflineRecognizer.from_whisper(
        encoder=str(d / "small.en-encoder.int8.onnx"), decoder=str(d / "small.en-decoder.int8.onnx"),
        tokens=str(d / "small.en-tokens.txt"), language="en", task="transcribe", num_threads=4)
    audio, sr = sf.read(a.wav, dtype="float32")
    timing = json.loads(Path(a.timing).read_text().split("=", 1)[1].rstrip().rstrip(";"))
    caps = json.load(open(a.captions))
    scores = []
    for c, t in zip(caps, timing):
        seg = audio[int(t["newStart"] * sr): int((t["newStart"] + t["newDur"]) * sr)]
        st = rec.create_stream(); st.accept_waveform(sr, seg); rec.decode_stream(st)
        heard = st.result.text.strip()
        want = vo.spoken(c["text"])
        r = difflib.SequenceMatcher(None, norm(want), norm(heard)).ratio()
        scores.append(r)
        flag = "OK " if r >= .93 else "CHK"
        if r < .93:
            print(f"{flag} {r:.2f}  {t['newStart']:6.1f}s\n   script: {want}\n   heard:  {heard}")
    print(f"\n{len(scores)} lines · mean match {np.mean(scores):.3f} · {sum(s >= .93 for s in scores)} lines ≥ 0.93")


if __name__ == "__main__":
    main()
