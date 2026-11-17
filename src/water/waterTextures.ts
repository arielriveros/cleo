import { fft2d, seededRandom } from '../core/math';

// The water surface's DETAIL texture: one tileable RGBA8 image, made once on the CPU, that the surface
// shader (shaders/wgsl/water.wgsl) samples at two scales, scrolled along the wind and the flow.
//
//   R, G  the slope of a small-wave height field (d/dx, d/dz, signed, 0.5 = flat). The height field is a
//         SPECTRUM turned into a surface by an inverse FFT, periodic by construction: a Phillips spectrum
//         (amplitude ~ e^(-1/(kL)^2) / k^4, short waves damped), as Tessendorf's "Simulating Ocean Water"
//         does for the full ocean, frozen here, but with every direction alike: these are the ripples of
//         running water, which no wind lines up (a wind-sea's, carried down a river, comb it into rows).
//         Random phases from a seeded PRNG, so every build makes the same image.
//   B     BOILS: noise with no direction and no grid in it, 0.5 = none. Made the same way, from a spectrum
//         that is a ring: wavelengths about a tenth of the tile and no others. What the live waves'
//         turbulence is renewed with (shaders/wgsl/waterWaveStep.wgsl): a boil has a size, and a lattice
//         noise prints its lattice on the water.
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
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const kx = (x < size / 2 ? x : x - size) * 2 * Math.PI / size;
        const kz = (y < size / 2 ? y : y - size) * 2 * Math.PI / size;
        const k = Math.hypot(kx, kz);
        if (k < 1e-6) continue;
        const p = Math.exp(-1 / ((k * L) * (k * L))) / (k * k * k * k) * Math.exp(-(k * damp) * (k * damp) * 0.02);
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

/**
 * Tileable noise with no direction: a surface whose spectrum is a ring, `centre` waves across the tile and
 * `width` either side of that, every direction alike, random phases. -1..1, its largest value 1.
 */
function ringNoise(size: number, seed: number, centre: number, width: number): Float32Array {
    const rand = seededRandom(seed);
    const gauss = () => {
        const u = Math.max(1e-9, rand()), v = rand();
        return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    };
    const re = new Float64Array(size * size), im = new Float64Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const kx = x < size / 2 ? x : x - size, kz = y < size / 2 ? y : y - size;
        const off = (Math.hypot(kx, kz) - centre) / width;
        const a = Math.exp(-off * off);
        re[y * size + x] = gauss() * a;
        im[y * size + x] = gauss() * a;
    }
    re[0] = 0; im[0] = 0;
    fft2d(re, im, size, true);
    let max = 0;
    for (let i = 0; i < re.length; i++) max = Math.max(max, Math.abs(re[i]));
    const out = new Float32Array(size * size);
    for (let i = 0; i < re.length; i++) out[i] = max > 0 ? re[i] / max : 0;
    return out;
}

/**
 * Tileable cell noise over `cells` x `cells` jittered points, as foam's web is made from it: 1 along the edge
 * between two cells, most where three meet, falling to 0 at each cell's own point. Two things added: how far
 * the nearest point is (round holes, wide junctions) and how nearly the two nearest are as far (a strand
 * along every edge, so the web joins up before its holes close).
 */
function foamWeb(size: number, cells: number, seed: number): Float32Array {
    const rand = seededRandom(seed);
    const pts = new Float32Array(cells * cells * 2);
    for (let i = 0; i < cells * cells; i++) { pts[i * 2] = rand(); pts[i * 2 + 1] = rand(); }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = x / size * cells, fy = y / size * cells;
        const cx = Math.floor(fx), cy = Math.floor(fy);
        let f1 = Infinity, f2 = Infinity;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            const gx = cx + i, gy = cy + j;
            const wx = ((gx % cells) + cells) % cells, wy = ((gy % cells) + cells) % cells;
            const dx = gx + pts[(wy * cells + wx) * 2] - fx, dy = gy + pts[(wy * cells + wx) * 2 + 1] - fy;
            const d = dx * dx + dy * dy;
            if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
        }
        const near = Math.sqrt(f1), gap = Math.sqrt(f2) - near;
        out[y * size + x] = 0.6 * Math.min(1, near / 0.8) + 0.4 * (1 - Math.min(1, gap / 0.45));
    }
    return out;
}

/** The detail texture's RGBA8 pixels (see the header), `WATER_DETAIL_SIZE` square, tileable. */
export function waterDetailPixels(seed = 7): Uint8Array {
    const n = WATER_DETAIL_SIZE;
    const h = phillipsHeight(n, seed);
    const boils = ringNoise(n, seed + 1, 10, 5);
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
        out[o + 2] = Math.round(Math.min(1, Math.max(0, 0.5 + boils[i] * 0.5)) * 255);
        out[o + 3] = Math.round((h[i] * 0.5 + 0.5) * 255);
    }
    return out;
}

// ---- foam -----------------------------------------------------------------------------------------------------
//
// The FOAM texture: one tileable RGBA8 image the surface shader turns an amount of foam into foam with. Foam
// on water is not a pattern laid over it but a population: rafts of bubbles of every size packed against each
// other where it is thick, strands and lace where it is thin and the current has drawn it out, single bubbles
// drifting off its edges as it dies. The four channels are the four things the shader needs to draw that from
// one number, the amount of foam at a point (water.wgsl foamCover):
//
//   R  BUBBLES: rafts of round bubbles in three sizes, each a film (bright at its rim, where it is seen edge
//      on, dimmer across its dome), the big ones lying over the small. What thick foam is textured with, and
//      what its edge breaks up into.
//   G  LACE: the order foam fills the water in. Foam is a web: strands along the edges between cells, holes
//      in the middle of them, and cells inside cells (three sizes of cell noise, bent by a slow noise so none
//      is regular). This is highest on the widest strands, lower on the finer ones inside them, lowest in the
//      middle of the smallest holes, and spread evenly over 0..1 (its values are ranked, so every level holds
//      the same share of the image). Foam is drawn where it is above one less the amount: a little foam is a
//      few broken strands, more is a web, more still is white with holes in it, then with pinholes, then white.
//   B  THICK AND THIN PLACES: a cloudy noise, ranked the same way. Where the amount is spent first.
//   A  GRAIN: a fine, even bubble field, for the surface of thick foam and the glitter of its edge.

/** Side of the foam texture, texels. */
export const WATER_FOAM_SIZE = 512;

/**
 * Cloudy noise over a `size` square that tiles: `octaves` of value noise, the first `base` cells across, each
 * twice as fine and half as strong as the last. 0..1.
 */
function cloudField(size: number, base: number, octaves: number, seed: number): Float32Array {
    const out = new Float32Array(size * size);
    const rand = seededRandom(seed);
    let amp = 0.5, norm = 0, cells = base;
    for (let o = 0; o < octaves; o++) {
        const lattice = new Float32Array(cells * cells);
        for (let i = 0; i < lattice.length; i++) lattice[i] = rand();
        for (let y = 0; y < size; y++) {
            const fy = (y + 0.5) / size * cells, iy = Math.floor(fy), ty = fy - iy, uy = ty * ty * (3 - 2 * ty);
            const r0 = (iy % cells) * cells, r1 = ((iy + 1) % cells) * cells;
            for (let x = 0; x < size; x++) {
                const fx = (x + 0.5) / size * cells, ix = Math.floor(fx), tx = fx - ix, ux = tx * tx * (3 - 2 * tx);
                const c0 = ix % cells, c1 = (ix + 1) % cells;
                const top = lattice[r0 + c0] + (lattice[r0 + c1] - lattice[r0 + c0]) * ux;
                const bottom = lattice[r1 + c0] + (lattice[r1 + c1] - lattice[r1 + c0]) * ux;
                out[y * size + x] += (top + (bottom - top) * uy) * amp;
            }
        }
        norm += amp; amp *= 0.5; cells *= 2;
    }
    for (let i = 0; i < out.length; i++) out[i] /= norm;
    return out;
}

/**
 * A raft of bubbles over a `size` square: one bubble to a cell of a `cells` x `cells` grid, set off-centre
 * and of its own radius, some cells left empty. Each is a film: brightest at its rim. Tiles.
 */
function bubbleRaft(size: number, cells: number, seed: number, filled: number): Float32Array {
    const rand = seededRandom(seed);
    const cx = new Float32Array(cells * cells), cy = new Float32Array(cells * cells), cr = new Float32Array(cells * cells);
    for (let i = 0; i < cells * cells; i++) {
        cx[i] = 0.3 + rand() * 0.4; cy[i] = 0.3 + rand() * 0.4;
        cr[i] = rand() < filled ? 0.3 + rand() * 0.24 : 0;
    }
    const out = new Float32Array(size * size);
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        const fx = (x + 0.5) / size * cells, fy = (y + 0.5) / size * cells;
        const gx = Math.floor(fx), gy = Math.floor(fy);
        let best = 0;
        for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
            const wx = (((gx + i) % cells) + cells) % cells, wy = (((gy + j) % cells) + cells) % cells;
            const k = wy * cells + wx, r = cr[k];
            if (r <= 0) continue;
            const dx = gx + i + cx[k] - fx, dy = gy + j + cy[k] - fy;
            const d2 = dx * dx + dy * dy;
            if (d2 >= r * r) continue;
            const t = Math.sqrt(d2) / r;
            // The film: its rim bright, its dome dim, a glint off its top.
            const rim = Math.min(1, Math.max(0, (t - 0.45) / 0.45));
            const edge = Math.min(1, (1 - t) / 0.12);
            const glint = Math.max(0, 1 - Math.sqrt((t - 0.35) * (t - 0.35) + 0.01) / 0.3);
            const v = edge * (0.45 + 0.55 * rim * rim) + 0.25 * glint * glint;
            if (v > best) best = v;
        }
        out[y * size + x] = Math.min(1, best);
    }
    return out;
}

/** The foam texture's RGBA8 pixels (see above), `WATER_FOAM_SIZE` square, tileable. */
export function waterFoamPixels(seed = 11): Uint8Array {
    const n = WATER_FOAM_SIZE;
    const out = new Uint8Array(n * n * 4);
    // Bubbles: big over middling over small.
    const big = bubbleRaft(n, 14, seed + 1, 0.7), mid = bubbleRaft(n, 31, seed + 2, 0.85), small = bubbleRaft(n, 67, seed + 3, 0.95);
    const grain = bubbleRaft(n, 120, seed + 4, 1);
    // Lace: cells at three sizes, read through a warp (slow and wide, with a quick narrow one on it) so
    // they are bent out of shape and their strands waver.
    const wide = foamWeb(n, 7, seed + 5), middling = foamWeb(n, 15, seed + 6), fine = foamWeb(n, 33, seed + 7);
    const warpU = cloudField(n, 3, 3, seed + 20), warpV = cloudField(n, 3, 3, seed + 21);
    const waverU = cloudField(n, 14, 2, seed + 24), waverV = cloudField(n, 14, 2, seed + 25);
    const breaks = cloudField(n, 7, 3, seed + 23);
    const clouds = cloudField(n, 4, 5, seed + 30), speckle = cloudField(n, 32, 2, seed + 31);
    const lace = new Float32Array(n * n), thick = new Float32Array(n * n);
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
        const i = y * n + x, o = i * 4;
        out[o] = Math.round(Math.max(big[i], mid[i] * 0.85, small[i] * 0.7) * 255);
        const px = (((x + Math.round(((warpU[i] - 0.5) * 0.09 + (waverU[i] - 0.5) * 0.022) * n)) % n) + n) % n;
        const py = (((y + Math.round(((warpV[i] - 0.5) * 0.09 + (waverV[i] - 0.5) * 0.022) * n)) % n) + n) % n;
        const w = py * n + px;
        // The wide cells' strands outrank the finer ones inside them; a strand is stronger in places and
        // weaker in others, so a little foam is broken strands and not a whole net; and its edge is its
        // bubbles' edges, not a line.
        const web = Math.max(wide[w], middling[w] * 0.93, fine[w] * 0.85);
        lace[i] = web + 0.34 * (breaks[i] - 0.5) + 0.1 * (Math.max(mid[i], small[i] * 0.8) - 0.5);
        // Thick and thin places: clouds, with the bubbles' own grain in them.
        thick[i] = clouds[i] + 0.08 * (Math.max(big[i], mid[i]) - 0.5) + 0.05 * (speckle[i] - 0.5);
        out[o + 3] = Math.round(grain[i] * 255);
    }
    ranked(lace, out, 1);
    ranked(thick, out, 2);
    return out;
}

/** Write `values` into channel `channel` of the RGBA8 `out`, RANKED: every level then holds the same share of the image. */
function ranked(values: Float32Array, out: Uint8Array, channel: number): void {
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < values.length; i++) { const v = values[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    const BINS = 4096, count = new Uint32Array(BINS + 1);
    const bin = (v: number) => Math.min(BINS - 1, Math.floor((v - lo) / (hi - lo || 1) * BINS));
    for (let i = 0; i < values.length; i++) count[bin(values[i]) + 1]++;
    for (let k = 0; k < BINS; k++) count[k + 1] += count[k];
    for (let i = 0; i < values.length; i++) {
        const k = bin(values[i]);
        out[i * 4 + channel] = Math.round((count[k] + count[k + 1]) * 0.5 / values.length * 255);
    }
}
