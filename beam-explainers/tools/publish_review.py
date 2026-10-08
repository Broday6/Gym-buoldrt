#!/usr/bin/env python3
"""Add a rendered version of one beam explainer to its review project.

    python tools/publish_review.py <video> <version> [--previous vN] [--changes changes.json]

<video> is which-one | heritage | timberthane. Reads scripts/<video>.json and out/<video>/timeline.json,
copies the build data into the project (build/), and writes projects/<project>/review/<version>/manifest.json,
then validates it with the review kit's validator. The cuts must already be at
projects/<project>/renders/<version>/<slug>-16x9.mp4 and -9x16.mp4 (never overwritten later).
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# The review kit sits next to this folder in the repo; REVIEW_KIT overrides.
KIT = Path(os.environ.get("REVIEW_KIT", ROOT.parent / "install-video-kit"))
sys.path.insert(0, str(KIT / "skills/ekena-install-video-review/scripts"))
import validate_review as vr  # noqa: E402

PROJECTS = {"which-one": "beams-which-one", "heritage": "heritage-explorer", "timberthane": "timberthane-explorer"}
# Moments worth checking on their own: (id, label, the spoken words the picture reveals it on).
ACTIONS = {
    "which-one": {
        "hook": [("hook_heritage", "Heritage Timber label", "Heritage"), ("hook_tt", "Timberthane label", "Timber")],
        "both": [("both_poly", "Polyurethane point", "lightweight"), ("both_texture", "Real-wood textures point", "textures"),
                 ("both_hollow", "Hollow point + photo", "hollow"), ("both_install", "Same install + block diagram", "install")],
        "speed": [("speed_h", "Heritage 3-5 days fills", "three"), ("speed_t", "Timberthane 10-12 days fills", "10")],
        "sizes": [("sizes_h", "Heritage 8 sizes drop in", "Heritage"), ("sizes_t", "Timberthane section grows 3 to 24 in", "3")],
        "shapes": [("shapes_h", "Heritage U-beam", "Heritage"), ("shapes_plank", "Timberthane plank", "plank"),
                   ("shapes_l", "Timberthane L-beam", "L"), ("shapes_box", "Timberthane box beam", "box")],
        "looks": [("looks_h", "Heritage textures + finishes", "six"), ("looks_t", "Timberthane textures + 29 swatches", "eight")],
        "details": [("det_seams", "One piece, no corner seams", "molded"), ("det_endcap_h", "Heritage endcaps", "caps"),
                    ("det_endcap_t", "Timberthane endcap selector", "add"), ("det_usa", "Made in the USA", "made")],
        "choose": [("choose_h", "Go Heritage", "Go"), ("choose_t", "Go Timberthane", "exact")],
        "end": [("end_samples", "Both samples", "sample")],
    },
    "heritage": {
        "hook": [("hook_tags", "Texture / Finish / Size tags", "texture")],
        "textures": [(f"tex_{i}", f"Texture: {n}", p) for i, (n, p) in enumerate(
            [("Mena", "Mina"), ("Salvaged Timber", "salvaged"), ("Rustic Sawn", "rustic"), ("Resawn Rip", "re"), ("Reclaimed Axed Cut", "reclaimed"), ("Sanded Smooth", "sanded")], 1)],
        "finishes": [(f"fin_{i}", f"Finish: {n}", p) for i, (n, p) in enumerate(
            [("Sandstone", "Sandstone"), ("Kona Brown", "Kona"), ("Vanilla Chai", "vanilla"), ("Warm Caramel", "warm"), ("Natural White Oak", "natural"), ("Smokey Brown", "smoky"), ("Primed", "primed")], 1)],
        "matrix": [("matrix_smooth", "Sanded Smooth: primed only", "sanded")],
        "sizes": [("sizes_drop", "Eight sections drop in", "eight")],
        "fit": [("fit_slide", "Beam slides over the block", "slides"), ("fit_cut", "1/8 in narrower note", "cut")],
        "lengths": [("len_grow", "Length bars grow", "four")],
        "ship": [("ship_stained", "Stained 3-5 days", "stained"), ("ship_primed", "Primed 24-72 h", "primed"), ("ship_endcaps", "Endcaps sold separately", "end")],
        "end": [("end_sample", "Sample appears", "sample")],
    },
    "timberthane": {
        "hook": [("hook_tags", "Shape / Texture / Finish / Size tags", "shape")],
        "shapes": [(f"shape_{i}", f"Shape: {n}", p) for i, (n, p) in enumerate(
            [("plank", "one"), ("L-beam", "two"), ("U-beam", "three"), ("box beam", "four")], 1)],
        "textures": [(f"tex_{i}", f"Texture: {n}", p) for i, (n, p) in enumerate(
            [("Hand Hewn", "hand"), ("Rough Sawn", "rough"), ("Rough Cedar", "cedar"), ("Sandblasted", "sandblasted"), ("Pecky Cypress", "cypress"), ("Riverwood", "riverwood"), ("Knotty Pine", "pine"), ("Rustic Smooth", "rustic")], 1)],
        "finishes": [("fin_cycle", "Finish photos cycle", "hand"), ("fin_sanddune", "Sand Dune", "sand"), ("fin_driftwood", "Driftwood", "driftwood"),
                     ("fin_hickory", "Hickory", "hickory"), ("fin_cherry", "Cherry", "cherry"), ("fin_prepped", "Factory Prepped", "factory")],
        "size": [("size_w", "Width 3 to 24 in", "three"), ("size_h", "Height 3 to 24 in", "tall")],
        "length": [("len_grow", "Length 2 to 30 ft", "two")],
        "made": [("made_endcaps", "Endcap selector", "one"), ("made_hand", "Hand finished", "hand"), ("made_usa", "Made in the USA", "made"), ("made_ships", "10-12 business days", "ships")],
        "end": [("end_sample", "Sample appears", "sample")],
    },
}


def norm(w: str) -> str:
    return re.sub(r"[^a-z0-9]", "", w.lower())


def find(words, phrase, after=0.0):
    want = norm(phrase)
    for w in words:
        if w["t0"] >= after and norm(w["w"]).startswith(want):
            return w["t0"]
    return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("video")
    ap.add_argument("version")
    ap.add_argument("--previous")
    ap.add_argument("--changes", type=Path)
    a = ap.parse_args()
    script = json.loads((ROOT / "scripts" / f"{a.video}.json").read_text(encoding="utf-8"))
    tl = json.loads((ROOT / "out" / a.video / "timeline.json").read_text(encoding="utf-8"))
    proj = ROOT / "projects" / PROJECTS[a.video]
    slug = script["slug"]
    fps = tl["fps"]

    # Build data and references the evaluator reads.
    (proj / "build").mkdir(parents=True, exist_ok=True)
    (proj / "research").mkdir(exist_ok=True)
    shutil.copy(ROOT / "out" / a.video / "timeline.json", proj / "build" / f"timeline-{a.version}.json")
    shutil.copy(ROOT / "scripts" / f"{a.video}.json", proj / "build" / f"script-{a.version}.json")
    for f in ("INSTALL_BMU.pdf", "beam-lines-facts.md", "facts.json"):
        shutil.copy(ROOT / "research" / f, proj / "research" / f)
    refs_dir = proj / "research" / "product-images"
    refs_dir.mkdir(exist_ok=True)
    picks = {
        "which-one": ["heritage/product/salvaged-timber/kona-brown.jpg", "timberthane/product/hand-hewn/aged.jpg",
                      "timberthane/shapes/hand-hewn-box-beam.jpg", "heritage/accessories/endcap.jpg", "heritage/angles/BMSTKB-05.jpg"],
        "heritage": ["heritage/product/salvaged-timber/kona-brown.jpg", "heritage/product/mena/kona-brown.jpg",
                     "heritage/swatch/finish-kona-brown.jpg", "heritage/product/sanded-smooth/primed.jpg", "heritage/accessories/sample-kit.jpg"],
        "timberthane": ["timberthane/product/hand-hewn/aged.jpg", "timberthane/shapes/hand-hewn-plank.jpg", "timberthane/shapes/hand-hewn-l-beam.jpg",
                        "timberthane/shapes/hand-hewn-box-beam.jpg", "timberthane/builder/finish-driftwood.jpg"],
    }[a.video]
    product_images = []
    for rel in picks:
        dst = refs_dir / rel.replace("/", "__")
        shutil.copy(ROOT / "img" / rel, dst)
        product_images.append(str(dst.relative_to(proj)))

    by_id = {s["id"]: s for s in script["scenes"]}
    scenes = []
    for s in tl["scenes"]:
        sc = by_id[s["id"]]
        acts, after = [], 0.0
        for aid, label, phrase in ACTIONS[a.video].get(s["id"], []):
            t = find(s["words"], phrase, after)
            if t is None:
                continue
            after = t + 0.05
            fr = min(s["end_frame"] - 1, s["start_frame"] + round(t * fps))
            acts.append({"id": f"{s['id']}__{aid}", "label": label, "frame": fr})
        scenes.append({
            "id": s["id"], "title": sc["title"], "kind": sc.get("kind", "other"),
            "start_frame": s["start_frame"], "end_frame": s["end_frame"],
            "step_card": sc["card"], "narration": " ".join(x.strip() for x in sc["vo"].split("|") if x.strip()), "claims": sc.get("claims", []),
            "transition_in": "dissolve", "static_ok": sc.get("kind") == "end", "black_ok": False,
            "actions": acts,
            "source": {"files": [f"render/videos/{a.video}.mjs", "render/lib/core.mjs"], "timeline_keys": [s["id"]],
                       "card": f"build/script-{a.version}.json#{s['id']}", "narration": f"build/script-{a.version}.json#{s['id']}"},
        })
    cuts = []
    for cid, (w, h) in (("16x9", (1920, 1080)), ("9x16", (1080, 1920))):
        rel = f"renders/{a.version}/{slug}-{cid}.mp4"
        if not (proj / rel).is_file():
            print(f"missing cut {rel}")
            return 1
        cuts.append({"id": cid, "file": rel, "width": w, "height": h})
    m = {
        "schema": vr.MANIFEST_SCHEMA, "project": script["project"], "version": a.version,
        "created": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "previous": a.previous, "fps": fps, "frame_count": tl["frames"], "cuts": cuts, "scenes": scenes,
        "claims": script["claims"], "key_terms": script["key_terms"],
        "references": {"install_guide": "research/INSTALL_BMU.pdf", "product_images": product_images,
                       "house_rules": "HOUSE_RULES.md", "readme": "research/beam-lines-facts.md",
                       "timeline": f"build/timeline-{a.version}.json"},
        "changes": json.loads(a.changes.read_text()) if a.changes else [],
    }
    out = proj / "review" / a.version / "manifest.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(m, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    res = vr.validate_manifest(m, version_dir=a.version)
    for e in res.errors:
        print("ERROR  ", e)
    for w in res.warnings:
        print("WARNING", w)
    print(f"wrote {out}: {len(scenes)} scenes, {sum(len(s['actions']) for s in scenes)} actions, {tl['frames']} frames")
    # Every cut must have exactly the manifest's frame count.
    for c in cuts:
        n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=nb_read_frames",
                            "-of", "csv=p=0", str(proj / c["file"])], capture_output=True, text=True).stdout.strip()
        print(f"  {c['id']}: {n} frames")
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
