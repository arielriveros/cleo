// Generated surface materials: a tileable PBR set (albedo, normal, ORM, height) for each terrain kind
// the World Creator shows its layers with. Preview only: the World exports where each layer lies, never
// these pictures.
//
// The bark method (foliage/textures/bark.ts): every kind builds ONE height field from periodic noise
// first, and the albedo, the normal map, the ORM map and the height map are all read off that field, so
// colour, relief, occlusion and the stack's height blend always agree. Every noise is periodic over the
// tile (integer cell counts) and every texel is sampled at its centre, so the maps wrap exactly.
//
// Colours are LINEAR and fairly natural for the kind (grass reads green with the material's baseColor
// left white); the World tints a layer through its material's baseColor, which multiplies these, so a
// tint never regenerates the maps. Pure, deterministic and DOM-free: it runs in surfaceWorker.ts and in
// tests alike.

import { noiseSeed, NoiseTables } from '../core/texture/noise';
import { createImage, toSrgb, type Image } from '../core/texture/image';
import { ormMap } from '../core/texture/orm';
import type { SurfaceKind } from './kinds';

export interface SurfaceMaps {
  size: number;
  /** sRGB colour, opaque. */
  albedo: Image;
  /** Tangent-space normal, OpenGL convention (green up the image), as glTF and the engine read it. */
  normal: Image;
  /** R ambient occlusion, G roughness, B metallic (0). */
  orm: Image;
  /** The relief, grey, white = high, normalised to use the whole 0..1 range. */
  height: Image;
}

/** A kind's recipe: the relief at a texel, then its colour and roughness from the normalised relief. */
interface Recipe {
  normalStrength: number;
  aoStrength: number;
  /** Raw relief at (u, v) in [0, 1)²; may leave two values per texel in `aux` for `surface`. */
  relief(u: number, v: number, aux: Float32Array): number;
  /** Linear albedo (out[0..2]) and roughness (out[3]) from the normalised relief `h` and the aux values. */
  surface(h: number, a: number, b: number, out: Float32Array): void;
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const smoothstep = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const frac = (x: number) => x - Math.floor(x);

/** A per-cell random value in [0, 1): the same cell id gives the same value across the tile's wrap. */
function cellRand(seed: number, id: number): number {
  let h = Math.imul(id ^ seed, 0x9e3779b1) ^ 0x85ebca6b;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** A thin line where a noise crosses one half (needles, cracks in drawn relief). */
const line = (n: number, width: number) => 1 - smoothstep(0, width, Math.abs(n - 0.5));

/** Linear 0..1 -> sRGB byte through a table (an exact `toSrgb` per entry; within half a level everywhere). */
const SRGB_STEPS = 8191;
let srgbTable: Uint8Array | null = null;
function srgbByte(c: number): number {
  if (!srgbTable) {
    srgbTable = new Uint8Array(SRGB_STEPS + 1);
    for (let i = 0; i <= SRGB_STEPS; i++) srgbTable[i] = Math.round(toSrgb(i / SRGB_STEPS) * 255);
  }
  return srgbTable[Math.round(clamp01(c) * SRGB_STEPS)];
}

/**
 * The tiling normal map: `normalFromHeight(h, size, size, strength, true)`'s Sobel and convention (green
 * up the image), with the wrap folded into precomputed neighbour indices instead of a modulo per tap.
 */
function tilingNormal(h: Float32Array, size: number, strength: number): Image {
  const img = createImage(size, size);
  const k = strength * size / 64;
  for (let y = 0; y < size; y++) {
    const up = ((y + size - 1) % size) * size, row = y * size, dn = ((y + 1) % size) * size;
    for (let x = 0; x < size; x++) {
      const l = (x + size - 1) % size, r = (x + 1) % size;
      const dx = (h[up + r] + 2 * h[row + r] + h[dn + r]) - (h[up + l] + 2 * h[row + l] + h[dn + l]);
      const dy = (h[dn + l] + 2 * h[dn + x] + h[dn + r]) - (h[up + l] + 2 * h[up + x] + h[up + r]);
      const nx = -dx * k, ny = dy * k, len = Math.sqrt(nx * nx + ny * ny + 1);
      const o = (row + x) * 4;
      img.data[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
      img.data[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
      img.data[o + 2] = Math.round((1 / len * 0.5 + 0.5) * 255);
      img.data[o + 3] = 255;
    }
  }
  return img;
}

function put(out: Float32Array, r: number, g: number, b: number, rough: number): void {
  out[0] = r; out[1] = g; out[2] = b; out[3] = rough;
}

function recipe(kind: SurfaceKind, s: number, noise: NoiseTables): Recipe {
  // Every noise is a sampler bound once here (core/texture/noise NoiseTables: fbm2 / worley2's values off
  // lattice tables), then read per texel. A Worley sampler hands back its own record, overwritten by its
  // next call, so ids are copied out before the same sampler is read again.
  const fbm = (seed: number, cx: number, cy: number, octaves = 4, gain = 0.5) => noise.fbm(seed, cx, cy, octaves, gain);
  const worley = (seed: number, cx: number, cy: number) => noise.worley(seed, cx, cy);
  switch (kind) {
    case 'grass': {
      // Tufts (Worley clumps) of fine blades, drier patches across the tile.
      const broadN = fbm(s + 1, 3, 3, 4), tuftN = worley(s + 2, 22, 22), bladesN = fbm(s + 3, 80, 80, 2, 0.6), streakN = fbm(s + 4, 96, 24, 2);
      return {
        normalStrength: 1.4, aoStrength: 0.55,
        relief(u, v, aux) {
          const broad = broadN(u, v);
          const tuft = tuftN(u, v);
          const clump = 1 - smoothstep(0.05, 0.75, tuft.f1);
          aux[0] = broad; aux[1] = cellRand(s, tuft.id);
          return 0.45 * clump + 0.35 * bladesN(u, v) + 0.12 * streakN(u, v) + 0.08 * broad;
        },
        surface(h, broad, tuft, out) {
          const t = Math.pow(h, 0.9);
          let r = mix(0.035, 0.16, t), g = mix(0.06, 0.22, t), b = mix(0.015, 0.05, t);
          const dry = clamp01(smoothstep(0.55, 0.8, broad) * 0.6 + (tuft - 0.5) * 0.15);
          const k = 0.6 + 0.6 * h;
          r = mix(r, 0.28 * k, dry); g = mix(g, 0.24 * k, dry); b = mix(b, 0.09 * k, dry);
          put(out, r, g, b, 0.88 + 0.06 * (1 - h));
        },
      };
    }
    case 'forest': {
      // Leaf litter in two overlapping layers, needles criss-crossing, dark soil showing between.
      const soilN = fbm(s + 1, 6, 6, 4), leafAN = worley(s + 2, 18, 18), leafBN = worley(s + 3, 26, 26);
      const needleAN = fbm(s + 4, 90, 6, 2), needleBN = fbm(s + 5, 6, 90, 2);
      return {
        normalStrength: 1.6, aoStrength: 0.65,
        relief(u, v, aux) {
          const la = leafAN(u, v);
          const idA = la.id;
          const leafA = (1 - smoothstep(0.1, 0.55, la.f1)) * (0.6 + 0.4 * cellRand(s, idA));
          const lb = leafBN(u + 0.37, v + 0.11);
          const idB = lb.id;
          const leafB = (1 - smoothstep(0.1, 0.5, lb.f1)) * (0.5 + 0.5 * cellRand(s + 9, idB)) * 0.9;
          const needles = Math.max(line(needleAN(u, v), 0.02), line(needleBN(u, v), 0.02));
          const top = Math.max(leafA, leafB);
          aux[0] = leafA >= leafB ? cellRand(s + 7, idA) : cellRand(s + 8, idB);
          aux[1] = Math.max(top, needles * 0.8);
          return 0.25 * soilN(u, v) + 0.55 * top + 0.2 * needles;
        },
        surface(h, tone, cover, out) {
          // Dark brown, through orange, to a pale dry leaf.
          let r: number, g: number, b: number;
          if (tone < 0.5) { const t = tone * 2; r = mix(0.09, 0.25, t); g = mix(0.05, 0.12, t); b = mix(0.02, 0.04, t); }
          else { const t = (tone - 0.5) * 2; r = mix(0.25, 0.2, t); g = mix(0.12, 0.16, t); b = mix(0.04, 0.08, t); }
          const k = 0.7 + 0.5 * h, c = smoothstep(0.15, 0.45, cover);
          put(out, mix(0.035, r * k, c), mix(0.024, g * k, c), mix(0.014, b * k, c), 0.9);
        },
      };
    }
    case 'dirt': {
      // Clods, a scatter of small stones, thin wandering dry cracks; damper where it lies low.
      const clodsN = fbm(s + 1, 8, 8, 5, 0.55), stoneN = worley(s + 2, 20, 20), crackN = fbm(s + 3, 5, 5, 4), moistN = fbm(s + 4, 3, 3, 3);
      return {
        normalStrength: 1.3, aoStrength: 0.6,
        relief(u, v, aux) {
          const w = stoneN(u, v);
          const stone = cellRand(s, w.id) > 0.8 ? 1 - smoothstep(0.08, 0.3, w.f1) : 0;
          aux[1] = stone > 0.05 ? 0.4 + 0.6 * cellRand(s + 5, w.id) : 0;
          aux[0] = moistN(u, v);
          return 0.65 * clodsN(u, v) + 0.25 * stone - 0.12 * line(crackN(u, v), 0.012);
        },
        surface(h, moisture, stone, out) {
          const t = clamp01(0.25 + 0.75 * h * (0.7 + 0.6 * moisture));
          let r = mix(0.06, 0.2, t), g = mix(0.04, 0.14, t), b = mix(0.025, 0.085, t);
          if (stone > 0) { const k = 0.7 + 0.5 * stone; r = mix(r, 0.17 * k, 0.75); g = mix(g, 0.15 * k, 0.75); b = mix(b, 0.13 * k, 0.75); }
          put(out, r, g, b, 0.92);
        },
      };
    }
    case 'mud': {
      // Broad wet undulation and ruts; standing water fills the hollows flat, dark and glossy.
      const broadN = fbm(s + 1, 4, 4, 4), rutsN = fbm(s + 2, 2, 10, 3), detailN = fbm(s + 3, 24, 24, 3);
      const level = 0.42;
      return {
        normalStrength: 1.0, aoStrength: 0.45,
        relief(u, v, aux) {
          const detail = detailN(u, v);
          const base = 0.65 * broadN(u, v) + 0.15 * rutsN(u, v) + 0.2 * detail;
          aux[0] = smoothstep(level, level - 0.04, base);
          aux[1] = detail;
          // The water's surface: flat, with a whisper of the bed under it so the normal map is not dead.
          return base < level ? level - 0.02 + (base - level) * 0.05 : base;
        },
        surface(h, puddle, detail, out) {
          const k = 0.75 + 0.5 * h;
          put(out, mix(0.07 * k, 0.03, puddle), mix(0.05 * k, 0.025, puddle), mix(0.033 * k, 0.02, puddle),
              mix(0.55 + 0.15 * (1 - detail), 0.06, puddle));
        },
      };
    }
    case 'sand': {
      // Wind ripples (an integer count across the tile, warped by periodic noise, so they still wrap),
      // gentle dunes under them, a fine grain on top.
      const warpN = fbm(s + 1, 3, 3, 3), ampN = fbm(s + 2, 4, 4, 3), grainN = fbm(s + 3, 128, 128, 2), duneN = fbm(s + 4, 2, 2, 3);
      return {
        normalStrength: 0.7, aoStrength: 0.3,
        relief(u, v, aux) {
          const f = frac(16 * v + u + (warpN(u, v) - 0.5) * 0.9);
          // Long windward rise, short steep lee face.
          const ripple = f < 0.72 ? smoothstep(0, 0.72, f) : 1 - smoothstep(0.72, 1, f);
          const grain = grainN(u, v), dunes = duneN(u, v);
          aux[0] = grain; aux[1] = dunes;
          return 0.5 * ripple * (0.6 + 0.4 * ampN(u, v)) + 0.3 * dunes + 0.2 * grain;
        },
        surface(h, grain, _dunes, out) {
          const t = clamp01(0.3 + 0.7 * h), k = 0.92 + 0.16 * grain;
          put(out, mix(0.42, 0.62, t) * k, mix(0.34, 0.53, t) * k, mix(0.22, 0.38, t) * k, 0.92);
        },
      };
    }
    case 'gravel': {
      // Two sizes of angular stones packed together, each its own tone; dark gaps between.
      const bigN = worley(s + 1, 44, 44), smallN = worley(s + 2, 90, 90), baseN = fbm(s + 3, 8, 8, 3);
      return {
        normalStrength: 1.8, aoStrength: 0.7,
        relief(u, v, aux) {
          const w1 = bigN(u, v);
          const stone1 = smoothstep(0, 0.22, w1.f2 - w1.f1) * (0.55 + 0.45 * cellRand(s, w1.id)) * (1 - 0.6 * w1.f1);
          const w2 = smallN(u + 0.5, v + 0.5);
          const stone2 = smoothstep(0, 0.2, w2.f2 - w2.f1) * (0.4 + 0.4 * cellRand(s + 1, w2.id)) * 0.6;
          aux[0] = stone1 >= stone2 ? cellRand(s + 5, w1.id) : cellRand(s + 6, w2.id);
          aux[1] = Math.max(stone1, stone2);
          return 0.9 * aux[1] + 0.1 * baseN(u, v);
        },
        surface(h, tone, stone, out) {
          const grey = 0.14 + 0.24 * tone, warm = frac(tone * 13.7) - 0.5;
          const k = (0.45 + 0.55 * smoothstep(0, 0.3, stone)) * (0.85 + 0.3 * h);
          put(out, grey * (1 + 0.12 * warm) * k, grey * (1 + 0.04 * warm) * k, grey * (1 - 0.08 * warm) * k, 0.8);
        },
      };
    }
    case 'pebbles': {
      // Rounded river stones (domes inside Worley cells, gaps at their borders) on a sandy bed.
      const stoneN = worley(s + 1, 12, 12), sandN = fbm(s + 2, 48, 48, 3);
      const palette = [[0.3, 0.29, 0.27], [0.18, 0.17, 0.16], [0.36, 0.3, 0.22], [0.12, 0.11, 0.1], [0.42, 0.4, 0.36]];
      return {
        normalStrength: 1.6, aoStrength: 0.6,
        relief(u, v, aux) {
          const w = stoneN(u, v);
          // A round stone of its own radius around each feature point, pinched where two meet.
          const q = w.f1 / (0.45 + 0.2 * cellRand(s, w.id));
          const dome = Math.sqrt(Math.max(0, 1 - q * q));
          const pebble = dome * smoothstep(0.0, 0.1, w.f2 - w.f1) * (0.75 + 0.25 * cellRand(s + 3, w.id));
          const sand = 0.15 * sandN(u, v);
          aux[0] = cellRand(s + 4, w.id);
          aux[1] = pebble > sand ? smoothstep(0, 0.3, pebble) : 0;
          return Math.max(pebble, sand);
        },
        surface(h, tone, cover, out) {
          const p = palette[Math.min(palette.length - 1, Math.floor(tone * palette.length))];
          const k = 0.8 + 0.3 * h;
          put(out, mix(0.3, p[0] * k, cover), mix(0.26, p[1] * k, cover), mix(0.19, p[2] * k, cover), mix(0.85, 0.55, cover));
        },
      };
    }
    case 'rock': {
      // Broken, ridged relief over broad blocks whose joints wander (a strongly warped Worley), a fine
      // grain on top; tone drifts warm and cool in broad streaks rather than block by block.
      const warpUN = fbm(s + 1, 3, 3, 3), warpVN = fbm(s + 6, 3, 3, 3), blockN = worley(s + 2, 5, 5);
      const ridgeN = fbm(s + 3, 6, 6, 5, 0.55), fineN = fbm(s + 4, 40, 40, 3), toneN = fbm(s + 5, 2, 4, 3);
      return {
        normalStrength: 2.0, aoStrength: 0.7,
        relief(u, v, aux) {
          const wu = u + (warpUN(u, v) - 0.5) * 0.35, wv = v + (warpVN(u, v) - 0.5) * 0.35;
          const w = blockN(wu, wv);
          const joint = smoothstep(0, 0.09, w.f2 - w.f1);
          const block = cellRand(s, w.id);
          const ridged = 1 - Math.abs(2 * ridgeN(u, v) - 1);
          aux[0] = toneN(u, v); aux[1] = joint;
          return joint * (0.3 + 0.15 * block) + 0.45 * ridged * ridged + 0.12 * fineN(u, v);
        },
        surface(h, tone, joint, out) {
          const t = clamp01(0.15 + 0.85 * h), w = (tone - 0.5) * 0.25, k = 0.6 + 0.4 * joint;
          put(out, mix(0.12, 0.4, t) * (1 + w) * k, mix(0.115, 0.38, t) * k, mix(0.105, 0.35, t) * (1 - w) * k, 0.8 + 0.1 * (1 - joint));
        },
      };
    }
    case 'cliff': {
      // Horizontal strata: an integer number of bands down the tile, warped by periodic noise, each band
      // its own protrusion and tone, weathered into ledges and split by vertical joints.
      const N = 9;
      const warpN = fbm(s + 1, 2, 3, 3), jointWarpN = fbm(s + 2, 4, 8, 3), detailN = fbm(s + 3, 16, 32, 4);
      // Ochre, grey, red-brown and pale beds, chosen per band.
      const palette = [[0.34, 0.26, 0.17], [0.27, 0.26, 0.24], [0.3, 0.18, 0.12], [0.42, 0.39, 0.33]];
      return {
        normalStrength: 1.8, aoStrength: 0.7,
        relief(u, v, aux) {
          const t = v * N + (warpN(u, v) - 0.5) * 0.9;
          const ti = Math.floor(t);
          const band = ((ti % N) + N) % N;
          const f = t - ti;
          const prot = 0.35 + 0.65 * cellRand(s, band);
          const ledge = smoothstep(0, 0.12, f) * (1 - 0.55 * f);
          // Vertical joints, a whole number across the tile, staggered from one bed to the next.
          const jf = frac(7 * u + cellRand(s + 3, band) + (jointWarpN(u, v) - 0.5) * 0.25);
          const joint = 0.5 + 0.5 * smoothstep(0, 0.03, Math.min(jf, 1 - jf));
          aux[0] = cellRand(s + 7, band); aux[1] = f;
          return 0.55 * prot * ledge * (0.75 + 0.25 * joint) + 0.3 * detailN(u, v) + 0.06 * joint;
        },
        surface(h, tone, _f, out) {
          const x = tone * (palette.length - 1), i = Math.min(palette.length - 2, Math.floor(x)), t = x - i;
          const a = palette[i], b = palette[i + 1], k = 0.65 + 0.45 * h;
          put(out, mix(a[0], b[0], t) * k, mix(a[1], b[1], t) * k, mix(a[2], b[2], t) * k, 0.85);
        },
      };
    }
    case 'snow': {
      // Soft drifts and wind-carved sastrugi; no fine glitter in the normal, a faint blue in the hollows.
      const driftN = fbm(s + 1, 3, 3, 5, 0.5), sastrugiN = fbm(s + 2, 14, 4, 3), fineN = fbm(s + 3, 32, 32, 2);
      return {
        normalStrength: 0.6, aoStrength: 0.25,
        relief(u, v) {
          return 0.6 * driftN(u, v) + 0.3 * sastrugiN(u, v) + 0.1 * fineN(u, v);
        },
        surface(h, _a, _b, out) {
          const t = clamp01(0.25 + 0.75 * h);
          put(out, mix(0.7, 0.88, t), mix(0.74, 0.9, t), mix(0.82, 0.93, t), 0.62 + 0.1 * (1 - h));
        },
      };
    }
  }
}

/** The generated set for `kind` at `size` x `size` (256..1024; 512 is the preview's), from `seed`. */
export function generateSurface(kind: SurfaceKind, size: number, seed: number): SurfaceMaps {
  size = Math.max(4, Math.round(size));
  const r = recipe(kind, noiseSeed(seed, `surface:${kind}`), new NoiseTables());
  const n = size * size;
  const raw = new Float32Array(n), A = new Float32Array(n), B = new Float32Array(n);
  const aux = new Float32Array(2);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    aux[0] = 0; aux[1] = 0;
    raw[i] = r.relief((x + 0.5) / size, (y + 0.5) / size, aux);
    A[i] = aux[0]; B[i] = aux[1];
  }
  // The relief over the whole 0..1 range: what the stack's height blend reads.
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < n; i++) { const h = raw[i]; if (h < lo) lo = h; if (h > hi) hi = h; }
  const span = hi - lo;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) h[i] = span > 0 ? (raw[i] - lo) / span : 0.5;

  const albedo = createImage(size, size), roughness = createImage(size, size), height = createImage(size, size);
  const out = new Float32Array(4);
  for (let i = 0; i < n; i++) {
    r.surface(h[i], A[i], B[i], out);
    const o = i * 4;
    albedo.data[o] = srgbByte(out[0]); albedo.data[o + 1] = srgbByte(out[1]); albedo.data[o + 2] = srgbByte(out[2]); albedo.data[o + 3] = 255;
    const rough = Math.round(clamp01(out[3]) * 255), hv = Math.round(h[i] * 255);
    roughness.data[o] = roughness.data[o + 1] = roughness.data[o + 2] = rough;
    roughness.data[o + 3] = 255;
    height.data[o] = height.data[o + 1] = height.data[o + 2] = hv;
    height.data[o + 3] = 255;
  }
  const normal = tilingNormal(h, size, r.normalStrength);
  const orm = ormMap(size, { height: h, roughness }, { roughness: 1, metallic: 0, aoStrength: r.aoStrength });
  return { size, albedo, normal, orm, height };
}
