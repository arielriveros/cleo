// The stage floor's weather, composited into its maps (the Creators' floor is plain PBR, which the engine's
// WeatherNode does not reach -- only foliage answers it). Pure and synchronous: floorWorker.ts runs it off
// the main thread. A set is albedo (sRGB), a tangent-space normal map, ARM (R occlusion, G roughness, B
// metallic) and a height map; any but albedo may be missing.
//
//   wet  : the albedo darkens by how porous the floor is (rough floors drink more), roughness falls toward
//          a film of water, and past half the slider puddles fill the height map's low spots -- dark, nearly
//          mirror-glossy, flat (after Lagarde's wet-surface model).
//   snow : coverage grows with the slider, the low spots and the noise patches first, everything at 1; it
//          blends toward a snow set (or a flat white) and covers the puddles.
//
// At wetness 0 and snow 0 the output is the input, untouched.

export interface FloorMaps {
  /** Pixels a side (square). */
  size: number;
  /** RGBA8, row 0 first. */
  diff: Uint8ClampedArray;
  nor?: Uint8ClampedArray;
  arm?: Uint8ClampedArray;
  disp?: Uint8ClampedArray;
}

export interface FloorWeather { wetness: number; snow: number; seed?: number }

export interface FloorOutput { size: number; diff: Uint8ClampedArray; nor: Uint8ClampedArray; arm: Uint8ClampedArray; disp: Uint8ClampedArray | null }

const SNOW_ALBEDO = [0.9, 0.9, 0.92] as const;
const SNOW_ROUGHNESS = 0.85;
const WATER_ROUGHNESS = 0.12;
const PUDDLE_ROUGHNESS = 0.03;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function hash(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 0x8da6b343) ^ Math.imul(y, 0xd8163841) ^ Math.imul(seed + 1, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0x5bd1e995) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

/** Value noise in 0..1 that repeats every `period` cells, so it tiles with the floor's maps. */
function tiledNoise(u: number, v: number, period: number, seed: number): number {
  const x = u * period, y = v * period;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = smooth(0, 1, x - x0), fy = smooth(0, 1, y - y0);
  const p = (i: number, j: number) => hash(((i % period) + period) % period, ((j % period) + period) % period, seed);
  return lerp(lerp(p(x0, y0), p(x0 + 1, y0), fx), lerp(p(x0, y0 + 1), p(x0 + 1, y0 + 1), fx), fy);
}

/** Pixel (x, y) of the unit square, sampled nearest from a map of any size. */
function texel(map: Uint8ClampedArray, size: number, u: number, v: number): number {
  const x = Math.min(size - 1, Math.floor(u * size)), y = Math.min(size - 1, Math.floor(v * size));
  return (x + size * y) * 4;
}

export function compositeFloor(base: FloorMaps, snow: FloorMaps | null, weather: FloorWeather): FloorOutput {
  const n = base.size;
  const count = n * n * 4;
  const diff = new Uint8ClampedArray(base.diff);
  const nor = new Uint8ClampedArray(count);
  const arm = new Uint8ClampedArray(count);
  const wet = clamp01(weather.wetness), sn = clamp01(weather.snow);
  const seed = weather.seed ?? 7;
  // The base maps as they are where nothing is missing or touched: flat normals, ao 1, rough 0.9, dry.
  for (let i = 0; i < n * n; i++) {
    const o = i * 4;
    if (base.nor) { nor[o] = base.nor[o]; nor[o + 1] = base.nor[o + 1]; nor[o + 2] = base.nor[o + 2]; } else { nor[o] = 128; nor[o + 1] = 128; nor[o + 2] = 255; }
    nor[o + 3] = 255;
    if (base.arm) { arm[o] = base.arm[o]; arm[o + 1] = base.arm[o + 1]; arm[o + 2] = base.arm[o + 2]; } else { arm[o] = 255; arm[o + 1] = 230; arm[o + 2] = 0; }
    arm[o + 3] = 255;
  }
  const dispOut = base.disp ? new Uint8ClampedArray(base.disp) : null;
  if (wet <= 0 && sn <= 0) return { size: n, diff, nor, arm, disp: dispOut };

  // Heights normalised to 0..1 (low spots collect water); a floor with no height map gets noise.
  let lo = 255, hi = 0;
  if (base.disp) for (let i = 0; i < n * n; i++) { const h = base.disp[i * 4]; if (h < lo) lo = h; if (h > hi) hi = h; }
  const hSpan = Math.max(1, hi - lo);
  const puddles = smooth(0.5, 1, wet);
  const wetAmount = smooth(0, 0.5, wet);

  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const i = x + n * y, o = i * 4;
    const u = (x + 0.5) / n, v = (y + 0.5) / n;
    const h = base.disp ? (base.disp[o] - lo) / hSpan : tiledNoise(u, v, 6, seed + 3);
    let r = diff[o] / 255, g = diff[o + 1] / 255, b = diff[o + 2] / 255;
    let ao = arm[o] / 255, rough = arm[o + 1] / 255, metal = arm[o + 2] / 255;
    let nx = nor[o] / 127.5 - 1, ny = nor[o + 1] / 127.5 - 1, nz = nor[o + 2] / 127.5 - 1;

    if (wet > 0) {
      const dark = 1 - 0.5 * wetAmount * (0.4 + 0.6 * rough);
      r *= dark; g *= dark; b *= dark;
      rough = lerp(rough, WATER_ROUGHNESS, wetAmount * 0.85);
      if (puddles > 0) {
        const m = 1 - smooth(puddles * 0.65 - 0.1, puddles * 0.65, h);
        if (m > 0) {
          const d = 1 - 0.35 * m;
          r *= d; g *= d; b *= d;
          rough = lerp(rough, PUDDLE_ROUGHNESS, m);
          nx = lerp(nx, 0, m); ny = lerp(ny, 0, m); nz = lerp(nz, 1, m);
        }
      }
    }

    if (sn > 0) {
      const score = (1 - h) * 0.5 + tiledNoise(u, v, 8, seed) * 0.35 + tiledNoise(u, v, 24, seed + 1) * 0.15;
      const t = 1.1 - sn * 1.25;
      const c = smooth(t - 0.1, t + 0.1, score);
      if (c > 0) {
        let sr = SNOW_ALBEDO[0], sg = SNOW_ALBEDO[1], sb = SNOW_ALBEDO[2], sRough = SNOW_ROUGHNESS;
        let snx = 0, sny = 0, snz = 1;
        if (snow) {
          const rep = Math.max(1, Math.round(n / snow.size));
          const s = texel(snow.diff, snow.size, (u * rep) % 1, (v * rep) % 1);
          sr = snow.diff[s] / 255; sg = snow.diff[s + 1] / 255; sb = snow.diff[s + 2] / 255;
          if (snow.arm) sRough = snow.arm[s + 1] / 255;
          if (snow.nor) { snx = snow.nor[s] / 127.5 - 1; sny = snow.nor[s + 1] / 127.5 - 1; snz = snow.nor[s + 2] / 127.5 - 1; }
        }
        r = lerp(r, sr, c); g = lerp(g, sg, c); b = lerp(b, sb, c);
        rough = lerp(rough, sRough, c); ao = lerp(ao, 1, c); metal = lerp(metal, 0, c);
        nx = lerp(nx, snx, c * 0.85); ny = lerp(ny, sny, c * 0.85); nz = lerp(nz, snz, c * 0.85);
      }
    }

    const len = Math.hypot(nx, ny, nz) || 1;
    diff[o] = r * 255; diff[o + 1] = g * 255; diff[o + 2] = b * 255;
    nor[o] = (nx / len * 0.5 + 0.5) * 255; nor[o + 1] = (ny / len * 0.5 + 0.5) * 255; nor[o + 2] = (nz / len * 0.5 + 0.5) * 255;
    arm[o] = ao * 255; arm[o + 1] = rough * 255; arm[o + 2] = metal * 255;
  }
  return { size: n, diff, nor, arm, disp: dispOut };
}
