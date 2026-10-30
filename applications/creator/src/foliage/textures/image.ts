// The texture plumbing every foliage texture shares: an RGBA8 image, colour conversion, a triangle
// rasterizer (for baking into a mesh's UV layout and for drawing card pictures), push-pull colour
// dilation under cutout alpha, and a height-to-normal filter.
//
// Images are rows top to bottom, straight alpha, sRGB colour: what PNG stores and what glTF expects of
// a base-colour texture. Parameters arrive LINEAR (ParamForm's colour field), so they are encoded here.

import type { Rgba } from '../foliageParams';

export interface Image {
  width: number;
  height: number;
  /** RGBA8, row 0 = top, straight alpha. */
  data: Uint8Array;
}

export const createImage = (width: number, height: number): Image => ({ width, height, data: new Uint8Array(width * height * 4) });

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Linear 0..1 -> sRGB 0..1. */
export function toSrgb(c: number): number {
  c = clamp01(c);
  return c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055;
}

/** A linear colour, mixed and scaled, written as sRGB bytes at pixel `i` (index in pixels). */
export function putLinear(img: Image, i: number, r: number, g: number, b: number, a = 1): void {
  const o = i * 4;
  img.data[o] = Math.round(toSrgb(r) * 255);
  img.data[o + 1] = Math.round(toSrgb(g) * 255);
  img.data[o + 2] = Math.round(toSrgb(b) * 255);
  img.data[o + 3] = Math.round(clamp01(a) * 255);
}

export type Rgb = [number, number, number];
export const rgb = (c: Rgba | Rgb): Rgb => [c[0], c[1], c[2]];
export const mixRgb = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const scaleRgb = (a: Rgb, s: number): Rgb => [a[0] * s, a[1] * s, a[2] * s];

/** Shift a linear colour's hue by `turns` (0..1) and its saturation by `sat`, through HSV. */
export function shiftHue(c: Rgb, turns: number, sat = 1): Rgb {
  const max = Math.max(c[0], c[1], c[2]), min = Math.min(c[0], c[1], c[2]);
  const v = max, d = max - min, s = max > 0 ? d / max : 0;
  let h = 0;
  if (d > 0) {
    if (max === c[0]) h = ((c[1] - c[2]) / d + 6) % 6;
    else if (max === c[1]) h = (c[2] - c[0]) / d + 2;
    else h = (c[0] - c[1]) / d + 4;
    h /= 6;
  }
  h = (((h + turns) % 1) + 1) % 1;
  const s2 = clamp01(s * sat);
  const k = (n: number) => { const x = (n + h * 6) % 6; return v - v * s2 * Math.max(0, Math.min(x, 4 - x, 1)); };
  return [k(5), k(3), k(1)];
}

/**
 * Fill every pixel of the triangle (a, b, c) -- pixel-space corners -- calling `shade(x, y, w0, w1, w2)`
 * with the barycentric weights of the pixel centre. Top-left fill rule, so triangles sharing an edge
 * cover it exactly once. Either winding.
 */
export function rasterTriangle(width: number, height: number,
                               ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
                               shade: (x: number, y: number, w0: number, w1: number, w2: number) => void): void {
  const area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  if (Math.abs(area) < 1e-12) return;
  const minX = Math.max(0, Math.floor(Math.min(ax, bx, cx))), maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx, cx)));
  const minY = Math.max(0, Math.floor(Math.min(ay, by, cy))), maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by, cy)));
  const inv = 1 / area;
  for (let y = minY; y <= maxY; y++) {
    const py = y + 0.5;
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const w0 = ((bx - px) * (cy - py) - (by - py) * (cx - px)) * inv;
      const w1 = ((cx - px) * (ay - py) - (cy - py) * (ax - px)) * inv;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      shade(x, y, w0, w1, w2);
    }
  }
}

/**
 * Push-pull dilation: every pixel with alpha 0 takes the colour of the nearest covered pixels, alpha
 * untouched. Without it a cutout texture's transparent texels keep whatever colour they had -- black,
 * usually -- and mipmapping blends that into the silhouette, so leaves grow dark outlines at distance.
 * `covered(i)` says which pixels hold real colour (default: alpha > 0).
 */
export function dilateColor(img: Image, covered?: (i: number) => boolean): void {
  const { width: w, height: h, data } = img;
  const has = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) has[i] = (covered ? covered(i) : data[i * 4 + 3] > 0) ? 1 : 0;
  // Pull: a mip pyramid of averaged covered colour.
  type Level = { w: number; h: number; rgb: Float32Array; n: Float32Array };
  const levels: Level[] = [];
  let cur: Level = { w, h, rgb: new Float32Array(w * h * 3), n: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++) if (has[i]) {
    cur.rgb[i * 3] = data[i * 4]; cur.rgb[i * 3 + 1] = data[i * 4 + 1]; cur.rgb[i * 3 + 2] = data[i * 4 + 2]; cur.n[i] = 1;
  }
  levels.push(cur);
  while (cur.w > 1 || cur.h > 1) {
    const nw = Math.max(1, cur.w >> 1), nh = Math.max(1, cur.h >> 1);
    const next: Level = { w: nw, h: nh, rgb: new Float32Array(nw * nh * 3), n: new Float32Array(nw * nh) };
    for (let y = 0; y < cur.h; y++) for (let x = 0; x < cur.w; x++) {
      const i = y * cur.w + x, j = Math.min(nh - 1, y >> 1) * nw + Math.min(nw - 1, x >> 1);
      const n = cur.n[i];
      if (n <= 0) continue;
      next.rgb[j * 3] += cur.rgb[i * 3]; next.rgb[j * 3 + 1] += cur.rgb[i * 3 + 1]; next.rgb[j * 3 + 2] += cur.rgb[i * 3 + 2];
      next.n[j] += n;
    }
    levels.push(next);
    cur = next;
  }
  // Push: each empty pixel takes the first level up that has colour over it.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (has[i]) continue;
    for (let l = 1; l < levels.length; l++) {
      const L = levels[l];
      const j = Math.min(L.h - 1, y >> l) * L.w + Math.min(L.w - 1, x >> l);
      if (L.n[j] > 0) {
        data[i * 4] = Math.round(L.rgb[j * 3] / L.n[j]);
        data[i * 4 + 1] = Math.round(L.rgb[j * 3 + 1] / L.n[j]);
        data[i * 4 + 2] = Math.round(L.rgb[j * 3 + 2] / L.n[j]);
        break;
      }
    }
  }
}

/**
 * A tangent-space normal map from a height field (0..1, row 0 = top). Sobel gradients, `wrap` for a
 * tiling texture. OpenGL convention (green = up the image), which is glTF's.
 */
export function normalFromHeight(heights: Float32Array, width: number, height: number, strength: number, wrap: boolean): Image {
  const img = createImage(width, height);
  const at = (x: number, y: number) => {
    if (wrap) { x = (x + width) % width; y = (y + height) % height; }
    else { x = Math.min(width - 1, Math.max(0, x)); y = Math.min(height - 1, Math.max(0, y)); }
    return heights[y * width + x];
  };
  const k = strength * Math.max(width, height) / 64;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    // Image y runs DOWN, tangent-space +Y runs up: a height rising down the image tilts the normal up.
    let nx = -dx * k, ny = dy * k;
    const nz = 1, l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l;
    const o = (y * width + x) * 4;
    img.data[o] = Math.round((nx * 0.5 + 0.5) * 255);
    img.data[o + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    img.data[o + 2] = Math.round((nz / l * 0.5 + 0.5) * 255);
    img.data[o + 3] = 255;
  }
  return img;
}

/** Bilinear resample of an RGBA8 image to a new size (for user overrides of another size). */
export function resample(src: Image, width: number, height: number): Image {
  if (src.width === width && src.height === height) return src;
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const sx = Math.min(src.width - 1, Math.max(0, (x + 0.5) * src.width / width - 0.5));
    const sy = Math.min(src.height - 1, Math.max(0, (y + 0.5) * src.height / height - 0.5));
    const x0 = Math.floor(sx), y0 = Math.floor(sy), x1 = Math.min(src.width - 1, x0 + 1), y1 = Math.min(src.height - 1, y0 + 1);
    const fx = sx - x0, fy = sy - y0;
    for (let c = 0; c < 4; c++) {
      const a = src.data[(y0 * src.width + x0) * 4 + c], b = src.data[(y0 * src.width + x1) * 4 + c];
      const d = src.data[(y1 * src.width + x0) * 4 + c], e = src.data[(y1 * src.width + x1) * 4 + c];
      out.data[(y * width + x) * 4 + c] = Math.round((a + (b - a) * fx) * (1 - fy) + (d + (e - d) * fx) * fy);
    }
  }
  return out;
}
