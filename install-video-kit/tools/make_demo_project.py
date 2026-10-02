#!/usr/bin/env python3
"""Build a small fake install-video project to try the Review Studio and evaluator on.

    python make_demo_project.py demo-project
    python review_server.py demo-project

It writes two versions. v1 has a deliberate 2.5 s freeze in scene s03. v2 "fixes" it and lists
that fix in its changes. Both are 20 s at 60 fps, in a 16:9 and a 9:16 cut, with a test pattern
standing in for the 3D render.

Pass --codec vp9 to write WebM instead of H.264 MP4. That is for browsers without H.264, such as
the open-source Chromium used in automated tests. Edge and Chrome play the MP4s.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path

FPS = 60
SCENES = [
    # id, kind, title, frames, hue, step card, narration, claims, actions [(id, label, offset, length)]
    ("s01", "title", "Title", 120, None, None, None, [], []),
    ("s02", "step", "Locate the joists", 300, 0,
     "Step 1 — Find and mark the joists",
     "Use a stud finder to find each ceiling joist, and mark it with a pencil.",
     ["C1"], [("mark_1", "Mark joist 1", 60, 30), ("mark_2", "Mark joist 2", 180, 30)]),
    ("s03", "step", "Fasten the mounting blocks", 300, 90,
     "Step 2 — Screw the mounting blocks into the joists",
     "Screw each mounting block into a joist with two screws.",
     ["C2"], [("drill_1", "Drive screw 1", 40, 40), ("drill_2", "Drive screw 2", 200, 40)]),
    ("s04", "diagram", "How it holds", 240, 200,
     "How it holds",
     "The beam slides over the blocks, so the screws stay hidden.",
     ["C3"], []),
    ("s05", "step", "Lift and fasten the beam", 120, 300,
     "Step 3 — Lift the beam over the blocks and fasten from the side",
     "Lift the beam over the blocks and fasten it through the sides.",
     ["C4"], [("lift", "Lift beam", 10, 60)]),
    ("s06", "end", "End card", 120, None, None, None, [], []),
]
CLAIMS = [
    {"id": "C1", "text": "Mounting blocks fasten into ceiling joists", "source": "Install guide p.1, step 1"},
    {"id": "C2", "text": "Two screws per mounting block", "source": "Install guide p.1, step 2"},
    {"id": "C3", "text": "Beam conceals the mounting blocks", "source": "Product page, 'Installation'"},
    {"id": "C4", "text": "Fasten through the beam sides into the blocks", "source": "Install guide p.2, step 4"},
]
CUTS = [("16x9", 640, 360), ("9x16", 360, 640)]
FREEZE_SCENE = "s03"


def tiny_pdf(lines: list[str]) -> bytes:
    """A one-page PDF with a few lines of text: enough to stand in for an install guide."""
    esc = lambda t: t.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")  # noqa: E731
    text = "BT /F1 14 Tf 60 760 Td 20 TL " + " ".join(f"({esc(ln)}) Tj T*" for ln in lines) + " ET"
    objs = ["<< /Type /Catalog /Pages 2 0 R >>",
            "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
            "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
            "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
            f"<< /Length {len(text)} >>\nstream\n{text}\nendstream"]
    body, offsets = b"%PDF-1.4\n", []
    for i, o in enumerate(objs, 1):
        offsets.append(len(body))
        body += f"{i} 0 obj\n{o}\nendobj\n".encode("latin-1")
    xref = len(body)
    body += f"xref\n0 {len(objs) + 1}\n0000000000 65535 f \n".encode()
    body += "".join(f"{o:010d} 00000 n \n" for o in offsets).encode()
    body += f"trailer\n<< /Size {len(objs) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n".encode()
    return body


def run(cmd: list[str]) -> None:
    proc = subprocess.run(cmd, capture_output=True, text=True)
    if proc.returncode != 0:
        sys.stderr.write(proc.stderr[-3000:])
        raise SystemExit(f"ffmpeg failed: {' '.join(cmd[:6])} …")


def scene_layout() -> list[dict]:
    out, start = [], 0
    for sid, kind, title, n, hue, card, narr, claims, actions in SCENES:
        out.append({"id": sid, "kind": kind, "title": title, "start_frame": start,
                    "end_frame": start + n, "hue": hue, "step_card": card, "narration": narr,
                    "claims": claims,
                    "actions": [{"id": a, "label": lbl, "frame": start + off, "end_frame": start + off + ln - 1}
                                for a, lbl, off, ln in actions]})
        start += n
    return out


def render(path: Path, w: int, h: int, with_freeze: bool, codec: str, ffmpeg: str) -> None:
    layout = scene_layout()
    total = layout[-1]["end_frame"]
    inputs: list[str] = []
    chains: list[str] = []
    for i, s in enumerate(layout):
        n = s["end_frame"] - s["start_frame"]
        dur = n / FPS
        if s["hue"] is None:
            inputs += ["-f", "lavfi", "-i", f"color=c=0x2f6b3c:s={w}x{h}:r={FPS}:d={dur}"]
            chains.append(f"[{i}:v]format=yuv420p,setsar=1[v{i}]")
        elif with_freeze and s["id"] == FREEZE_SCENE:
            half = n // 2
            inputs += ["-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r={FPS}:d={half / FPS}"]
            chains.append(f"[{i}:v]hue=h={s['hue']},tpad=stop_mode=clone:stop={n - half},"
                          f"format=yuv420p,setsar=1[v{i}]")
        else:
            inputs += ["-f", "lavfi", "-i", f"testsrc2=s={w}x{h}:r={FPS}:d={dur}"]
            chains.append(f"[{i}:v]hue=h={s['hue']},format=yuv420p,setsar=1[v{i}]")
    a = len(layout)
    inputs += ["-f", "lavfi", "-i",
               f"sine=frequency=220:sample_rate=48000:duration={total / FPS},volume=8dB"]
    concat = "".join(f"[v{i}]" for i in range(len(layout)))
    graph = ";".join(chains) + f";{concat}concat=n={len(layout)}:v=1:a=0[v]"
    venc = (["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p"]
            if codec == "h264" else
            ["-c:v", "libvpx-vp9", "-b:v", "0", "-crf", "40", "-deadline", "realtime", "-cpu-used", "8"])
    aenc = ["-c:a", "aac", "-b:a", "128k"] if codec == "h264" else ["-c:a", "libopus", "-b:a", "96k"]
    run([ffmpeg, "-y", "-hide_banner", *inputs, "-filter_complex", graph,
         "-map", "[v]", "-map", f"{a}:a", "-r", str(FPS), "-frames:v", str(total),
         *venc, "-ac", "2", *aenc, "-shortest", str(path)])


def manifest_for(version: str, previous: str | None, files: dict[str, str], changes: list) -> dict:
    layout = scene_layout()
    scenes = []
    for s in layout:
        scene = {k: s[k] for k in ("id", "title", "kind", "start_frame", "end_frame",
                                   "step_card", "narration", "claims", "actions")}
        scene["transition_in"] = "cut"
        if s["kind"] in ("title", "end"):
            scene["static_ok"] = True
        scene["source"] = {"files": [f"scenes/{s['id']}.js"],
                           "timeline_keys": [a["id"] for a in s["actions"]]}
        scenes.append(scene)
    return {
        "schema": "ekena-install-review/1",
        "project": "Demo — Faux Beam Ceiling Install",
        "version": version,
        "created": "2026-09-30T14:00:00Z",
        "previous": previous,
        "fps": FPS,
        "frame_count": layout[-1]["end_frame"],
        "target_duration_s": layout[-1]["end_frame"] / FPS,
        "cuts": [{"id": cid, "file": files[cid], "width": w, "height": h} for cid, w, h in CUTS],
        "scenes": scenes,
        "claims": CLAIMS,
        "key_terms": ["joists", "mounting block"],
        "references": {"install_guide": "research/install-guide.pdf",
                       "product_images": ["research/product.jpg"], "house_rules": "HOUSE_RULES.md",
                       "readme": "README.md"},
        "changes": changes,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("out", type=Path, help="folder to create (replaced if it holds a previous demo)")
    ap.add_argument("--codec", choices=("h264", "vp9"), default="h264")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    args = ap.parse_args(argv)
    out: Path = args.out
    if out.exists():
        if not (out / ".demo-project").exists():
            raise SystemExit(f"{out} exists and is not a demo project; pick another folder")
        shutil.rmtree(out)
    (out / "review").mkdir(parents=True)
    (out / ".demo-project").write_text("made by make_demo_project.py\n")
    (out / "research").mkdir()
    run([args.ffmpeg, "-y", "-hide_banner", "-f", "lavfi", "-i",
         "gradients=s=800x450:c0=0x6b4a2b:c1=0x8a6440", "-frames:v", "1",
         str(out / "research" / "product.jpg")])
    (out / "research" / "install-guide.pdf").write_bytes(tiny_pdf(
        ["Demo faux beam - installation guide",
         "1. Find the ceiling joists and mark them.",
         "2. Screw each mounting block into a joist with two screws.",
         "3. Slide the beam over the blocks.",
         "4. Fasten through the sides of the beam into the blocks."]))
    (out / "HOUSE_RULES.md").write_text(
        "# House rules\n\n"
        "1. No size callouts on screen or in the narration.\n"
        "2. Two screws per mounting block, never one.\n", encoding="utf-8")
    (out / "README.md").write_text(
        "# Demo — Faux Beam Ceiling Install\n\n| Claim | Line | Source |\n|---|---|---|\n"
        + "".join(f"| {c['id']} | {c['text']} | {c['source']} |\n" for c in CLAIMS), encoding="utf-8")

    ext = "mp4" if args.codec == "h264" else "webm"
    for version, freeze in (("v1", True), ("v2", False)):
        files = {}
        for cid, w, h in CUTS:
            rel = f"renders/{version}/demo_{cid}.{ext}"
            (out / rel).parent.mkdir(parents=True, exist_ok=True)
            render(out / rel, w, h, freeze, args.codec, args.ffmpeg)
            files[cid] = rel
        s03 = next(s for s in scene_layout() if s["id"] == FREEZE_SCENE)
        changes = [] if version == "v1" else [
            {"kind": "note", "note": "v1-n1", "finding": None, "scene": "s03",
             "frames": [s03["start_frame"], s03["end_frame"] - 1], "status": "addressed",
             "summary": "Second half of the screw-in no longer freezes"},
            {"kind": "note", "note": "v1-n2", "finding": None, "scene": "s05", "status": "declined",
             "summary": "Kept 'fasten from the side': the guide's step 4 says to fasten through the sides"},
        ]
        m = manifest_for(version, None if version == "v1" else "v1", files, changes)
        vdir = out / "review" / version
        vdir.mkdir(parents=True)
        (vdir / "manifest.json").write_text(json.dumps(m, indent=2, ensure_ascii=False), encoding="utf-8")

    # v1 already has the user's notes, so v2 can show them as "previous notes".
    s03 = next(s for s in scene_layout() if s["id"] == FREEZE_SCENE)
    s05 = next(s for s in scene_layout() if s["id"] == "s05")
    fb = {
        "schema": "ekena-install-feedback/1", "project": "Demo — Faux Beam Ceiling Install",
        "version": "v1", "updated": "2026-09-30T15:30:00Z", "submitted": True,
        "approved": False, "approved_at": None,
        "notes": [
            {"id": "v1-n1", "cut": "16x9", "frame": s03["start_frame"] + 200, "scene": "s03",
             "action": "drill_2", "category": "physics", "priority": "must",
             "text": "Picture freezes halfway through the second screw",
             "region": {"x": 0.3, "y": 0.25, "w": 0.4, "h": 0.5}, "from_finding": None,
             "created": "2026-09-30T15:20:00Z"},
            {"id": "v1-n2", "cut": "16x9", "frame": s05["start_frame"] + 30, "scene": "s05",
             "action": "lift", "category": "text", "priority": "nice",
             "text": "Should the card say 'fasten from below'?", "region": None,
             "from_finding": None, "created": "2026-09-30T15:25:00Z"},
        ],
        "text_changes": [], "pace": [], "findings": {},
    }
    (out / "review" / "v1" / "feedback.json").write_text(json.dumps(fb, indent=2), encoding="utf-8")
    print(f"Demo project written to {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
