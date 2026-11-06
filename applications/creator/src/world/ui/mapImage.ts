// The Map's picture for each view: a hillshade, a data mask, a field, the water, or the surfaces as a
// colour-coded composite. Pure (pixels in, pixels out), drawn into the Map's canvas.

import { compositeWeights } from 'cleo/terrain/terrainLayers';
import { surfaceKindInfo } from '../../surfaces/kinds';
import { sampleField } from '../fields';
import { WATER_DRY, WATER_LAKE } from '../lakes';
import { MASK_KINDS, type MaskKind } from '../masks';
import type { PreviewResult } from '../worldWorker';
import type { WorldDoc } from '../worldDoc';

export type MapLayerView = 'height' | 'surfaces' | 'selected' | 'water' | MaskKind | 'aspect' | 'cavity' | 'flowArea' | 'shore' | 'deposits' | 'wear' | 'talus';

export const MAP_VIEWS: { value: MapLayerView; label: string }[] = [
  { value: 'height', label: 'Height' },
  { value: 'surfaces', label: 'Surfaces' },
  { value: 'selected', label: 'Selected surface' },
  { value: 'water', label: 'Water' },
  ...MASK_KINDS.map(k => ({ value: k as MapLayerView, label: k[0].toUpperCase() + k.slice(1) })),
  { value: 'aspect', label: 'Aspect' },
  { value: 'cavity', label: 'Cavity' },
  { value: 'flowArea', label: 'Flow area' },
  { value: 'shore', label: 'Shore distance' },
  { value: 'deposits', label: 'Deposits' },
  { value: 'wear', label: 'Wear' },
  { value: 'talus', label: 'Talus' },
];

export interface MapPicture { width: number; height: number; rgba: Uint8ClampedArray }

const toSrgb8 = (c: number) => Math.round(Math.pow(Math.min(1, Math.max(0, c)), 1 / 2.2) * 255);

/** Lambert from the north-west, the cartographic convention, 0.35..1. */
function hillshade(r: PreviewResult): Float32Array {
  const { heights, frame } = r.out;
  const res = frame.resolution;
  const e = frame.size / (res - 1);
  const out = new Float32Array(res * res);
  for (let y = 0; y < res; y++) for (let x = 0; x < res; x++) {
    const hx = (heights[y * res + Math.min(res - 1, x + 1)] - heights[y * res + Math.max(0, x - 1)]) * frame.heightScale / (2 * e);
    const hy = (heights[Math.min(res - 1, y + 1) * res + x] - heights[Math.max(0, y - 1) * res + x]) * frame.heightScale / (2 * e);
    const lambert = Math.max(0, (hx * 0.6 + hy * 0.6 + 1) / Math.sqrt(1 + hx * hx + hy * hy) / 1.5);
    out[y * res + x] = 0.35 + 0.65 * lambert;
  }
  return out;
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6), f = h * 6 - i;
  const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
  switch (((i % 6) + 6) % 6) {
    case 0: return [v, t, p]; case 1: return [q, v, p]; case 2: return [p, v, t];
    case 3: return [p, q, v]; case 4: return [t, p, v]; default: return [v, p, q];
  }
}

export function mapPicture(view: MapLayerView, r: PreviewResult, doc: WorldDoc, selectedSurface: string | null): MapPicture {
  const f = r.fields;
  const R = f.resolution;
  const shade = hillshade(r);

  if (view === 'surfaces' || view === 'selected') {
    const { alphas, size: M } = r.surfaces;
    const rgba = new Uint8ClampedArray(M * M * 4);
    const enabled = doc.surfaces.map((s, i) => ({ s, a: alphas[i] })).filter(e => e.a) as { s: WorldDoc['surfaces'][number]; a: Uint8Array }[];
    const colours = enabled.map(({ s }) => surfaceKindInfo(s.preview.kind).color.map((c, j) => c * s.preview.tint[j]));
    const sel = enabled.findIndex(e => e.s.id === selectedSurface);
    const a = new Float64Array(enabled.length), w = new Float64Array(enabled.length);
    for (let y = 0; y < M; y++) for (let x = 0; x < M; x++) {
      const t = y * M + x;
      const sh = sampleField(shade, R, ((x + 0.5) / M) * (R - 1), ((y + 0.5) / M) * (R - 1));
      let rgb: [number, number, number];
      if (view === 'selected') {
        const v = sel >= 0 ? enabled[sel].a[t] / 255 : 0;
        const g = sh * 0.25;
        rgb = [g + v * 0.75, g + v * 0.62, g + v * 0.25];
        rgba.set([toSrgb8(rgb[0]), toSrgb8(rgb[1]), toSrgb8(rgb[2]), 255], t * 4);
        continue;
      }
      for (let i = 0; i < enabled.length; i++) a[i] = enabled[i].a[t] / 255;
      a[0] = 1;
      compositeWeights(a, w);
      rgb = [0, 0, 0];
      for (let i = 0; i < enabled.length; i++) for (let j = 0; j < 3; j++) rgb[j] += colours[i][j] * w[i];
      // Lifted so dark surfaces (mud, forest floor) stay readable on the map.
      rgba.set([toSrgb8(rgb[0] * sh * 1.6), toSrgb8(rgb[1] * sh * 1.6), toSrgb8(rgb[2] * sh * 1.6), 255], t * 4);
    }
    return { width: M, height: M, rgba };
  }

  const rgba = new Uint8ClampedArray(R * R * 4);
  const h = r.out.heights;
  let min = Infinity, max = -Infinity;
  for (const v of h) { if (v < min) min = v; if (v > max) max = v; }
  const span = max - min || 1;
  const water = f.water;
  for (let i = 0; i < R * R; i++) {
    let rgb: [number, number, number];
    const wet = water.kind[i] !== WATER_DRY;
    switch (view) {
      case 'height': {
        const t = (h[i] - min) / span;
        const base: [number, number, number] = wet ? [40, 80, 140] : [90 + 120 * t, 110 + 90 * t, 70 + 110 * t];
        rgb = [base[0] * shade[i], base[1] * shade[i], base[2] * shade[i]];
        break;
      }
      case 'water': {
        if (!wet) { const g = 110 * shade[i]; rgb = [g, g, g]; break; }
        const depth = f.waterDepth[i];
        const d = Math.min(1, depth / 40);
        rgb = water.kind[i] === WATER_LAKE ? [40 + 60 * (1 - d), 140 + 80 * (1 - d), 160 + 60 * (1 - d)] : [20 + 50 * (1 - d), 60 + 100 * (1 - d), 140 + 90 * (1 - d)];
        break;
      }
      case 'aspect': {
        const a = f.aspect ? f.aspect[i] / 360 : 0;
        const s = Math.min(1, f.slope[i] / 25);
        const c = hsv(a, 0.75 * s, 0.35 + 0.65 * shade[i]);
        rgb = [c[0] * 255, c[1] * 255, c[2] * 255];
        break;
      }
      case 'shore': {
        const d = f.shoreDistance[i];
        const t = Math.min(1, Math.abs(d) / 200);
        rgb = d < 0 ? [30, 70 + 100 * (1 - t), 170 + 60 * (1 - t)] : [220 - 120 * t, 200 - 110 * t, 140 - 70 * t];
        break;
      }
      default: {
        let v = 0;
        if (view === 'cavity') v = (f.cavity.medium?.[i] ?? 0) * 2.5;
        else if (view === 'flowArea') v = f.flowArea ? (f.flowArea[i] - 1) / 8 : 0;
        else if (view === 'deposits' || view === 'wear' || view === 'talus') v = f[view][i];
        else v = r.out.masks[view as MaskKind][i];
        const g = Math.min(1, Math.max(0, v)) * 255;
        rgb = [g, g, g];
      }
    }
    rgba[i * 4] = rgb[0]; rgba[i * 4 + 1] = rgb[1]; rgba[i * 4 + 2] = rgb[2]; rgba[i * 4 + 3] = 255;
  }
  return { width: R, height: R, rgba };
}
