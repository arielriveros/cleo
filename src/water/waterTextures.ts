import { fft2d, seededRandom } from '../core/math';

// The water surface's DETAIL texture: one tileable RGBA8 image, made once on the CPU, that the surface
// shader (shaders/wgsl/water.wgsl) samples at two scales, scrolled along the wind and the flow.
//
//   R, G  the slope of a small-wave height field (d/dx, d/dz, signed, 0.5 = flat). The height field is a
//         wind-sea SPECTRUM turned into a surface by an inverse FFT, periodic by construction: a Phillips
//         spectrum (amplitude ~ e^(-1/(kL)^2) / k^4, directional spreading cos^2 about the wind, short
//         waves damped), as Tessendorf's "Simulating Ocean Water" does for the full ocean, frozen here.
//         Random phases from a seeded PRNG, so every build makes the same image.
//   B     a FOAM pattern: the edges of a tileable Worley cell noise (F2 - F1), the web of bubbles foam
//         makes on water, sharpened; thresholded by how much foam a point carries.
//   A     the small-wave height itself, 0..1, for crest scattering and breakup.

/** Side of the detail texture, texels. */
export const WATER_DETAIL_SIZE = 256;

function phillipsHeight(size: number, seed: number): Float32Array {
    const rand = seededRandom(seed);
    const gauss = () => {
        // Box-Muller.
        const u = Math.max(1e-9, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const re = new Float64Array(size * size), im = new Float64Array(size * size);
    // In texture units: the largest wave about a quarter of the tile, the shortest about two texels.
    const L = size / 6, damp = 2.5;
    const wx = Math.SQRT1_2, wz = Math.SQRT1_2;   // the wind across the tile's diagonal
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const kx = (x < size / 2 ? x : x - size) * 2 * Math.PI / size;
        const kz = (y < size / 2 ? y : y - size) * 2 * Math.PI / size;
        const k = Math.hypot(kx, kz);
        if (k < 1e-6) continue;
        const align = (kx * wx + kz * wz) / k;
        // Waves running against the wind are weak, not absent: keeps the pattern from streaking.
        const spread = align * align * (align < 0 ? 0.35 : 1) + 0.08;
        const p = Math.exp(-1 / ((k * L) * (k * L))) / (k * k * k * k) * spread * Math.exp(-(k * damp) * (k * damp) * 0.02);
        const a = Math.sqrt(p) / Math.SQRT2;
        re[y * size + x] = gauss() * a;
        im[y * size + x] = gauss() * a;
    }
    fft2d(re, im, size, true);
    let max = 0;
    for (let i = 0; i < re.length; i++) max = Math.max(max, Math.abs(re[i]));
    const out = new Float32Array(size * size);
    for (let i = 0; i < re.length; i++) out[i] = max > 0 ? re[i] / max : 0;
    return out;
}

/** Tileable Worley F2 - F1 over `cells` x `cells` jittered points, 0..1 (0 on a cell edge). */
function worleyEdges(size: number, cells: number, seed: number): Float32Array {
    const rand = seededRandom(seed);
    const pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < cells * cells; i++) { pts[i * 2] = rand(); pts[i * 2 + 1] = rand(); }
    const out = new Float32Array(size * size);
    let max = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x / size * cells, fy = y / size * cells;
        const cx = Math.floor(fx), cy = Math.floor(fy);
        let f1 = Infinity, f2 = Infinity;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            const gx = cx + i, gy = cy + j;
            const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
            const px = gx + pts[(wy * cells + wx) * 2], py = gy + pts[(wy * cells + wx) * 2 + 1];
            const d = Math.hypot(px - fx, py - fy);
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        const e = f2 - f1;
        out[y * size + x] = e;
        max = Math.max(max, e);
    }
    for (let i = 0; i < out.length; i++) out[i] /= max || 1;
    return out;
}

/** The detail texture's RGBA8 pixels (see the header), `WATER_DETAIL_SIZE` square, tileable. */
export function waterDetailPixels(seed = 7): Uint8Array {
    const n = WATER_DETAIL_SIZE;
    const h = phillipsHeight(n, seed);
    const coarse = worleyEdges(n, 9, seed + 1), fine = worleyEdges(n, 23, seed + 2);
    const out = new Uint8Array(n * n * 4);
    // Slope gain: the steepest small wave about 35 degrees.
    let maxSlope = 0;
    const slopes = new Float32Array(n * n * 2);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const dx = (h[y * n + ((x + 1) % n)] - h[y * n + ((x - 1 + n) % n)]) * 0.5;
        const dz = (h[((y + 1) % n) * n + x] - h[((y - 1 + n) % n) * n + x]) * 0.5;
        slopes[(y * n + x) * 2] = dx; slopes[(y * n + x) * 2 + 1] = dz;
        maxSlope = Math.max(maxSlope, Math.abs(dx), Math.abs(dz));
    }
    const gain = 0.7 / (maxSlope || 1);
    for (let i = 0; i < n * n; i++) {
        const o = i * 4;
        out[o] = Math.round(Math.min(1, Math.max(0, 0.5 + slopes[i * 2] * gain * 0.5)) * 255);
        out[o + 1] = Math.round(Math.min(1, Math.max(0, 0.5 + slopes[i * 2 + 1] * gain * 0.5)) * 255);
        // Foam: bright bubble webs (edges are 0, so invert), coarse cells laced with fine ones.
        const web = Math.max(1 - Math.min(1, coarse[i] * 3.2), (1 - Math.min(1, fine[i] * 3.5)) * 0.7);
        out[o + 2] = Math.round(Math.pow(web, 1.6) * 255);
        out[o + 3] = Math.round((h[i] * 0.5 + 0.5) * 255);
    }
    return out;
}
