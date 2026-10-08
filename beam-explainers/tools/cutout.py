#!/usr/bin/env python3
"""Cut real product photos (shot on white) out of their background, so they can sit on any scene.

    python tools/cutout.py img/heritage/product/salvaged-timber/kona-brown.jpg ... --out img/heritage/cutout

Only the white that touches the photo's border is removed (flood fill), so light parts of the beam
itself (the cream inside of a U-beam, a primed face) stay. The edge is feathered by a pixel or two.
Writes <out>/<parent>__<name>.png, trimmed to the beam with a small margin (or the full frame with
--keep-frame, so photos from the same studio set stay aligned).
"""
import argparse
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter


def cut(path: Path, thresh: int, keep_frame: bool = False) -> Image.Image:
    im = Image.open(path).convert("RGB")
    a = np.asarray(im).astype(np.int16)
    h, w, _ = a.shape
    white = (a.min(axis=2) >= thresh) & ((a.max(axis=2) - a.min(axis=2)) <= 14)
    bg = np.zeros((h, w), bool)
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True; q.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if white[y, x] and not bg[y, x]:
                bg[y, x] = True; q.append((y, x))
    while q:
        y, x = q.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            yy, xx = y + dy, x + dx
            if 0 <= yy < h and 0 <= xx < w and white[yy, xx] and not bg[yy, xx]:
                bg[yy, xx] = True; q.append((yy, xx))
    alpha = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8))
    # Shrink the matte by a pixel (kills the white fringe), then feather it.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(1.1))
    out = im.convert("RGBA")
    out.putalpha(alpha)
    if keep_frame:
        return out
    ys, xs = np.where(np.asarray(alpha) > 8)
    m = 6
    return out.crop((max(0, xs.min() - m), max(0, ys.min() - m), min(w, xs.max() + m), min(h, ys.max() + m)))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--thresh", type=int, default=238)
    ap.add_argument("--keep-frame", action="store_true", help="keep the full photo frame (a set of shots stays aligned)")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    for f in a.files:
        im = cut(f, a.thresh, a.keep_frame)
        dst = a.out / f"{f.parent.name}__{f.stem}.png"
        im.save(dst, optimize=True)
        print(dst, im.size)


if __name__ == "__main__":
    main()
