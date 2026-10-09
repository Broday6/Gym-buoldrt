#!/usr/bin/env python3
"""Make the "before" of an Ekena room render by taking the beams out. No generative model.

    python tools/remove_beams.py <dark finish>.jpg <primed>.jpg out.jpg [--grow 21] [--split-x 600 --split-y 300]
                                 [--rod 600,150,600,272]

Ekena renders each room once per finish with the camera, light and furniture identical, so the
pixels that differ between two finishes (a dark one and Primed) are the beams. That difference is
the mask. The masked area is filled from the surrounding ceiling with a push-pull pyramid (smooth
fill that follows the ceiling's shading), then given the render's own fine grain back.
"""
import sys

import cv2
import numpy as np


def beam_mask(a, b, thresh=18, grow=7):
    d = np.abs(a.astype(np.int16) - b.astype(np.int16)).max(axis=2)
    m = (d > thresh).astype(np.uint8)
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    return cv2.dilate(m, np.ones((grow, grow), np.uint8))


def push_pull(img, mask):
    """Fill mask==1 from the unmasked pixels: average down a pyramid, then fill back up."""
    levels = []
    cur, w = img.astype(np.float32) * (1 - mask[..., None]), (1 - mask).astype(np.float32)
    while min(cur.shape[:2]) > 4:
        levels.append((cur, w))
        cur = cv2.pyrDown(cur * 1.0)
        w = cv2.pyrDown(w)
        cur = np.where(w[..., None] > 1e-4, cur / np.maximum(w[..., None], 1e-4), 0) * np.minimum(1, w[..., None] * 4)
        w = np.minimum(1, w * 4)
    fill = cur / np.maximum(w[..., None], 1e-4)
    for c, wl in reversed(levels):
        up = cv2.resize(fill, (c.shape[1], c.shape[0]), interpolation=cv2.INTER_LINEAR)
        known = np.where(wl[..., None] > 1e-4, c / np.maximum(wl[..., None], 1e-4), up)
        a = np.clip(wl, 0, 1)[..., None]
        fill = known * a + up * (1 - a)
    return fill


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("a"); ap.add_argument("b"); ap.add_argument("out")
    ap.add_argument("--grow", type=int, default=7, help="px the beam mask is widened by (covers their soft shadows)")
    ap.add_argument("--split-x", type=int, help="a roof ridge at this x: fill each side on its own so the crease stays sharp")
    ap.add_argument("--split-y", type=int, default=10**6, help="the ridge runs from the top down to this y")
    ap.add_argument("--rod", help="x0,y0,x1,y1: redraw a light fixture's rod (and its canopy at x0,y0) after the fill")
    ap.add_argument("--dark", type=int, default=0, help="also treat pixels darker than this near the beams as unknown")
    args = ap.parse_args()
    a, b, out = cv2.imread(args.a), cv2.imread(args.b), args.out
    m = beam_mask(a, b, grow=args.grow)
    if args.dark:
        near = cv2.dilate(m, np.ones((61, 61), np.uint8)) > 0
        g = cv2.cvtColor(a, cv2.COLOR_BGR2GRAY)
        m = (m.astype(bool) | (near & (g < args.dark))).astype(np.uint8)
    if args.split_x is None:
        fill = push_pull(a, m)
    else:
        h, w = m.shape
        side = np.zeros((h, w), bool)
        side[:, :args.split_x] = True
        side[args.split_y:, :] = False  # below the ridge both sides blend normally
        left = push_pull(a, (m.astype(bool) | ~(side | (np.arange(h)[:, None] >= args.split_y))).astype(np.uint8))
        right = push_pull(a, (m.astype(bool) | side).astype(np.uint8))
        fill = np.where(side[..., None], left, right)
    # A little of the render's grain, so the filled ceiling isn't plastic-smooth.
    rng = np.random.default_rng(0)
    grain = rng.normal(0, 1.2, a.shape[:2])[..., None]
    soft = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 2.0)[..., None]
    res = a.astype(np.float32) * (1 - soft) + (fill + grain) * soft
    res = np.clip(res, 0, 255).astype(np.uint8)
    if args.rod:
        x0, y0, x1, y1 = map(int, args.rod.split(","))
        cv2.line(res, (x0, y0), (x1, y1), (32, 30, 30), 3, cv2.LINE_AA)
        cv2.ellipse(res, (x0, y0), (11, 6), 0, 0, 360, (28, 26, 26), -1, cv2.LINE_AA)
    cv2.imwrite(out, res, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(out.replace(".jpg", "-mask.png"), m * 255)
    print(out, "masked", round(m.mean() * 100, 1), "% of the frame")


if __name__ == "__main__":
    main()
