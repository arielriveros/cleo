"""Bake a foliage impostor card offline: an orthographic front elevation of a model, cut out by its alpha.

The editor bakes the same card on the GPU (editor/src/utils/modelThumbnails.ts `bakeModelImpostor`);
the generator has no GPU, so this is a small software rasterizer that follows the same contract:

  - ORTHOGRAPHIC, looking down -Z with world +X to the right (a front elevation, not a mirror).
  - Framed to the box the runtime card is built from (`FoliageLayer._prototypeFootprint`):
    width = max(dx, dz) centred on x = 0 -- the card is `crossQuadGeometry(width, height)`, centred on the
    instance -- and height = maxY - minY. A square sheet, stretched back by the card's own aspect.
  - SUPERSAMPLED and box-filtered down with coverage weighting, so needle edges get fractional alpha
    and no background colour bleeds into them.
  - Lit into the albedo (the billboard shader writes a fixed up-normal), with a key and a fill.

Usage: python impostor.py <request.json> <out.png>
The request lists parts: raw little-endian files of f32 positions (xyz), f32 uvs (uv), u32 indices,
plus the part's diffuse texture and optional alpha mask.
"""

import json
import sys

import numpy as np
from PIL import Image

Image.MAX_IMAGE_PIXELS = None


def load_texture(path):
    img = Image.open(path).convert("RGBA")
    return np.asarray(img, dtype=np.float32) / 255.0


def main(request_path, out_path):
    req = json.load(open(request_path))
    size = int(req.get("size", 512))
    factor = int(req.get("supersample", 4))
    cap = size * factor
    # Texture rows: glTF UVs put v = 0 at the image's TOP row, which is how the engine samples them.
    flip_v = bool(req.get("flipV", False))

    parts = []
    lo = np.array([np.inf, np.inf, np.inf])
    hi = -lo
    for p in req["parts"]:
        pos = np.fromfile(p["positions"], dtype="<f4").reshape(-1, 3).astype(np.float64)
        uv = np.fromfile(p["uvs"], dtype="<f4").reshape(-1, 2).astype(np.float64)
        idx = np.fromfile(p["indices"], dtype="<u4").reshape(-1, 3)
        diff = load_texture(p["diffuse"])
        mask = load_texture(p["mask"])[..., 0] if p.get("mask") else None
        parts.append((pos, uv, idx, diff, mask))
        lo = np.minimum(lo, pos.min(axis=0))
        hi = np.maximum(hi, pos.max(axis=0))

    width = max(hi[0] - lo[0], hi[2] - lo[2])
    height = hi[1] - lo[1]
    # x in [-width/2, width/2] (the card is centred on the instance), y in [lo.y, hi.y].
    def to_px(p):
        sx = (p[:, 0] / width + 0.5) * cap
        sy = (1.0 - (p[:, 1] - lo[1]) / height) * cap
        return sx, sy

    color = np.zeros((cap, cap, 3), dtype=np.float32)
    alpha = np.zeros((cap, cap), dtype=np.float32)
    depth = np.full((cap, cap), -np.inf, dtype=np.float32)  # larger z = nearer the camera at +Z

    key = np.array([0.45, 0.65, 0.6])
    key /= np.linalg.norm(key)
    for pos, uv, idx, diff, mask in parts:
        th, tw = diff.shape[:2]
        sx, sy = to_px(pos)
        tri = idx
        ax, ay = sx[tri[:, 0]], sy[tri[:, 0]]
        bx, by = sx[tri[:, 1]], sy[tri[:, 1]]
        cx, cy = sx[tri[:, 2]], sy[tri[:, 2]]
        # Face normals for the key light; two-sided, so facing away flips.
        e1 = pos[tri[:, 1]] - pos[tri[:, 0]]
        e2 = pos[tri[:, 2]] - pos[tri[:, 0]]
        n = np.cross(e1, e2)
        n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-12)
        n[n[:, 2] < 0] *= -1
        shade = 0.55 + 0.45 * np.clip(n @ key, 0.0, 1.0)

        for t in range(len(tri)):
            x0 = int(max(0, np.floor(min(ax[t], bx[t], cx[t]))))
            x1 = int(min(cap - 1, np.ceil(max(ax[t], bx[t], cx[t]))))
            y0 = int(max(0, np.floor(min(ay[t], by[t], cy[t]))))
            y1 = int(min(cap - 1, np.ceil(max(ay[t], by[t], cy[t]))))
            if x1 < x0 or y1 < y0:
                continue
            area = (bx[t] - ax[t]) * (cy[t] - ay[t]) - (by[t] - ay[t]) * (cx[t] - ax[t])
            if abs(area) < 1e-9:
                continue
            gx, gy = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
            w0 = ((bx[t] - gx) * (cy[t] - gy) - (by[t] - gy) * (cx[t] - gx)) / area
            w1 = ((cx[t] - gx) * (ay[t] - gy) - (cy[t] - gy) * (ax[t] - gx)) / area
            w2 = 1.0 - w0 - w1
            inside = (w0 >= 0) & (w1 >= 0) & (w2 >= 0)
            if not inside.any():
                continue
            i0, i1, i2 = tri[t]
            z = w0 * pos[i0, 2] + w1 * pos[i1, 2] + w2 * pos[i2, 2]
            u = w0 * uv[i0, 0] + w1 * uv[i1, 0] + w2 * uv[i2, 0]
            v = w0 * uv[i0, 1] + w1 * uv[i1, 1] + w2 * uv[i2, 1]
            if flip_v:
                v = 1.0 - v
            tx = np.mod(np.floor(np.mod(u, 1.0) * tw), tw).astype(np.int64)
            ty = np.mod(np.floor(np.mod(v, 1.0) * th), th).astype(np.int64)
            a = mask[ty, tx] if mask is not None else diff[ty, tx, 3]
            ys, xs = gy.astype(np.int64), gx.astype(np.int64)
            ok = inside & (a >= 0.5) & (z > depth[ys, xs])
            if not ok.any():
                continue
            yy, xx = ys[ok], xs[ok]
            depth[yy, xx] = z[ok]
            color[yy, xx] = diff[ty[ok], tx[ok], :3] * shade[t]
            alpha[yy, xx] = 1.0

    # Coverage-weighted box filter, as `downsampleCoverage` does it.
    a4 = alpha.reshape(size, factor, size, factor)
    c4 = color.reshape(size, factor, size, factor, 3)
    cov = a4.sum(axis=(1, 3))
    rgb = (c4 * a4[..., None]).sum(axis=(1, 3)) / np.maximum(cov, 1e-6)[..., None]
    out = np.zeros((size, size, 4), dtype=np.uint8)
    out[..., :3] = np.clip(rgb * 255.0 + 0.5, 0, 255).astype(np.uint8)
    out[..., 3] = np.clip(cov / (factor * factor) * 255.0 + 0.5, 0, 255).astype(np.uint8)
    Image.fromarray(out, "RGBA").save(out_path)
    kept = float((out[..., 3] >= 128).mean())
    print(json.dumps({"width": width, "height": height, "coverage": kept}))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
