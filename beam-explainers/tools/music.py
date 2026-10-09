#!/usr/bin/env python3
"""Synthesized score + narration mix for one video, all from code.

    python tools/music.py out/heritage [--seed 3]

Reads <out>/timeline.json and the narration wavs. Writes:
  <out>/audio/music.wav     the bed alone (48 kHz stereo)
  <out>/audio/mix.wav       narration over the bed, the bed ducked 12 dB under the voice,
                            loudness-normalised to -14 LUFS integrated, true peak <= -1.5 dBTP.
The score: D major, I-V-vi-IV, warm pad, soft plucked arpeggio, round bass, light kick and shaker.
With --track, a real (licence-cleared) recording replaces the synthesized score: the track is cut
from music_offset_s in timeline.json (set by timeline.py --beats so scene changes land on its beats),
levelled so its bed sits --bed-lu LU under the narration, ducked a further --duck dB while anyone
speaks, faded in and out. Keep it quiet: the defaults put it 16 LU under the voice, 24 LU under it
while the voice is on.

With --hits, each scene change also gets a soft filtered-noise swell into a low thump, timed to the
middle of the picture's transition (scene start + --hit-offset s), so the score moves with the cuts.
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 48000
DUCK_DB = -12.0


def midi(n: float) -> float:
    return 440.0 * 2 ** ((n - 69) / 12)


def adsr(n: int, a: float, d: float, s: float, r: float) -> np.ndarray:
    a_n, d_n, r_n = int(a * SR), int(d * SR), int(r * SR)
    env = np.full(n, s, dtype=np.float64)
    env[:a_n] = np.linspace(0, 1, a_n, endpoint=False) if a_n else env[:a_n]
    if d_n:
        env[a_n:a_n + d_n] = np.linspace(1, s, min(d_n, max(0, n - a_n)), endpoint=False)[: max(0, min(d_n, n - a_n))]
    if r_n and n > r_n:
        env[-r_n:] *= np.linspace(1, 0, r_n)
    return env


def pluck(freq: float, dur: float, rng: np.random.Generator) -> np.ndarray:
    """Karplus-Strong string."""
    n = int(dur * SR)
    period = max(2, int(SR / freq))
    buf = rng.uniform(-1, 1, period) * 0.5
    out = np.empty(n)
    for i in range(n):
        out[i] = buf[i % period]
        buf[i % period] = 0.5 * (buf[i % period] + buf[(i + 1) % period]) * 0.996
    return out * np.exp(-np.linspace(0, dur * 3.2, n))


def add(buf: np.ndarray, s0: int, w: np.ndarray, g: float = 1.0) -> None:
    """buf[s0:] += g * w, clipped to the buffer."""
    if s0 >= len(buf):
        return
    e = min(len(buf), s0 + len(w))
    buf[s0:e] += g * w[: e - s0]


def build_score(seconds: float, bpm: float, seed: int) -> np.ndarray:
    rng = np.random.default_rng(seed)
    n = int(seconds * SR) + SR
    L = np.zeros(n)
    R = np.zeros(n)
    beat = 60.0 / bpm
    bar = 4 * beat
    # D  A  Bm  G   (one chord per bar)
    chords = [[50, 57, 62, 66, 69], [45, 57, 61, 64, 69], [47, 54, 59, 62, 66], [43, 55, 59, 62, 67]]
    nbars = int(np.ceil(seconds / bar)) + 1
    t_bar = np.arange(int(bar * SR)) / SR
    for b in range(nbars):
        ch = chords[b % 4]
        start = int(b * bar * SR)
        seg = len(t_bar)
        # Pad: detuned sines with a slow swell, overlapping the next bar a little.
        pad_n = int((bar + 0.6) * SR)
        tp = np.arange(pad_n) / SR
        env = adsr(pad_n, 0.9, 0.4, 0.75, 0.9)
        padL = np.zeros(pad_n)
        padR = np.zeros(pad_n)
        for note in ch[1:]:
            f = midi(note)
            for det, pan in ((-0.12, 0.7), (0.0, 0.5), (0.12, 0.3)):
                w = np.sin(2 * np.pi * f * (1 + det / 100) * tp) + 0.18 * np.sin(2 * np.pi * 2 * f * tp)
                padL += w * pan
                padR += w * (1 - pan)
        gain = 0.022 * (0.55 if b < 2 else 1.0)
        add(L, start, padL * env, gain)
        add(R, start, padR * env, gain)
        if b < 1:
            continue
        # Bass: root on beats 1 and 3, round sine with a touch of 2nd harmonic.
        for k in (0, 2):
            s0 = start + int(k * beat * SR)
            dn = int(beat * 1.6 * SR)
            tb = np.arange(dn) / SR
            f = midi(ch[0] - 12 if ch[0] > 45 else ch[0])
            w = (np.sin(2 * np.pi * f * tb) + 0.25 * np.sin(4 * np.pi * f * tb)) * adsr(dn, 0.01, 0.2, 0.6, 0.3)
            add(L, s0, w, 0.085)
            add(R, s0, w, 0.085)
        if b < 2:
            continue
        # Pluck arpeggio on eighth notes, alternating pan.
        arp = [ch[2], ch[3], ch[4], ch[3] + 12 if b % 2 else ch[3], ch[2] + 12, ch[4], ch[3], ch[1] + 12]
        for k, note in enumerate(arp):
            s0 = start + int(k * beat / 2 * SR)
            p = pluck(midi(note), 0.9, rng)
            pan = 0.35 if k % 2 else 0.65
            add(L, s0, p, 0.05 * pan)
            add(R, s0, p, 0.05 * (1 - pan))
        # Kick on 1 and 3, shaker on off-beat sixteenths.
        for k in (0, 2):
            s0 = start + int(k * beat * SR)
            dn = int(0.32 * SR)
            tk = np.arange(dn) / SR
            ph = 2 * np.pi * np.cumsum(48 + 70 * np.exp(-tk * 30)) / SR
            w = np.sin(ph) * np.exp(-tk * 11)
            add(L, s0, w, 0.16)
            add(R, s0, w, 0.16)
        for k in range(16):
            if k % 2 == 0:
                continue
            s0 = start + int(k * beat / 4 * SR)
            dn = int(0.06 * SR)
            nz = rng.standard_normal(dn)
            nz = nz - np.concatenate(([0], nz[:-1]))  # crude high-pass
            w = nz * np.exp(-np.linspace(0, 6, dn))
            g = 0.010 if k % 4 == 3 else 0.006
            add(L, s0, w, g * 0.6)
            add(R, s0, w, g * 0.4)
    out = np.stack([L, R], axis=1)[: int(seconds * SR)]
    # Fade in 1.2 s, fade out over the last 2.2 s.
    fi, fo = int(1.2 * SR), int(2.2 * SR)
    out[:fi] *= np.linspace(0, 1, fi)[:, None]
    out[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return out


def add_hits(music: np.ndarray, times: list[float], seed: int) -> None:
    """A soft swell (low-passed noise, rising) into a round low thump at each time."""
    rng = np.random.default_rng(seed + 1)
    sw = int(0.55 * SR)
    for t in times:
        nz = rng.standard_normal(sw)
        lp = np.zeros(sw)
        acc = 0.0
        for i in range(sw):  # one-pole low-pass whose cutoff opens as the swell rises
            k = 0.02 + 0.25 * (i / sw) ** 2
            acc += k * (nz[i] - acc)
            lp[i] = acc
        swell = lp * (np.linspace(0, 1, sw) ** 2.2) * 0.9
        s0 = int(t * SR) - sw
        add(music[:, 0], max(0, s0), swell[max(0, -s0):], 0.05)
        add(music[:, 1], max(0, s0), swell[max(0, -s0):], 0.05)
        dn = int(0.6 * SR)
        tk = np.arange(dn) / SR
        ph = 2 * np.pi * np.cumsum(42 + 40 * np.exp(-tk * 18)) / SR
        th = np.sin(ph) * np.exp(-tk * 6.5)
        add(music[:, 0], int(t * SR), th, 0.14)
        add(music[:, 1], int(t * SR), th, 0.14)


def lufs(x: np.ndarray) -> float:
    """Integrated loudness (LUFS) of a stereo buffer, measured by ffmpeg's ebur128."""
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav") as f:
        sf.write(f.name, x.astype(np.float32), SR)
        log = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", f.name, "-af", "ebur128", "-f", "null", "-"],
                             capture_output=True, text=True).stderr
    return float(log[log.rfind("I:"):].split()[1])


def load_track(path: Path, offset: float, seconds: float) -> np.ndarray:
    """The track from `offset` s for `seconds`, 48 kHz stereo, with a short fade in and a 2.5 s fade out."""
    a, sr = sf.read(path, dtype="float64", always_2d=True)
    if sr != SR:
        idx = np.arange(int(len(a) * SR / sr)) * (sr / SR)
        a = np.stack([np.interp(idx, np.arange(len(a)), a[:, c]) for c in range(a.shape[1])], axis=1)
    if a.shape[1] == 1:
        a = np.repeat(a, 2, axis=1)
    n = int(seconds * SR)
    out = np.zeros((n, 2))
    s0 = int(offset * SR)
    src = a[max(0, s0):max(0, s0) + n - max(0, -s0)]
    out[max(0, -s0):max(0, -s0) + len(src)] = src
    fi, fo = int(0.8 * SR), int(2.5 * SR)
    out[:fi] *= np.linspace(0, 1, fi)[:, None]
    out[-fo:] *= np.linspace(1, 0, fo)[:, None]
    return out


def duck_envelope(n: int, spans: list[tuple[float, float]]) -> np.ndarray:
    g = np.ones(n)
    low = 10 ** (DUCK_DB / 20)
    for a, b in spans:
        a0, b0 = int((a - 0.15) * SR), int((b + 0.25) * SR)
        g[max(0, a0):min(n, b0)] = low
    # Smooth: 150 ms attack, 400 ms release (one-pole each way).
    out = np.empty(n)
    acc = 1.0
    att, rel = np.exp(-1 / (0.15 * SR)), np.exp(-1 / (0.4 * SR))
    for i in range(n):
        c = att if g[i] < acc else rel
        acc = c * acc + (1 - c) * g[i]
        out[i] = acc
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("out", type=Path)
    ap.add_argument("--seed", type=int, default=7)
    ap.add_argument("--hits", action="store_true", help="swell + thump on every scene change")
    ap.add_argument("--track", type=Path, help="a licence-cleared recording to use instead of the synthesized score")
    ap.add_argument("--bed-lu", type=float, default=16.0, help="how far (LU) the music bed sits under the narration")
    ap.add_argument("--duck", type=float, default=8.0, help="extra dB the track drops while the voice is on")
    ap.add_argument("--hit-offset", type=float, default=0.3)
    args = ap.parse_args()
    tl = json.loads((args.out / "timeline.json").read_text(encoding="utf-8"))
    seconds = tl["frames"] / tl["fps"]
    (args.out / "audio").mkdir(exist_ok=True)

    if args.track:
        music = load_track(args.track, tl.get("music_offset_s", 0.0), seconds)
    else:
        music = build_score(seconds, tl["bpm"], args.seed)
    if args.hits:
        add_hits(music, [s["start_frame"] / tl["fps"] + args.hit_offset for s in tl["scenes"][1:]], args.seed)
    sf.write(args.out / "audio" / "music.wav", music.astype(np.float32), SR)

    n = len(music)
    voice = np.zeros(n)
    spans = []
    for s in tl["scenes"]:
        a, sr = sf.read(args.out / s["vo_wav"], dtype="float64")
        if sr != SR:
            idx = np.arange(int(len(a) * SR / sr)) * (sr / SR)
            a = np.interp(idx, np.arange(len(a)), a)
        t0 = s["start_frame"] / tl["fps"] + s["vo_start_s"]
        add(voice, int(t0 * SR), a)
        spans.append((t0, t0 + len(a) / SR))
    if args.track:
        global DUCK_DB
        DUCK_DB = -args.duck
        gain = 10 ** ((lufs(voice[:, None].repeat(2, axis=1)) - args.bed_lu - lufs(music)) / 20)
        music = music * gain
        sf.write(args.out / "audio" / "music.wav", music.astype(np.float32), SR)
    duck = duck_envelope(n, spans)
    mix = music * duck[:, None] * 1.0 + voice[:, None] * 0.9
    raw = args.out / "audio" / "mix_raw.wav"
    sf.write(raw, mix.astype(np.float32), SR)

    # Two-pass loudnorm to -14 LUFS / -1.5 dBTP.
    first = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(raw), "-af",
                            "loudnorm=I=-14:TP=-3:LRA=11:print_format=json", "-f", "null", "-"],
                           capture_output=True, text=True)
    js = first.stderr[first.stderr.rfind("{"):first.stderr.rfind("}") + 1]
    m = json.loads(js)
    af = (f"loudnorm=I=-14:TP=-3:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
          f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true,"
          f"aresample={SR}")
    final = args.out / "audio" / "mix.wav"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(raw), "-af", af,
                    "-ar", str(SR), "-c:a", "pcm_s16le", str(final)], check=True)
    chk = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", str(final), "-af", "ebur128=peak=true",
                          "-f", "null", "-"], capture_output=True, text=True).stderr
    summary = chk[chk.rfind("Summary:"):]
    print(args.out.name, " ".join(summary.split())[:220])
    return 0


if __name__ == "__main__":
    sys.exit(main())
