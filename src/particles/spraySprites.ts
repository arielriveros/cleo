// The engine's own sprites for flowing water's spray (water/spray/): sheets generated from code, as the rain's
// are (precipitationSprites.ts serves them by id and keeps their rules: white RGB, the shape in the alpha, a
// transparent border round every cell). Pure: bytes only.
//
//  - SPRAY: four drops, a few millimetres across, each a bright core with a soft rim, two of them broken into a
//    pair or a trio (what a splash throws is a cloud of drops, not one).
//  - MIST: four puffs of fine spray: a warped, wisped density with a rim that eases to nothing (no disc, no
//    threshold, so no outline to see however big and faint it is drawn).
//  - FOAM: four clusters of bubbles, the white churn where water tumbles: a ragged blob with bubbles packed
//    in it, densest in the middle.
//
// Each has LIGHTING MAPS derived from the same cell, for lit particles to take light with: a tangent-space NORMAL
// map for the drops, the foam and (gently) the mist, and for the mist a pair of SIX-WAY lightmaps (sixWaySprites.ts),
// baked from the puff's density: lit from its right, top and back in one, left, bottom and front in the other.

import { angularNoise, fbm2, heightToTangentNormal, smoothstep } from '../core/math';
import { sixWayFromDensity } from './sixWaySprites';

export const BUILTIN_SPRAY_SPRITE = '__builtin__/spray';
export const BUILTIN_MIST_SPRITE = '__builtin__/mist';
export const BUILTIN_FOAM_SPRITE = '__builtin__/foam';
export const BUILTIN_SPRAY_NORMAL = '__builtin__/spray-normal';
export const BUILTIN_MIST_NORMAL = '__builtin__/mist-normal';
export const BUILTIN_FOAM_NORMAL = '__builtin__/foam-normal';
export const BUILTIN_MIST_SIXWAY_POS = '__builtin__/mist-sixway-pos';
export const BUILTIN_MIST_SIXWAY_NEG = '__builtin__/mist-sixway-neg';

/** What a built-in sheet holds: its alpha (a sprite), a normal map or a six-way map derived from another sheet's cells. */
export type BuiltinSpriteKind = 'alpha' | 'normal' | 'sixWayPos' | 'sixWayNeg';

/** A built-in sheet: `columns` x `rows` cells, and for a derived map what it is made from and how. */
export interface BuiltinSpriteLayout {
    width: number; height: number; columns: number; rows: number; frames: number;
    /** Absent: `alpha`. */
    kind?: BuiltinSpriteKind;
    /** A derived map: the alpha sheet whose cells it is made from. */
    of?: string;
    /** A normal map: how steep the relief is (1 reads as a sphere's edge reaching 45 degrees). */
    strength?: number;
    /** A six-way map: the density the alpha stands for is `-ln(1 - alpha) / densityK`. */
    densityK?: number;
    sigma?: number; column?: number; floor?: number;
}

/** The mist's alpha is `1 - exp(-K * density)`: the K its six-way maps undo to find the density. */
const MIST_ALPHA_K = 1.8;

/** The layout of each spray sheet (2 x 2 cells, four variants), and of each map derived from one. */
export const SPRAY_SPRITE_LAYOUT: Readonly<Record<string, BuiltinSpriteLayout>> = {
    [BUILTIN_SPRAY_SPRITE]: { width: 128, height: 128, columns: 2, rows: 2, frames: 4 },
    [BUILTIN_MIST_SPRITE]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4 },
    [BUILTIN_FOAM_SPRITE]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4 },
    [BUILTIN_SPRAY_NORMAL]: { width: 128, height: 128, columns: 2, rows: 2, frames: 4, kind: 'normal', of: BUILTIN_SPRAY_SPRITE, strength: 1.5 },
    [BUILTIN_MIST_NORMAL]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4, kind: 'normal', of: BUILTIN_MIST_SPRITE, strength: 0.6 },
    [BUILTIN_FOAM_NORMAL]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4, kind: 'normal', of: BUILTIN_FOAM_SPRITE, strength: 3 },
    [BUILTIN_MIST_SIXWAY_POS]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4, kind: 'sixWayPos', of: BUILTIN_MIST_SPRITE,
                                 densityK: MIST_ALPHA_K, sigma: 2.2, column: 1.6, floor: 0.45 },
    [BUILTIN_MIST_SIXWAY_NEG]: { width: 256, height: 256, columns: 2, rows: 2, frames: 4, kind: 'sixWayNeg', of: BUILTIN_MIST_SPRITE,
                                 densityK: MIST_ALPHA_K, sigma: 2.2, column: 1.6, floor: 0.45 },
};

/**
 * Fills one cell's alpha (`out`, `w` x `h`) for a spray sheet `id`, variant `cell`, `border` pixels clear;
 * false for any other id.
 */
export function sprayCell(id: string, out: Float32Array, w: number, h: number, cell: number, rng: () => number, border: number): boolean {
    if (id === BUILTIN_SPRAY_SPRITE) { sprayDrops(out, w, h, cell, rng, border); return true; }
    if (id === BUILTIN_MIST_SPRITE) { mistPuff(out, w, h, cell, rng, border); return true; }
    if (id === BUILTIN_FOAM_SPRITE) { foamCluster(out, w, h, cell, rng, border); return true; }
    return false;
}

/**
 * One cell of a DERIVED sheet (a normal or six-way map) from its base cell's alpha (`alpha`, `w` x `h`, 0..1,
 * the border already clear), as RGBA8. Outside the shape a normal map is flat (128, 128, 255) and a six-way map
 * has no coverage.
 */
export function deriveCell(layout: BuiltinSpriteLayout, alpha: Float32Array, w: number, h: number): Uint8ClampedArray {
    if (layout.kind === 'sixWayPos' || layout.kind === 'sixWayNeg') {
        const k = layout.densityK ?? 1.8;
        const density = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) density[i] = -Math.log(1 - Math.min(alpha[i], 0.995)) / k;
        const maps = sixWayFromDensity(density, alpha, w, h, { sigma: layout.sigma ?? 2.2, column: layout.column ?? 1.6, floor: layout.floor ?? 0.45 });
        return layout.kind === 'sixWayPos' ? maps.pos : maps.neg;
    }
    // A normal map: the height is the shape's own relief, the drops a dome, the foam its bubbles' rims (the alpha
    // softened a little), the mist its density.
    const base = layout.of ?? '';
    let height: Float32Array = alpha;
    if (base === BUILTIN_SPRAY_SPRITE) {
        // A drop is round, not a flat disc with a bevel: the alpha softened across its radius, then its square
        // root, which is the dome of a sphere.
        const r = Math.max(2, Math.round(w * 0.09));
        const soft = boxBlur(boxBlur(boxBlur(alpha, w, h, r), w, h, r), w, h, r);
        height = new Float32Array(w * h);
        for (let i = 0; i < w * h; i++) height[i] = alpha[i] > 0 ? Math.sqrt(Math.min(1, soft[i] * 1.6)) : 0;
    } else if (base === BUILTIN_FOAM_SPRITE) {
        height = blur3(blur3(alpha, w, h), w, h);
    }
    const out = new Uint8ClampedArray(w * h * 4);
    const n: [number, number, number] = [0, 0, 1];
    // One texel of height at the cell's half-width reads as `strength` of a unit slope.
    const scale = (layout.strength ?? 1) * 0.5 * w;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        heightToTangentNormal(height, w, h, x, y, scale, n);
        const o = (y * w + x) * 4;
        out[o] = Math.round((n[0] * 0.5 + 0.5) * 255);
        out[o + 1] = Math.round((n[1] * 0.5 + 0.5) * 255);
        out[o + 2] = Math.round((n[2] * 0.5 + 0.5) * 255);
        out[o + 3] = 255;
    }
    return out;
}

/** A separable box blur of radius `r` texels (a sliding window), clamped at the edges. */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
    const tmp = new Float32Array(w * h), out = new Float32Array(w * h);
    const n = 2 * r + 1;
    for (let y = 0; y < h; y++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[y * w + Math.min(w - 1, Math.max(0, k))];
        for (let x = 0; x < w; x++) {
            tmp[y * w + x] = sum / n;
            sum += src[y * w + Math.min(w - 1, x + r + 1)] - src[y * w + Math.max(0, x - r)];
        }
    }
    for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += tmp[Math.min(h - 1, Math.max(0, k)) * w + x];
        for (let y = 0; y < h; y++) {
            out[y * w + x] = sum / n;
            sum += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
        }
    }
    return out;
}

/** A 3 x 3 box blur, clamped at the edges. */
function blur3(src: Float32Array, w: number, h: number): Float32Array {
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let b = -1; b <= 1; b++) for (let a = -1; a <= 1; a++)
            s += src[Math.min(h - 1, Math.max(0, y + b)) * w + Math.min(w - 1, Math.max(0, x + a))];
        out[y * w + x] = s / 9;
    }
    return out;
}

function blob(out: Float32Array, w: number, h: number, x0: number, y0: number, r: number, softness: number, peak: number,
              rim: (a: number) => number = () => 1, rimAmount = 0): void {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - x0, dy = y + 0.5 - y0;
        const d = Math.hypot(dx, dy);
        const edge = r * (1 - rimAmount + rimAmount * rim(Math.atan2(dy, dx)));
        const a = (1 - smoothstep(edge * (1 - softness), edge, d)) * peak;
        if (a > out[y * w + x]) out[y * w + x] = a;
    }
}

/** A drop (variants 0, 1), a pair (2) or a trio (3): bright cores, soft rims. */
function sprayDrops(out: Float32Array, w: number, h: number, variant: number, rng: () => number, border: number): void {
    const reach = Math.min(w, h) / 2 - border - 1;
    const cx = w / 2, cy = h / 2;
    if (variant <= 1) {
        blob(out, w, h, cx, cy, reach * (0.75 + 0.15 * variant), 0.6, 1, angularNoise(rng, 6), 0.12);
        return;
    }
    const count = variant === 2 ? 2 : 3;
    for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2, along = reach * (0.25 + rng() * 0.25);
        const r = reach * (0.32 + rng() * 0.18);
        blob(out, w, h, cx + Math.cos(a) * along, cy + Math.sin(a) * along, Math.min(r, reach - along), 0.6, 0.8 + rng() * 0.2);
    }
}

/**
 * A puff of fine spray: a density that fades out to nothing by the cell's reach with no disc and no threshold in
 * it. A Gaussian envelope on a domain-warped, angularly-noised radius makes the body irregular; a wisped fractal
 * thins it into streamers; the alpha is the density's own extinction, `1 - exp(-K * D)`.
 */
function mistPuff(out: Float32Array, w: number, h: number, variant: number, rng: () => number, border: number): void {
    const reach = Math.min(w, h) / 2 - border - 1;
    const cx = w / 2, cy = h / 2;
    const seed = 3 + variant * 7 + rng() * 5;
    const rim = angularNoise(rng, 5);
    const K = MIST_ALPHA_K;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const u = (x + 0.5 - cx) / reach, v = (y + 0.5 - cy) / reach;
        const r0 = Math.hypot(u, v);
        if (r0 >= 1) continue;
        // The body: warped, so no two puffs are the same lump, and its outline never a circle.
        const wu = u + 0.22 * fbm2(1.7 * u, 1.7 * v, seed + 11);
        const wv = v + 0.22 * fbm2(1.7 * u, 1.7 * v, seed + 23);
        const rr = Math.hypot(wu, wv) / (0.78 + 0.22 * rim(Math.atan2(wv, wu)));
        const envelope = Math.exp(-3.2 * rr * rr) * (1 - smoothstep(0.75, 1, r0));
        // The streamers: finer structure inside the body, never a mask on it.
        const wisps = smoothstep(0.25, 0.85, 0.5 + 0.5 * fbm2(2.4 * wu, 2.4 * wv, seed));
        const density = envelope * (0.35 + 0.65 * wisps);
        out[y * w + x] = 1 - Math.exp(-K * density);
    }
}

/** A cluster of bubbles: a ragged blob, bubbles packed into it, densest in the middle. */
function foamCluster(out: Float32Array, w: number, h: number, variant: number, rng: () => number, border: number): void {
    const reach = Math.min(w, h) / 2 - border - 1;
    const cx = w / 2, cy = h / 2;
    const rim = angularNoise(rng, 9);
    // The body: a soft, ragged, half-dense web.
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
        const d = Math.hypot(dx, dy);
        const edge = reach * (0.62 + 0.3 * rim(Math.atan2(dy, dx)));
        if (d >= edge) continue;
        const n = 0.5 + 0.5 * fbm2(dx * 0.09, dy * 0.09, 11 + variant);
        out[y * w + x] = (1 - smoothstep(edge * 0.55, edge, d)) * (0.35 + 0.45 * n);
    }
    // Bubbles: rings brighter than the web, more of them toward the middle.
    const count = 26 + variant * 6;
    for (let i = 0; i < count; i++) {
        const a = rng() * Math.PI * 2, along = Math.sqrt(rng()) * reach * 0.7;
        const r = reach * (0.04 + rng() * 0.09) * (1 - 0.4 * along / reach);
        const x0 = cx + Math.cos(a) * along, y0 = cy + Math.sin(a) * along;
        for (let y = Math.max(0, Math.floor(y0 - r - 2)); y < Math.min(h, Math.ceil(y0 + r + 2)); y++)
            for (let x = Math.max(0, Math.floor(x0 - r - 2)); x < Math.min(w, Math.ceil(x0 + r + 2)); x++) {
                const d = Math.hypot(x + 0.5 - x0, y + 0.5 - y0);
                // A bubble's skin is its bright ring; its middle shows the water through it.
                const ring = Math.exp(-((d - r) * (d - r)) / (2 * 0.9 * 0.9)) + 0.35 * (1 - smoothstep(r * 0.6, r, d));
                const a2 = Math.min(1, ring) * 0.95;
                if (a2 > out[y * w + x]) out[y * w + x] = a2;
            }
    }
}
