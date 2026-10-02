#!/usr/bin/env python3
"""Pull exact frames from the delivered files and lay them out for judging.

    python extract_frames.py <project> <version> [--scenes s03,s05]

For every cut it decodes exactly the frames it needs, by frame number, from the finished video:

  eval/frames/<cut>_f000734.jpg   full-size frames
  eval/sheets/<cut>_<scene>.jpg   one contact sheet per scene: evenly spaced frames, first to last
  eval/strips/<cut>_<action>.jpg  one strip per action: frames across the action, to judge motion
  eval/pairs/<scene>_<what>.jpg   the same moment in every cut side by side, to judge the reframe
  eval/frames.md                  index: which image shows which frames

The sheets, strips and pairs need Pillow (pip install pillow). Without it you still get every
frame, and frames.md lists them.
--scenes limits the work to scenes changed since the last version.
"""
from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from evalkit import EvalError, cut_path, fmt_time, load_version, run, tool  # noqa: E402

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:  # sheets are skipped; frames still come out
    Image = None

CHUNK = 200  # frames per decoding pass: keeps the select expression short on Windows


def spread(a: int, b: int, n: int) -> list[int]:
    """n frame numbers spread evenly from a to b inclusive."""
    if b <= a or n <= 1:
        return [a]
    return sorted({a + round(k * (b - a) / (n - 1)) for k in range(n)})


def plan(m: dict, per_scene: int, strip: int, only: set | None) -> dict:
    fps = m["fps"]
    out = {"scenes": []}
    for s in m["scenes"]:
        if only and s["id"] not in only:
            continue
        a, b = s["start_frame"], s["end_frame"] - 1
        entry = {"scene": s, "sample": spread(a, b, per_scene), "actions": []}
        for act in s.get("actions") or []:
            start = act["frame"]
            end = act.get("end_frame")
            if end is None or end <= start:
                half = int(round(fps * 0.25))
                start, end = max(a, start - half), min(b, start + half)
            entry["actions"].append({"action": act, "frames": spread(start, min(end, b), strip)})
        out["scenes"].append(entry)
    return out


def wanted_frames(p: dict) -> list[int]:
    fr = set()
    for e in p["scenes"]:
        fr.update(e["sample"])
        for a in e["actions"]:
            fr.update(a["frames"])
            fr.add(a["action"]["frame"])
    return sorted(fr)


def extract(ffmpeg: str, src: Path, frames: list[int], dest: Path, cut_id: str) -> dict[int, Path]:
    dest.mkdir(parents=True, exist_ok=True)
    got: dict[int, Path] = {}
    todo = [f for f in frames if not (dest / f"{cut_id}_f{f:06d}.jpg").exists()]
    for f in frames:
        if f not in todo:
            got[f] = dest / f"{cut_id}_f{f:06d}.jpg"
    for i in range(0, len(todo), CHUNK):
        part = todo[i:i + CHUNK]
        expr = "+".join(f"eq(n\\,{f})" for f in part)
        with tempfile.TemporaryDirectory() as tmp:
            pattern = str(Path(tmp) / "%06d.jpg")
            base = [ffmpeg, "-hide_banner", "-nostats", "-v", "error", "-i", str(src),
                    "-vf", f"select='{expr}'", "-q:v", "2"]
            proc = run(base + ["-fps_mode", "passthrough", pattern], check=False)
            if proc.returncode != 0:  # ffmpeg older than 5.1
                proc = run(base + ["-vsync", "0", pattern])
            outs = sorted(Path(tmp).glob("*.jpg"))
            if len(outs) != len(part):
                raise EvalError(f"{src.name}: asked for {len(part)} frames, ffmpeg gave {len(outs)}. "
                                "Is frame_count in the manifest right?")
            for f, o in zip(part, outs):
                target = dest / f"{cut_id}_f{f:06d}.jpg"
                shutil.move(str(o), str(target))
                got[f] = target
    return got


_font_cache: dict = {}


def font(size: int):
    if size in _font_cache:
        return _font_cache[size]
    for name in ("segoeui.ttf", "arial.ttf", "DejaVuSans.ttf",
                 "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", "/System/Library/Fonts/Helvetica.ttc"):
        try:
            _font_cache[size] = ImageFont.truetype(name, size)
            return _font_cache[size]
        except OSError:
            continue
    try:
        _font_cache[size] = ImageFont.load_default(size=size)
    except TypeError:
        _font_cache[size] = ImageFont.load_default()
    return _font_cache[size]


def grid(images: list[tuple[Path, str]], cols: int, tile_w: int, title: str, out: Path) -> None:
    first = Image.open(images[0][0])
    tile_h = round(tile_w * first.height / first.width)
    label_h, head_h, gap = 28, 40, 6
    rows = (len(images) + cols - 1) // cols
    W = cols * tile_w + (cols + 1) * gap
    H = head_h + rows * (tile_h + label_h + gap) + gap
    sheet = Image.new("RGB", (W, H), (18, 20, 19))
    d = ImageDraw.Draw(sheet)
    d.text((gap + 4, 9), title, fill=(235, 240, 236), font=font(20))
    for i, (path, label) in enumerate(images):
        r, c = divmod(i, cols)
        x = gap + c * (tile_w + gap)
        y = head_h + r * (tile_h + label_h + gap)
        with Image.open(path) as im:
            sheet.paste(im.convert("RGB").resize((tile_w, tile_h)), (x, y))
        d.text((x + 2, y + tile_h + 4), label, fill=(190, 200, 194), font=font(16))
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)


def side_by_side(images: list[tuple[Path, str]], height: int, title: str, out: Path) -> None:
    gap, label_h, head_h = 8, 28, 40
    tiles = []
    for path, label in images:
        with Image.open(path) as im:
            w = round(im.width * height / im.height)
            tiles.append((im.convert("RGB").resize((w, height)), label))
    W = sum(t.width for t, _ in tiles) + gap * (len(tiles) + 1)
    H = head_h + height + label_h + gap
    sheet = Image.new("RGB", (W, H), (18, 20, 19))
    d = ImageDraw.Draw(sheet)
    d.text((gap + 4, 9), title, fill=(235, 240, 236), font=font(20))
    x = gap
    for t, label in tiles:
        sheet.paste(t, (x, head_h))
        d.text((x + 2, head_h + height + 4), label, fill=(190, 200, 194), font=font(16))
        x += t.width + gap
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, quality=88)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("project", type=Path)
    ap.add_argument("version")
    ap.add_argument("--scenes", help="comma-separated scene ids to cover (default: all)")
    ap.add_argument("--per-scene", type=int, default=6, help="frames per scene contact sheet")
    ap.add_argument("--strip", type=int, default=4, help="frames per action strip")
    ap.add_argument("--ffmpeg")
    args = ap.parse_args(argv)
    try:
        ffmpeg = tool("ffmpeg", args.ffmpeg)
        m, vdir = load_version(args.project, args.version)
        only = set(args.scenes.split(",")) if args.scenes else None
        if only:
            unknown = only - {s["id"] for s in m["scenes"]}
            if unknown:
                raise EvalError(f"no such scene(s): {', '.join(sorted(unknown))}")
        p = plan(m, args.per_scene, args.strip, only)
        frames = wanted_frames(p)
        eval_dir = vdir / "eval"
        got: dict[str, dict[int, Path]] = {}
        for cut in m["cuts"]:
            src = cut_path(args.project, cut)
            if not src.is_file():
                raise EvalError(f"{cut['file']} is missing")
            print(f"extracting {len(frames)} frames from {cut['id']} …", flush=True)
            got[cut["id"]] = extract(ffmpeg, src, frames, eval_dir / "frames", cut["id"])
    except EvalError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    fps = m["fps"]
    rel = lambda path: path.relative_to(args.project).as_posix()  # noqa: E731
    lab = lambda f, extra="": f"f{f} · {fmt_time(f, fps)}" + (f" · {extra}" if extra else "")  # noqa: E731
    lines = [f"# Frames for {m['project']} — {args.version}", "",
             f"{fps} fps, {m['frame_count']} frames. Cuts: " + ", ".join(f"{c['id']} ({c['width']}×{c['height']})" for c in m["cuts"]),
             "Every image here was decoded from the delivered files by frame number.", ""]
    if Image is None:
        lines += ["Pillow is not installed, so there are no sheets: open the frames below directly.",
                  "(pip install pillow, then re-run, to get sheets, strips and pairs.)", ""]
    for e in p["scenes"]:
        s = e["scene"]
        lines += [f"## {s['id']} — {s.get('title') or ''}  (f{s['start_frame']}–{s['end_frame'] - 1}, "
                  f"{fmt_time(s['start_frame'], fps)}–{fmt_time(s['end_frame'], fps)})", ""]
        if s.get("step_card"):
            lines.append(f"- Step card: “{s['step_card']}”")
        if s.get("narration"):
            lines.append(f"- Narration: “{s['narration']}”")
        for cut in m["cuts"]:
            cid = cut["id"]
            portrait = cut["height"] > cut["width"]
            if Image is not None:
                out = eval_dir / "sheets" / f"{cid}_{s['id']}.jpg"
                grid([(got[cid][f], lab(f)) for f in e["sample"]], 6 if portrait else 3, 270 if portrait else 640,
                     f"{args.version} · {cid} · {s['id']} {s.get('title') or ''} · f{s['start_frame']}–{s['end_frame'] - 1}", out)
                lines.append(f"- Sheet {cid}: `{rel(out)}` — frames {', '.join(map(str, e['sample']))} (left→right, top→bottom)")
            else:
                lines.append(f"- Frames {cid}: " + ", ".join(f"`{rel(got[cid][f])}`" for f in e["sample"]))
        for a in e["actions"]:
            act = a["action"]
            lines.append(f"- Action `{act['id']}` {act.get('label') or ''} (f{act['frame']}"
                         + (f"–{act['end_frame']}" if act.get("end_frame") else "") + ")")
            for cut in m["cuts"]:
                cid = cut["id"]
                portrait = cut["height"] > cut["width"]
                if Image is not None:
                    out = eval_dir / "strips" / f"{cid}_{act['id']}.jpg"
                    grid([(got[cid][f], lab(f)) for f in a["frames"]], len(a["frames"]), 300 if portrait else 480,
                         f"{args.version} · {cid} · {act['id']} {act.get('label') or ''}", out)
                    lines.append(f"  - Strip {cid}: `{rel(out)}` — frames {', '.join(map(str, a['frames']))}")
                else:
                    lines.append(f"  - Frames {cid}: " + ", ".join(f"`{rel(got[cid][f])}`" for f in a["frames"]))
                lines.append(f"  - Full frame {cid} at the action: `{rel(got[cid][act['frame']])}`")
        if Image is not None and len(m["cuts"]) > 1:
            moments = [(a["action"]["id"], a["action"]["frame"]) for a in e["actions"]] or \
                      [("mid", e["sample"][len(e["sample"]) // 2])]
            for what, f in moments:
                out = eval_dir / "pairs" / f"{s['id']}_{what}.jpg"
                side_by_side([(got[c["id"]][f], f"{c['id']} · f{f}") for c in m["cuts"]], 540,
                             f"{args.version} · reframe check · {s['id']} · {what} · {lab(f)}", out)
                lines.append(f"- Reframe pair at f{f}: `{rel(out)}`")
        lines.append("")
    index = eval_dir / "frames.md"
    index.write_text("\n".join(lines), encoding="utf-8")
    print(f"wrote {index}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
