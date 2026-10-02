#!/usr/bin/env python3
"""Technical checks on every cut of a version, run on the delivered files themselves.

    python tech_checks.py <project> <version>

Checks each cut against its manifest: codec, size, frame rate, exact frame count and length,
audio present and in sync, loudness (default −14 ±1 LUFS integrated, true peak ≤ −1 dBTP),
no decode errors, no black frames outside scenes marked black_ok, no freezes outside scenes
marked static_ok, and every hard cut landing exactly on a scene boundary. It also checks that
the cuts match each other in length.

Writes review/<version>/eval/technical.json and exits 1 if any check fails. Warnings, such
as an unexpected cut that may be a flash, are reported but do not fail.
Needs ffmpeg and ffprobe (on PATH, or via --ffmpeg/--ffprobe or the FFMPEG/FFPROBE variables).
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evalkit import (EvalError, cut_path, ffprobe_json, frac, load_version, run, tool,  # noqa: E402
                     write_json)

BLACK_RE = re.compile(r"black_start:\s*([\d.]+)\s+black_end:\s*([\d.]+)")
FREEZE_START_RE = re.compile(r"freeze_start:\s*([\d.]+)")
FREEZE_END_RE = re.compile(r"freeze_end:\s*([\d.]+)")
SHOWINFO_RE = re.compile(r"Parsed_showinfo.*?\bn:\s*\d+\s+pts:\s*\d+\s+pts_time:\s*([\d.]+)")
LUFS_RE = re.compile(r"^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS", re.M)
PEAK_RE = re.compile(r"True peak:\s*\n\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS", re.M)


class Checks:
    def __init__(self) -> None:
        self.items: list[dict] = []

    def add(self, cid: str, ok: bool, detail: str, cut: str | None = None, frames=None, warn_only=False):
        self.items.append({
            "id": cid, "cut": cut, "pass": bool(ok or warn_only),
            "severity": "warning" if (warn_only and not ok) else ("info" if ok else "error"),
            "detail": detail, "frames": frames,
        })


def scenes_covering(m: dict, a: int, b: int) -> list[dict]:
    return [s for s in m["scenes"] if s["start_frame"] <= b and a < s["end_frame"]]


def analyse(ffmpeg: str, path: Path, scene_threshold: float, black_s: float, black_pix: float,
            freeze_s: float, freeze_noise: str) -> dict:
    vf = (f"blackdetect=d={black_s}:pix_th={black_pix},"
          f"freezedetect=n={freeze_noise}:d={freeze_s},"
          f"select='gt(scene\\,{scene_threshold})',showinfo")
    proc = run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path),
                "-filter_complex", f"[0:v]{vf}[v];[0:a]ebur128=peak=true:framelog=verbose[a]",
                "-map", "[v]", "-map", "[a]", "-f", "null", "-"], check=False)
    log = proc.stderr
    if proc.returncode != 0 and "Integrated loudness" not in log:
        raise EvalError(f"ffmpeg could not analyse {path.name}:\n" + "\n".join(log.splitlines()[-10:]))
    blacks = [(float(a), float(b)) for a, b in BLACK_RE.findall(log)]
    starts = [float(x) for x in FREEZE_START_RE.findall(log)]
    ends = [float(x) for x in FREEZE_END_RE.findall(log)]
    freezes = []
    for i, st in enumerate(starts):
        freezes.append((st, ends[i] if i < len(ends) else None))  # None: frozen until the end
    cuts = [float(t) for t in SHOWINFO_RE.findall(log)]
    summary = log[log.rfind("Summary:"):] if "Summary:" in log else ""
    lufs = LUFS_RE.search(summary)
    peak = PEAK_RE.search(summary)
    tofloat = lambda v: float("-inf") if v == "-inf" else float(v)  # noqa: E731
    return {
        "blacks": blacks, "freezes": freezes, "cuts": cuts,
        "lufs": tofloat(lufs.group(1)) if lufs else None,
        "true_peak": tofloat(peak.group(1)) if peak else None,
    }


def check_cut(args, project: Path, m: dict, cut: dict, ffmpeg: str, ffprobe: str, ck: Checks) -> dict:
    cid = cut["id"]
    fps = m["fps"]
    path = cut_path(project, cut)
    if not path.is_file() or path.stat().st_size == 0:
        ck.add("file", False, f"{cut['file']} is missing or empty", cid)
        return {"file": cut["file"], "readable": False}

    probe = ffprobe_json(ffprobe, path, "-count_frames", "-select_streams", "v:0", "-show_entries",
                         "stream=codec_name,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,pix_fmt:format=duration")
    streams = probe.get("streams") or []
    if not streams:
        ck.add("video_stream", False, f"{cut['file']} has no video stream", cid)
        return {"file": cut["file"], "readable": False}
    v = streams[0]
    dur = frac((probe.get("format") or {}).get("duration"))
    codec = v.get("codec_name")
    want = args.expect_codec
    ck.add("codec", want == "any" or codec == want, f"{codec}" + ("" if want in ("any", codec) else f" (expected {want})"), cid)
    w, h = v.get("width"), v.get("height")
    ck.add("resolution", (w, h) == (cut["width"], cut["height"]),
           f"{w}×{h}" + ("" if (w, h) == (cut["width"], cut["height"]) else f" (manifest says {cut['width']}×{cut['height']})"), cid)
    rate = frac(v.get("r_frame_rate")) or frac(v.get("avg_frame_rate"))
    ck.add("frame_rate", rate is not None and abs(rate - fps) < 1e-3,
           f"{rate:g} fps" if rate else "unknown frame rate", cid)
    n = int(v.get("nb_read_frames") or 0)
    ck.add("frame_count", n == m["frame_count"],
           f"{n} frames" + ("" if n == m["frame_count"] else f" (manifest says {m['frame_count']}; off by {n - m['frame_count']:+d})"), cid)
    expect_s = m["frame_count"] / fps
    if dur is not None:
        ok = abs(dur - expect_s) <= 1.0 / fps + 1e-6
        ck.add("duration", ok, f"{dur:.3f} s" + ("" if ok else f" (expected {expect_s:.3f} s)"), cid)

    aprobe = ffprobe_json(ffprobe, path, "-select_streams", "a:0", "-show_entries",
                          "stream=codec_name,sample_rate,channels,duration")
    astreams = aprobe.get("streams") or []
    if not astreams:
        ck.add("audio_stream", False, "no audio stream", cid)
    else:
        a = astreams[0]
        adur = frac(a.get("duration"))
        ok = adur is None or abs(adur - expect_s) <= args.audio_tolerance_s
        ck.add("audio_sync", ok, f"{a.get('codec_name')} {a.get('sample_rate')} Hz × {a.get('channels')}, "
               + (f"{adur:.3f} s" if adur else "length unknown")
               + ("" if ok else f" vs picture {expect_s:.3f} s"), cid)

    dec = run([ffmpeg, "-hide_banner", "-nostats", "-v", "error", "-i", str(path), "-f", "null", "-"], check=False)
    errs = [ln for ln in dec.stderr.splitlines() if ln.strip()]
    ck.add("decode", dec.returncode == 0 and not errs,
           "decodes cleanly" if not errs else f"{len(errs)} decoder error(s): {errs[0][:160]}", cid)

    an = analyse(ffmpeg, path, args.cut_threshold, args.black_s, args.black_pix, args.freeze_s, args.freeze_noise)

    if astreams:
        lufs, peak = an["lufs"], an["true_peak"]
        if lufs is None:
            ck.add("loudness", False, "could not measure loudness", cid)
        else:
            ok = abs(lufs - args.lufs) <= args.lufs_tolerance
            ck.add("loudness", ok, f"{lufs:.1f} LUFS integrated (target {args.lufs:g} ±{args.lufs_tolerance:g})", cid)
        if peak is not None:
            ok = peak <= args.true_peak
            ck.add("true_peak", ok, f"{peak:.1f} dBTP (limit {args.true_peak:g})", cid)

    to_f = lambda t: int(round(t * fps))  # noqa: E731
    bad_black = []
    for a, b in an["blacks"]:
        fa, fb = to_f(a), max(to_f(a), to_f(b) - 1)
        cover = scenes_covering(m, fa, fb)
        if not cover or not all(s.get("black_ok") for s in cover):
            bad_black.append([fa, fb])
    ck.add("black_frames", not bad_black,
           "none outside black_ok scenes" if not bad_black else
           "black at " + ", ".join(f"f{a}–{b}" for a, b in bad_black[:6]), cid,
           frames=bad_black[0] if bad_black else None)

    bad_freeze = []
    for a, b in an["freezes"]:
        fa = to_f(a)
        fb = m["frame_count"] - 1 if b is None else max(fa, to_f(b) - 1)
        cover = scenes_covering(m, fa, fb)
        if not cover or not all(s.get("static_ok") for s in cover):
            bad_freeze.append([fa, fb, ",".join(s["id"] for s in cover)])
    ck.add("frozen_frames", not bad_freeze,
           f"no freeze ≥ {args.freeze_s:g} s outside static_ok scenes" if not bad_freeze else
           "frozen " + ", ".join(f"f{a}–{b} ({sc}, {(b - a + 1) / fps:.2f} s)" for a, b, sc in bad_freeze[:6]), cid,
           frames=bad_freeze[0][:2] if bad_freeze else None)

    boundaries = {s["start_frame"]: s for s in m["scenes"] if s["start_frame"] > 0}
    detected = sorted({to_f(t) for t in an["cuts"] if to_f(t) > 0})
    off, stray = [], []
    for c in detected:
        near = min(boundaries, key=lambda b: abs(b - c)) if boundaries else None
        if near is not None and c == near:
            continue
        if near is not None and abs(c - near) <= args.cut_window:
            off.append((c, near))
        else:
            stray.append(c)
    ck.add("cuts_on_frame", not off,
           f"{len(detected)} hard cut(s), all on scene boundaries" if not off else
           "; ".join(f"cut at f{c} is {c - b:+d} frame(s) from {boundaries[b]['id']} (f{b})" for c, b in off), cid,
           frames=[off[0][0], off[0][0]] if off else None)
    if stray:
        ck.add("unexpected_cuts", False,
               "hard cut or flash away from any boundary at " + ", ".join(f"f{c}" for c in stray[:8]), cid,
               frames=[stray[0], stray[0]], warn_only=True)
    missing = [s for b, s in boundaries.items() if s.get("transition_in") == "cut"
               and not any(abs(c - b) <= args.cut_window for c in detected)]
    if missing:
        ck.add("expected_cuts", False,
               "no hard cut detected where the manifest expects one: " + ", ".join(f"{s['id']} (f{s['start_frame']})" for s in missing),
               cid, frames=[missing[0]["start_frame"], missing[0]["start_frame"]], warn_only=True)

    return {"file": cut["file"], "readable": True, "codec": codec, "width": w, "height": h, "fps": rate,
            "frames": n, "duration_s": dur, "lufs": an["lufs"], "true_peak": an["true_peak"],
            "cuts_detected": detected, "freezes": an["freezes"], "blacks": an["blacks"]}


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--out", type=Path, help="default: review/<version>/eval/technical.json")
    ap.add_argument("--expect-codec", default="h264", help="video codec every cut must use, or 'any'")
    ap.add_argument("--lufs", type=float, default=-14.0)
    ap.add_argument("--lufs-tolerance", type=float, default=1.0)
    ap.add_argument("--true-peak", type=float, default=-1.0, help="highest allowed true peak, dBTP")
    ap.add_argument("--audio-tolerance-s", type=float, default=0.05,
                    help="allowed audio/picture length difference (AAC adds a few ms of priming)")
    ap.add_argument("--black-s", type=float, default=0.1, help="shortest black run to report")
    ap.add_argument("--black-pix", type=float, default=0.10, help="pixel level that counts as black (0–1)")
    ap.add_argument("--freeze-s", type=float, default=1.0, help="shortest freeze to report")
    ap.add_argument("--freeze-noise", default="-60dB", help="freezedetect noise tolerance")
    ap.add_argument("--cut-threshold", type=float, default=0.35, help="scene-change score that counts as a hard cut")
    ap.add_argument("--cut-window", type=int, default=3, help="frames either side of a boundary that count as 'meant for it'")
    ap.add_argument("--ffmpeg")
    ap.add_argument("--ffprobe")
    args = ap.parse_args(argv)
    try:
        ffmpeg, ffprobe = tool("ffmpeg", args.ffmpeg), tool("ffprobe", args.ffprobe)
        m, vdir = load_version(args.project, args.version)
        ck = Checks()
        cuts = {}
        for cut in m["cuts"]:
            print(f"checking {cut['id']} ({cut['file']}) …", flush=True)
            cuts[cut["id"]] = check_cut(args, args.project, m, cut, ffmpeg, ffprobe, ck)
        readable = [c for c in cuts.values() if c.get("readable")]
        if len(readable) > 1:
            frames = {c["frames"] for c in readable}
            ck.add("cuts_match", len(frames) == 1,
                   "all cuts have the same frame count" if len(frames) == 1 else
                   "cuts differ in length: " + ", ".join(f"{k} {v.get('frames')}" for k, v in cuts.items()))
    except EvalError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    ok = all(c["pass"] for c in ck.items)
    report = {"schema": "ekena-install-tech/1", "version": args.version, "pass": ok,
              "thresholds": {"lufs": args.lufs, "lufs_tolerance": args.lufs_tolerance, "true_peak": args.true_peak,
                             "freeze_s": args.freeze_s, "black_s": args.black_s, "cut_threshold": args.cut_threshold},
              "checks": ck.items, "cuts": cuts}
    out = args.out or (vdir / "eval" / "technical.json")
    write_json(out, report)
    for c in ck.items:
        mark = "✓" if c["severity"] == "info" else ("!" if c["severity"] == "warning" else "✗")
        print(f"  {mark} {(c['cut'] + ' ') if c['cut'] else ''}{c['id']}: {c['detail']}")
    print(f"{'PASS' if ok else 'FAIL'} — wrote {out}")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
