#!/usr/bin/env python3
"""Trace paving, beds and lawn on an aerial photo and print them as `outdoor.zones`.

Usage:
  python3 ground_from_ortho.py ortho.jpg --corners "TL_x,TL_y TR_x,TR_y BR_x,BR_y BL_x,BL_y" \
      [--exclude "x,y x,y x,y ..."]... [--clip "x,y ..."] [--preview preview.png] > zones.json

The corners are the same as `house.ortho.corners` (floor plan metres). Every
pixel is sorted into lawn, paved or bed by its hue rather than its brightness,
so shadows baked into the photo do not count; they take the kind around
them. The ground under trees and hedges counts as lawn. The kinds are
smoothed and traced into polygons, largest first: the card paints zones in
list order, so an island comes after the area around it. --exclude (house,
garden house, pond, ...) takes the kind around it as well, --clip keeps only
the own plot.
Needs Pillow, NumPy and SciPy.
"""
import argparse, json, sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi

KINDS = ["lawn", "paved", "bed"]
SHOW = {"lawn": (120, 220, 90), "paved": (255, 255, 255), "bed": (255, 150, 40)}


def pairs(text):
    return [tuple(map(float, p.split(","))) for p in text.split()]


def classify(im, px_m):
    """Kind index per pixel, -1 where the ground cannot be seen (foliage, shadow)."""
    gray = im.mean(-1)
    k = max(3, round(1.0 / px_m))                   # about one metre
    # aerial photos are JPEG-compressed with coarse colour blocks: smooth the hue first
    c = np.stack([ndi.gaussian_filter(im[..., i], 0.6 / px_m) for i in range(3)], -1)
    r, g, b = c[..., 0], c[..., 1], c[..., 2]
    s = r + g + b + 1e-6
    exg = (2 * g - r - b) / s                       # excess green
    exr = (1.4 * r - g) / s                         # excess red
    val = ndi.gaussian_filter(gray, 0.3 / px_m)
    # foliage is rough in brightness, lawn and paving are smooth
    loc = np.sqrt(np.maximum(ndi.uniform_filter(gray ** 2, k) - ndi.uniform_filter(gray, k) ** 2, 0))
    rough = ndi.uniform_filter(loc, k)

    green = exg > 0.06
    foliage = green & ((rough > 0.032) | ((val < 0.26) & (exg > 0.12)))
    bed = ~green & (exg > -0.02) & (exr > 0.16) & (exr < 0.26)
    cls = np.where(green, 0, np.where(bed, 2, 1))   # roofs and the rest count as paved
    # cast shadow is dark, smooth and bluish: its hue tells nothing
    cls[val < 0.3] = -1
    # in a garden the ground under trees and hedges is lawn
    cls[foliage] = 0
    return cls


def fill(cls, px_m, keep):
    """Hidden pixels take the kind that dominates around them, then whatever is nearest.
    Only pixels inside `keep` count as neighbours."""
    unknown = cls < 0
    if not unknown.any() or unknown.all():
        return np.maximum(cls, 0)
    near = np.stack([ndi.gaussian_filter(((cls == i) & keep).astype(float), 2.0 / px_m) for i in range(len(KINDS))])
    cls = cls.copy()
    cls[unknown] = np.where(near.max(0) > 0.02, near.argmax(0), -1)[unknown]
    _, (iy, ix) = ndi.distance_transform_edt((cls < 0) | ~keep, return_indices=True)
    return np.where(cls < 0, cls[iy, ix], cls)


def trace(m):
    """Outer boundary of a blob as pixel corners, interior on the right."""
    ys, xs = np.nonzero(m)
    i = np.lexsort((xs, ys))[0]
    start = (int(xs[i]), int(ys[i]))
    pad = np.pad(m, 1)
    at = lambda x, y: pad[y + 1, x + 1]
    x, y, dx, dy = *start, 1, 0
    pts = []
    while True:
        lx, ly = dy, -dx                            # left of the walking direction
        # pixels ahead-left and ahead-right of the corner
        al = at(x + (dx + lx - 1) // 2, y + (dy + ly - 1) // 2)
        ar = at(x + (dx - lx - 1) // 2, y + (dy - ly - 1) // 2)
        nd = (lx, ly) if al else (dx, dy) if ar else (-lx, -ly)
        if nd != (dx, dy):
            pts.append((x, y))
        if (x, y) == start and pts:
            return np.array(pts, float)
        dx, dy = nd
        x, y = x + dx, y + dy


def simplify(p, tol):
    """Douglas-Peucker on a closed ring."""
    def rdp(a):
        if len(a) < 3:
            return a
        d = a[-1] - a[0]
        n = np.hypot(*d) or 1
        dist = np.abs(d[0] * (a[:, 1] - a[0, 1]) - d[1] * (a[:, 0] - a[0, 0])) / n
        i = int(dist.argmax())
        if dist[i] <= tol:
            return a[[0, -1]]
        return np.vstack([rdp(a[:i + 1])[:-1], rdp(a[i:])])
    far = int(np.hypot(*(p - p[0]).T).argmax())
    return np.vstack([rdp(p[:far + 1])[:-1], rdp(np.vstack([p[far:], p[:1]]))[:-1]])


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--corners", required=True)
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--clip", help="trace only inside this polygon (the own plot)")
    ap.add_argument("--min-area", type=float, default=3, help="smallest zone in square metres")
    ap.add_argument("--smooth", type=float, default=0.6, help="edge smoothing in metres")
    ap.add_argument("--preview")
    a = ap.parse_args()

    src = Image.open(a.image).convert("RGB")
    im = np.asarray(src).astype(float) / 255
    hgt, wid = im.shape[:2]
    tl, tr, br, bl = [np.array(p) for p in pairs(a.corners)]
    ux, vy = (tr - tl) / wid, (bl - tl) / hgt          # plan metres per pixel step
    px_m = (np.linalg.norm(ux) + np.linalg.norm(vy)) / 2
    inv = np.linalg.inv(np.column_stack([ux, vy]))
    to_plan = lambda px, py: tl + ux * px + vy * py
    to_px = lambda p: inv @ (np.array(p) - tl)
    mask = lambda poly: np.asarray(_draw(wid, hgt, [tuple(to_px(p)) for p in pairs(poly)]), bool)

    cls = classify(im, px_m)
    for poly in a.exclude:
        cls[mask(poly)] = -1
    plot = mask(a.clip) if a.clip else np.ones_like(cls, bool)
    cls = fill(cls, px_m, plot)
    cls[~plot] = 0

    # specks join the kind around them
    for _ in range(2):
        for i in range(len(KINDS)):
            lab, n = ndi.label(cls == i)
            if not n:
                continue
            small = np.isin(lab, 1 + np.nonzero(ndi.sum(cls == i, lab, range(1, n + 1)) * px_m ** 2 < a.min_area)[0])
            if small.any():
                ring = ndi.binary_dilation(small, iterations=2) & ~small
                around = np.array([((cls == j) & ring).sum() for j in range(len(KINDS))], float)
                around[i] = -1
                cls[small] = int(around.argmax())

    # soft kinds, scaled up four times, the strongest wins: round, clean edges
    S = 4
    soft = [ndi.zoom(ndi.gaussian_filter((cls == i).astype(np.float32), a.smooth / px_m), S, order=1)
            for i in range(len(KINDS))]
    big = np.argmax(np.stack(soft), 0)

    zones = []
    for i, kind in enumerate(KINDS):
        lab, n = ndi.label(big == i)
        for j, sl in enumerate(ndi.find_objects(lab), 1):
            blob = lab[sl] == j
            touches = sl[0].start == 0 or sl[1].start == 0 or sl[0].stop == big.shape[0] or sl[1].stop == big.shape[1]
            area = blob.sum() * (px_m / S) ** 2
            # the lawn that reaches the edge is the ground itself
            if area < a.min_area or (kind == "lawn" and touches):
                continue
            ring = simplify(trace(blob) + [sl[1].start, sl[0].start], 0.12 / (px_m / S))
            if len(ring) < 3:
                continue
            poly = [[round(float(v), 2) for v in to_plan(x / S, y / S)] for x, y in ring]
            zones.append((area, kind, poly))

    zones.sort(key=lambda z: -z[0])
    count = {}
    out = []
    for area, kind, poly in zones:
        count[kind] = count.get(kind, 0) + 1
        out.append({"id": f"{kind}_{count[kind]}", "kind": kind, "label": False, "poly": poly})
    json.dump(out, sys.stdout, indent=None)
    print()
    print(", ".join(f"{n} {k}" for k, n in count.items()) or "no zones", file=sys.stderr)

    if a.preview:
        pv = src.resize((wid * S, hgt * S))
        d = ImageDraw.Draw(pv)
        for z in out:
            d.polygon([tuple(to_px(p) * S) for p in z["poly"]], outline=SHOW[z["kind"]], width=2)
        pv.save(a.preview)


def _draw(wid, hgt, pts):
    im = Image.new("L", (wid, hgt), 0)
    ImageDraw.Draw(im).polygon(pts, fill=1)
    return im


if __name__ == "__main__":
    main()
