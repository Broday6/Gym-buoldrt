#!/usr/bin/env python3
"""End-to-end test of the install-video review kit on a generated demo project.

    python tests/test_kit.py [--keep DIR] [--no-browser]

Builds a demo project, runs every evaluator script on it, writes and assembles judgments,
then serves it and drives the Review Studio in Chromium (needs Node and Playwright; skipped
with --no-browser or when they are missing). Needs ffmpeg and ffprobe.
"""
from __future__ import annotations

import argparse
import filecmp
import json
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

KIT = Path(__file__).resolve().parent.parent
REVIEW = KIT / "skills" / "ekena-install-video-review"
EVAL = KIT / "skills" / "ekena-install-video-evaluator"
PY = sys.executable
failures = 0


def check(cond: bool, msg: str) -> None:
    global failures
    print(("  ok   " if cond else "  FAIL ") + msg)
    if not cond:
        failures += 1


def run(*args, expect=0) -> subprocess.CompletedProcess:
    proc = subprocess.run([str(a) for a in args], capture_output=True, text=True)
    if expect is not None and proc.returncode != expect:
        print(proc.stdout[-2000:], proc.stderr[-2000:], sep="\n")
        check(False, f"{Path(str(args[1])).name} exited {proc.returncode}, expected {expect}")
    return proc


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def judgments_v1(m: dict) -> dict:
    full = {k: 2 for k in ("product", "install", "physics", "graphics", "sync", "reframe", "craft")}
    scenes = [{"scene": s["id"], "scores": dict(full)} for s in m["scenes"]]
    by = {s["scene"]: s for s in scenes}
    by["s03"]["scores"]["physics"] = 0
    by["s04"]["scores"]["sync"] = 1
    by["s05"]["scores"]["reframe"] = 1
    return {"scenes": scenes, "findings": [
        {"scene": "s03", "action": "drill_2", "cut": "16x9", "frame": 570, "end_frame": 719, "severity": "blocker",
         "criterion": "physics", "what": "The screw-in stops dead halfway through the scene.",
         "fix": "Re-render s03 from f570.", "evidence": ["review/v1/eval/strips/16x9_drill_2.jpg"],
         "region": {"x": 0.1, "y": 0.5, "w": 0.35, "h": 0.45}},
        {"scene": "s04", "frame": 720, "severity": "major", "criterion": "sync",
         "what": "Narration for 'How it holds' starts late.", "fix": "Move the s04 line earlier."},
        {"scene": "s05", "action": "lift", "cut": "9x16", "frame": 970, "severity": "minor", "criterion": "reframe",
         "what": "Vertical cut crops the end of the beam.", "fix": "Shift the 9:16 crop right.",
         "region": {"x": 0.6, "y": 0.3, "w": 0.4, "h": 0.4}},
    ]}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--keep", type=Path, help="build the demo here and leave it")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    for t in ("ffmpeg", "ffprobe"):
        if not shutil.which(t):
            print(f"SKIP: {t} not found")
            return 0
    tmp = None
    if args.keep:
        root = args.keep
    else:
        tmp = tempfile.TemporaryDirectory()
        root = Path(tmp.name)
    proj = root / "demo"

    print("shared files")
    check(filecmp.cmp(REVIEW / "scripts/validate_review.py", EVAL / "scripts/validate_review.py", shallow=False),
          "validate_review.py is the same in both skills")
    check(filecmp.cmp(REVIEW / "references/schemas.md", EVAL / "references/schemas.md", shallow=False),
          "schemas.md is the same in both skills")

    print("demo project")
    run(PY, KIT / "tools/make_demo_project.py", proj, "--codec", "vp9")
    for v in ("v1", "v2"):
        run(PY, REVIEW / "scripts/validate_review.py", proj / f"review/{v}/manifest.json")
    run(PY, REVIEW / "scripts/validate_review.py", proj / "review/v1/feedback.json")

    print("technical checks")
    p = run(PY, EVAL / "scripts/tech_checks.py", proj, "v1", "--expect-codec", "any", expect=1)
    tech = json.loads((proj / "review/v1/eval/technical.json").read_text())
    failed = {c["id"] for c in tech["checks"] if not c["pass"]}
    check(failed == {"frozen_frames"}, f"v1 fails only on the planted freeze (failed: {sorted(failed)})")
    fr = next(c for c in tech["checks"] if c["id"] == "frozen_frames")["frames"]
    # The freeze starts at f570. Encoders keep refining a still frame for a while, so detection can lag a little.
    check(570 <= fr[0] <= 640 and fr[1] - fr[0] >= 60, f"the freeze is placed in the second half of s03 (f{fr[0]}–{fr[1]})")
    run(PY, EVAL / "scripts/tech_checks.py", proj, "v2", "--expect-codec", "any", expect=0)
    p = run(PY, EVAL / "scripts/tech_checks.py", proj, "v2", expect=1)
    check("codec" in p.stdout and "expected h264" in p.stdout, "the codec check holds the line at H.264 by default")
    run(PY, EVAL / "scripts/tech_checks.py", proj, "v2", "--expect-codec", "any", expect=0)

    print("frames")
    run(PY, EVAL / "scripts/extract_frames.py", proj, "v1")
    idx = (proj / "review/v1/eval/frames.md").read_text()
    check("## s03" in idx and "16x9_drill_1.jpg" in idx, "frames.md indexes scenes and action strips")
    check((proj / "review/v1/eval/frames/16x9_f000460.jpg").exists(), "the exact action frame is extracted")
    import importlib.util
    if importlib.util.find_spec("PIL"):
        check((proj / "review/v1/eval/sheets/9x16_s03.jpg").exists() and (proj / "review/v1/eval/pairs/s03_drill_1.jpg").exists(),
              "sheets and reframe pairs are drawn")
    else:
        print("  (Pillow missing: sheets not checked)")
    run(PY, EVAL / "scripts/extract_frames.py", proj, "v1", "--scenes", "nope", expect=2)

    print("narration")
    m1 = json.loads((proj / "review/v1/manifest.json").read_text())
    words = []
    for s in m1["scenes"]:
        if not s.get("narration"):
            continue
        t0 = s["start_frame"] / 60 + 0.3
        text = s["narration"]
        if s["id"] == "s04":
            t0 = next(x for x in m1["scenes"] if x["id"] == "s05")["start_frame"] / 60 + 0.1
        if s["id"] == "s03":
            text = text.replace("mounting block", "mountain block")
        for i, w in enumerate(text.split()):
            words.append({"word": " " + w, "start": t0 + i * 0.18, "end": t0 + i * 0.18 + 0.15})
    (root / "words.json").write_text(json.dumps(words))
    run(PY, EVAL / "scripts/transcribe_check.py", proj, "v1", "--words", root / "words.json")
    nar = {r["scene"]: r for r in json.loads((proj / "review/v1/eval/narration.json").read_text())["scenes"]}
    check(nar["s03"]["missing_terms"] == ["mounting block"], "a near-miss key term ('mountain block') is caught")
    check(nar["s04"]["flag"] and "s05" in nar["s04"]["flag"], "a line that drifts into the next scene is caught")
    check(nar["s02"]["flag"] is None and not nar["s02"]["missing_terms"], "a correct line passes (joist/joists match)")

    print("report")
    jpath = proj / "review/v1/eval/judgments.json"
    j = judgments_v1(m1)
    bad = json.loads(json.dumps(j))
    bad["scenes"] = bad["scenes"][:-1]
    bad["findings"] = bad["findings"][1:]
    jpath.write_text(json.dumps(bad))
    p = run(PY, EVAL / "scripts/assemble_report.py", proj, "v1", expect=1)
    check("s06 was not judged" in p.stderr and "physics scored 0" in p.stderr, "incomplete judgments are refused with reasons")
    jpath.write_text(json.dumps(j))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v1")
    r1 = json.loads((proj / "review/v1/eval-report.json").read_text())
    check(r1["overall"] == "fail", "v1 fails")
    check([f["id"] for f in r1["findings"]][:2] == ["e1", "e2"] and r1["findings"][0]["severity"] == "blocker",
          "findings are numbered with blockers first")
    check(any(f["criterion"] == "technical" and "frozen" in f["what"] for f in r1["findings"]), "failed technical checks become findings")
    check(any(f["criterion"] == "narration" for f in r1["findings"]), "narration problems become findings")
    run(PY, REVIEW / "scripts/validate_review.py", proj / "review/v1/eval-report.json")

    (proj / "review/v2/eval/judgments.json").write_text(json.dumps({"carry_from": "v1", "scenes": [
        {"scene": "s03", "scores": {k: 2 for k in ("product", "install", "physics", "graphics", "sync", "reframe", "craft")}}]}))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")
    r2 = json.loads((proj / "review/v2/eval-report.json").read_text())
    carried = sorted(s["scene"] for s in r2["scenes"] if s["carried"])
    check(r2["overall"] == "pass" and carried == ["s01", "s02", "s04", "s05", "s06"], f"v2 passes and carries unchanged scenes ({carried})")
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps({"carry_from": "v1", "scenes": []}))
    p = run(PY, EVAL / "scripts/assemble_report.py", proj, "v2", expect=1)
    check("s03 can't keep v1's verdict" in p.stderr, "a changed scene cannot carry the old verdict")
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps({"carry_from": "v1", "scenes": [
        {"scene": "s03", "scores": {k: 2 for k in ("product", "install", "physics", "graphics", "sync", "reframe", "craft")}}]}))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")
    check((proj / "review/eval-log.md").read_text().count("## v") >= 2, "eval-log.md gets an entry per report")

    print("server and studio")
    port = free_port()
    server = subprocess.Popen([PY, str(REVIEW / "scripts/review_server.py"), str(proj), "--no-open", "--port", str(port)],
                              stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    try:
        url = f"http://127.0.0.1:{port}/"
        for _ in range(50):
            try:
                urllib.request.urlopen(url + "api/project", timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        proj_info = json.loads(urllib.request.urlopen(url + "api/project").read())
        check([v["id"] for v in proj_info["versions"]] == ["v1", "v2"], "the server lists both versions")
        check(proj_info["versions"][0]["eval_overall"] == "fail" and proj_info["versions"][1]["eval_overall"] == "pass",
              "the server reports each version's verdict")
        req = urllib.request.Request(url + "files/renders/v1/demo_16x9.webm", headers={"Range": "bytes=0-99"})
        with urllib.request.urlopen(req) as resp:
            check(resp.status == 206 and len(resp.read()) == 100, "video is served in byte ranges (seeking works)")
        node = shutil.which("node")
        if args.no_browser or not node:
            print("  (browser part skipped)")
        else:
            shots = root / "shots"
            shots.mkdir(exist_ok=True)
            p = subprocess.run([node, str(KIT / "tests/studio_e2e.mjs"), url, str(proj),
                                str(REVIEW / "assets/studio.html"), str(shots)], text=True, capture_output=True)
            print(p.stdout.rstrip())
            if p.returncode != 0:
                print(p.stderr[-3000:])
            check(p.returncode == 0, "studio end-to-end")
            if "SKIP" not in p.stdout:
                check((proj / "review/v1/feedback.prev.json").exists(), "saving keeps the previous feedback.json")
                run(PY, REVIEW / "scripts/validate_review.py", proj / "review/v1/feedback.json")
    finally:
        server.terminate()
        server.wait(timeout=5)

    print(f"\n{'ALL PASSED' if not failures else f'{failures} FAILED'}" + (f" — demo kept in {root}" if args.keep else ""))
    if tmp:
        tmp.cleanup()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
