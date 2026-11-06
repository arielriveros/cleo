// A tileable water normal map: a band-limited random spectrum (amplitude ~ 1/k^1.9, random phases)
// turned into a height field by an inverse FFT, which is periodic by construction, then into slopes.
// The JS twin of tools/valley/prepare.py `water_normal`, with a seeded PRNG instead of numpy's.
//
// Channel convention (what the water shader reads): R and G are the surface slope along the image's
// x and y (world x and z), stored as -dh scaled into 0..1 -- NOT the green-up convention of
// core/texture/image.ts `normalFromHeight`. B is the normal's up component.

import { seededRandom } from 'cleo/terrain/sculpt';

/** In-place radix-2 FFT of n complex values (re, im), inverse when `inverse`. n must be a power of two. */
function fft(re: Float64Array, im: Float64Array, inverse: boolean): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

/** The periodic height field (size² , -1..1). `size` must be a power of two. */
export function waterHeightField(size: number, seed: number): Float32Array {
  const rand = seededRandom(seed);
  const re = new Float64Array(size * size), im = new Float64Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    // Signed frequencies, as numpy's fftfreq * size.
    const kx = x < size / 2 ? x : x - size, ky = y < size / 2 ? y : y - size;
    const k = Math.hypot(0.75 * kx, ky);
    const phase = rand() * Math.PI * 2;
    if (k <= 2 || k >= 64) continue;
    const amp = 1 / Math.pow(Math.max(k, 1), 1.9);
    re[y * size + x] = amp * Math.cos(phase);
    im[y * size + x] = amp * Math.sin(phase);
  }
  const rowRe = new Float64Array(size), rowIm = new Float64Array(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) { rowRe[x] = re[y * size + x]; rowIm[x] = im[y * size + x]; }
    fft(rowRe, rowIm, true);
    for (let x = 0; x < size; x++) { re[y * size + x] = rowRe[x]; im[y * size + x] = rowIm[x]; }
  }
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) { rowRe[y] = re[y * size + x]; rowIm[y] = im[y * size + x]; }
    fft(rowRe, rowIm, true);
    for (let y = 0; y < size; y++) re[y * size + x] = rowRe[y];
  }
  let max = 0;
  for (let i = 0; i < re.length; i++) max = Math.max(max, Math.abs(re[i]));
  const out = new Float32Array(size * size);
  for (let i = 0; i < re.length; i++) out[i] = max > 0 ? re[i] / max : 0;
  return out;
}

/** RGBA8 normal map (see the channel convention above), tileable. */
export function waterNormalMap(size = 256, seed = 1337, strength = 10): Uint8Array {
  const h = waterHeightField(size, seed);
  const out = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (h[y * size + ((x + 1) % size)] - h[y * size + ((x - 1 + size) % size)]) * 0.5;
    const dy = (h[((y + 1) % size) * size + x] - h[((y - 1 + size) % size) * size + x]) * 0.5;
    const nx = -dx * strength, ny = -dy * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    const o = (y * size + x) * 4;
    out[o] = Math.round((nx / len * 0.5 + 0.5) * 255);
    out[o + 1] = Math.round((ny / len * 0.5 + 0.5) * 255);
    out[o + 2] = Math.round((nz / len * 0.5 + 0.5) * 255);
    out[o + 3] = 255;
  }
  return out;
}
