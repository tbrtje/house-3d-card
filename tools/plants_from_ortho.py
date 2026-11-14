#!/usr/bin/env python3
"""Detect trees and shrubs on an aerial photo and print them as `house.plants`.

Usage:
  python3 plants_from_ortho.py ortho.jpg --corners "TL_x,TL_y TR_x,TR_y BR_x,BR_y BL_x,BL_y" \
      [--exclude "x,y x,y x,y ..."]... [--clip "x,y ..."] [--preview preview.png] > plants.json

The corners are the same as `house.ortho.corners` (floor plan metres).
Pass the house outline and modelled objects (garden house, pond, ...) with
--exclude, so no plants grow on them. Needs Pillow, NumPy and SciPy.
"""
import argparse, colorsys, json, math, sys

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage as ndi


def pairs(text):
    return [tuple(map(float, p.split(","))) for p in text.split()]


def tone(col):
    # the photo average includes shade: lift it to a sunlit foliage tone
    h, s, v = colorsys.rgb_to_hsv(*col)
    if not 0.15 < h < 0.45:
        h = 0.25
    rgb = colorsys.hsv_to_rgb(h, min(0.75, s * 1.5 + 0.1), min(0.62, max(0.4, v * 1.35)))
    return "#%02x%02x%02x" % tuple(int(x * 255) for x in rgb)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("image")
    ap.add_argument("--corners", required=True)
    ap.add_argument("--exclude", action="append", default=[])
    ap.add_argument("--clip", help="keep only plants inside this polygon (the own plot)")
    ap.add_argument("--max", type=int, default=400, help="maximum number of plants")
    ap.add_argument("--preview")
    a = ap.parse_args()

    im = np.asarray(Image.open(a.image).convert("RGB")).astype(float) / 255
    hgt, wid = im.shape[:2]
    tl, tr, br, bl = [np.array(p) for p in pairs(a.corners)]
    ux, vy = (tr - tl) / wid, (bl - tl) / hgt          # plan metres per pixel step
    px_m = (np.linalg.norm(ux) + np.linalg.norm(vy)) / 2
    inv = np.linalg.inv(np.column_stack([ux, vy]))
    to_plan = lambda px, py: tl + ux * px + vy * py
    to_px = lambda p: inv @ (np.array(p) - tl)

    # foliage: green and textured, or dark dense green; lawn is smooth, roofs are grey
    r, g, b = im[..., 0], im[..., 1], im[..., 2]
    gray, val = im.mean(-1), im.max(-1)
    exg = (2 * g - r - b) / (r + g + b + 1e-6)
    k = max(3, round(1.0 / px_m))                    # about one metre
    loc = np.sqrt(np.maximum(ndi.uniform_filter(gray ** 2, k) - ndi.uniform_filter(gray, k) ** 2, 0))
    L, X = ndi.uniform_filter(loc, k), ndi.uniform_filter(exg, k)
    m = (L > 0.034) & (X > 0.02) & (g >= r - 0.01)
    m |= (X > 0.10) & (val < 0.30)
    m |= (L > 0.03) & (val < 0.26) & (b < g + 0.03)
    m = ndi.binary_opening(m, iterations=2)
    m = ndi.binary_fill_holes(ndi.binary_closing(m))
    m &= ~ndi.binary_dilation(ndi.uniform_filter(val, 3) > 0.62, iterations=2)
    keep = Image.new("L", (wid, hgt), 0)
    d = ImageDraw.Draw(keep)
    for poly in a.exclude:
        d.polygon([tuple(to_px(p)) for p in pairs(poly)], fill=1)
    m &= ~np.asarray(keep, bool)
    if a.clip:
        plot = Image.new("L", (wid, hgt), 0)
        ImageDraw.Draw(plot).polygon([tuple(to_px(p)) for p in pairs(a.clip)], fill=1)
        m &= np.asarray(plot, bool)
    lab, n = ndi.label(m)
    sizes = ndi.sum(m, lab, range(1, n + 1))
    m = np.isin(lab, 1 + np.nonzero(sizes >= 8)[0])

    # greedy crowns: the widest free spot first, then cut it out
    dist = ndi.distance_transform_edt(m)
    free = m.copy()
    yy, xx = np.mgrid[0:hgt, 0:wid]
    plants = []
    for _ in range(a.max):
        dd = np.where(free, dist, 0)
        py, px = divmod(int(dd.argmax()), wid)
        R = min(dd[py, px], 4.8 / px_m)
        if R * px_m < 0.7:
            break
        disk = (xx - px) ** 2 + (yy - py) ** 2 <= R * R
        free &= ~((xx - px) ** 2 + (yy - py) ** 2 <= (0.9 * R) ** 2)
        rm = R * px_m
        dark = im[disk].max(-1).mean() < 0.3
        if rm < 1.6:
            kind, h = "shrub", min(3.0, 0.6 + 1.6 * rm)
        elif dark and rm < 3:
            kind, h = "conifer", rm * 4.5
        else:
            kind, h = "tree", min(17, 2.4 * rm + 2.5)
        x, y = to_plan(px + 0.5, py + 0.5)
        plants.append({"at": [round(float(x), 2), round(float(y), 2)], "r": round(rm, 2), "h": round(h, 1),
                       "kind": kind, "color": tone(im[disk & m].mean(0))})

    json.dump(plants, sys.stdout, indent=None)
    print()
    print(f"{len(plants)} plants", file=sys.stderr)
    if a.preview:
        out = Image.fromarray((im * 255).astype(np.uint8))
        d = ImageDraw.Draw(out)
        for p in plants:
            cx, cy = to_px(p["at"])
            R = p["r"] / px_m
            d.ellipse([cx - R, cy - R, cx + R, cy + R],
                      outline={"tree": (255, 0, 255), "conifer": (0, 255, 255), "shrub": (255, 255, 0)}[p["kind"]])
        out.save(a.preview)


if __name__ == "__main__":
    main()
