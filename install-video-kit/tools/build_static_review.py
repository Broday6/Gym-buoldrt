#!/usr/bin/env python3
"""Bundle a project's review into a folder the Review Studio can open without the server.

    python tools/build_static_review.py <project> <out-dir> [--note "…"] [--fragment]

Writes <out-dir>/index.html (the studio), <out-dir>/studio-static.json (every version's
manifest, eval report and feedback) and a copy of each version's cuts at the same relative
paths the manifests use. Serve the folder with any static web server, or publish it as a page,
and the studio opens it read-and-annotate: notes stay in the viewer's browser and are handed
over with Copy summary / Copy feedback.json.

--fragment writes index.html without its <!doctype>/<html>/<head>/<body> wrapper, for hosts
that add their own (claude.ai artifacts).
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
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


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("out", type=Path)
    ap.add_argument("--note", help="the banner shown at the top of the bundled copy")
    ap.add_argument("--fragment", action="store_true", help="leave out the document wrapper")
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
            shutil.copy2(src, dest)
            media.append(c["file"])
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
