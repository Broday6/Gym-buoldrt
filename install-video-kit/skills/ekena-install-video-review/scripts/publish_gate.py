#!/usr/bin/env python3
"""The check every install video passes before it is published anywhere.

    python publish_gate.py <project>                       # the latest version
    python publish_gate.py <project> --version v8 --file out/ekena-beam-75s.mp4 [--file …]

A version is cleared only when:
  1. its manifest is valid and every cut it lists is on disk;
  2. the evaluator passed it (review/<v>/eval-report.json, overall "pass"), after the manifest
     was last written;
  3. Brody approved it in the Review Studio (review/<v>/feedback.json, approved: true);
  4. no newer version exists (pass --allow-older to publish an older approved one on purpose);
  5. every --file you are about to publish is byte-for-byte one of the approved cuts, so a
     re-render made after approval can't go out unreviewed.

On success it writes review/<v>/release.json (version, approval time, sha256 of every cut) and
exits 0. Otherwise it prints what is missing and exits 1: don't publish.
Standard library only, Python 3.8+.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_review as vr  # noqa: E402


def natural_key(s: str):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", s)]


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("--version", help="default: the latest version under review/")
    ap.add_argument("--file", action="append", default=[], type=Path,
                    help="a file you are about to publish (repeat for each); must match an approved cut")
    ap.add_argument("--allow-older", action="store_true", help="publish an approved version that is not the latest")
    args = ap.parse_args(argv)

    review = args.project / "review"
    versions = sorted((d.name for d in review.iterdir() if (d / "manifest.json").is_file()),
                      key=natural_key) if review.is_dir() else []
    if not versions:
        print(f"BLOCKED: nothing has been through review: no versions under {review}")
        return 1
    vid = args.version or versions[-1]
    if vid not in versions:
        print(f"BLOCKED: no version {vid!r} under {review} (have: {', '.join(versions)})")
        return 1
    vdir = review / vid
    problems: list[str] = []

    m = read_json(vdir / "manifest.json")
    res = vr.validate_manifest(m, version_dir=vid) if m is not None else None
    if res is None or not res.ok:
        problems.append(f"{vid}/manifest.json is not valid" + (f": {res.errors[0]}" if res and res.errors else ""))
        m = None

    cuts = []
    if m:
        for c in m["cuts"]:
            p = args.project / c["file"]
            if not p.is_file():
                problems.append(f"cut {c['id']} is missing: {c['file']}")
            else:
                cuts.append({"cut": c["id"], "path": c["file"], "bytes": p.stat().st_size, "sha256": sha256(p)})

    ev = read_json(vdir / "eval-report.json")
    if ev is None:
        problems.append(f"the evaluator hasn't checked {vid} (no eval-report.json)")
    else:
        if ev.get("version") != vid:
            problems.append(f"eval-report.json is for {ev.get('version')!r}, not {vid}")
        if ev.get("overall") != "pass":
            blockers = [f for f in ev.get("findings") or [] if f.get("severity") == "blocker"]
            problems.append(f"the evaluator failed {vid}" + (f" ({len(blockers)} blocker(s))" if blockers else ""))
        if (vdir / "manifest.json").stat().st_mtime > (vdir / "eval-report.json").stat().st_mtime + 1:
            problems.append(f"{vid}/manifest.json changed after the evaluation; evaluate it again")

    fb = read_json(vdir / "feedback.json")
    if not fb or not fb.get("approved"):
        problems.append(f"Brody hasn't approved {vid} in the Review Studio")

    newer = versions[versions.index(vid) + 1:]
    if newer and not args.allow_older:
        problems.append(f"{vid} isn't the latest version ({', '.join(newer)} came after it); "
                        "publish the latest, or pass --allow-older if this is deliberate")

    approved = {c["sha256"]: c for c in cuts}
    published = []
    for f in args.file:
        if not f.is_file():
            problems.append(f"file to publish not found: {f}")
            continue
        digest = sha256(f)
        match = approved.get(digest)
        if match is None:
            problems.append(f"{f} is not one of the approved {vid} cuts (different bytes: re-rendered or edited "
                            "after approval?). Publish the approved file, or put this one through review")
        else:
            published.append({"file": str(f), "cut": match["cut"], "sha256": digest})

    if problems:
        print(f"BLOCKED: {m['project'] if m else args.project.name} {vid} is not cleared for publishing:")
        for p in problems:
            print(f"  - {p}")
        return 1

    release = {
        "version": vid, "project": m["project"],
        "cleared_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "approved_at": fb.get("approved_at"), "evaluated_at": ev.get("evaluated_at"),
        "cuts": cuts, "published_files": published,
    }
    (vdir / "release.json").write_text(json.dumps(release, indent=2) + "\n", encoding="utf-8")
    print(f"CLEARED: {m['project']} {vid} (evaluator pass, approved {fb.get('approved_at') or ''}).")
    for c in cuts:
        print(f"  {c['cut']}: {c['path']}  sha256 {c['sha256'][:12]}…")
    print(f"wrote {vdir / 'release.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
