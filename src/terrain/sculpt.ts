// The landscape sculpt tools as pure functions over a height grid.
//
// Every tool here edits a REGION of a row-major height array in place and reports the grid rectangle it
// changed, so `Terrain` can refresh only those chunks and an undo step can record only those samples. None
// of them touch GL, physics or the scene graph, which is what lets each one be unit-tested on a 9x9 grid.
//
// Coordinates: the grid is `resolution` samples per side spanning `size` world units, centred on the
// terrain's origin — terrain-LOCAL space, the space `Terrain.heightAt` takes. Sample (c, r) sits at
// local (-size/2 + c * e, -size/2 + r * e) with `e = size / (resolution - 1)`.

import { brushFalloffWeight } from './brushFalloff';
import { valueNoise } from './terrainLayers';

/** Every tool the landscape brush offers in sculpt mode. */
export type SculptTool =
    | 'raise' | 'lower' | 'smooth' | 'flatten' | 'setHeight' | 'ramp' | 'noise' | 'terrace'
    | 'erode' | 'hydro' | 'stamp';

/**
 * How weight falls from the brush centre to its rim.
 *
 * `soft` is the curve the brush has always had (see brushFalloff.ts), where `falloff` is an EXPONENT
 * knob: 0 a hard disc, 1 fully feathered. The other four follow the Unreal/Unity convention, where
 * `falloff` is the FRACTION of the radius over which the weight drops — the inner `1 - falloff` of the
 * brush is at full strength.
 */
export type FalloffCurve = 'soft' | 'smooth' | 'linear' | 'sphere' | 'tip';

export type BrushShape = 'circle' | 'square';

/** A grayscale brush alpha ("stamp"), 0..1 per texel, row-major, row 0 at the stamp's -Z edge. */
export interface StampAlpha {
    data: Float32Array;
    width: number;
    height: number;
}

/** Where and how the brush lands. All distances in world units. */
export interface BrushSpec {
    /** Brush centre in terrain-local x/z. */
    x: number;
    z: number;
    radius: number;
    falloff: number;
    curve?: FalloffCurve;
    shape?: BrushShape;
    /** Rotation of a square or stamp brush about Y, in degrees. */
    rotation?: number;
    /** Shapes the brush when set: the stamp's alpha multiplies the falloff weight. */
    stamp?: StampAlpha | null;
}

/** The height grid a tool edits, in place. */
export interface HeightGrid {
    heights: Float32Array;
    resolution: number;
    size: number;
}

/** An inclusive rectangle of grid samples. */
export interface GridRegion {
    c0: number; r0: number; c1: number; r1: number;
}

export interface SculptParams {
    tool: SculptTool;
    /**
     * How much this application does. For the continuous tools it is a RATE already multiplied by the
     * frame time (world units per second x dt for raise/lower/noise; a 0..1 blend per application for
     * the ones that move toward a target). `ramp` applies it once, as the blend toward the ramp surface.
     */
    amount: number;
    /** flatten / setHeight: the height to move toward, terrain-local. */
    target?: number;
    /** flatten: only raise ground below the target, only lower ground above it, or both. */
    flattenMode?: 'both' | 'raise' | 'lower';
    /** ramp: the two ends, terrain-local x/z plus the height at each. The brush radius is the half-width. */
    rampFrom?: { x: number; z: number; h: number };
    rampTo?: { x: number; z: number; h: number };
    /** noise: feature size in world units, and a seed. */
    noiseScale?: number;
    noiseSeed?: number;
    /** terrace: step height in world units, and 0..1 how flat the treads are. */
    terraceStep?: number;
    terraceSharpness?: number;
    /** erode (thermal): the steepest slope, in degrees, material rests at before it slides. */
    talusDegrees?: number;
    /** erode / hydro: simulation passes per application. */
    iterations?: number;
    /** hydro: random source, injectable so a test is deterministic. */
    random?: () => number;
}

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** World spacing between samples. */
export function gridElement(g: HeightGrid): number {
    return g.size / (g.resolution - 1);
}

/**
 * Weight of a curve at normalised distance `t` (0 centre .. 1 rim). 0 at or beyond the rim.
 * See {@link FalloffCurve} for what `falloff` means for each.
 */
export function curveWeight(t: number, falloff: number, curve: FalloffCurve = 'soft'): number {
    if (t >= 1) return t === 1 && falloff <= 0 ? 1 : 0;
    if (curve === 'soft') return brushFalloffWeight(t, falloff);
    const f = clamp01(falloff);
    if (f <= 0) return 1;
    const inner = 1 - f;
    if (t <= inner) return 1;
    const u = (t - inner) / f;
    switch (curve) {
        case 'smooth': return 1 - u * u * (3 - 2 * u);
        case 'linear': return 1 - u;
        case 'sphere': return Math.sqrt(Math.max(0, 1 - u * u));
        case 'tip': { const v = 1 - u; return 1 - Math.sqrt(Math.max(0, 1 - v * v)); }
    }
    return 0;
}

/** Bilinear read of a stamp at normalised coordinates (0..1 each), clamped. */
function sampleStamp(s: StampAlpha, u: number, v: number): number {
    const x = clamp01(u) * (s.width - 1), y = clamp01(v) * (s.height - 1);
    const x0 = Math.floor(x), y0 = Math.floor(y);
    const x1 = Math.min(x0 + 1, s.width - 1), y1 = Math.min(y0 + 1, s.height - 1);
    const fx = x - x0, fy = y - y0;
    const a = s.data[y0 * s.width + x0] + (s.data[y0 * s.width + x1] - s.data[y0 * s.width + x0]) * fx;
    const b = s.data[y1 * s.width + x0] + (s.data[y1 * s.width + x1] - s.data[y1 * s.width + x0]) * fx;
    return a + (b - a) * fy;
}

/**
 * The brush's weight at an offset `(dx, dz)` from its centre, 0..1. Circle and square measure distance
 * differently (Euclidean vs the rotated Chebyshev); a stamp additionally multiplies its alpha, mapped
 * over the brush's rotated square footprint.
 */
export function brushWeight(dx: number, dz: number, b: BrushSpec): number {
    const r = Math.max(b.radius, 1e-6);
    const rot = ((b.rotation ?? 0) * Math.PI) / 180;
    const needsFrame = b.shape === 'square' || !!b.stamp;
    let lx = dx, lz = dz;
    if (needsFrame && rot !== 0) {
        const c = Math.cos(rot), s = Math.sin(rot);
        lx = dx * c + dz * s;
        lz = -dx * s + dz * c;
    }
    const t = b.shape === 'square' ? Math.max(Math.abs(lx), Math.abs(lz)) / r : Math.hypot(dx, dz) / r;
    if (t > 1) return 0;
    let w = curveWeight(t, b.falloff, b.curve ?? 'soft');
    if (b.stamp) {
        if (Math.abs(lx) > r || Math.abs(lz) > r) return 0;
        w *= sampleStamp(b.stamp, (lx / r + 1) / 2, (lz / r + 1) / 2);
    }
    return w;
}

/**
 * The grid rectangle a world-space box covers, clipped to the grid; null when it misses entirely.
 * `pad` adds whole samples on every side (a kernel's reach).
 */
export function regionFor(g: HeightGrid, minX: number, minZ: number, maxX: number, maxZ: number, pad = 0): GridRegion | null {
    const e = gridElement(g), half = g.size / 2, R = g.resolution;
    const c0 = Math.max(0, Math.floor((minX + half) / e) - pad);
    const c1 = Math.min(R - 1, Math.ceil((maxX + half) / e) + pad);
    const r0 = Math.max(0, Math.floor((minZ + half) / e) - pad);
    const r1 = Math.min(R - 1, Math.ceil((maxZ + half) / e) + pad);
    return c0 > c1 || r0 > r1 ? null : { c0, r0, c1, r1 };
}

/** The rectangle a brush can touch. */
export function brushRegion(g: HeightGrid, b: BrushSpec): GridRegion | null {
    // A rotated square reaches √2 x its radius on the diagonal; bound it by that rather than the radius.
    const reach = b.shape === 'square' || b.stamp ? b.radius * Math.SQRT2 : b.radius;
    return regionFor(g, b.x - reach, b.z - reach, b.x + reach, b.z + reach);
}

/** Copy a rectangle of the grid out, for a snapshot-based tool or an undo record. */
export function readRegion(g: HeightGrid, reg: GridRegion): Float32Array {
    const w = reg.c1 - reg.c0 + 1, h = reg.r1 - reg.r0 + 1, R = g.resolution;
    const out = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
        out.set(g.heights.subarray((reg.r0 + r) * R + reg.c0, (reg.r0 + r) * R + reg.c0 + w), r * w);
    return out;
}

/** Write a rectangle back — the inverse of {@link readRegion}. */
export function writeRegion(g: HeightGrid, reg: GridRegion, data: Float32Array): void {
    const w = reg.c1 - reg.c0 + 1, h = reg.r1 - reg.r0 + 1, R = g.resolution;
    for (let r = 0; r < h; r++)
        g.heights.set(data.subarray(r * w, r * w + w), (reg.r0 + r) * R + reg.c0);
}

/** The union of two regions (either may be null). */
export function unionRegion(a: GridRegion | null, b: GridRegion | null): GridRegion | null {
    if (!a) return b;
    if (!b) return a;
    return { c0: Math.min(a.c0, b.c0), r0: Math.min(a.r0, b.r0), c1: Math.max(a.c1, b.c1), r1: Math.max(a.r1, b.r1) };
}

/** Fractal value noise, zero-mean in roughly -1..1: four octaves of {@link valueNoise}. */
export function fbm(x: number, z: number, seed = 0): number {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    const ox = seed * 31.7, oz = seed * -17.3;
    for (let o = 0; o < 4; o++) {
        sum += amp * (valueNoise(x * freq + ox + o * 11.1, z * freq + oz - o * 7.7) * 2 - 1);
        norm += amp;
        amp *= 0.5;
        freq *= 2.03;
    }
    return sum / norm;
}

/** A terraced height: flat treads every `step`, with risers whose steepness `sharpness` (0..1) sets. */
export function terraceHeight(h: number, step: number, sharpness: number): number {
    if (step <= 1e-6) return h;
    const k = 1 + clamp01(sharpness) * 7;
    const n = Math.floor(h / step);
    const f = h / step - n;
    return (n + Math.pow(f, k)) * step;
}

/** Deterministic 0..1 PRNG (mulberry32), for tests and for a reproducible erosion pass. */
export function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Apply one sculpt tool. Mutates `g.heights` and returns the rectangle that actually changed, or null.
 */
export function applySculpt(g: HeightGrid, b: BrushSpec, p: SculptParams): GridRegion | null {
    switch (p.tool) {
        case 'raise':
        case 'lower':
        case 'stamp':
            return applyAdd(g, b, p.tool === 'lower' ? -p.amount : p.amount);
        case 'smooth': return applySmooth(g, b, p.amount);
        case 'flatten':
        case 'setHeight':
            return applyTowardTarget(g, b, p.amount, p.target ?? 0, p.tool === 'flatten' ? (p.flattenMode ?? 'both') : 'both');
        case 'ramp': return applyRamp(g, b, p);
        case 'noise': return applyNoise(g, b, p.amount, p.noiseScale ?? b.radius * 0.5, p.noiseSeed ?? 0);
        case 'terrace': return applyTerrace(g, b, p.amount, p.terraceStep ?? 2, p.terraceSharpness ?? 0.7);
        case 'erode': return applyThermal(g, b, p.amount, p.talusDegrees ?? 35, p.iterations ?? 4);
        case 'hydro': return applyHydraulic(g, b, p.amount, p.iterations ?? 1, p.random ?? Math.random);
    }
    return null;
}

/**
 * Run `fn(c, r, weight, index)` for every sample the brush touches with a non-zero weight, tracking the
 * rectangle whose heights `fn` actually changed (it returns the new height).
 */
function forEachBrushed(g: HeightGrid, b: BrushSpec, fn: (c: number, r: number, w: number, i: number, h: number) => number): GridRegion | null {
    const reg = brushRegion(g, b);
    if (!reg) return null;
    const e = gridElement(g), half = g.size / 2, R = g.resolution, H = g.heights;
    let changed: GridRegion | null = null;
    for (let r = reg.r0; r <= reg.r1; r++) {
        const dz = -half + r * e - b.z;
        for (let c = reg.c0; c <= reg.c1; c++) {
            const w = brushWeight(-half + c * e - b.x, dz, b);
            if (w <= 0) continue;
            const i = r * R + c;
            const h = H[i];
            const n = fn(c, r, w, i, h);
            if (n !== h && Number.isFinite(n)) {
                H[i] = n;
                if (!changed) changed = { c0: c, r0: r, c1: c, r1: r };
                else {
                    if (c < changed.c0) changed.c0 = c;
                    if (c > changed.c1) changed.c1 = c;
                    if (r < changed.r0) changed.r0 = r;
                    if (r > changed.r1) changed.r1 = r;
                }
            }
        }
    }
    return changed;
}

function applyAdd(g: HeightGrid, b: BrushSpec, amount: number): GridRegion | null {
    if (amount === 0) return null;
    return forEachBrushed(g, b, (_c, _r, w, _i, h) => h + amount * w);
}

function applyTowardTarget(g: HeightGrid, b: BrushSpec, amount: number, target: number,
                           mode: 'both' | 'raise' | 'lower'): GridRegion | null {
    const k = clamp01(Math.abs(amount));
    if (k === 0) return null;
    return forEachBrushed(g, b, (_c, _r, w, _i, h) => {
        if (mode === 'raise' && h >= target) return h;
        if (mode === 'lower' && h <= target) return h;
        return h + (target - h) * Math.min(1, k * w);
    });
}

/**
 * Smooth toward a box-filtered neighbourhood whose reach grows with the brush (in samples), from a
 * snapshot of the region so the result does not depend on scan order. Region-local: the whole-field copy
 * this replaces cost `resolution²` floats per mouse move.
 */
function applySmooth(g: HeightGrid, b: BrushSpec, amount: number): GridRegion | null {
    const k = clamp01(Math.abs(amount));
    const reg = brushRegion(g, b);
    if (!reg || k === 0) return null;
    const e = gridElement(g);
    const reach = Math.max(1, Math.min(4, Math.round((b.radius / e) * 0.12)));
    const R = g.resolution;
    const pad: GridRegion = {
        c0: Math.max(0, reg.c0 - reach), r0: Math.max(0, reg.r0 - reach),
        c1: Math.min(R - 1, reg.c1 + reach), r1: Math.min(R - 1, reg.r1 + reach),
    };
    const snap = readRegion(g, pad);
    const pw = pad.c1 - pad.c0 + 1;
    const at = (c: number, r: number) => {
        const cc = Math.min(Math.max(c, pad.c0), pad.c1), rr = Math.min(Math.max(r, pad.r0), pad.r1);
        return snap[(rr - pad.r0) * pw + (cc - pad.c0)];
    };
    return forEachBrushed(g, b, (c, r, w, _i, h) => {
        let sum = 0, n = 0;
        for (let j = -reach; j <= reach; j++)
            for (let i = -reach; i <= reach; i++) {
                if (c + i < 0 || c + i >= R || r + j < 0 || r + j >= R) continue;
                sum += at(c + i, r + j); n++;
            }
        const avg = sum / n;
        return h + (avg - h) * Math.min(1, k * w);
    });
}

function applyRamp(g: HeightGrid, b: BrushSpec, p: SculptParams): GridRegion | null {
    const A = p.rampFrom, B = p.rampTo;
    if (!A || !B) return null;
    const k = clamp01(Math.abs(p.amount || 1));
    const width = Math.max(b.radius, 1e-6);
    const reg = regionFor(g, Math.min(A.x, B.x) - width, Math.min(A.z, B.z) - width,
                          Math.max(A.x, B.x) + width, Math.max(A.z, B.z) + width);
    if (!reg) return null;
    const e = gridElement(g), half = g.size / 2, R = g.resolution, H = g.heights;
    const abx = B.x - A.x, abz = B.z - A.z;
    const len2 = abx * abx + abz * abz;
    let changed: GridRegion | null = null;
    for (let r = reg.r0; r <= reg.r1; r++) {
        const pz = -half + r * e;
        for (let c = reg.c0; c <= reg.c1; c++) {
            const px = -half + c * e;
            const t = len2 > 1e-12 ? clamp01(((px - A.x) * abx + (pz - A.z) * abz) / len2) : 0;
            const qx = A.x + abx * t, qz = A.z + abz * t;
            const d = Math.hypot(px - qx, pz - qz);
            if (d > width) continue;
            // Sideways falloff only: along its length a ramp is the whole point, so it runs full strength
            // from one end to the other.
            const w = curveWeight(d / width, b.falloff, b.curve ?? 'smooth');
            if (w <= 0) continue;
            const i = r * R + c;
            const target = A.h + (B.h - A.h) * t;
            const n = H[i] + (target - H[i]) * Math.min(1, k * w);
            if (n !== H[i]) {
                H[i] = n;
                changed = unionRegion(changed, { c0: c, r0: r, c1: c, r1: r });
            }
        }
    }
    return changed;
}

function applyNoise(g: HeightGrid, b: BrushSpec, amount: number, scale: number, seed: number): GridRegion | null {
    if (amount === 0) return null;
    const e = gridElement(g), half = g.size / 2;
    const s = 1 / Math.max(scale, 1e-3);
    // Local coordinates, so the pattern belongs to the terrain and does not crawl when the brush moves.
    return forEachBrushed(g, b, (c, r, w, _i, h) => h + fbm((-half + c * e) * s, (-half + r * e) * s, seed) * amount * w);
}

function applyTerrace(g: HeightGrid, b: BrushSpec, amount: number, step: number, sharpness: number): GridRegion | null {
    const k = clamp01(Math.abs(amount));
    if (k === 0 || step <= 1e-6) return null;
    return forEachBrushed(g, b, (_c, _r, w, _i, h) => h + (terraceHeight(h, step, sharpness) - h) * Math.min(1, k * w));
}

/**
 * Thermal erosion: wherever the drop to a neighbour exceeds the talus slope, material slides down it.
 * Mass-conserving inside the brush, scaled per sample by the brush weight, so the rim barely moves.
 */
function applyThermal(g: HeightGrid, b: BrushSpec, amount: number, talusDeg: number, iterations: number): GridRegion | null {
    const k = clamp01(Math.abs(amount));
    const reg = brushRegion(g, b);
    if (!reg || k === 0) return null;
    const e = gridElement(g), half = g.size / 2, R = g.resolution, H = g.heights;
    const maxDiff = Math.tan((Math.max(0, Math.min(89, talusDeg)) * Math.PI) / 180) * e;
    const w = reg.c1 - reg.c0 + 1, h = reg.r1 - reg.r0 + 1;
    const weight = new Float32Array(w * h);
    for (let r = 0; r < h; r++)
        for (let c = 0; c < w; c++)
            weight[r * w + c] = brushWeight(-half + (reg.c0 + c) * e - b.x, -half + (reg.r0 + r) * e - b.z, b);
    const before = readRegion(g, reg);
    const delta = new Float32Array(w * h);
    const N = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    for (let it = 0; it < Math.max(1, iterations); it++) {
        delta.fill(0);
        for (let r = 0; r < h; r++) {
            for (let c = 0; c < w; c++) {
                const wi = weight[r * w + c];
                if (wi <= 0) continue;
                const i = (reg.r0 + r) * R + reg.c0 + c;
                const hc = H[i];
                // Musgrave's rule: move HALF THE LARGEST excess, split across every downhill neighbour
                // past the talus in proportion to its own excess. Moving half the SUM instead overshoots
                // wherever several neighbours are downhill at once, and the grid oscillates to infinity
                // within a few passes.
                let total = 0, largest = 0;
                const excess = [0, 0, 0, 0];
                for (let n = 0; n < 4; n++) {
                    const cc = c + N[n][0], rr = r + N[n][1];
                    if (cc < 0 || cc >= w || rr < 0 || rr >= h) continue;
                    const d = hc - H[(reg.r0 + rr) * R + reg.c0 + cc] - maxDiff;
                    if (d > 0) { excess[n] = d; total += d; if (d > largest) largest = d; }
                }
                if (total <= 0) continue;
                const move = largest * 0.5 * k * wi;
                delta[r * w + c] -= move;
                for (let n = 0; n < 4; n++) {
                    if (excess[n] <= 0) continue;
                    delta[(r + N[n][1]) * w + (c + N[n][0])] += move * (excess[n] / total);
                }
            }
        }
        for (let r = 0; r < h; r++)
            for (let c = 0; c < w; c++)
                if (delta[r * w + c] !== 0) H[(reg.r0 + r) * R + reg.c0 + c] += delta[r * w + c];
    }
    return diffRegion(g, reg, before);
}

/**
 * Hydraulic erosion by droplets (Hans Theobald Beyer, 2015): each drop runs downhill picking up sediment
 * in proportion to its speed and slope and dropping it where it slows, carving gullies and filling
 * basins. Drops start inside the brush and die when they leave it, so the edit stays local.
 */
function applyHydraulic(g: HeightGrid, b: BrushSpec, amount: number, iterations: number, rand: () => number): GridRegion | null {
    const k = clamp01(Math.abs(amount));
    const reg = brushRegion(g, b);
    if (!reg || k === 0) return null;
    const e = gridElement(g), half = g.size / 2, R = g.resolution, H = g.heights;
    const before = readRegion(g, reg);
    const inRegion = (gx: number, gz: number) => gx >= reg.c0 && gx < reg.c1 && gz >= reg.r0 && gz < reg.r1;

    // Heights and gradient at a fractional grid position (bilinear).
    const sample = (gx: number, gz: number) => {
        const c = Math.floor(gx), r = Math.floor(gz);
        const u = gx - c, v = gz - r;
        const i = r * R + c;
        const h00 = H[i], h10 = H[i + 1], h01 = H[i + R], h11 = H[i + R + 1];
        return {
            h: h00 * (1 - u) * (1 - v) + h10 * u * (1 - v) + h01 * (1 - u) * v + h11 * u * v,
            gx: (h10 - h00) * (1 - v) + (h11 - h01) * v,
            gz: (h01 - h00) * (1 - u) + (h11 - h10) * u,
        };
    };
    const deposit = (gx: number, gz: number, amt: number) => {
        const c = Math.floor(gx), r = Math.floor(gz);
        const u = gx - c, v = gz - r;
        const i = r * R + c;
        H[i] += amt * (1 - u) * (1 - v);
        H[i + 1] += amt * u * (1 - v);
        H[i + R] += amt * (1 - u) * v;
        H[i + R + 1] += amt * u * v;
    };

    const areaSamples = Math.PI * (b.radius / e) ** 2;
    const drops = Math.max(1, Math.round(areaSamples * 0.35 * k * Math.max(1, iterations)));
    const INERTIA = 0.05, CAPACITY = 4, MIN_CAP = 0.01, ERODE = 0.3, DEPOSIT = 0.3, EVAP = 0.02, GRAVITY = 4;
    const LIFETIME = 30;
    for (let d = 0; d < drops; d++) {
        const a = rand() * Math.PI * 2, rr = Math.sqrt(rand()) * b.radius;
        let gx = (b.x + Math.cos(a) * rr + half) / e;
        let gz = (b.z + Math.sin(a) * rr + half) / e;
        if (!inRegion(gx, gz)) continue;
        let dx = 0, dz = 0, speed = 1, water = 1, sediment = 0;
        for (let life = 0; life < LIFETIME; life++) {
            const s = sample(gx, gz);
            dx = dx * INERTIA - s.gx * (1 - INERTIA);
            dz = dz * INERTIA - s.gz * (1 - INERTIA);
            const len = Math.hypot(dx, dz);
            if (len < 1e-9) break;
            dx /= len; dz /= len;
            const nx = gx + dx, nz = gz + dz;
            if (!inRegion(nx, nz)) break; // leaving the brush: what it carries is dropped below
            const deltaH = sample(nx, nz).h - s.h;
            // In height units: the slope term is a height difference, floored at MIN_CAP of a cell so a
            // drop on flat ground can still carry something.
            const cap = Math.max(-deltaH, MIN_CAP * e) * speed * water * CAPACITY;
            const wgt = brushWeight(gx * e - half - b.x, gz * e - half - b.z, b) * k;
            if (sediment > cap || deltaH > 0) {
                const amt = deltaH > 0 ? Math.min(deltaH, sediment) : (sediment - cap) * DEPOSIT;
                sediment -= amt;
                deposit(gx, gz, amt);
            } else {
                const amt = Math.min((cap - sediment) * ERODE * wgt, -deltaH);
                if (amt > 0) { deposit(gx, gz, -amt); sediment += amt; }
            }
            speed = Math.sqrt(Math.max(0, speed * speed + deltaH / e * -GRAVITY));
            water *= 1 - EVAP;
            gx = nx; gz = nz;
        }
        // Whatever the drop still carries lands where it stopped — out of the brush, out of lifetime or
        // on flat ground. Dropping it anywhere else, or nowhere, would not conserve the terrain's mass.
        if (sediment > 0) deposit(gx, gz, sediment);
    }
    return diffRegion(g, reg, before);
}

/** The tight rectangle, within `reg`, whose samples differ from `before`. */
function diffRegion(g: HeightGrid, reg: GridRegion, before: Float32Array): GridRegion | null {
    const w = reg.c1 - reg.c0 + 1, R = g.resolution;
    let out: GridRegion | null = null;
    for (let r = reg.r0; r <= reg.r1; r++)
        for (let c = reg.c0; c <= reg.c1; c++)
            if (g.heights[r * R + c] !== before[(r - reg.r0) * w + (c - reg.c0)])
                out = unionRegion(out, { c0: c, r0: r, c1: c, r1: r });
    return out;
}
