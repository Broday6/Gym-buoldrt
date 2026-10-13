#!/usr/bin/env python3
"""Clean up a real photo for full-frame use, without changing what it shows.

    python tools/clean_photo.py <photo> ... --out img/heritage/clean [--crop x0,y0,x1,y1]

- crops away the white letterbox the gallery photos sit in;
- light colour denoise (phone-photo noise), then a gentle grey-world white balance (half strength)
  and a 0.5% levels stretch, so a yellow or blue cast doesn't read as the beam's colour;
- 2x Lanczos resample with only a very light sharpen, so highlights don't turn glossy.
"""
import argparse
from pathlib import Path

import cv2
import numpy as np


def clean(path: Path, crop=None, balance=True) -> np.ndarray:
    im = cv2.imread(str(path))
    if crop:
        x0, y0, x1, y1 = crop
        im = im[y0:y1, x0:x1]
    else:
        nw = im.min(axis=2) < 245
        ys, xs = np.where(nw.any(1))[0], np.where(nw.any(0))[0]
        im = im[ys.min() + 2:ys.max() - 1, xs.min() + 2:xs.max() - 1]
    im = cv2.fastNlMeansDenoisingColored(im, None, 3, 3, 7, 21)
    f = im.astype(np.float32)
    if balance:  # rooms only: product photos keep Ekena's colour exactly
        means = f.reshape(-1, 3).mean(0)
        f *= (1 + 0.5 * (means.mean() / means - 1))  # half-strength grey world
        lo, hi = np.percentile(f, 0.5), np.percentile(f, 99.5)
        f = (f - lo) * (255.0 / max(1.0, hi - lo))
    f = np.clip(f, 0, 255).astype(np.uint8)
    f = cv2.resize(f, (f.shape[1] * 2, f.shape[0] * 2), interpolation=cv2.INTER_LANCZOS4)
    blur = cv2.GaussianBlur(f, (0, 0), 1.6)
    return cv2.addWeighted(f, 1.18, blur, -0.18, 0)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--crop")
    ap.add_argument("--name", help="output name (single file only)")
    ap.add_argument("--no-balance", action="store_true", help="no colour or levels change at all (product photos keep Ekena's colour)")
    a = ap.parse_args()
    a.out.mkdir(parents=True, exist_ok=True)
    crop = tuple(map(int, a.crop.split(","))) if a.crop else None
    for f in a.files:
        dst = a.out / ((a.name or f.stem[:8]) + ".jpg")
        cv2.imwrite(str(dst), clean(f, crop, not a.no_balance), [cv2.IMWRITE_JPEG_QUALITY, 94])
        print(dst)


if __name__ == "__main__":
    main()
