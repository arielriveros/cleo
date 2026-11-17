import type { BuoyancyVolume, WaterColumnSample } from './buoyancy';
import { PHYSICS_WAVE_CELL, waveCrest, waveReach, waveSurfaceAt, type WaterWave, type WaveSurface } from './water/waves';
import { waterColumnAt, type ResolvedWaterShape, type WaterColumn } from './water/waterColumn';
import { addSurf, surfOf, surfTravelTime, type SurfWave } from './water/surf';

// A water node as plain data, and the surface it waves. Shared by the scene's WaterVolumeNode and the
// physics worker (physics/worker/), which buoys bodies in a thread that has no scene: both build the
// BuoyancyVolume the solver reads from the same numbers with the same formula, so a crate floats the same
// on either side, and on the wave the renderer draws (water/waves.ts here is the twin of the shader's).

/** Everything buoyancy needs from one water node, cloneable across threads. */
export interface WaterSpec {
    /** The Water node's id, so overlapping water can tell which gives way to which. */
    id?: string;
    /**
     * What this spec is built from, beyond the per-step `waveScale`: equal keys, equal specs. The physics
     * worker is sent a spec once per key and keeps it.
     */
    key?: string;
    /** World-space box around the water: the cheap reject. `max[1]` is the highest resting surface. */
    min: [number, number, number];
    max: [number, number, number];
    density: number;
    /** Per second: how fast drag brings a body that displaces its own weight of water to the water's speed. */
    linearDrag: number;
    angularDrag: number;
    affectCharacters: boolean;
    /** The swell: metres, and cycles per second. 0 amplitude is no swell. */
    waveAmplitude: number;
    waveFrequency: number;
    /** The body in world space (water/waterShapes.ts). Empty: the box `min`..`max` itself. */
    shapes?: ResolvedWaterShape[];
    /** The waves on top of the swell (water/waves.ts), and the factor on their height (wind strength). */
    waves?: WaterWave[];
    waveScale?: number;
    /** How fast the waves run against their natural pace (their clock is multiplied by it). Default 1. */
    waveSpeed?: number;
    /** Metres from a shore over which waves fade out (0 = no fade). */
    shoreFade?: number;
    /** Whether flowing water drags bodies along with it (river currents). */
    currents?: boolean;
    /** A bake's settled water: where it is given it replaces the shapes' surface and flow. */
    flowGrid?: WaterFlowGrid;
    /** An endless ocean's shore: how far each point is from land, and the sea bed there. */
    shoreGrid?: WaterShoreGrid;
    /** The Water nodes (ids) this water gives way to where they overlap: a river's lake. */
    yieldsTo?: string[];
}

/**
 * The flow bake as physics reads it (water/bake/): `nx` x `nz` cells `cell` metres apart from
 * (originX, originZ), three floats each: resting surface (NaN = dry), flow x, flow z. Plain data, so it
 * crosses to the worker with the rest of the spec.
 */
export interface WaterFlowGrid {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    data: Float32Array;
}

/**
 * An endless ocean's shore grid (water/waterInfo.ts buildOceanShoreInfo, the one the surface is drawn
 * with): `nx` x `nz` cells from (originX, originZ), two floats each: metres to the shore (negative on land)
 * and the bed's height.
 */
export interface WaterShoreGrid {
    originX: number; originZ: number; cell: number; nx: number; nz: number;
    data: Float32Array;
}

/** Bilinear lookup of the grid at (x, z) into `col`; false where it is dry or outside. */
function sampleFlowGrid(g: WaterFlowGrid, x: number, z: number, col: WaterColumn): boolean {
    const fx = (x - g.originX) / g.cell, fz = (z - g.originZ) / g.cell;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return false;
    const x0 = Math.min(g.nx - 2, Math.floor(fx)), z0 = Math.min(g.nz - 2, Math.floor(fz));
    const tx = fx - x0, tz = fz - z0;
    let s = 0, u = 0, v = 0, w = 0;
    for (let k = 0; k < 4; k++) {
        const ix = x0 + (k & 1), iz = z0 + (k >> 1);
        const o = (iz * g.nx + ix) * 3;
        const surf = g.data[o];
        if (!Number.isFinite(surf)) continue;
        const wk = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? tz : 1 - tz);
        s += surf * wk; u += g.data[o + 1] * wk; v += g.data[o + 2] * wk; w += wk;
    }
    if (w < 0.5) return false;
    col.surface = s / w; col.flowX = u / w; col.flowZ = v / w;
    return true;
}

/** Bilinear lookup of the shore grid at (x, z): [metres to shore, bed]; false outside it. */
function sampleShoreGrid(g: WaterShoreGrid, x: number, z: number, out: number[]): boolean {
    const fx = (x - g.originX) / g.cell, fz = (z - g.originZ) / g.cell;
    if (fx < 0 || fz < 0 || fx > g.nx - 1 || fz > g.nz - 1) return false;
    const x0 = Math.min(g.nx - 2, Math.floor(fx)), z0 = Math.min(g.nz - 2, Math.floor(fz));
    const tx = fx - x0, tz = fz - z0;
    let e = 0, b = 0;
    for (let k = 0; k < 4; k++) {
        const o = ((z0 + (k >> 1)) * g.nx + x0 + (k & 1)) * 2;
        const wk = ((k & 1) ? tx : 1 - tx) * ((k >> 1) ? tz : 1 - tz);
        e += g.data[o] * wk; b += g.data[o + 1] * wk;
    }
    out[0] = e; out[1] = b;
    return true;
}

/** The swell's phase at a world x/z on the waves' clock `t`. */
const swellPhase = (spec: Pick<WaterSpec, 'waveFrequency'>, x: number, z: number, t: number) =>
    t * spec.waveFrequency * Math.PI * 2 + x * 0.37 + z * 0.29;

/** The surface height at a world x/z at `time` seconds over a resting level of `spec.max[1]`. */
export function waterSurfaceHeight(spec: Pick<WaterSpec, 'max' | 'waveAmplitude' | 'waveFrequency' | 'waveSpeed'>, x: number, z: number, time: number): number {
    const level = spec.max[1];
    if (!(spec.waveAmplitude > 0)) return level;
    return level + spec.waveAmplitude * Math.sin(swellPhase(spec, x, z, time * (spec.waveSpeed ?? 1)));
}

const _surface: WaveSurface = { height: 0, vx: 0, vy: 0, vz: 0, k: 0 };

/**
 * The waves over a column `edge` metres from its shore and `depth` deep: their height (into `out.height`),
 * the water's motion there and the wavenumber it fades with below. The renderer's vertex stage does the
 * same: shoaling over `shoreFade`, and a tall crest no taller than 0.4 of the depth.
 */
export function waveAt(spec: WaterSpec, x: number, z: number, time: number, edge: number, factor: number,
                       depth: number, out: WaveSurface): WaveSurface {
    const speed = spec.waveSpeed ?? 1;
    const t = time * speed;
    out.height = 0; out.vx = 0; out.vy = 0; out.vz = 0; out.k = 0;
    const waves = spec.waves;
    const heightScale = spec.waveScale ?? 1;
    if (waves && waves.length && heightScale > 0) {
        const fade = spec.shoreFade && spec.shoreFade > 0 ? Math.min(1, Math.max(0, edge / spec.shoreFade)) : 1;
        const crest = waveCrest(waves, heightScale);
        const cap = Number.isFinite(depth) ? Math.min(1, Math.max(0, 0.4 * depth / Math.max(crest, 1e-3))) : 1;
        const scale = heightScale * factor * fade * fade * (3 - 2 * fade) * cap;
        if (scale > 0) waveSurfaceAt(waves, x, z, t, scale, speed, PHYSICS_WAVE_CELL, out);
    }
    if (spec.waveAmplitude > 0) {
        const ph = swellPhase(spec, x, z, t);
        out.height += spec.waveAmplitude * Math.sin(ph);
        out.vy += spec.waveAmplitude * Math.cos(ph) * spec.waveFrequency * Math.PI * 2 * speed;
    }
    return out;
}

/** Height the waves add over a column `edge` metres from its shore (and `depth` deep). */
export function waveHeight(spec: WaterSpec, x: number, z: number, time: number, edge: number, factor = 1, depth = Infinity): number {
    return waveAt(spec, x, z, time, edge, factor, depth, _surface).height;
}

const _shore = [0, 0];
const _shoreAt = [0, 0];
const _surf: SurfWave = { omega: 0, amplitude: 0 };

/** The surf's travel time to the shore at (x, z) from the shore grid (water.wgsl oceanTravelTime); `fallback` outside it. */
function shoreTravelTime(g: WaterShoreGrid, level: number, x: number, z: number, fallback: number): number {
    if (!sampleShoreGrid(g, x, z, _shoreAt)) return fallback;
    return surfTravelTime(_shoreAt[0], level - _shoreAt[1]);
}

/**
 * The water at (x, z) at `time`: surface (waves included), its resting height, bed, flow, and the waves'
 * motion; null where there is none. Exactly what the buoyancy solver reads, and what scripts asking "is this
 * point under water" get.
 */
export function waterSpecColumn(spec: WaterSpec, x: number, z: number, time: number, out?: WaterColumn): WaterColumn | null {
    if (x < spec.min[0] || x > spec.max[0] || z < spec.min[2] || z > spec.max[2]) return null;
    const col = out ?? { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: Infinity, waveFactor: 1 };
    let ocean = false;
    if (spec.shapes && spec.shapes.length) {
        if (!waterColumnAt(spec.shapes, x, z, col)) return null;
        const r = spec.shapes[col.shape];
        ocean = !!r && r.type === 'ocean' && r.endless;
    } else {
        col.shape = -1; col.surface = spec.max[1]; col.floor = spec.min[1];
        col.flowX = 0; col.flowZ = 0; col.waveFactor = 1;
        col.edge = Math.min(x - spec.min[0], spec.max[0] - x, z - spec.min[2], spec.max[2] - z);
    }
    // A bake knows where the water really runs: its surface and currents over the shapes' own.
    if (spec.flowGrid && spec.shapes && spec.shapes.length) {
        const keepFloor = col.floor;
        if (!sampleFlowGrid(spec.flowGrid, x, z, col)) return null;
        col.floor = Math.min(keepFloor, col.surface);
    }
    // The ocean knows where the beach is: the waves shoal over it and the bed is the sea floor there.
    let depth = Infinity;
    if (ocean && spec.shoreGrid && sampleShoreGrid(spec.shoreGrid, x, z, _shore)) {
        // Inland there is no sea: the surface is not drawn there either (water.wgsl discards it two cells in
        // from the shore). Without this the sea would claim every point of the land, and a river that runs
        // into it would give way to it along its whole length.
        if (_shore[0] < -2 * spec.shoreGrid.cell) return null;
        col.edge = _shore[0];
        depth = Math.max(0, col.surface - _shore[1]);
    }
    col.rest = col.surface;
    const w = waveAt(spec, x, z, time, col.edge, col.waveFactor, depth, _surface);
    // Over the beach, the surf (water/surf.ts), as the renderer draws it: its slope from the travel time's
    // gradient, a grid cell either way.
    if (ocean && spec.shoreGrid && Number.isFinite(depth) && spec.waves && spec.waves.length) {
        const s = surfOf(spec.waves, spec.waveScale ?? 1, _surf);
        if (s.amplitude > 0 && depth < 8 * Math.max(2 * s.amplitude / 0.78, 0.05)) {
            const g = spec.shoreGrid, d = g.cell, level = col.surface;
            const t0 = surfTravelTime(col.edge, depth);
            const tx = (shoreTravelTime(g, level, x + d, z, t0) - shoreTravelTime(g, level, x - d, z, t0)) / (2 * d);
            const tz = (shoreTravelTime(g, level, x, z + d, t0) - shoreTravelTime(g, level, x, z - d, t0)) / (2 * d);
            const speed = spec.waveSpeed ?? 1;
            addSurf(s, x, z, time * speed, speed, col.edge, depth, tx, tz, w);
        }
    }
    col.surface += w.height;
    col.waveVX = w.vx; col.waveVY = w.vy; col.waveVZ = w.vz; col.waveK = w.k;
    if (!spec.currents) { col.flowX = 0; col.flowZ = 0; }
    return col;
}

/** What the solver buoys with, at physics time `time`. */
export function buoyancyVolumeFromSpec(spec: WaterSpec, time: number): BuoyancyVolume {
    const layered = !!(spec.shapes && spec.shapes.length) || !!(spec.waves && spec.waves.length);
    if (!layered) {
        // One box, a swell at most: the original (and cheapest) path.
        return {
            id: spec.id, yieldsTo: spec.yieldsTo,
            min: spec.min, max: spec.max, density: spec.density,
            linearDrag: spec.linearDrag, angularDrag: spec.angularDrag,
            affectCharacters: spec.affectCharacters,
            surfaceAt: spec.waveAmplitude > 0 ? (x, z) => waterSurfaceHeight(spec, x, z, time) : undefined,
        };
    }
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: Infinity, waveFactor: 1 };
    const sample: WaterColumnSample = { surface: 0, floor: 0, flowX: 0, flowZ: 0, rest: 0, waveVX: 0, waveVY: 0, waveVZ: 0, waveK: 0 };
    // Waves can lift the surface above the resting box: widen the reject by their reach.
    let reach = Math.max(0, spec.waveAmplitude);
    reach += waveReach(spec.waves ?? [], spec.waveScale ?? 1);
    // The surf over a beach stands taller still (water/surf.ts: at most 1.41 times its amplitude, in sets).
    if (spec.shoreGrid && spec.waves && spec.waves.length) reach += 1.5 * surfOf(spec.waves, spec.waveScale ?? 1, _surf).amplitude;
    return {
        id: spec.id, yieldsTo: spec.yieldsTo,
        min: spec.min, max: [spec.max[0], spec.max[1] + reach, spec.max[2]], density: spec.density,
        linearDrag: spec.linearDrag, angularDrag: spec.angularDrag,
        affectCharacters: spec.affectCharacters,
        columnAt: (x, z) => {
            if (!waterSpecColumn(spec, x, z, time, col)) return null;
            sample.surface = col.surface; sample.floor = col.floor; sample.flowX = col.flowX; sample.flowZ = col.flowZ;
            sample.rest = col.rest ?? col.surface;
            sample.waveVX = col.waveVX ?? 0; sample.waveVY = col.waveVY ?? 0; sample.waveVZ = col.waveVZ ?? 0; sample.waveK = col.waveK ?? 0;
            return sample;
        },
    };
}
