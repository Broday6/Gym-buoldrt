#!/usr/bin/env python3
"""Pre-scale photos that fill the frame, so they hold up at 1920 px.

    python tools/upscale.py img/heritage/room-renders/BMSTKB-09.jpg ... --out img/heritage/hi

The source images top out at 1200 px. Canvas upscaling at render time is bilinear and soft, so the
full-frame photos are scaled 2x here with Lanczos and given a light unsharp mask. Nothing is
generated or invented: it is the same photo, resampled.
"""
import argparse
from pathlib import Path

from PIL import Image, ImageFilter


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--scale", type=float, default=2.0)
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for f in a.files:
        im = Image.open(f).convert("RGB")
        im = im.resize((round(im.width * a.scale), round(im.height * a.scale)), Image.LANCZOS)
        im = im.filter(ImageFilter.UnsharpMask(radius=2.0, percent=55, threshold=2))
        dst = a.out / f.name
        im.save(dst, quality=93)
        print(dst, im.size)


if __name__ == "__main__":
    main()
