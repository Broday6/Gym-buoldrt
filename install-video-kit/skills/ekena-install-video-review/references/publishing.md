# Writing publish_review.py

The builder already knows the scene map (narration-driven timings), the timeline events and the
claims table. `publish_review.py` writes them out in the review format once per version. Keep it
in the project, next to the build, so every version is published the same way.

## Rules that matter

1. **Frames, not seconds.** `start_frame` inclusive, `end_frame` exclusive, contiguous, from 0 to
   `frame_count`. Use the frame numbers the renderer actually used after narration stretched the
   scenes, not the planned ones.
2. **Stable scene ids.** Derive them from the scene's key in the build (`"mark_joists"` → `s03` is
   fine, or use the key itself), never from position alone, if scenes can be inserted.
3. **Actions = timeline events.** One per event worth checking on its own (drill hole 1, tap
   Shutter-Lok 3, lift the beam). `id` = the `timeline.json` key, `frame` = its first frame,
   `end_frame` = its last frame (inclusive; subtract 1 if the timeline stores an exclusive end).
   Skip pure camera moves. A step with a fastening, lifting or cutting move should have an action
   for it, so notes and findings can point at it.
4. **`source` points at code.** `files` = the scene's module(s); `timeline_keys` = its events;
   `card` and `narration` = where the card text and the spoken line are defined (`path#key`).
   This is what turns "f734, box around the drill" into "drill_1 in scenes/joists.js".
5. **Immutable files.** `cuts[].file` must point at a copy that will never be overwritten, such as
   `renders/v7/…` or the build's backup of v7.
6. **`changes`.** One entry for everything Brody asked for on `previous`: each note
   (`kind: note`; an accepted finding is a note too, so add its `finding` id to the same entry),
   each wording request (`kind: text`, `scene`, `field`) and each pacing request (`kind: pace`,
   `scene`). Each is `addressed` or `declined` with a one-line `summary`, plus the `scene` and
   the `frames` (`[first, last]`) it touched in this version. The simplest way is to append to
   `review/<new version>/changes.json` as you work through the feedback; the template reads it.
7. **References.** Always include `install_guide` (the official PDF, on disk); the evaluator
   raises a blocker on any version with step scenes that lacks it. Also add `timeline` and
   `scene_map`, so whoever reads the manifest later can find the build data.
8. **`static_ok` / `black_ok`.** Mark title and end cards `static_ok: true` (they hold still on purpose),
   and any intended fade `black_ok: true`, so the technical check doesn't flag them.
9. **`transition_in`.** `cut` if the scene starts on a hard cut, `continuous` if the camera flows
   from the last one, `dissolve` for a dissolve. Only `cut` is checked for frame accuracy.

## Template

Adapt the four `load_*` functions to the build. The rest stays as is.

```python
#!/usr/bin/env python3
"""Publish a rendered version for review:  python publish_review.py v8 [--previous v7]"""
import argparse, json, shutil
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent
FPS = 60

def load_scene_map():
    """[(scene_key, title, kind, start_frame, end_frame, step_card, narration, claim_ids, files)] after narration timing."""
    raise NotImplementedError("read the build's resolved scene map")

def load_events():
    """[(event_key, scene_key, label, first_frame, last_frame)] from timeline.json, in frames (last inclusive)."""
    raise NotImplementedError

def load_claims():
    """[{"id": "C4", "text": "...", "source": "Install guide p.2, step 3"}] from the README claims table."""
    raise NotImplementedError

def load_cuts(version):
    """Copy the final renders to renders/<version>/ (never overwritten later) and describe them."""
    out = []
    for cid, src, w, h in [("16x9", "out/final_16x9.mp4", 1920, 1080), ("9x16", "out/final_9x16.mp4", 1080, 1920)]:
        dest = ROOT / "renders" / version / Path(src).name
        dest.parent.mkdir(parents=True, exist_ok=True)
        if not dest.exists():
            shutil.copy2(ROOT / src, dest)
        out.append({"id": cid, "file": dest.relative_to(ROOT).as_posix(), "width": w, "height": h})
    return out

def changes_for(version):
    """The entries you kept in review/<version>/changes.json while working through the notes."""
    path = ROOT / "review" / version / "changes.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("version")
    ap.add_argument("--previous")
    a = ap.parse_args()
    events = load_events()
    scenes = []
    for key, title, kind, s, e, card, line, claims, files in load_scene_map():
        acts = [{"id": k, "label": lbl, "frame": fs, "end_frame": fe}
                for k, sk, lbl, fs, fe in events if sk == key]
        scenes.append({
            "id": key, "title": title, "kind": kind, "start_frame": s, "end_frame": e,
            "step_card": card, "narration": line, "claims": claims, "actions": acts,
            "transition_in": "cut", "static_ok": kind in ("title", "end"),
            "source": {"files": files, "timeline_keys": [x["id"] for x in acts],
                       "card": f"cards.json#{key}", "narration": f"narration/lines.json#{key}"},
        })
    m = {
        "schema": "ekena-install-review/1",
        "project": "Timberthane Faux Beam — Ceiling Install",
        "version": a.version,
        "created": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "previous": a.previous,
        "fps": FPS,
        "frame_count": scenes[-1]["end_frame"],
        "target_duration_s": 75,
        "cuts": load_cuts(a.version),
        "scenes": scenes,
        "claims": load_claims(),
        "key_terms": ["joists", "mounting block"],
        "references": {"install_guide": "research/install-guide.pdf",
                       "product_images": ["research/renders/hero.jpg"],
                       "house_rules": "HOUSE_RULES.md", "readme": "README.md",
                       "timeline": "timeline.json", "scene_map": "build/scene_map.json"},
        "changes": changes_for(a.version),
    }
    d = ROOT / "review" / a.version
    d.mkdir(parents=True, exist_ok=True)
    (d / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"published review/{a.version}/manifest.json")

if __name__ == "__main__":
    main()
```

After writing it, publish a version and run `validate_review.py` on the manifest. Then open the
studio and click through a few scenes, checking the scene names under the playhead match what's
on screen. If they're off by a scene, the frame numbers aren't the rendered ones.
