// The leaf atlas: a 2 x 2 grid of sprig cards -- a twig carrying several leaves, or a brush of needles --
// drawn as signed-distance shapes, with an alpha cutout and colour dilated under it, and a normal map read
// off a height field drawn alongside: each leaf a gentle dome with a sunken midrib and veins, each needle
// and twig a rounded ridge.
//
// A card per sprig rather than a card per leaf is the standard trade (SpeedTree's leaf clusters): ten
// to twenty leaves for two triangles. Every card is anchored at the MIDDLE OF ITS BOTTOM EDGE, where the
// twig meets the branch, which is how tree/treeMesh.ts places them.

import type { LeafShape, Rgba } from '../foliageParams';
import { stream } from '../rng';
import { createImage, dilateColor, mixRgb, normalFromHeight, putLinear, rgb, scaleRgb, shiftHue, type Image, type Rgb } from './image';

export const ATLAS_CELLS = 2;

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Half-width of a leaf at `s` along it (0 base, 1 tip), as a fraction of its length. */
function halfWidth(shape: LeafShape, s: number): number {
  if (s <= 0 || s >= 1) return 0;
  switch (shape) {
    case 'elliptic': return Math.sin(Math.PI * s) * 0.24;
    case 'lanceolate': return Math.sin(Math.PI * Math.pow(s, 0.7)) * 0.13;
    case 'round': return Math.sqrt(Math.max(0, 1 - (2 * s - 1) ** 2)) * 0.42;
    case 'lobed': return Math.sin(Math.PI * Math.pow(s, 0.85)) * 0.3 * (0.62 + 0.38 * Math.abs(Math.sin(4.5 * Math.PI * s)));
    default: return Math.sin(Math.PI * Math.pow(s, 0.75)) * 0.3 * (1 + 0.035 * Math.sin(46 * s));
  }
}

export interface LeafAtlasOptions {
  seed: number;
  size: number;
  kind: 'broadleaf' | 'needles';
  shape: LeafShape;
  color: Rgba;
  variation: number;
  autumn: number;
}

/**
 * The relief drawn with the colour, 0..1 per pixel: what the leaf normal map is read from. Module state for
 * the length of one `leafTextures` call (the drawing helpers are called from one place, synchronously).
 */
let relief: Float32Array | null = null;

/** Lay `h` over a pixel's relief with the same coverage the colour gets. */
function raise(i: number, h: number, a: number): void {
  if (relief && a > 0) relief[i] = h * a + relief[i] * (1 - a);
}

/** Accumulate a straight-alpha colour over what a pixel already holds ("over", in linear terms). */
function over(acc: Float32Array, i: number, c: Rgb, a: number): void {
  if (a <= 0) return;
  const o = i * 4, inv = 1 - a;
  acc[o] = c[0] * a + acc[o] * inv;
  acc[o + 1] = c[1] * a + acc[o + 1] * inv;
  acc[o + 2] = c[2] * a + acc[o + 2] * inv;
  acc[o + 3] = a + acc[o + 3] * inv;
}

/** A tapered line from (x0, y0) to (x1, y1), widths in pixels, drawn with a 1 px soft edge. */
function stroke(acc: Float32Array, w: number, h: number, x0: number, y0: number, x1: number, y1: number,
                w0: number, w1: number, color: Rgb, clip: [number, number, number, number]): void {
  const pad = Math.max(w0, w1) + 2;
  const minX = Math.max(clip[0], Math.floor(Math.min(x0, x1) - pad)), maxX = Math.min(clip[2] - 1, Math.ceil(Math.max(x0, x1) + pad));
  const minY = Math.max(clip[1], Math.floor(Math.min(y0, y1) - pad)), maxY = Math.min(clip[3] - 1, Math.ceil(Math.max(y0, y1) + pad));
  const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5 - x0, py = y + 0.5 - y0;
    const t = Math.min(1, Math.max(0, (px * dx + py * dy) / len2));
    const d = Math.hypot(px - dx * t, py - dy * t);
    const half = (w0 + (w1 - w0) * t) * 0.5;
    const a = smoothstep(half + 0.7, half - 0.7, d);
    over(acc, y * w + x, color, a);
    // A rounded ridge across the stroke: a needle or a twig is a cylinder.
    raise(y * w + x, 0.55 + 0.45 * Math.sqrt(Math.max(0, 1 - (d / Math.max(0.5, half)) ** 2)), a);
  }
}

/**
 * One leaf: base at (bx, by), pointing along unit (dx, dy), `len` pixels long. Colour with a lighter
 * midrib, pinnate veins and a darker rim.
 */
function leaf(acc: Float32Array, w: number, h: number, bx: number, by: number, dx: number, dy: number, len: number,
              shape: LeafShape, color: Rgb, clip: [number, number, number, number]): void {
  const nx = -dy, ny = dx;
  const reach = len * 0.5;
  const minX = Math.max(clip[0], Math.floor(Math.min(bx, bx + dx * len) - reach)), maxX = Math.min(clip[2] - 1, Math.ceil(Math.max(bx, bx + dx * len) + reach));
  const minY = Math.max(clip[1], Math.floor(Math.min(by, by + dy * len) - reach)), maxY = Math.min(clip[3] - 1, Math.ceil(Math.max(by, by + dy * len) + reach));
  const vein = mixRgb(color, [0.55, 0.6, 0.3], 0.25);
  const rim = scaleRgb(color, 0.75);
  for (let y = minY; y <= maxY; y++) for (let x = minX; x <= maxX; x++) {
    const px = x + 0.5 - bx, py = y + 0.5 - by;
    const s = (px * dx + py * dy) / len;          // along, 0..1
    const t = (px * nx + py * ny) / len;          // across, in lengths
    if (s < -0.02 || s > 1.02) continue;
    const hw = halfWidth(shape, s);
    const edge = (hw - Math.abs(t)) * len;        // pixels inside the outline
    const a = smoothstep(-0.7, 0.7, edge);
    if (a <= 0) continue;
    const at = Math.abs(t);
    const midrib = smoothstep(0.012 * len + 0.6, 0.004 * len, at * len) * smoothstep(1, 0.85, s);
    const veinPhase = (s * 7 - at * 5) % 1;
    const veins = smoothstep(0.06, 0.0, Math.abs(veinPhase - 0.5) - 0.42) * smoothstep(hw * 0.95, hw * 0.3, at) * 0.6;
    const rimK = smoothstep(2.5, 0, edge);
    let c = mixRgb(color, vein, Math.min(1, midrib + veins));
    c = mixRgb(c, rim, rimK * 0.6);
    // A soft light-to-dark across the blade, as a leaf's curl catches the light.
    c = scaleRgb(c, 0.88 + 0.24 * (0.5 - t / Math.max(hw, 1e-3) * 0.5));
    over(acc, y * w + x, c, a);
    // Relief: a dome across the blade, the midrib and veins sunk into it, the rim turned up a touch.
    const across = Math.min(1, at / Math.max(hw, 1e-3));
    raise(y * w + x, 0.45 + 0.35 * (1 - across * across) - 0.22 * midrib - 0.1 * veins + 0.08 * rimK, a);
  }
}

export interface LeafTextures { albedo: Image; normal: Image }

/** The atlas alone (its colour and cutout). */
export function leafAtlas(o: LeafAtlasOptions): Image {
  return leafTextures(o).albedo;
}

/** The atlas and its tangent-space normal map (OpenGL, flat outside the leaves). */
export function leafTextures(o: LeafAtlasOptions): LeafTextures {
  const size = o.size;
  const cell = size / ATLAS_CELLS;
  const acc = new Float32Array(size * size * 4);
  relief = new Float32Array(size * size);
  try {
    const albedo = drawAtlas(o, size, cell, acc);
    // Outside every leaf the relief is 0 and so flat; at an edge the cutout hides the step.
    const normal = normalFromHeight(relief, size, size, o.kind === 'needles' ? 0.8 : 1.4, false);
    return { albedo, normal };
  } finally {
    relief = null;
  }
}

function drawAtlas(o: LeafAtlasOptions, size: number, cell: number, acc: Float32Array): Image {
  const base = rgb(o.color);
  const autumnA: Rgb = [0.62, 0.22, 0.02], autumnB: Rgb = [0.48, 0.06, 0.03], autumnC: Rgb = [0.7, 0.5, 0.05];
  const stemColor: Rgb = o.kind === 'needles' ? [0.12, 0.08, 0.05] : [0.16, 0.13, 0.06];

  for (let cy = 0; cy < ATLAS_CELLS; cy++) for (let cx = 0; cx < ATLAS_CELLS; cx++) {
    const r = stream(o.seed, 'atlas', cx, cy);
    const clip: [number, number, number, number] = [Math.floor(cx * cell), Math.floor(cy * cell), Math.floor((cx + 1) * cell), Math.floor((cy + 1) * cell)];
    const ox = clip[0], oy = clip[1];
    // The twig: from the middle of the cell's bottom edge, up and slightly curved.
    const bx = ox + cell * 0.5, by = oy + cell * 0.985;
    const top = oy + cell * (o.kind === 'needles' ? 0.08 : 0.31);
    const sway = r.signed() * cell * 0.06;
    const pointAt = (s: number): [number, number] => [bx + sway * s * s, by + (top - by) * s];
    const leafColor = (k: number): Rgb => {
      const lr = stream(o.seed, 'leafcolor', cx, cy, k);
      let c = shiftHue(base, lr.signed() * 0.035 * o.variation, 1 + lr.signed() * 0.25 * o.variation);
      c = scaleRgb(c, 1 + lr.signed() * 0.35 * o.variation);
      if (o.autumn > 0) {
        const pick = lr.next();
        const fall = pick < 0.45 ? autumnA : pick < 0.75 ? autumnC : autumnB;
        c = mixRgb(c, fall, Math.min(1, o.autumn * (0.7 + 0.6 * lr.next())));
      }
      return c;
    };

    if (o.kind === 'needles') {
      // A conifer sprig: a twig with alternating side shoots, every shoot a dense bottlebrush of needles
      // splayed forward on both sides (and some foreshortened, standing out of the card), lighter at the
      // fresh tips. Dense enough that the card still reads as a tuft at a distance, after mipmapping.
      const needleW = Math.max(1.8, cell * 0.013);
      const brush = (x0: number, y0: number, x1: number, y1: number, k0: number) => {
        const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy) || 1;
        const ux = dx / len, uy = dy / len;
        const count = Math.max(8, Math.round(len / (cell * 0.0075)));
        for (let k = 0; k < count; k++) {
          const s = (k + r.next()) / count;
          const px = x0 + dx * s, py = y0 + dy * s;
          const side = k % 2 === 0 ? 1 : -1;
          // Foreshortened needles (pointing at or away from the viewer) are drawn short.
          const depth = r.next() < 0.3 ? 0.35 + 0.3 * r.next() : 1;
          const ang = (40 + r.signed() * 15) * Math.PI / 180 * side;
          const nl = cell * (0.11 + 0.03 * r.signed()) * depth * (1 - 0.35 * s * s);
          const ca = Math.cos(ang), sa = Math.sin(ang);
          const ex = px + (ux * ca - uy * sa) * nl, ey = py + (ux * sa + uy * ca) * nl;
          // Fresh growth toward the shoot's tip is lighter.
          const c = mixRgb(leafColor(k0 + k), scaleRgb(leafColor(k0 + k), 1.45), smoothstep(0.6, 1, s) * 0.6);
          stroke(acc, size, size, px, py, ex, ey, needleW, needleW * 0.4, c, clip);
        }
        stroke(acc, size, size, x0, y0, x1, y1, Math.max(1.6, cell * 0.014), 1, stemColor, clip);
      };
      const shoots = 4 + r.int(0, 2);
      for (let k = 0; k < shoots; k++) {
        const s = 0.2 + 0.6 * (k / shoots) + r.signed() * 0.04;
        const [px, py] = pointAt(s);
        const side = k % 2 === 0 ? 1 : -1;
        const ang = (38 + r.signed() * 10) * Math.PI / 180;
        const len = cell * (0.36 - 0.14 * s + 0.04 * r.signed());
        brush(px, py, px + Math.sin(ang) * side * len, py - Math.cos(ang) * len, k * 200);
      }
      const [tx, ty] = pointAt(1);
      brush(bx, by - cell * 0.12, tx, ty, 5000);
      stroke(acc, size, size, bx, by, bx, by - cell * 0.12, Math.max(2, cell * 0.02), 1.6, stemColor, clip);
    } else {
      const [tx, ty] = pointAt(1);
      stroke(acc, size, size, bx, by, tx, ty, Math.max(1.6, cell * 0.016), 1, stemColor, clip);
      // Alternate leaves up the twig, then one at the tip.
      const pairs = 5 + r.int(0, 2);
      for (let k = 0; k < pairs; k++) {
        const s = 0.18 + 0.72 * (k / pairs);
        const [px, py] = pointAt(s);
        const side = k % 2 === 0 ? 1 : -1;
        const ang = (48 + r.signed() * 14) * Math.PI / 180;
        const dx = Math.sin(ang) * side, dy = -Math.cos(ang);
        const len = cell * (0.32 + 0.06 * r.signed()) * (1 - 0.25 * s);
        const petiole = len * 0.08;
        stroke(acc, size, size, px, py, px + dx * petiole, py + dy * petiole, 1.4, 1, stemColor, clip);
        leaf(acc, size, size, px + dx * petiole, py + dy * petiole, dx, dy, len, o.shape, leafColor(k), clip);
      }
      leaf(acc, size, size, tx, ty, 0, -1, cell * 0.3, o.shape, leafColor(99), clip);
    }
  }

  const img = createImage(size, size);
  for (let i = 0; i < size * size; i++) {
    const a = acc[i * 4 + 3];
    // `acc` is premultiplied; un-premultiply for straight alpha.
    putLinear(img, i, a > 0 ? acc[i * 4] / a : 0, a > 0 ? acc[i * 4 + 1] / a : 0, a > 0 ? acc[i * 4 + 2] / a : 0, a);
  }
  dilateColor(img, i => img.data[i * 4 + 3] >= 128);
  return img;
}

/** Atlas cell `index` (0..3) as a uv rectangle [u0, v0, u1, v1], v0 at the top. */
export function atlasCell(index: number): [number, number, number, number] {
  const cx = index % ATLAS_CELLS, cy = Math.floor(index / ATLAS_CELLS) % ATLAS_CELLS;
  const inset = 0.002;
  return [cx / ATLAS_CELLS + inset, cy / ATLAS_CELLS + inset, (cx + 1) / ATLAS_CELLS - inset, (cy + 1) / ATLAS_CELLS - inset];
}
