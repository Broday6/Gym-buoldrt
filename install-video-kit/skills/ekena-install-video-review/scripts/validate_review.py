#!/usr/bin/env python3
"""Validate a review manifest, feedback file or eval report (see references/schemas.md).

    python validate_review.py review/v7/manifest.json
    python validate_review.py review/v7/feedback.json --manifest review/v7/manifest.json

Prints every problem and exits 1 if any is an error. Warnings alone exit 0.
Standard library only, Python 3.8+.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path, PurePosixPath

MANIFEST_SCHEMA = "ekena-install-review/1"
FEEDBACK_SCHEMA = "ekena-install-feedback/1"
REPORT_SCHEMA = "ekena-install-eval/1"

SCENE_KINDS = {"title", "step", "diagram", "end", "other"}
TRANSITIONS = {"cut", "dissolve", "continuous"}
CHANGE_STATUSES = {"addressed", "declined"}
CHANGE_KINDS = {"note", "finding", "text", "pace", "other"}
NOTE_CATEGORIES = {"product", "install", "physics", "graphics", "text", "narration",
                   "timing", "color", "audio", "other"}
PRIORITIES = {"must", "nice"}
TEXT_FIELDS = {"step_card", "narration"}
DECISIONS = {"accept", "reject"}
CRITERIA = ("product", "install", "physics", "graphics", "sync", "reframe", "craft")
SEVERITIES = {"blocker", "major", "minor"}
SCOPES = {"local", "systemic"}


class Result:
    def __init__(self) -> None:
        self.errors: list[str] = []
        self.warnings: list[str] = []

    def error(self, msg: str) -> None:
        self.errors.append(msg)

    def warn(self, msg: str) -> None:
        self.warnings.append(msg)

    @property
    def ok(self) -> bool:
        return not self.errors


def _is_int(v) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _is_num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _check_rel_path(res: Result, where: str, p) -> None:
    if not isinstance(p, str) or not p:
        res.error(f"{where}: path must be a non-empty string")
        return
    if "\\" in p:
        res.error(f"{where}: use forward slashes in paths ({p!r})")
        return
    pp = PurePosixPath(p)
    if pp.is_absolute() or (len(p) > 1 and p[1] == ":"):
        res.error(f"{where}: path must be relative to the project folder ({p!r})")
    elif ".." in pp.parts:
        res.error(f"{where}: path may not leave the project folder ({p!r})")


def _check_region(res: Result, where: str, region) -> None:
    if region is None:
        return
    if not isinstance(region, dict):
        res.error(f"{where}: region must be an object or null")
        return
    for k in ("x", "y", "w", "h"):
        v = region.get(k)
        if not _is_num(v) or not 0 <= v <= 1:
            res.error(f"{where}: region.{k} must be a number between 0 and 1")
            return
    if region["x"] + region["w"] > 1.0001 or region["y"] + region["h"] > 1.0001:
        res.error(f"{where}: region runs past the edge of the frame")


def scene_at(manifest: dict, frame: int):
    for s in manifest.get("scenes", []):
        if s.get("start_frame", 0) <= frame < s.get("end_frame", 0):
            return s
    return None


def action_index(manifest: dict) -> dict:
    out = {}
    for s in manifest.get("scenes", []):
        for a in s.get("actions", []) or []:
            if isinstance(a, dict) and "id" in a:
                out[a["id"]] = (s, a)
    return out


def validate_manifest(m, version_dir: str | None = None) -> Result:
    res = Result()
    if not isinstance(m, dict):
        res.error("manifest must be a JSON object")
        return res
    if m.get("schema") != MANIFEST_SCHEMA:
        res.error(f"schema must be {MANIFEST_SCHEMA!r} (got {m.get('schema')!r})")
    for k in ("project", "version"):
        if not isinstance(m.get(k), str) or not m.get(k):
            res.error(f"{k} must be a non-empty string")
    if version_dir and m.get("version") != version_dir:
        res.error(f"version {m.get('version')!r} does not match its folder name {version_dir!r}")
    fps = m.get("fps")
    if not _is_num(fps) or fps <= 0:
        res.error("fps must be a positive number")
        fps = None
    fc = m.get("frame_count")
    if not _is_int(fc) or fc <= 0:
        res.error("frame_count must be a positive integer")
        fc = None
    prev = m.get("previous")
    if prev is not None and (not isinstance(prev, str) or not prev):
        res.error("previous must be a version id or null")
    if prev is not None and prev == m.get("version"):
        res.error("previous cannot be the version itself")

    tgt = m.get("target_duration_s")
    if tgt is not None:
        if not _is_num(tgt) or tgt <= 0:
            res.error("target_duration_s must be a positive number")
        elif fps and fc and abs(fc / fps - tgt) > 1.0 / fps + 1e-9:
            res.warn(f"frame_count/fps is {fc / fps:.3f}s but target_duration_s is {tgt}s")

    cuts = m.get("cuts")
    if not isinstance(cuts, list) or not cuts:
        res.error("cuts must be a non-empty list")
        cuts = []
    seen = set()
    for i, c in enumerate(cuts):
        w = f"cuts[{i}]"
        if not isinstance(c, dict):
            res.error(f"{w} must be an object")
            continue
        cid = c.get("id")
        if not isinstance(cid, str) or not cid:
            res.error(f"{w}.id must be a non-empty string")
        elif cid in seen:
            res.error(f"{w}.id {cid!r} is used twice")
        seen.add(cid)
        _check_rel_path(res, f"{w}.file", c.get("file"))
        for k in ("width", "height"):
            if not _is_int(c.get(k)) or c.get(k) <= 0:
                res.error(f"{w}.{k} must be a positive integer")

    claims = m.get("claims")
    claim_ids = set()
    if claims is not None:
        if not isinstance(claims, list):
            res.error("claims must be a list")
        else:
            for i, c in enumerate(claims):
                if not isinstance(c, dict) or not isinstance(c.get("id"), str):
                    res.error(f"claims[{i}] needs a string id")
                    continue
                if c["id"] in claim_ids:
                    res.error(f"claims[{i}].id {c['id']!r} is used twice")
                claim_ids.add(c["id"])
                if not c.get("source"):
                    res.warn(f"claim {c['id']} has no source")

    scenes = m.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        res.error("scenes must be a non-empty list")
        scenes = []
    scene_ids = set()
    action_ids = set()
    expect = 0
    for i, s in enumerate(scenes):
        w = f"scenes[{i}]"
        if not isinstance(s, dict):
            res.error(f"{w} must be an object")
            continue
        sid = s.get("id")
        if isinstance(sid, str) and sid:
            w = f"scene {sid}"
            if sid in scene_ids:
                res.error(f"{w}: id is used twice")
            scene_ids.add(sid)
        else:
            res.error(f"{w}.id must be a non-empty string")
        st, en = s.get("start_frame"), s.get("end_frame")
        if not _is_int(st) or not _is_int(en):
            res.error(f"{w}: start_frame and end_frame must be integers")
            continue
        if en <= st:
            res.error(f"{w}: end_frame must be greater than start_frame")
        if st != expect:
            what = "gap" if st > expect else "overlap"
            res.error(f"{w}: starts at frame {st}, expected {expect} ({what} between scenes)")
        expect = en
        kind = s.get("kind")
        if kind is not None and kind not in SCENE_KINDS:
            res.error(f"{w}: kind must be one of {sorted(SCENE_KINDS)}")
        tr = s.get("transition_in")
        if tr is not None and tr not in TRANSITIONS:
            res.error(f"{w}: transition_in must be one of {sorted(TRANSITIONS)}")
        for k in ("step_card", "narration", "title"):
            if s.get(k) is not None and not isinstance(s.get(k), str):
                res.error(f"{w}: {k} must be a string or null")
        sc = s.get("claims") or []
        if not isinstance(sc, list):
            res.error(f"{w}: claims must be a list")
            sc = []
        for cid in sc:
            if claims is not None and cid not in claim_ids:
                res.error(f"{w}: claim {cid!r} is not in the claims list")
        if kind == "step" and not sc and (s.get("step_card") or s.get("narration")):
            res.warn(f"{w}: step scene has card or narration but no claims")
        for j, a in enumerate(s.get("actions") or []):
            aw = f"{w}.actions[{j}]"
            if not isinstance(a, dict):
                res.error(f"{aw} must be an object")
                continue
            aid = a.get("id")
            if not isinstance(aid, str) or not aid:
                res.error(f"{aw}.id must be a non-empty string")
            elif aid in action_ids:
                res.error(f"{aw}.id {aid!r} is used twice in the manifest")
            else:
                action_ids.add(aid)
            af = a.get("frame")
            if not _is_int(af):
                res.error(f"{aw}.frame must be an integer")
            elif not st <= af < en:
                res.error(f"{aw}: frame {af} is outside its scene ({st}–{en - 1})")
            ae = a.get("end_frame")  # inclusive: the action's last frame
            if ae is not None:
                if not _is_int(ae) or (_is_int(af) and ae < af):
                    res.error(f"{aw}.end_frame must be an integer ≥ frame")
                elif ae >= en:
                    res.warn(f"{aw}: end_frame {ae} runs past its scene's last frame ({en - 1})")
        src = s.get("source")
        if src is not None:
            if not isinstance(src, dict):
                res.error(f"{w}: source must be an object")
            else:
                for p in src.get("files") or []:
                    _check_rel_path(res, f"{w}.source.files", p)
    if scenes and fc is not None and expect != fc:
        res.error(f"scenes end at frame {expect} but frame_count is {fc}")

    refs = m.get("references")
    if refs is not None:
        if not isinstance(refs, dict):
            res.error("references must be an object")
        else:
            for k, v in refs.items():
                for p in (v if isinstance(v, list) else [v]):
                    if p is not None:
                        _check_rel_path(res, f"references.{k}", p)

    kt = m.get("key_terms")
    if kt is not None:
        if not isinstance(kt, list):
            res.error("key_terms must be a list")
        else:
            for i, t in enumerate(kt):
                if isinstance(t, str) and t.strip():
                    continue
                if (isinstance(t, dict) and isinstance(t.get("term"), str) and t["term"].strip()
                        and all(isinstance(x, str) for x in t.get("heard_as") or [])):
                    continue
                res.error(f"key_terms[{i}] must be a word, or {{\"term\": …, \"heard_as\": [ … ]}}")

    for i, ch in enumerate(m.get("changes") or []):
        w = f"changes[{i}]"
        if not isinstance(ch, dict):
            res.error(f"{w} must be an object")
            continue
        if ch.get("status") not in CHANGE_STATUSES:
            res.error(f"{w}.status must be one of {sorted(CHANGE_STATUSES)}")
        kind = ch.get("kind")
        if kind is not None and kind not in CHANGE_KINDS:
            res.error(f"{w}.kind must be one of {sorted(CHANGE_KINDS)}")
        if kind in ("text", "pace") and not ch.get("scene"):
            res.error(f"{w}: a {kind} change must name its scene")
        if kind == "text" and ch.get("field") not in TEXT_FIELDS:
            res.error(f"{w}.field must be one of {sorted(TEXT_FIELDS)} for a text change")
        if not ch.get("note") and not ch.get("finding") and not ch.get("summary"):
            res.error(f"{w} must name a note, a finding, or at least carry a summary")
        if ch.get("status") == "declined" and not ch.get("summary"):
            res.error(f"{w}: a declined change must say why in summary")
        if ch.get("scene") is not None and ch.get("scene") not in scene_ids:
            res.error(f"{w}: scene {ch.get('scene')!r} is not in this version")
        fr = ch.get("frames")
        if fr is not None:
            if (not isinstance(fr, list) or len(fr) != 2 or not all(_is_int(x) for x in fr)
                    or fr[0] > fr[1]):
                res.error(f"{w}.frames must be [first, last] frame numbers")
            elif fc is not None and (fr[0] < 0 or fr[1] >= fc):
                res.error(f"{w}.frames {fr} is outside the video (0–{fc - 1}; the last frame is included)")
    return res


def validate_feedback(fb, manifest: dict | None = None) -> Result:
    res = Result()
    if not isinstance(fb, dict):
        res.error("feedback must be a JSON object")
        return res
    if fb.get("schema") != FEEDBACK_SCHEMA:
        res.error(f"schema must be {FEEDBACK_SCHEMA!r} (got {fb.get('schema')!r})")
    if manifest and fb.get("version") != manifest.get("version"):
        res.error(f"feedback is for {fb.get('version')!r} but the manifest is {manifest.get('version')!r}")
    cuts = {c.get("id") for c in (manifest or {}).get("cuts", [])}
    scenes = {s.get("id"): s for s in (manifest or {}).get("scenes", [])}
    actions = action_index(manifest or {})
    fc = (manifest or {}).get("frame_count")
    ids = set()
    for i, n in enumerate(fb.get("notes") or []):
        w = f"notes[{i}]"
        if not isinstance(n, dict):
            res.error(f"{w} must be an object")
            continue
        nid = n.get("id")
        if not isinstance(nid, str) or not nid:
            res.error(f"{w}.id must be a non-empty string")
        elif nid in ids:
            res.error(f"{w}.id {nid!r} is used twice")
        ids.add(nid)
        if not isinstance(n.get("text"), str) or not n.get("text").strip():
            res.error(f"{w}: text is empty")
        if n.get("category") not in NOTE_CATEGORIES:
            res.error(f"{w}.category must be one of {sorted(NOTE_CATEGORIES)}")
        if n.get("priority") not in PRIORITIES:
            res.error(f"{w}.priority must be one of {sorted(PRIORITIES)}")
        f = n.get("frame")
        if not _is_int(f) or f < 0 or (fc is not None and f >= fc):
            res.error(f"{w}.frame must be a frame number inside the video")
        if manifest:
            if n.get("cut") not in cuts:
                res.error(f"{w}.cut {n.get('cut')!r} is not a cut of this version")
            sid = n.get("scene")
            if sid not in scenes:
                res.error(f"{w}.scene {sid!r} is not in this version")
            elif _is_int(f) and not scenes[sid]["start_frame"] <= f < scenes[sid]["end_frame"]:
                res.warn(f"{w}: frame {f} is not inside scene {sid}")
            if n.get("action") is not None and n.get("action") not in actions:
                res.error(f"{w}.action {n.get('action')!r} is not in this version")
        _check_region(res, w, n.get("region"))
    for i, t in enumerate(fb.get("text_changes") or []):
        w = f"text_changes[{i}]"
        if not isinstance(t, dict):
            res.error(f"{w} must be an object")
            continue
        if t.get("field") not in TEXT_FIELDS:
            res.error(f"{w}.field must be one of {sorted(TEXT_FIELDS)}")
        if not isinstance(t.get("to"), str):
            res.error(f"{w}.to must be a string")
        if manifest and t.get("scene") not in scenes:
            res.error(f"{w}.scene {t.get('scene')!r} is not in this version")
    for i, p in enumerate(fb.get("pace") or []):
        w = f"pace[{i}]"
        if not isinstance(p, dict) or not _is_num(p.get("delta_s")):
            res.error(f"{w}.delta_s must be a number")
            continue
        if manifest and p.get("scene") not in scenes:
            res.error(f"{w}.scene {p.get('scene')!r} is not in this version")
    finds = fb.get("findings") or {}
    if not isinstance(finds, dict):
        res.error("findings must be an object keyed by finding id")
    else:
        for fid, d in finds.items():
            if not isinstance(d, dict) or d.get("decision") not in DECISIONS:
                res.error(f"findings[{fid}].decision must be one of {sorted(DECISIONS)}")
            elif d.get("decision") == "accept" and d.get("note") and d.get("note") not in ids:
                res.error(f"findings[{fid}].note {d.get('note')!r} is not one of the notes")
    for k in ("submitted", "approved"):
        if k in fb and not isinstance(fb[k], bool):
            res.error(f"{k} must be true or false")
    return res


def validate_report(r, manifest: dict | None = None) -> Result:
    res = Result()
    if not isinstance(r, dict):
        res.error("report must be a JSON object")
        return res
    if r.get("schema") != REPORT_SCHEMA:
        res.error(f"schema must be {REPORT_SCHEMA!r} (got {r.get('schema')!r})")
    if r.get("overall") not in ("pass", "fail"):
        res.error("overall must be 'pass' or 'fail'")
    if manifest and r.get("version") != manifest.get("version"):
        res.error(f"report is for {r.get('version')!r} but the manifest is {manifest.get('version')!r}")
    scenes = {s.get("id") for s in (manifest or {}).get("scenes", [])}
    actions = action_index(manifest or {})
    cuts = {c.get("id") for c in (manifest or {}).get("cuts", [])}
    fc = (manifest or {}).get("frame_count")
    for i, s in enumerate(r.get("scenes") or []):
        w = f"scenes[{i}]"
        if not isinstance(s, dict):
            res.error(f"{w} must be an object")
            continue
        if manifest and s.get("scene") not in scenes:
            res.error(f"{w}.scene {s.get('scene')!r} is not in this version")
        for k, v in (s.get("scores") or {}).items():
            if k not in CRITERIA:
                res.error(f"{w}.scores.{k} is not a criterion")
            elif v is not None and (not _is_int(v) or not 0 <= v <= 2):
                res.error(f"{w}.scores.{k} must be 0, 1, 2 or null")
    ids = set()
    for i, f in enumerate(r.get("findings") or []):
        w = f"findings[{i}]"
        if not isinstance(f, dict):
            res.error(f"{w} must be an object")
            continue
        fid = f.get("id")
        if not isinstance(fid, str) or not fid:
            res.error(f"{w}.id must be a non-empty string")
        elif fid in ids:
            res.error(f"{w}.id {fid!r} is used twice")
        ids.add(fid)
        if f.get("severity") not in SEVERITIES:
            res.error(f"{w}.severity must be one of {sorted(SEVERITIES)}")
        if f.get("criterion") not in CRITERIA + ("technical", "narration", "claims"):
            res.error(f"{w}.criterion {f.get('criterion')!r} is not recognised")
        if f.get("scope", "local") not in SCOPES:
            res.error(f"{w}.scope must be one of {sorted(SCOPES)}")
        if not f.get("what"):
            res.error(f"{w}: 'what' is empty")
        fr = f.get("frame")
        if fr is not None and (not _is_int(fr) or fr < 0 or (fc is not None and fr >= fc)):
            res.error(f"{w}.frame must be a frame number inside the video")
        fe = f.get("end_frame")  # inclusive
        if fe is not None and (not _is_int(fe) or (_is_int(fr) and fe < fr) or (fc is not None and fe >= fc)):
            res.error(f"{w}.end_frame must be a frame number ≥ frame, inside the video")
        many = f.get("scenes")
        if many is not None and (not isinstance(many, list) or not all(isinstance(x, str) for x in many)):
            res.error(f"{w}.scenes must be a list of scene ids")
            many = None
        if manifest:
            if f.get("scene") is not None and f.get("scene") not in scenes:
                res.error(f"{w}.scene {f.get('scene')!r} is not in this version")
            for x in many or []:
                if x not in scenes:
                    res.error(f"{w}.scenes: {x!r} is not in this version")
            if f.get("action") is not None and f.get("action") not in actions:
                res.error(f"{w}.action {f.get('action')!r} is not in this version")
            if f.get("cut") is not None and f.get("cut") not in cuts:
                res.error(f"{w}.cut {f.get('cut')!r} is not a cut of this version")
        _check_region(res, w, f.get("region"))
    return res


def validate_file(path: Path, manifest_path: Path | None = None) -> Result:
    try:
        obj = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        res = Result()
        res.error(f"cannot read {path}: {exc}")
        return res
    schema = obj.get("schema") if isinstance(obj, dict) else None
    if schema == MANIFEST_SCHEMA:
        return validate_manifest(obj, version_dir=path.parent.name)
    manifest = None
    mp = manifest_path or path.parent / "manifest.json"
    if mp.exists():
        try:
            manifest = json.loads(mp.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            manifest = None
    if schema == FEEDBACK_SCHEMA:
        return validate_feedback(obj, manifest)
    if schema == REPORT_SCHEMA:
        return validate_report(obj, manifest)
    res = Result()
    res.error(f"unknown schema {schema!r}")
    return res


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("file", type=Path)
    ap.add_argument("--manifest", type=Path, help="manifest to check feedback or a report against "
                    "(default: manifest.json next to the file)")
    args = ap.parse_args(argv)
    res = validate_file(args.file, args.manifest)
    for e in res.errors:
        print(f"ERROR   {e}")
    for w in res.warnings:
        print(f"WARNING {w}")
    if res.ok:
        print(f"OK      {args.file}" + (f" ({len(res.warnings)} warning(s))" if res.warnings else ""))
    return 0 if res.ok else 1


if __name__ == "__main__":
    sys.exit(main())
