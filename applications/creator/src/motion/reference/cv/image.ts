// The reference analysis's pictures: small grayscale frames, and the classical operations on them -- frame
// difference, luminance histograms, the per-pixel median of many frames, Otsu's threshold, binary
// morphology and connected components. No learning anywhere: each step is a few lines of arithmetic a
// person can check, and runs on a 256-pixel-wide copy of the frame in the reference worker.

/** A grayscale picture, one byte a pixel, rows top to bottom. */
export interface Gray { w: number; h: number; data: Uint8Array; }

/** A binary picture (1 = set). */
export interface Mask { w: number; h: number; data: Uint8Array; }

/** A rectangle in a picture's unit square: x, y of its top-left, w, h (all 0..1). */
export interface Box { x: number; y: number; w: number; h: number; }

/** RGBA bytes to luma (Rec. 601 weights, the eye's), one byte a pixel. */
export function toGray(rgba: ArrayLike<number>, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  return { w, h, data };
}

/**
 * A frame's two colour-difference planes (Cb, Cr around 128): a subject the same brightness as what is behind
 * it (a red shirt on a grey floor) still differs from it in colour.
 */
export function toChroma(rgba: ArrayLike<number>, w: number, h: number): [Gray, Gray] {
  const cb = new Uint8Array(w * h), cr = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < cb.length; i++, j += 4) {
    const y = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
    cb[i] = Math.max(0, Math.min(255, 128 + ((rgba[j + 2] - y) >> 1)));
    cr[i] = Math.max(0, Math.min(255, 128 + ((rgba[j] - y) >> 1)));
  }
  return [{ w, h, data: cb }, { w, h, data: cr }];
}

/**
 * How different two frames are: the mean absolute difference of their pixels (0 the same, 1 black against
 * white), over the whole frame or inside `roi`.
 */
export function frameDifference(a: Gray, b: Gray, roi?: Box | null): number {
  const [x0, y0, x1, y1] = roiPixels(a, roi);
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * a.w;
    for (let x = x0; x < x1; x++) { sum += Math.abs(a.data[row + x] - b.data[row + x]); n++; }
  }
  return n ? sum / n / 255 : 0;
}

/** A unit-square box as clamped pixel bounds [x0, y0, x1, y1) of a picture. */
export function roiPixels(g: { w: number; h: number }, roi?: Box | null): [number, number, number, number] {
  if (!roi) return [0, 0, g.w, g.h];
  const x0 = Math.max(0, Math.floor(roi.x * g.w)), y0 = Math.max(0, Math.floor(roi.y * g.h));
  const x1 = Math.min(g.w, Math.ceil((roi.x + roi.w) * g.w)), y1 = Math.min(g.h, Math.ceil((roi.y + roi.h) * g.h));
  return [x0, y0, Math.max(x0, x1), Math.max(y0, y1)];
}

/** A normalised luminance histogram (sums to 1). */
export function histogram(g: Gray, bins = 32): Float32Array {
  const out = new Float32Array(bins);
  const k = bins / 256;
  for (let i = 0; i < g.data.length; i++) out[(g.data[i] * k) | 0]++;
  for (let i = 0; i < bins; i++) out[i] /= Math.max(1, g.data.length);
  return out;
}

/** The χ² distance between two normalised histograms (0 the same, up to 2 nothing shared). */
export function chiSquare(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) { const s = a[i] + b[i]; if (s > 0) d += ((a[i] - b[i]) ** 2) / s; }
  return d;
}

/**
 * The per-pixel median of several frames: the background of a shot from a still camera, where anything
 * that moves is in front of it in fewer than half of them. A 256-bin count per pixel, so any number of frames.
 */
export function temporalMedian(frames: Gray[]): Gray {
  const { w, h } = frames[0];
  const n = frames.length, half = (n - 1) / 2;
  const out = new Uint8Array(w * h);
  const count = new Uint16Array(256);
  for (let i = 0; i < w * h; i++) {
    count.fill(0);
    for (const f of frames) count[f.data[i]]++;
    let seen = 0, v = 0;
    for (; v < 256; v++) { seen += count[v]; if (seen > half) break; }
    out[i] = Math.min(255, v);
  }
  return { w, h, data: out };
}

/**
 * Otsu's threshold for a 256-bin histogram of counts: the level that best splits it into two classes (the
 * one that maximises the variance between them). Returns the level; values above it are the bright class.
 */
export function otsu(hist: ArrayLike<number>): number {
  let total = 0, sum = 0;
  for (let i = 0; i < 256; i++) { total += hist[i]; sum += i * hist[i]; }
  let wB = 0, sumB = 0, best = 0, level = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; level = t; }
  }
  return level;
}

/** |frame − background|, as a picture (for a threshold). */
export function absDiff(a: Gray, b: Gray): Gray {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < out.length; i++) out[i] = Math.abs(a.data[i] - b.data[i]);
  return { w: a.w, h: a.h, data: out };
}

/** A 256-bin count of a picture's values. */
export function counts(g: Gray): Uint32Array {
  const out = new Uint32Array(256);
  for (let i = 0; i < g.data.length; i++) out[g.data[i]]++;
  return out;
}

/** Pixels above `threshold`. */
export function threshold(g: Gray, t: number): Mask {
  const out = new Uint8Array(g.data.length);
  for (let i = 0; i < out.length; i++) out[i] = g.data[i] > t ? 1 : 0;
  return { w: g.w, h: g.h, data: out };
}

/** 3×3 erosion (`min`) or dilation (`max`), as two 3-wide passes (the box is separable). */
function morph(m: Mask, op: 'min' | 'max'): Mask {
  const { w, h } = m;
  const pick = op === 'min' ? Math.min : Math.max;
  const edge = op === 'min' ? 0 : 0;
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const l = x > 0 ? m.data[i - 1] : edge, r = x < w - 1 ? m.data[i + 1] : edge;
    tmp[i] = pick(l, m.data[i], r);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    const u = y > 0 ? tmp[i - w] : edge, d = y < h - 1 ? tmp[i + w] : edge;
    out[i] = pick(u, tmp[i], d);
  }
  return { w, h, data: out };
}
export const erode = (m: Mask) => morph(m, 'min');
export const dilate = (m: Mask) => morph(m, 'max');
/** Opening: specks smaller than the brush go. */
export const open = (m: Mask) => dilate(erode(m));
/** Closing: holes and cracks smaller than the brush fill. */
export const close = (m: Mask) => erode(dilate(m));

export interface Blob { area: number; x0: number; y0: number; x1: number; y1: number; cx: number; cy: number; label: number; }

/**
 * Connected regions of a mask (8-connected), by the two-pass union-find: a provisional label per pixel
 * from its already-labelled neighbours, the equivalences merged, then relabelled. Blobs largest first;
 * `labels` holds each pixel's blob label (0 = none).
 */
export function connectedComponents(m: Mask): { labels: Int32Array; blobs: Blob[] } {
  const { w, h } = m;
  const labels = new Int32Array(w * h);
  const parent: number[] = [0];
  const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (!m.data[i]) continue;
    let label = 0;
    const neighbours = [x > 0 ? i - 1 : -1, y > 0 && x > 0 ? i - w - 1 : -1, y > 0 ? i - w : -1, y > 0 && x < w - 1 ? i - w + 1 : -1];
    for (const n of neighbours) {
      if (n < 0 || !labels[n]) continue;
      if (!label) label = labels[n]; else union(label, labels[n]);
    }
    if (!label) { label = parent.length; parent.push(label); }
    labels[i] = label;
  }
  const byRoot = new Map<number, Blob>();
  for (let i = 0; i < labels.length; i++) {
    if (!labels[i]) continue;
    const root = find(labels[i]);
    labels[i] = root;
    const x = i % w, y = (i / w) | 0;
    let b = byRoot.get(root);
    if (!b) { b = { area: 0, x0: x, y0: y, x1: x, y1: y, cx: 0, cy: 0, label: root }; byRoot.set(root, b); }
    b.area++; b.cx += x; b.cy += y;
    if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x; if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
  }
  const blobs = [...byRoot.values()].map(b => ({ ...b, cx: b.cx / b.area, cy: b.cy / b.area })).sort((a, b) => b.area - a.area);
  return { labels, blobs };
}

/** A blob's bounding box in its picture's unit square. */
export const blobBox = (b: Blob, w: number, h: number): Box => ({ x: b.x0 / w, y: b.y0 / h, w: (b.x1 - b.x0 + 1) / w, h: (b.y1 - b.y0 + 1) / h });

/**
 * The moving subject of a frame from a still camera: |frame − background| over Otsu's threshold (never below
 * `minLevel`, so a frame with nothing moving does not threshold its own noise), opened and closed, and the
 * largest region. Several planes (luma and the two chroma) count by the largest difference of any. Null when
 * nothing larger than `minArea` (a share of the frame) moves.
 */
export function subjectOf(frame: Gray | Gray[], background: Gray | Gray[], opts: { minLevel?: number; minArea?: number } = {}): { box: Box; mask: Mask; fraction: number } | null {
  const fs = Array.isArray(frame) ? frame : [frame], bs = Array.isArray(background) ? background : [background];
  const diff = absDiff(fs[0], bs[0]);
  for (let p = 1; p < fs.length && p < bs.length; p++) {
    const d = absDiff(fs[p], bs[p]);
    // Chroma differences are halved in toChroma: doubled back to compare with luma's.
    for (let i = 0; i < diff.data.length; i++) diff.data[i] = Math.max(diff.data[i], Math.min(255, d.data[i] * 2));
  }
  const level = Math.max(opts.minLevel ?? 18, otsu(counts(diff)));
  const mask = close(open(threshold(diff, level)));
  let set = 0;
  for (let i = 0; i < mask.data.length; i++) set += mask.data[i];
  const fraction = set / mask.data.length;
  const { blobs } = connectedComponents(mask);
  const top = blobs[0];
  if (!top || top.area < (opts.minArea ?? 0.002) * mask.data.length) return null;
  return { box: blobBox(top, fs[0].w, fs[0].h), mask, fraction };
}
