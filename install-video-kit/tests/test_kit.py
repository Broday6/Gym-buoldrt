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
import functools
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
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
    for card in ("s01", "s06"):  # title and end cards: no product or action to judge
        by[card]["scores"].update(product=None, install=None, physics=None)
    by["s03"]["scores"]["physics"] = 0
    by["s04"]["scores"]["sync"] = 1
    by["s05"]["scores"]["reframe"] = 1
    for sid in ("s02", "s03", "s05"):
        by[sid]["scores"]["graphics"] = 1
    return {"scenes": scenes, "findings": [
        {"scene": "s02", "scenes": ["s02", "s03", "s05"], "cut": None, "frame": 130, "end_frame": 1079,
         "severity": "blocker", "criterion": "graphics", "scope": "systemic",
         "what": "Step cards sit on the timecode box in every step scene.",
         "fix": "One cause: the card anchor in graphics/cards.js ignores the safe area."},
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
    check(565 <= fr[0] <= 572 and fr[1] == 719, f"the freeze is found from where it really starts (f{fr[0]}–{fr[1]}; held from f569/570)")
    cuts = next(c for c in tech["checks"] if c["id"] == "cuts_on_frame" and c["cut"] == "16x9")
    check(cuts["pass"] and cuts["detail"].startswith("5 hard cut"), f"cuts between look-alike shots are found ({cuts['detail']})")
    card = next((c for c in tech["checks"] if c["id"] == "card_reading_time"), None)
    check(card is not None and card["severity"] == "warning" and "s05" in card["detail"], "a card too long for its scene is warned about")
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

    print("narration without a speech model")
    run(PY, EVAL / "scripts/transcribe_check.py", proj, "v2")
    v2n = json.loads((proj / "review/v2/eval/narration.json").read_text())
    flagged = [r["scene"] for r in (v2n.get("audio_activity") or {}).get("scenes", []) if r["flag"]]
    check(v2n["available"] is False and flagged == ["s02", "s03", "s04", "s05"],
          f"with no model, a steady tone where narration should be is still caught ({flagged})")

    print("report")
    jpath = proj / "review/v1/eval/judgments.json"
    j = judgments_v1(m1)
    bad = json.loads(json.dumps(j))
    bad["scenes"] = bad["scenes"][:-1]
    bad["findings"] = [f for f in bad["findings"] if f["criterion"] != "physics"]
    bad["scenes"][3]["scores"]["craft"] = 0  # s04
    bad["findings"].append({"scene": "s04", "frame": 800, "severity": "major", "criterion": "craft", "what": "Flicker."})
    bad["scenes"][2]["scores"]["product"] = None  # s03 is a step: product can't be skipped
    jpath.write_text(json.dumps(bad))
    p = run(PY, EVAL / "scripts/assemble_report.py", proj, "v1", expect=1)
    check("s06 was not judged" in p.stderr and "physics scored 0" in p.stderr, "incomplete judgments are refused with reasons")
    check("craft scored 0" in p.stderr, "a 0 explained only by a major is refused: whatever fails a scene is a blocker")
    check("scene s03: score product must be" in p.stderr, "a step scene can't mark product as not applicable")
    jpath.write_text(json.dumps(j))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v1")
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v1")
    r1 = json.loads((proj / "review/v1/eval-report.json").read_text())
    check(r1["overall"] == "fail", "v1 fails")
    check(all(f["id"] == f"e{i}" for i, f in enumerate(r1["findings"], 1)) and r1["findings"][0]["severity"] == "blocker",
          "findings are numbered with blockers first")
    sysf = [f for f in r1["findings"] if f.get("scope") == "systemic"]
    check(len(sysf) == 1 and sysf[0]["scenes"] == ["s02", "s03", "s05"], "one systemic finding explains the same defect in three scenes")
    titles = {s["scene"]: s for s in r1["scenes"]}
    check(titles["s01"]["scores"]["product"] is None and titles["s01"]["pass"], "title cards can leave product/install/physics unscored")
    check(not any(f["what"].startswith("expected_cuts") for f in r1["findings"]), "an undetected cut is not reported as a fault")
    check((proj / "review/eval-log.md").read_text().count("## v1 —") == 1, "re-running the report replaces its log entry")
    check(any(f["criterion"] == "technical" and "frozen" in f["what"] for f in r1["findings"]), "failed technical checks become findings")
    check(any(f["criterion"] == "narration" for f in r1["findings"]), "narration problems become findings")
    run(PY, REVIEW / "scripts/validate_review.py", proj / "review/v1/eval-report.json")

    v2_judgments = {"carry_from": "v1", "scenes": [{"scene": "s03", "scores": {
        k: 2 for k in ("product", "install", "physics", "graphics", "sync", "reframe", "craft")}}]}
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps(v2_judgments))
    p = run(PY, EVAL / "scripts/assemble_report.py", proj, "v2", expect=1)
    check("s02 failed in v1 and nothing in it changed" in p.stderr, "a scene that failed can't carry its verdict forward")
    full = {k: 2 for k in ("product", "install", "physics", "graphics", "sync", "reframe", "craft")}
    v2_judgments["scenes"] = [{"scene": sid, "scores": dict(full)} for sid in ("s02", "s03", "s05")]
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps(v2_judgments))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")
    r2 = json.loads((proj / "review/v2/eval-report.json").read_text())
    carried = sorted(s["scene"] for s in r2["scenes"] if s["carried"])
    check(r2["overall"] == "pass" and carried == ["s01", "s04", "s06"], f"v2 passes and carries unchanged, passing scenes ({carried})")
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps({"carry_from": "v1", "scenes": v2_judgments["scenes"][::2]}))
    p = run(PY, EVAL / "scripts/assemble_report.py", proj, "v2", expect=1)
    check("s03 can't keep v1's verdict" in p.stderr, "a changed scene cannot carry the old verdict")
    (proj / "review/v2/eval/judgments.json").write_text(json.dumps(v2_judgments))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")
    r2 = json.loads((proj / "review/v2/eval-report.json").read_text())
    check(sum(1 for f in r2["findings"] if f["criterion"] == "narration" and f["severity"] == "major") == 4,
          "the no-model audio flags become findings for Brody")
    check((proj / "review/eval-log.md").read_text().count("## v") == 2, "eval-log.md has one entry per version")
    guide = proj / "research/install-guide.pdf"
    guide.rename(guide.with_suffix(".bak"))
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")
    r2 = json.loads((proj / "review/v2/eval-report.json").read_text())
    check(r2["overall"] == "fail" and any("install guide" in f["what"] and f["severity"] == "blocker" for f in r2["findings"]),
          "a missing install guide is a blocker")
    guide.with_suffix(".bak").rename(guide)
    run(PY, EVAL / "scripts/assemble_report.py", proj, "v2")

    print("note frames")
    p = run(PY, REVIEW / "scripts/note_frames.py", proj, "v1")
    check((proj / "review/v1/builder/v1-n1.jpg").exists() and (proj / "review/v1/builder/v1-n1_strip.jpg").exists()
          and "scenes/s03.js" in p.stdout, "each note's exact frame and strip come out with its code pointer")

    print("publish gate")
    gate = REVIEW / "scripts/publish_gate.py"
    p = run(PY, gate, proj, "--version", "v1", expect=1)
    check("evaluator failed v1" in p.stdout and "hasn't approved v1" in p.stdout and "isn't the latest" in p.stdout,
          "the gate blocks a failed, unapproved, superseded version and says why")
    p = run(PY, gate, proj, expect=1)
    check("BLOCKED" in p.stdout and "hasn't approved v2" in p.stdout, "the gate blocks the latest version until Brody approves it")
    fb2 = {"schema": "ekena-install-feedback/1", "project": "Demo — Faux Beam Ceiling Install", "version": "v2",
           "updated": "2026-10-05T12:00:00Z", "submitted": True, "approved": True, "approved_at": "2026-10-05T12:00:00Z",
           "notes": [], "text_changes": [], "pace": [], "findings": {}}
    (proj / "review/v2/feedback.json").write_text(json.dumps(fb2))
    m2 = json.loads((proj / "review/v2/manifest.json").read_text())
    approved_file = proj / m2["cuts"][0]["file"]
    p = run(PY, gate, proj, "--file", approved_file, expect=0)
    rel = json.loads((proj / "review/v2/release.json").read_text())
    check("CLEARED" in p.stdout and len(rel["cuts"]) == 2 and rel["published_files"][0]["cut"] == "16x9",
          "an approved, passing version clears and gets a release.json")
    p = run(PY, gate, proj, "--file", proj / json.loads((proj / "review/v1/manifest.json").read_text())["cuts"][0]["file"], expect=1)
    check("not one of the approved v2 cuts" in p.stdout, "a file that isn't the approved render is blocked")
    mpath, epath = proj / "review/v2/manifest.json", proj / "review/v2/eval-report.json"
    st = mpath.stat()
    os.utime(mpath, (st.st_atime, epath.stat().st_mtime + 60))
    p = run(PY, gate, proj, expect=1)
    check("changed after the evaluation" in p.stdout, "a manifest changed after evaluation is blocked")
    os.utime(mpath, (st.st_atime, st.st_mtime))
    (proj / "review/v2/feedback.json").unlink()
    (proj / "review/v2/release.json").unlink()

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
        bundle = root / "bundle"
        run(PY, KIT / "tools/build_static_review.py", proj, bundle)
        sj = json.loads((bundle / "studio-static.json").read_text())
        check(sorted(sj["data"]) == ["v1", "v2"] and (bundle / "renders/v2/demo_9x16.webm").exists()
              and "window.REVIEW_BUNDLE" in (bundle / "index.html").read_text(), "a project bundles into a static copy")
        proxy = root / "bundle-proxy"
        run(PY, KIT / "tools/build_static_review.py", proj, proxy, "--proxy-mb", "1.5")
        pf = proxy / "renders/v1/demo_16x9.webm"
        n = subprocess.run(["ffprobe", "-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
                            "stream=nb_read_frames,width", "-of", "csv=p=0", str(pf)], capture_output=True, text=True).stdout.strip()
        demo_frames = json.loads((proj / "review/v1/manifest.json").read_text())["frame_count"]
        check(n == f"1280,{demo_frames}" and pf.stat().st_size <= 1.5e6,
              f"review proxies keep every frame and fit the size budget ({n}, {pf.stat().st_size / 1e6:.2f} MB)")
        class Quiet(http.server.SimpleHTTPRequestHandler):
            def log_message(self, *a):
                pass
        handler = functools.partial(Quiet, directory=str(bundle))
        static = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=static.serve_forever, daemon=True).start()
        node = shutil.which("node")
        if args.no_browser or not node:
            print("  (browser part skipped)")
        else:
            shots = root / "shots"
            shots.mkdir(exist_ok=True)
            p = subprocess.run([node, str(KIT / "tests/studio_e2e.mjs"), url, str(proj),
                                str(REVIEW / "assets/studio.html"), str(shots),
                                f"http://127.0.0.1:{static.server_address[1]}/"], text=True, capture_output=True)
            print(p.stdout.rstrip())
            if p.returncode != 0:
                print(p.stderr[-3000:])
            check(p.returncode == 0, "studio end-to-end")
            if "SKIP" not in p.stdout:
                check((proj / "review/v1/feedback.prev.json").exists(), "saving keeps the previous feedback.json")
                run(PY, REVIEW / "scripts/validate_review.py", proj / "review/v1/feedback.json")
        static.shutdown()
    finally:
        server.terminate()
        server.wait(timeout=5)

    print(f"\n{'ALL PASSED' if not failures else f'{failures} FAILED'}" + (f" — demo kept in {root}" if args.keep else ""))
    if tmp:
        tmp.cleanup()
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
