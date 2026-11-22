// Six-way lightmaps from a density, for the engine's own sprites (spraySprites.ts): the lighting data a lit
// particle with `shading: 'sixWay'` reads (chunks/particleDraw.wgsl; the layout is a tileset's, which the FX
// Creator bakes for smoke and lit sprites take):
//
//   positive map: R = the puff lit from its RIGHT, G from its TOP, B from BEHIND it (away from the camera),
//                 A = coverage;
//   negative map: R = lit from its LEFT, G from its BOTTOM, B from its FRONT, A = emission.
//
// Each response is how much of a light arriving from that side reaches a pixel of the puff: the light passes
// through the density between the pixel and that side, so a pixel on the right edge is fully lit from the right
// and shaded from the left, and a dense core is darker from every side than its rim. The in-plane sides are
// marched through the 2D density with running sums (O(pixels) a side); front and back use the density at the
// pixel as the thickness of a column through the puff. Multiple scattering (core/math.ts multiScatter) keeps a
// shaded side from going black, and a floor keeps a thin haze from ever reading dark: mist is bright.
//
// Pure: bytes in, bytes out; deterministic; no GPU.

import { multiScatter } from '../core/math';

export interface SixWayOptions {
    /** Optical depth of the puff's densest half-width: how much a thick part shades its far side. */
    sigma: number;
    /** Optical depth of a column through the puff, at density 1: how much the back and front differ. */
    column: number;
    /** The least light any side gives (a haze scatters sky light into its shadow). 0..1. */
    floor: number;
}

/** A cell's `pos` and `neg` lightmaps, RGBA8, `w` x `h`, row 0 the top. */
export interface SixWayCell {
    pos: Uint8ClampedArray;
    neg: Uint8ClampedArray;
}

const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255);

/**
 * The six lightmaps of a cell whose density is `D` (per pixel, about 0..1, `w` x `h`, row 0 the top) and whose
 * coverage is `alpha` (the same cell's alpha, 0..1).
 */
export function sixWayFromDensity(D: ArrayLike<number>, alpha: ArrayLike<number>, w: number, h: number, options: SixWayOptions): SixWayCell {
    const { sigma, column, floor } = options;
    const pos = new Uint8ClampedArray(w * h * 4), neg = new Uint8ClampedArray(w * h * 4);
    // Optical depth per unit of summed density: a half-width of density 1 gives `sigma`.
    const kx = sigma / (0.5 * w), ky = sigma / (0.5 * h);
    const lift = (tau: number, f: number) => f + (1 - f) * multiScatter(tau);
    const right = new Float32Array(w * h), left = new Float32Array(w * h), up = new Float32Array(w * h), down = new Float32Array(w * h);
    // The density between a pixel and each side: running sums along the rows and the columns.
    for (let y = 0; y < h; y++) {
        let run = 0;
        for (let x = 0; x < w; x++) { left[y * w + x] = run; run += D[y * w + x]; }
        run = 0;
        for (let x = w - 1; x >= 0; x--) { right[y * w + x] = run; run += D[y * w + x]; }
    }
    for (let x = 0; x < w; x++) {
        let run = 0;
        for (let y = 0; y < h; y++) { up[y * w + x] = run; run += D[y * w + x]; }
        run = 0;
        for (let y = h - 1; y >= 0; y--) { down[y * w + x] = run; run += D[y * w + x]; }
    }
    for (let i = 0; i < w * h; i++) {
        const tauCol = column * D[i];
        const o = i * 4;
        pos[o] = byte(lift(kx * right[i], floor));
        pos[o + 1] = byte(lift(ky * up[i], floor));
        // Light from behind passes through the whole puff; a haze glows lit from behind, so its floor is lower
        // than the sides' (the back-lit core is the darkest) but never black.
        pos[o + 2] = byte(lift(tauCol, 0.6 * floor));
        pos[o + 3] = byte(alpha[i]);
        neg[o] = byte(lift(kx * left[i], floor));
        neg[o + 1] = byte(lift(ky * down[i], floor));
        // Light from the front reaches the nearer half of the column only.
        neg[o + 2] = byte(lift(0.25 * tauCol, floor));
        neg[o + 3] = 0;
    }
    return { pos, neg };
}
