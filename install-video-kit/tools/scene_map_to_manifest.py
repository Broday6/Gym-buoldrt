#!/usr/bin/env python3
"""Turn the beam build's scene map + timeline into a review manifest.

    python tools/scene_map_to_manifest.py <project> <version> \\
        --scene-map build/scene-map.json --timeline build/timeline.json \\
        --cut 16x9=renders/v1/ekena-faux-beams-easy-install-75s.mp4:1920x1080 \\
        [--cut 9x16=renders/v1/ekena-faux-beams-easy-install-75s-vertical.mp4:1080x1920] \\
        [--previous v0] [--install-guide research/install-guide.pdf]

The scene map gives each delivered scene's frames, the remap knots from the 48 s design grid
(timeline.json) to the delivered frames, and the narration timing. Timeline events are moved
onto delivered frames through those knots and attached to the scene they fall in: one action per
moment (each saw stroke, each screw), a range where the timeline gives [start, end].
Writes review/<version>/manifest.json and validates it. All paths are relative to <project>.
"""
from __future__ import annotations

import argparse
import json
import sys
from bisect import bisect_right
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(KIT / "skills" / "ekena-install-video-review" / "scripts"))
import validate_review as vr  # noqa: E402

# Timeline keys whose two values are a start and an end, not two separate moments.
RANGES = {"glue_block", "screw_up", "ripple", "beads", "screw_ripple", "caulk_run"}
# Scene starts repeat as timeline keys; they are scenes, not actions.
LABELS = {
    "title1": "Title line 1 in", "title2": "Title line 2 in", "rewind": "Rewind into the title",
    "titlecard": "Title card", "snaps": "Chalk-line snap", "glue_block": "Glue on the block",
    "screw_up": "Screw the block into the joist", "ripple": "Blocks ripple along the line",
    "toggle": "Toggle bolt (no joist)", "measure": "Measure the opening", "saw": "Saw stroke",
    "offcut": "Offcut falls", "offcut_land": "Offcut lands", "beads": "Adhesive beads on the top edges",
    "block_glue": "Adhesive on the blocks", "spring": "Beam springs tight over the blocks",
    "screws": "Trim screw", "screw_ripple": "Screws repeat along the beam", "caulk_run": "Caulk run",
    "holes": "Caulk a screw hole", "slams": "Payoff slam", "done": "Done", "tagline": "Tagline",
    "guide": "Guide URL", "fine": "Fine print", "out": "Fade out", "block_rise": "Block rises to the ceiling",
}
KINDS = {"hook": "other", "title": "title", "payoff": "other", "end": "end"}
TITLES = {
    "hook": "Hook", "title": "Title", "acclimate": "Acclimate the beams", "mark": "Mark the beam lines",
    "blockcut": "Cut the blocks", "blockfix": "Glue and screw the blocks", "spacing": "Block spacing",
    "trim": "Cut the beam to length", "glue": "Adhesive on the beam", "lift": "Lift the beam over the blocks",
    "fasten": "Fasten with trim screws", "caulk": "Caulk the seams and screw heads", "payoff": "Payoff",
    "end": "End card",
}


def remapper(knots: list[list[int]]):
    """design frame -> delivered frame, piecewise-linear through the scene map's knots."""
    pairs = sorted((d, D) for D, d in knots)
    ds = [d for d, _ in pairs]

    def f(design: float) -> int:
        i = max(0, min(len(pairs) - 2, bisect_right(ds, design) - 1))
        (d0, D0), (d1, D1) = pairs[i], pairs[i + 1]
        return round(D0 + (design - d0) * (D1 - D0) / (d1 - d0))
    return f


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--scene-map", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--cut", action="append", required=True, help="id=path:WxH, relative to the project")
    ap.add_argument("--previous")
    ap.add_argument("--project-name", default="Ekena Faux Wood Beams — Easy Install (75 s)")
    ap.add_argument("--install-guide")
    ap.add_argument("--house-rules")
    args = ap.parse_args(argv)

    sm = json.loads((args.project / args.scene_map).read_text(encoding="utf-8"))
    tl = json.loads((args.project / args.timeline).read_text(encoding="utf-8"))
    fps, total = sm["fps"], sm["frames"]
    to_delivered = remapper(sm["remap_knots_delivered_to_design"])
    scene_starts = {s["name"]: s for s in sm["scenes"]}

    scenes = []
    for s in sm["scenes"]:
        a, b = s["frames"]
        lines = [v["text"] for v in sm.get("vo", []) if a <= round(v["start_s"] * fps) < b]
        scenes.append({"id": s["name"], "title": TITLES.get(s["name"], s["name"].title()),
                       "kind": KINDS.get(s["name"], "step"), "start_frame": a, "end_frame": b,
                       "step_card": None, "narration": " ".join(lines) or None, "claims": [],
                       "static_ok": s["name"] in ("title", "end"), "actions": [],
                       "source": {"files": [], "timeline_keys": [], "scene_map": f"{args.scene_map}#{s['name']}"}})

    def scene_for(frame: int):
        for s in scenes:
            if s["start_frame"] <= frame < s["end_frame"]:
                return s
        return scenes[-1]

    for key, val in tl.items():
        if key in ("fps", "bpm", "nf", "scenes") or (isinstance(val, int) and key in scene_starts):
            continue
        if key in ("block",):  # the blockcut scene's start under another name
            continue
        label = LABELS.get(key, key.replace("_", " ").capitalize())
        if isinstance(val, list) and key in RANGES and len(val) == 2:
            start, end = to_delivered(val[0]), to_delivered(val[1]) - 1
            s = scene_for(start)
            s["actions"].append({"id": key, "label": label, "frame": start,
                                 "end_frame": min(max(end, start), s["end_frame"] - 1)})
            s["source"]["timeline_keys"].append(key)
        elif isinstance(val, list):
            for i, v in enumerate(val, 1):
                fr = to_delivered(v)
                s = scene_for(fr)
                s["actions"].append({"id": f"{key}_{i}", "label": f"{label} {i}", "frame": fr})
            s["source"]["timeline_keys"].append(key)
        elif isinstance(val, (int, float)):
            fr = min(to_delivered(val), total - 1)
            s = scene_for(fr)
            s["actions"].append({"id": key, "label": label, "frame": fr})
            s["source"]["timeline_keys"].append(key)
    for s in scenes:
        s["actions"].sort(key=lambda x: x["frame"])
        s["source"]["timeline_keys"] = sorted(set(s["source"]["timeline_keys"]))

    cuts = []
    for spec in args.cut:
        cid, rest = spec.split("=", 1)
        path, size = rest.rsplit(":", 1)
        w, h = (int(x) for x in size.lower().split("x"))
        cuts.append({"id": cid, "file": path, "width": w, "height": h})
    refs = {"timeline": args.timeline, "scene_map": args.scene_map}
    if args.install_guide:
        refs["install_guide"] = args.install_guide
    if args.house_rules:
        refs["house_rules"] = args.house_rules
    m = {"schema": vr.MANIFEST_SCHEMA, "project": args.project_name, "version": args.version,
         "previous": args.previous, "fps": fps, "frame_count": total, "target_duration_s": sm["seconds"],
         "cuts": cuts, "scenes": scenes, "key_terms": ["joists", "toggle bolts", "trim screws", "adhesive", "caulk"],
         "references": refs, "changes": []}
    out = args.project / "review" / args.version / "manifest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    res = vr.validate_manifest(m, version_dir=args.version)
    for e in res.errors:
        print("ERROR  ", e)
    for w in res.warnings:
        print("WARNING", w)
    print(f"wrote {out}: {len(scenes)} scenes, {sum(len(s['actions']) for s in scenes)} actions")
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
