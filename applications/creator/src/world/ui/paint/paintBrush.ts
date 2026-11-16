// The paint brush for the World's masks: one dab at a map coordinate, with the engine terrain brush's
// falloff (terrain/brushFalloff), so a mask painted here feathers like a sculpt stroke in the editor.
// Pure: it changes the pixels it is handed and returns the texels it touched (for the undo history).

import { brushFalloffWeight } from 'cleo/terrain/brushFalloff';

export type BrushMode = 'add' | 'subtract' | 'smooth' | 'set';

export interface Brush {
  mode: BrushMode;
  /** Radius, metres. */
  radius: number;
  /** 0..1, how much one dab moves a texel toward its target. */
  strength: number;
  /** 0 hard edge .. 1 fully feathered. */
  falloff: number;
  /** `set`: the value painted (-1..1 on a signed mask). */
  value: number;
}

export const DEFAULT_BRUSH: Brush = { mode: 'add', radius: 80, strength: 0.35, falloff: 0.6, value: 1 };

/** Texel bounds, [x0, x1) x [y0, y1). */
export interface MaskRegion { x0: number; y0: number; x1: number; y1: number }

export const unionRegion = (a: MaskRegion | null, b: MaskRegion | null): MaskRegion | null =>
  !a ? b : !b ? a : { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) };

/**
 * One dab at map coordinate (u, v) (0..1, (0,0) the -X/-Z corner) on a `res`² mask of a `size` m map.
 * Returns the region it touched, or null when it missed the mask.
 */
export function dab(pixels: Float32Array, res: number, signed: boolean, size: number, u: number, v: number, brush: Brush): MaskRegion | null {
  const rTex = Math.max(0.5, brush.radius / size * res);
  const cx = u * res - 0.5, cy = v * res - 0.5;
  const x0 = Math.max(0, Math.floor(cx - rTex)), x1 = Math.min(res, Math.ceil(cx + rTex) + 1);
  const y0 = Math.max(0, Math.floor(cy - rTex)), y1 = Math.min(res, Math.ceil(cy + rTex) + 1);
  if (x0 >= x1 || y0 >= y1) return null;
  const lo = signed ? -1 : 0;
  const k = Math.min(1, Math.max(0, brush.strength));
  // Smooth reads the neighbourhood as it was before this dab: a copy of the dab's box plus a margin.
  const M = 2;
  const bx0 = Math.max(0, x0 - M), by0 = Math.max(0, y0 - M), bx1 = Math.min(res, x1 + M), by1 = Math.min(res, y1 + M);
  const before = brush.mode === 'smooth' ? readRegion(pixels, res, { x0: bx0, y0: by0, x1: bx1, y1: by1 }) : null;
  const bw = bx1 - bx0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const d = Math.hypot(x - cx, y - cy) / rTex;
      if (d > 1) continue;
      const w = brushFalloffWeight(d, brush.falloff) * k;
      const i = y * res + x;
      let target: number;
      switch (brush.mode) {
        case 'add': target = 1; break;
        case 'subtract': target = lo; break;
        case 'set': target = brush.value; break;
        case 'smooth': {
          let s = 0, n = 0;
          for (let dy = -M; dy <= M; dy++) for (let dx = -M; dx <= M; dx++) {
            const xx = x + dx, yy = y + dy;
            if (xx < bx0 || yy < by0 || xx >= bx1 || yy >= by1) continue;
            s += before![(yy - by0) * bw + (xx - bx0)]; n++;
          }
          target = s / n;
          break;
        }
      }
      const vNew = pixels[i] + (target - pixels[i]) * w;
      pixels[i] = Math.min(1, Math.max(lo, vNew));
    }
  }
  return { x0, y0, x1, y1 };
}

/** The texels of `region` copied out (for the undo history). */
export function readRegion(pixels: Float32Array, res: number, r: MaskRegion): Float32Array {
  const w = r.x1 - r.x0;
  const out = new Float32Array(w * (r.y1 - r.y0));
  for (let y = r.y0; y < r.y1; y++) out.set(pixels.subarray(y * res + r.x0, y * res + r.x1), (y - r.y0) * w);
  return out;
}

export function writeRegion(pixels: Float32Array, res: number, r: MaskRegion, data: Float32Array): void {
  const w = r.x1 - r.x0;
  for (let y = r.y0; y < r.y1; y++) pixels.set(data.subarray((y - r.y0) * w, (y - r.y0 + 1) * w), y * res + r.x0);
}
