#!/usr/bin/env python3
"""Build review/<version>/eval-report.json from the evaluator's judgments and the automatic checks.

    python assemble_report.py <project> <version>

Reads from review/<version>/eval/:
  technical.json   from tech_checks.py (required)
  narration.json   from transcribe_check.py (optional; reported as not run if absent)
  judgments.json   written by the evaluator: a 0–2 score per criterion for every scene, and the
                   findings that explain them (format in the evaluator's SKILL.md)

It applies the gates, so the pass bar is the same on every run:
  - any criterion at 0 fails the scene, and must be explained by a blocker finding
  - product, install, physics or graphics below 2 fails the scene, and must be explained by a blocker
  - product, install and physics may be null ("doesn't apply") on title and end cards only
  - a total below 75% of the points available fails the scene
  - the version fails if any scene fails, any finding is a blocker, or a technical check fails

It refuses to write a report that does not hold together: a scene nobody judged, a 0 with no
finding to explain it, or a carried-over verdict for a scene that changed. Exit 0 means it wrote
the report (pass or fail). Exit 1 means the judgments need fixing first.
Also appends one entry to review/eval-log.md.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import validate_review as vr  # noqa: E402
from evalkit import EvalError, load_version, write_json  # noqa: E402

CRITERIA = ("product", "install", "physics", "graphics", "sync", "reframe", "craft")
AUTO_FAIL = ("product", "install", "physics", "graphics")
NULLABLE_ON_CARDS = ("product", "install", "physics")
SEV_RANK = {"blocker": 0, "major": 1, "minor": 2}
TECH_FIX = {
    "file": "Re-export the cut and point the manifest at the file that stays put.",
    "video_stream": "Re-encode; the file has no picture.",
    "codec": "Encode as H.264 (libx264, yuv420p) so every player and channel takes it.",
    "resolution": "Render or reframe at the size the manifest gives, or fix the manifest.",
    "frame_rate": "Encode at the manifest frame rate; check the -r passed to ffmpeg.",
    "frame_count": "A frame was dropped or duplicated, usually at a splice. Re-run the splice for the "
                   "changed range and recount, or fix frame_count if the scene map changed.",
    "duration": "Container length disagrees with the frame count; re-mux after fixing the frame count.",
    "audio_stream": "Mux the narration and music back in.",
    "audio_sync": "Audio and picture lengths differ; re-mux with the mix trimmed or padded to the picture.",
    "decode": "Re-encode the affected chunk; the stream has decode errors.",
    "loudness": "Re-normalise the final mix to the target integrated loudness.",
    "true_peak": "Lower the limiter ceiling on the final mix.",
    "black_frames": "Find the black run (a failed render chunk or a bad splice) and re-render that range.",
    "frozen_frames": "Find why the picture stops here: a stalled render chunk, a dwell where nothing moves, "
                     "or a repeated frame in a splice. Re-render that range. (The reported start can be "
                     "a little late: the encoder keeps refining a still frame for a short while.)",
    "cuts_on_frame": "A cut lands off its scene boundary. Re-check the splice offsets for that boundary.",
    "unexpected_cuts": "Check whether this is a planned flash or a glitch; if a glitch, re-render that range.",
    "expected_cuts": "If the scene should open on a hard cut, check the boundary; if it is meant to flow, "
                     "set transition_in to 'continuous' in the manifest.",
    "cuts_match": "The cuts disagree in length; re-render the shorter one from the same scene map.",
}


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def gate(scores: dict) -> tuple[bool, int, list[str]]:
    scored = {k: v for k, v in scores.items() if v is not None}
    reasons = [f"{k} scored 0" for k, v in scored.items() if v == 0]
    reasons += [f"{k} below 2 (auto-fail criterion)" for k in AUTO_FAIL if scored.get(k, 2) == 1]
    total = sum(scored.values())
    need = math.ceil(0.75 * 2 * len(scored))
    if total < need:
        reasons.append(f"total {total} below {need} of {2 * len(scored)}")
    return not reasons, total, reasons


def scene_of(m: dict, frame) -> str | None:
    if frame is None:
        return None
    s = vr.scene_at(m, frame)
    return s["id"] if s else None


def changed_since(m: dict, prev_m: dict | None, scene: dict) -> str | None:
    """Why a scene can't keep last version's verdict, or None if it is unchanged."""
    for ch in m.get("changes") or []:
        if ch.get("status") != "addressed":
            continue  # a declined note leaves the scene as it was
        if ch.get("scene") == scene["id"]:
            return "the builder changed it in this version"
        fr = ch.get("frames")
        if fr and fr[0] < scene["end_frame"] and scene["start_frame"] <= fr[1]:
            return f"a change touches frames {fr[0]}–{fr[1]}"
    if prev_m is None:
        return "the previous manifest is missing"
    old = next((s for s in prev_m["scenes"] if s["id"] == scene["id"]), None)
    if old is None:
        return "it is new in this version"
    if old["end_frame"] - old["start_frame"] != scene["end_frame"] - scene["start_frame"]:
        return "it was re-timed"
    for k in ("step_card", "narration"):
        if (old.get(k) or "") != (scene.get(k) or ""):
            return f"its {k.replace('_', ' ')} changed"
    return None


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--judgments", type=Path, help="default: review/<version>/eval/judgments.json")
    args = ap.parse_args(argv)
    problems: list[str] = []
    warnings: list[str] = []
    try:
        m, vdir = load_version(args.project, args.version)
    except EvalError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2
    edir = vdir / "eval"

    def load(path: Path, required: bool):
        if not path.is_file():
            if required:
                problems.append(f"{path.relative_to(args.project).as_posix()} is missing")
            return None
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            problems.append(f"{path.name} is not valid JSON: {exc}")
            return None

    tech = load(edir / "technical.json", True)
    narr = load(edir / "narration.json", True)
    jpath = args.judgments or (edir / "judgments.json")
    judg = load(jpath, True)
    if problems:
        print("Cannot build the report yet:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    if tech.get("version") not in (None, args.version):
        problems.append(f"technical.json is for {tech.get('version')}, not {args.version}")

    multi_cut = len(m["cuts"]) > 1
    scene_ids = [s["id"] for s in m["scenes"]]
    judged = {}
    for i, s in enumerate(judg.get("scenes") or []):
        sid = s.get("scene")
        if sid not in scene_ids:
            problems.append(f"judgments scenes[{i}]: {sid!r} is not a scene of {args.version}")
            continue
        if sid in judged:
            problems.append(f"judgments: scene {sid} is judged twice")
        sc = s.get("scores") or {}
        clean = {}
        kind = next((x.get("kind") for x in m["scenes"] if x["id"] == sid), None)
        for k in CRITERIA:
            v = sc.get(k)
            if k == "reframe" and not multi_cut:
                clean[k] = None
                continue
            if v is None and k in NULLABLE_ON_CARDS and kind in ("title", "end"):
                clean[k] = None  # nothing to judge: no product or action on a title/end card
                continue
            if not isinstance(v, int) or isinstance(v, bool) or not 0 <= v <= 2:
                problems.append(f"scene {sid}: score {k} must be 0, 1 or 2 (got {v!r})")
            else:
                clean[k] = v
        extra = set(sc) - set(CRITERIA)
        if extra:
            problems.append(f"scene {sid}: unknown criteria {sorted(extra)}")
        judged[sid] = {"scores": clean, "comment": s.get("comment")}

    carry_from = judg.get("carry_from")
    prev_report = prev_m = None
    if carry_from:
        prev_report = load(args.project / "review" / carry_from / "eval-report.json", True)
        try:
            prev_m, _ = load_version(args.project, carry_from)
        except EvalError:
            prev_m = None
    scenes_out = []
    for s in m["scenes"]:
        sid = s["id"]
        if sid in judged:
            ok, total, reasons = gate(judged[sid]["scores"])
            scenes_out.append({"scene": sid, "pass": ok, "carried": False, "scores": judged[sid]["scores"],
                               "total": total, "gate_reasons": reasons, "comment": judged[sid]["comment"]})
            continue
        if not carry_from or prev_report is None:
            problems.append(f"scene {sid} was not judged" + ("" if carry_from else " (judge it, or set carry_from)"))
            continue
        why = changed_since(m, prev_m, s)
        old = next((x for x in prev_report.get("scenes") or [] if x.get("scene") == sid), None)
        if why:
            problems.append(f"scene {sid} can't keep {carry_from}'s verdict because {why}: judge it")
        elif old is None:
            problems.append(f"scene {sid} has no verdict in {carry_from} to carry: judge it")
        elif not old.get("pass"):
            problems.append(f"scene {sid} failed in {carry_from} and nothing in it changed: judge it again")
        else:
            scenes_out.append({**old, "carried": True})

    # ---- findings
    findings = []
    for i, f in enumerate(judg.get("findings") or []):
        if not isinstance(f, dict):
            problems.append(f"judgments findings[{i}] must be an object")
            continue
        f = dict(f)
        f.setdefault("scope", "local")
        if f.get("scene") is None and f.get("frame") is not None:
            f["scene"] = scene_of(m, f["frame"])
        if f.get("scenes"):
            # A systemic finding names every scene it covers; the first is where it shows on the timeline.
            if not isinstance(f["scenes"], list):
                problems.append(f"judgments findings[{i}].scenes must be a list of scene ids")
            else:
                f["scope"] = "systemic"
                if f.get("scene") is None:
                    f["scene"] = f["scenes"][0]
                elif f["scene"] not in f["scenes"]:
                    f["scenes"] = [f["scene"]] + f["scenes"]
        findings.append(f)

    tech_seen = {}
    for c in tech.get("checks") or []:
        if c.get("severity") == "info" or c["id"] == "expected_cuts":
            continue  # a cut the detector didn't see is not evidence of a fault
        frames = c.get("frames")
        key = (c["id"], c.get("detail"), tuple(frames) if frames else None)
        if key in tech_seen:
            tech_seen[key]["cut"] = None
            continue
        f = {"scene": scene_of(m, frames[0]) if frames else None, "action": None, "cut": c.get("cut"),
             "frame": frames[0] if frames else None, "end_frame": frames[1] if frames else None,
             "severity": "blocker" if not c["pass"] else "minor", "criterion": "technical", "scope": "local",
             "rule": None, "source": "tech_checks.py", "what": f"{c['id']}: {c.get('detail')}",
             "fix": TECH_FIX.get(c["id"], ""), "evidence": ["review/%s/eval/technical.json" % args.version], "region": None}
        tech_seen[key] = f
        findings.append(f)

    for r in (narr.get("audio_activity") or {}).get("scenes") or []:
        if r.get("flag"):
            findings.append({"scene": r["scene"], "action": None, "cut": narr.get("cut"),
                             "frame": r["frames"][0], "end_frame": r["frames"][1], "severity": "major",
                             "criterion": "narration", "scope": "local", "rule": None,
                             "source": "transcribe_check.py (no speech model: level check only)",
                             "what": r["flag"], "fix": "Check the narration line is in the mix for this scene.",
                             "evidence": [f"review/{args.version}/eval/narration.json"], "region": None})
    if narr.get("available"):
        for r in narr.get("scenes") or []:
            if r.get("flag"):
                findings.append({"scene": r["scene"], "action": None, "cut": narr.get("cut"),
                                 "frame": r["frames"][0], "end_frame": r["frames"][1], "severity": "major",
                                 "criterion": "narration", "scope": "local", "rule": None, "source": narr.get("engine"),
                                 "what": f"{r['flag']}. Heard: “{r.get('heard') or '(nothing)'}”",
                                 "fix": "Check the line's timing in the scene map, or its pronunciation.",
                                 "evidence": [f"review/{args.version}/eval/narration.json"], "region": None})
            if r.get("missing_terms"):
                findings.append({"scene": r["scene"], "action": None, "cut": narr.get("cut"),
                                 "frame": r["frames"][0], "end_frame": r["frames"][1], "severity": "major",
                                 "criterion": "narration", "scope": "local", "rule": None, "source": narr.get("engine"),
                                 "what": "Key term not heard clearly: " + ", ".join(r["missing_terms"]),
                                 "fix": "Adjust the phonetic spelling for this word and re-generate the line.",
                                 "evidence": [f"review/{args.version}/eval/narration.json"], "region": None})

        reported = {t for r in narr.get("scenes") or [] for t in r.get("missing_terms") or []}
        for t in narr.get("key_terms") or []:
            if not t.get("heard") and t.get("term") not in reported:
                findings.append({"scene": None, "action": None, "cut": narr.get("cut"), "frame": None,
                                 "end_frame": None, "severity": "major", "criterion": "narration",
                                 "scope": "local", "rule": None, "source": narr.get("engine"),
                                 "what": f"Key term never heard anywhere in the narration: {t.get('term')}",
                                 "fix": "Check the term is in the script as spoken, or add how it is heard "
                                        "(heard_as) to key_terms in the manifest.",
                                 "evidence": [f"review/{args.version}/eval/narration.json"], "region": None})

    guide = (m.get("references") or {}).get("install_guide")
    if any(s.get("kind") == "step" for s in m["scenes"]) and (not guide or not (args.project / guide).is_file()):
        findings.append({"scene": None, "action": None, "cut": None, "frame": None, "end_frame": None,
                         "severity": "blocker", "criterion": "claims", "scope": "local", "rule": None, "source": None,
                         "what": ("The manifest names no install guide" if not guide else f"The install guide {guide} is not on disk")
                                 + ", so no step could be checked against it.",
                         "fix": "Put the official install PDF in the project and set references.install_guide.",
                         "evidence": [f"review/{args.version}/manifest.json"], "region": None})

    # ---- integrity: every low score is explained
    for sc in scenes_out:
        if sc.get("carried"):
            continue
        for k, v in sc["scores"].items():
            if v is None or v == 2:
                continue
            mine = [f for f in findings if f.get("criterion") == k
                    and (f.get("scene") == sc["scene"] or sc["scene"] in (f.get("scenes") or []))]
            # Whatever fails a scene must be a blocker, so the version can't reach the user with it.
            if k in AUTO_FAIL or v == 0:
                if not any(f.get("severity") == "blocker" for f in mine):
                    problems.append(f"scene {sc['scene']}: {k} scored {v}, which fails the scene, but no blocker "
                                    f"finding (criterion '{k}', this scene or listing it in 'scenes') says what is wrong")
            elif not mine:
                warnings.append(f"scene {sc['scene']}: {k} scored 1 with no finding explaining it")
        if all(v in (None, 2) for v in sc["scores"].values()):
            if any(f.get("scene") == sc["scene"] and f.get("severity") == "blocker" and f.get("criterion") in CRITERIA
                   for f in findings):
                warnings.append(f"scene {sc['scene']}: scored all 2s but has a blocker finding")

    findings.sort(key=lambda f: (SEV_RANK.get(f.get("severity"), 9), f.get("frame") if f.get("frame") is not None else -1))
    for i, f in enumerate(findings, 1):
        f["id"] = f"e{i}"

    blockers = [f for f in findings if f.get("severity") == "blocker"]
    failing = [s["scene"] for s in scenes_out if not s["pass"]]
    tech_ok = bool(tech.get("pass"))
    overall = "pass" if not blockers and not failing and tech_ok and not problems else "fail"
    counts = {k: sum(1 for f in findings if f.get("severity") == k) for k in SEV_RANK}
    summary = judg.get("summary") or (
        ("Ready for review. " if overall == "pass" else "Not ready. ")
        + f"{counts['blocker']} blocker(s), {counts['major']} major, {counts['minor']} minor."
        + (f" Failing scenes: {', '.join(failing)}." if failing else "")
        + ("" if tech_ok else " Technical checks failed."))
    report = {"schema": vr.REPORT_SCHEMA, "project": m["project"], "version": args.version,
              "evaluated_at": now_iso(), "overall": overall, "summary": summary,
              "technical": {"pass": tech_ok, "checks": tech.get("checks") or []},
              "narration": narr, "scenes": scenes_out, "findings": findings}
    res = vr.validate_report(report, m)
    problems += res.errors
    if problems:
        print("The judgments need fixing before the report can be written:\n  " + "\n  ".join(problems), file=sys.stderr)
        return 1
    out = vdir / "eval-report.json"
    write_json(out, report)

    log = args.project / "review" / "eval-log.md"
    entry = [f"## {args.version} — {report['evaluated_at']} — {overall.upper()}", "",
             f"- {counts['blocker']} blocker, {counts['major']} major, {counts['minor']} minor",
             f"- Technical checks: {'pass' if tech_ok else 'FAIL'}; narration: "
             + ("pass" if narr.get("available") and narr.get("pass") else ("issues" if narr.get("available") else "not run")),
             f"- Scenes failing: {', '.join(failing) or 'none'}"]
    carried = [s["scene"] for s in scenes_out if s.get("carried")]
    if carried:
        entry.append(f"- Carried from {carry_from} unchanged: {', '.join(carried)}")
    for f in blockers[:10]:
        entry.append(f"- Blocker {f['id']} ({f.get('scene') or '—'}, {f['criterion']}): {f['what']}")
    # One entry per version: a re-run (after fixing judgments) replaces that version's entry.
    old = log.read_text(encoding="utf-8") if log.exists() else ""
    sections = [x for x in re.split(r"(?m)^(?=## )", old) if x.strip()]
    sections = [x for x in sections if not x.startswith(f"## {args.version} — ")]
    sections.append("\n".join(entry) + "\n\n")
    log.write_text("".join(x if x.endswith("\n\n") else x.rstrip("\n") + "\n\n" for x in sections), encoding="utf-8")

    for w in warnings + res.warnings:
        print(f"WARNING {w}")
    print(f"{overall.upper()} — {summary}")
    print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
