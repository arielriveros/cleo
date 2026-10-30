// Procedural bark: a tiling albedo and normal map, from periodic Worley and fBm.
//
// The texture wraps around the branch (u) and repeats up it (v), so every noise here is periodic in
// both. Each pattern is a height field first -- plates, furrows, lenticels -- and the albedo and the
// normal map are both read off that one field, so the colour and the relief always agree.

import type { BarkPattern, Rgba } from '../foliageParams';
import { fbm2, noiseSeed, worley2 } from '../noise';
import { createImage, normalFromHeight, putLinear, rgb, type Image } from './image';

const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

export interface BarkTextures { albedo: Image; normal: Image }

export function barkTextures(seed: number, size: number, pattern: BarkPattern, color: Rgba): BarkTextures {
  const s = noiseSeed(seed, 'bark');
  const heights = new Float32Array(size * size);
  const tint = new Float32Array(size * size);
  const base = rgb(color);
  const albedo = createImage(size, size);

  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + 0.5) / size, v = (y + 0.5) / size;
    const i = y * size + x;
    let h: number, shade: number;
    const fine = fbm2(s + 3, u, v, 32, 8, 3);
    const broad = fbm2(s + 5, u, v, 4, 2, 3);
    switch (pattern) {
      case 'plated': {
        // Pine: broad plates split by deep cracks, each plate its own tone.
        const w = worley2(s, u + (broad - 0.5) * 0.04, v, 5, 4);
        const crack = smoothstep(0.02, 0.22, w.f2 - w.f1);
        const plate = ((w.id * 2654435761) >>> 0) / 4294967296;
        h = crack * (0.7 + 0.3 * fine);
        shade = (0.45 + 0.55 * crack) * (0.85 + 0.3 * plate) * (0.9 + 0.2 * fine);
        tint[i] = plate;
        break;
      }
      case 'smooth': {
        // Beech-like: smooth skin, soft mottling, faint horizontal lenticels.
        const mottle = fbm2(s + 7, u, v, 6, 3, 4);
        const len = fbm2(s + 11, u, v, 6, 64, 2);
        const lenticel = smoothstep(0.7, 0.85, len);
        h = 0.5 + 0.15 * mottle - 0.25 * lenticel;
        shade = (0.8 + 0.35 * mottle) * (1 - 0.35 * lenticel);
        tint[i] = mottle;
        break;
      }
      case 'papery': {
        // Birch: pale papery skin with dark horizontal lenticels and dark scar patches.
        const len = fbm2(s + 13, u, v, 5, 48, 3);
        const lenticel = smoothstep(0.66, 0.8, len);
        const scar = smoothstep(0.62, 0.72, fbm2(s + 17, u, v, 3, 5, 4));
        const peel = fbm2(s + 19, u, v, 10, 30, 2);
        h = 0.55 + 0.1 * peel - 0.3 * lenticel - 0.2 * scar;
        shade = (0.92 + 0.12 * peel) * (1 - 0.75 * lenticel) * (1 - 0.8 * scar);
        tint[i] = scar;
        break;
      }
      default: {
        // Oak: long vertical plates between deep furrows, broken across into blocks, wandering a little.
        const warp = (fbm2(s + 23, u, v, 3, 2, 3) - 0.5) * 0.12;
        const w = worley2(s, u + warp, v, 8, 2);
        const ridge = smoothstep(0.02, 0.42, w.f2 - w.f1);
        const blocks = worley2(s + 29, u + warp, v, 8, 7);
        const across = smoothstep(0.0, 0.14, blocks.f2 - blocks.f1);
        const plate = ridge * (0.55 + 0.45 * across);
        const grain = fbm2(s + 31, u, v, 48, 6, 3);
        h = plate * (0.7 + 0.3 * grain) + 0.08 * broad;
        shade = (0.12 + 0.95 * Math.pow(plate, 0.8)) * (0.8 + 0.4 * grain);
        tint[i] = broad;
      }
    }
    heights[i] = h;
    const variation = 0.85 + 0.3 * broad;
    const k = shade * variation;
    // Cracks also cool slightly toward grey-brown; plates warm up. Small, but it reads as depth.
    const warm = (tint[i] - 0.5) * 0.12;
    putLinear(albedo, i, base[0] * k * (1 + warm), base[1] * k, base[2] * k * (1 - warm));
  }

  return { albedo, normal: normalFromHeight(heights, size, size, pattern === 'smooth' || pattern === 'papery' ? 1.2 : 3, true) };
}
