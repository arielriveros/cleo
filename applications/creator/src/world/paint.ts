// Painted masks: what the Paint Mask node reads. The document keeps only each mask's description and a
// content hash (`PaintMaskMeta`); the pixels travel beside it -- in the saved asset as 16-bit PNGs, in the
// Scratch document in IndexedDB (paintStore.ts), and to the worker with each request. The hash is what the
// caches and the export key on, so a stroke re-runs exactly what reads that mask.
//
// Values are 0..1, or -1..1 for a signed mask (raise / lower). Masks are square, independent of the
// world's resolution, and sampled bilinearly onto whatever grid the graph runs at.

import { decodePng, encodePng16 } from 'cleo/terrain/heightmapIO';

export interface PaintMaskMeta {
  id: string;
  name: string;
  /** Texels per side. */
  resolution: number;
  /** -1..1 rather than 0..1. */
  signed: boolean;
  /** Content hash of the pixels (`paintHash`). */
  hash: string;
}

/** The pixels of each mask, by id: resolution² values, row-major, (0,0) the map's -X/-Z corner. */
export type PaintPixels = Record<string, Float32Array>;

export const PAINT_RESOLUTIONS = [256, 512, 1024] as const;

export function blankMask(resolution: number): Float32Array {
  return new Float32Array(resolution * resolution);
}

/** A hash of a mask's pixels as they will be stored (16-bit), so a save and reload keeps it. */
export function paintHash(pixels: Float32Array, signed: boolean): string {
  let h1 = 0x811c9dc5, h2 = 0x9e3779b9;
  for (let i = 0; i < pixels.length; i++) {
    const q = quantise(pixels[i], signed);
    h1 = Math.imul(h1 ^ q, 0x01000193);
    h2 = Math.imul(h2 ^ q, 0x85ebca6b) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

const quantise = (v: number, signed: boolean) => {
  const t = signed ? (v + 1) * 0.5 : v;
  return Math.round(Math.min(1, Math.max(0, t)) * 65535);
};

/** `pixels` bilinearly resampled onto a `res`² grid (texel-centred both sides). */
export function sampleMask(pixels: Float32Array, maskRes: number, res: number): Float32Array {
  const out = new Float32Array(res * res);
  for (let r = 0; r < res; r++) {
    const fy = Math.min(maskRes - 1, Math.max(0, (r / Math.max(1, res - 1)) * maskRes - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(maskRes - 1, y0 + 1), ty = fy - y0;
    for (let c = 0; c < res; c++) {
      const fx = Math.min(maskRes - 1, Math.max(0, (c / Math.max(1, res - 1)) * maskRes - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(maskRes - 1, x0 + 1), tx = fx - x0;
      const a = pixels[y0 * maskRes + x0], b = pixels[y0 * maskRes + x1];
      const cc = pixels[y1 * maskRes + x0], d = pixels[y1 * maskRes + x1];
      const top = a + (b - a) * tx, bottom = cc + (d - cc) * tx;
      out[r * res + c] = top + (bottom - top) * ty;
    }
  }
  return out;
}

/** A mask as a 16-bit grayscale PNG (signed masks store (v + 1) / 2). */
export async function encodeMask(pixels: Float32Array, resolution: number, signed: boolean): Promise<Uint8Array> {
  const data = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) data[i] = quantise(pixels[i], signed) / 65535;
  return encodePng16({ width: resolution, height: resolution, data });
}

/** The inverse of encodeMask. */
export async function decodeMask(bytes: Uint8Array, signed: boolean): Promise<{ resolution: number; pixels: Float32Array }> {
  const img = await decodePng(bytes);
  const n = img.width * img.height;
  const pixels = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = img.data[i];
    pixels[i] = signed ? t * 2 - 1 : t;
  }
  return { resolution: img.width, pixels };
}

/** The file a mask is stored as beside a saved asset (a signed mask's name says so). */
export const paintFileName = (id: string, signed: boolean) => `paint/${id}${signed ? '.signed' : ''}.png`;

/** The mask id and signedness a stored file name stands for, or null. */
export function parsePaintFileName(name: string): { id: string; signed: boolean } | null {
  const m = /^paint\/(.+?)(\.signed)?\.png$/.exec(name);
  return m ? { id: m[1], signed: !!m[2] } : null;
}
