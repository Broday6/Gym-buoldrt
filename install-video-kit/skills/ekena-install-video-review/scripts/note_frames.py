#!/usr/bin/env python3
"""See exactly what Brody saw: the frame each note is pinned to, with Brody's box drawn on it.

    python note_frames.py <project> <version>                  # every note in feedback.json
    python note_frames.py <project> <version> --notes v7-n1,v7-n4
    python note_frames.py <project> <version> --frame 734 --cut 16x9 [--box 0.41,0.22,0.12,0.18]

For each note it decodes, by frame number from that version's delivered cut:
  review/<version>/builder/<note>.jpg        the note's frame, full size, box in yellow
  review/<version>/builder/<note>_strip.jpg  five frames around it, to see the motion
and prints the note beside the paths. Output goes in review/<version>/builder/, which belongs to the
builder. Never write into eval/: that is the evaluator's evidence.
Needs ffmpeg (on PATH, or --ffmpeg, or the FFMPEG variable). Standard library only.
"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


def ffmpeg_exe(override: str | None) -> str:
    exe = override or os.environ.get("FFMPEG") or "ffmpeg"
    if shutil.which(exe) is None and not Path(exe).exists():
        raise SystemExit("ffmpeg not found: put it on PATH, set FFMPEG, or pass --ffmpeg")
    return exe


def grab(ffmpeg: str, src: Path, frames: list[int], box, out: Path, width: int | None) -> None:
    frames = sorted(set(frames))
    chain = ["select='" + "+".join(f"eq(n\\,{f})" for f in frames) + "'"]
    if box:
        x, y, w, h = box
        chain.append(f"drawbox=x=iw*{x}:y=ih*{y}:w=iw*{w}:h=ih*{h}:color=yellow@1:t=max(3\\,ih/180)")
    if width:
        chain.append(f"scale={width}:-2")
    if len(frames) > 1:
        chain.append(f"tile={len(frames)}x1:padding=6:color=0x121413")
    base = [ffmpeg, "-y", "-hide_banner", "-nostats", "-v", "error", "-i", str(src), "-vf", ",".join(chain),
            "-frames:v", "1", "-q:v", "2"]
    out.parent.mkdir(parents=True, exist_ok=True)
    for sync in (["-fps_mode", "passthrough"], ["-vsync", "0"]):  # the second for ffmpeg older than 5.1
        proc = subprocess.run(base + sync + [str(out)], capture_output=True, text=True)
        if proc.returncode == 0 and out.exists():
            return
    raise SystemExit(f"ffmpeg could not extract frame(s) {frames} from {src.name}:\n{proc.stderr[-800:]}")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--notes", help="comma-separated note ids (default: all notes in feedback.json)")
    ap.add_argument("--frame", type=int, help="a single frame instead of notes")
    ap.add_argument("--cut", help="cut id for --frame (default: the first cut)")
    ap.add_argument("--box", help="x,y,w,h as fractions of the frame, for --frame")
    ap.add_argument("--step", type=int, default=6, help="frames between strip frames")
    ap.add_argument("--ffmpeg")
    args = ap.parse_args(argv)

    vdir = args.project / "review" / args.version
    m = json.loads((vdir / "manifest.json").read_text(encoding="utf-8"))
    cuts = {c["id"]: c for c in m["cuts"]}
    scenes = {s["id"]: s for s in m["scenes"]}
    ff = ffmpeg_exe(args.ffmpeg)
    out_dir = vdir / "builder"
    last = m["frame_count"] - 1

    def strip_frames(f: int) -> list[int]:
        return [min(last, max(0, f + k * args.step)) for k in (-2, -1, 0, 1, 2)]

    if args.frame is not None:
        cut = cuts.get(args.cut) if args.cut else m["cuts"][0]
        if cut is None:
            raise SystemExit(f"no cut {args.cut!r}; this version has {', '.join(cuts)}")
        box = tuple(float(v) for v in args.box.split(",")) if args.box else None
        if box is not None and len(box) != 4:
            raise SystemExit("--box needs four numbers: x,y,w,h")
        src = args.project / cut["file"]
        name = f"{cut['id']}_f{args.frame:06d}"
        grab(ff, src, [args.frame], box, out_dir / f"{name}.jpg", None)
        grab(ff, src, strip_frames(args.frame), box, out_dir / f"{name}_strip.jpg", 420)
        print(f"{out_dir / name}.jpg\n{out_dir / name}_strip.jpg")
        return 0

    fb_path = vdir / "feedback.json"
    if not fb_path.exists():
        raise SystemExit(f"no feedback yet for {args.version} ({fb_path})")
    fb = json.loads(fb_path.read_text(encoding="utf-8"))
    want = set(args.notes.split(",")) if args.notes else None
    notes = [n for n in fb.get("notes", []) if want is None or n["id"] in want]
    if want and len(notes) != len(want):
        missing = want - {n["id"] for n in notes}
        raise SystemExit(f"no such note(s): {', '.join(sorted(missing))}")
    for n in sorted(notes, key=lambda x: x["frame"]):
        cut = cuts.get(n["cut"]) or m["cuts"][0]
        r = n.get("region")
        box = (r["x"], r["y"], r["w"], r["h"]) if r else None
        src = args.project / cut["file"]
        grab(ff, src, [n["frame"]], box, out_dir / f"{n['id']}.jpg", None)
        grab(ff, src, strip_frames(n["frame"]), box, out_dir / f"{n['id']}_strip.jpg", 420)
        s = scenes.get(n["scene"], {})
        src_info = s.get("source") or {}
        print(f"{n['id']} [{n['priority']}, {n['category']}] f{n['frame']} {cut['id']} · {n['scene']} {s.get('title', '')}"
              + (f" · action {n['action']}" if n.get("action") else ""))
        print(f"    {n['text']}")
        if src_info:
            print(f"    code: {', '.join(src_info.get('files') or [])}"
                  + (f" · timeline: {', '.join(src_info.get('timeline_keys') or [])}" if src_info.get("timeline_keys") else ""))
        print(f"    {out_dir / n['id']}.jpg   {out_dir / n['id']}_strip.jpg")
    if not notes:
        print("no notes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
