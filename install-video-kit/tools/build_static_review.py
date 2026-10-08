#!/usr/bin/env python3
"""Bundle a project's review into a folder the Review Studio can open without the server.

    python tools/build_static_review.py <project> <out-dir> [--note "…"] [--fragment] [--proxy-mb 13]

Writes <out-dir>/index.html (the studio), <out-dir>/studio-static.json (every version's
manifest, eval report and feedback) and a copy of each version's cuts at the same relative
paths the manifests use. Serve the folder with any static web server, or publish it as a page,
and the studio opens it read-and-annotate: notes stay in the viewer's browser and are handed
over with Copy summary / Copy feedback.json.

--fragment writes index.html without its <!doctype>/<html>/<head>/<body> wrapper, for hosts
that add their own (claude.ai artifacts).

--proxy-mb N puts a review proxy of each cut in the bundle instead of the cut itself, for hosts that
cap file size: re-encoded (two-pass H.264, long edge 1280 px) to fit N MB, with the same frame rate and
exact frame count, so every note still lands on the same frame (note boxes are fractions of the
frame). The project's own cuts are untouched, and they stay the files publish_gate.py clears.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
REVIEW = KIT / "skills" / "ekena-install-video-review"
sys.path.insert(0, str(REVIEW / "scripts"))
import validate_review as vr  # noqa: E402


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def read_json(p: Path):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def strip_wrapper(html: str) -> str:
    html = re.sub(r"(?is)<!doctype[^>]*>\s*", "", html)
    html = re.sub(r"(?is)</?(html|head|body)\b[^>]*>\s*", "", html)
    html = re.sub(r'(?i)<meta\s+name="viewport"[^>]*>\s*', "", html)
    return html.lstrip()


def mark_bundle(html: str) -> str:
    """Tell the studio it is a bundled copy, so it loads studio-static.json instead of asking a server."""
    tag = '<script>window.REVIEW_BUNDLE = "studio-static.json";</script>\n'
    i = html.rfind("<script>")
    return html[:i] + tag + html[i:]


def probe(path: Path, entries: str, stream: str = "v:0") -> str:
    return subprocess.run(["ffprobe", "-v", "error", "-select_streams", stream, "-count_frames",
                           "-show_entries", entries, "-of", "csv=p=0", str(path)],
                          capture_output=True, text=True, check=True).stdout.strip()


def make_proxy(src: Path, dest: Path, max_mb: float, fps: int, frames: int) -> None:
    """Two-pass encode sized to fit max_mb (H.264, or VP9 for .webm), long edge 1280, same fps and frame count."""
    dur = frames / fps
    has_audio = bool(subprocess.run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries",
                                     "stream=index", "-of", "csv=p=0", str(src)], capture_output=True, text=True).stdout.strip())
    a_kbps = 96 if has_audio else 0
    v_kbps = max(200, int(max_mb * 8000 * 0.94 / dur) - a_kbps)
    w, h = (int(x) for x in probe(src, "stream=width,height").split(",")[:2])
    scale = "scale=1280:-2" if w >= h else "scale=-2:1280"
    webm = dest.suffix.lower() == ".webm"  # keep the container the manifest names
    for attempt in range(5):
        with tempfile.TemporaryDirectory() as tmp:
            common = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(src),
                      "-vf", f"{scale}:flags=lanczos", "-r", str(fps), "-frames:v", str(frames)]
            if webm:  # VP9 two-pass stumbles on a frame limit, so one constrained-bitrate pass
                subprocess.run(common + ["-c:v", "libvpx-vp9", "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
                                         "-b:v", f"{v_kbps}k", "-maxrate", f"{int(v_kbps * 1.3)}k", "-minrate", f"{v_kbps // 2}k"]
                               + (["-c:a", "libopus", "-b:a", f"{a_kbps}k"] if has_audio else ["-an"]) + [str(dest)], check=True)
            else:
                x264 = ["-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p", "-b:v", f"{v_kbps}k",
                        "-maxrate", f"{int(v_kbps * 1.6)}k", "-bufsize", f"{v_kbps * 3}k", "-passlogfile", str(Path(tmp) / "pass")]
                subprocess.run(common + x264 + ["-pass", "1", "-an", "-f", "mp4", "/dev/null"], check=True)
                subprocess.run(common + x264 + ["-pass", "2"] + (["-c:a", "aac", "-b:a", f"{a_kbps}k"] if has_audio else ["-an"])
                               + ["-movflags", "+faststart", str(dest)], check=True)
        if dest.stat().st_size <= max_mb * 1e6 or v_kbps <= 200:
            break
        v_kbps = max(200, int(v_kbps * 0.85))  # over budget: step the bitrate down and go again
    got = int(probe(dest, "stream=nb_read_frames"))
    if got != frames:
        raise SystemExit(f"proxy of {src.name} has {got} frames, expected {frames}")
    size = dest.stat().st_size / 1e6
    if size > max_mb:
        raise SystemExit(f"proxy of {src.name} is {size:.1f} MB, over the {max_mb} MB budget")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--note", help="the banner shown at the top of the bundled copy")
    ap.add_argument("--fragment", action="store_true", help="leave out the document wrapper")
    ap.add_argument("--proxy-mb", type=float, help="bundle a review proxy of each cut, sized to fit this many MB")
    args = ap.parse_args(argv)

    root = args.project.resolve()
    vdirs = sorted((d for d in (root / "review").iterdir() if (d / "manifest.json").is_file()),
                   key=lambda d: natural_key(d.name)) if (root / "review").is_dir() else []
    if not vdirs:
        raise SystemExit(f"no versions under {root / 'review'}")
    args.out.mkdir(parents=True, exist_ok=True)
    versions, data, media = [], {}, []
    name = root.name
    for d in vdirs:
        m = read_json(d / "manifest.json")
        res = vr.validate_manifest(m, version_dir=d.name) if m is not None else None
        if res is None or not res.ok:
            raise SystemExit(f"{d.name}/manifest.json has errors: {res.errors if res else 'not JSON'}")
        ev, fb = read_json(d / "eval-report.json"), read_json(d / "feedback.json")
        name = m.get("project") or name
        versions.append({"id": d.name, "project": m.get("project"), "created": m.get("created"),
                         "previous": m.get("previous"), "readable": True, "has_eval": ev is not None,
                         "eval_overall": (ev or {}).get("overall"), "has_feedback": fb is not None,
                         "approved": bool((fb or {}).get("approved")), "submitted": bool((fb or {}).get("submitted"))})
        data[d.name] = {"manifest": m, "manifest_errors": [], "manifest_warnings": res.warnings, "eval": ev, "feedback": fb}
        for c in m["cuts"]:
            src = root / c["file"]
            if not src.is_file():
                raise SystemExit(f"{d.name}: {c['file']} is missing")
            dest = args.out / c["file"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            if args.proxy_mb:
                make_proxy(src, dest, args.proxy_mb, m["fps"], m["frame_count"])
            else:
                shutil.copy2(src, dest)
            media.append(f"{c['file']}  ({dest.stat().st_size / 1e6:.1f} MB{', proxy' if args.proxy_mb else ''})")
    bundle = {"schema": "ekena-install-static/1", "name": name, "folder": root.name,
              "note": args.note, "versions": versions, "data": data}
    (args.out / "studio-static.json").write_text(json.dumps(bundle, ensure_ascii=False), encoding="utf-8")
    html = (REVIEW / "assets" / "studio.html").read_text(encoding="utf-8")
    html = mark_bundle(html)
    (args.out / "index.html").write_text(strip_wrapper(html) if args.fragment else html, encoding="utf-8")
    print(f"wrote {args.out}/index.html, studio-static.json and {len(media)} video file(s):")
    for f in media:
        print(f"  {f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
