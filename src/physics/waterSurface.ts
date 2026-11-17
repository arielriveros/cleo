import type { BuoyancyVolume, WaterColumnSample } from './buoyancy';
import { gerstnerHeightAt, type GerstnerWave } from './water/gerstner';
import { waterColumnAt, type ResolvedWaterShape, type WaterColumn } from './water/waterColumn';

// A water node as plain data, and the surface it waves. Shared by the scene's WaterVolumeNode and the
// physics worker (physics/worker/), which buoys bodies in a thread that has no scene: both build the
// BuoyancyVolume the solver reads from the same numbers with the same formula, so a crate floats the same
// on either side, and on the wave the renderer draws (the Gerstner sum is core/math's, twin of the shader's).

/** Everything buoyancy needs from one water node, cloneable across threads. */
export interface WaterSpec {
    /** World-space box around every shape: the cheap reject. `max[1]` is the highest resting surface. */
    min: [number, number, number];
    max: [number, number, number];
    density: number;
    linearDrag: number;
    angularDrag: number;
    affectCharacters: boolean;
    /** The swell: metres, and cycles per second. 0 amplitude is no swell. */
    waveAmplitude: number;
    waveFrequency: number;
    /** The node's shapes in world space (water/waterShapes.ts). Empty: the box `min`..`max` itself. */
    shapes?: ResolvedWaterShape[];
    /** The Gerstner waves on top of the swell, and the factor on their height (wind strength). */
    waves?: GerstnerWave[];
    waveScale?: number;
    /** How fast the waves run against their natural pace (time is multiplied by it). Default 1. */
    waveSpeed?: number;
    /** Metres from a shore over which waves fade out (0 = no fade). */
    shoreFade?: number;
    /** Whether flowing water drags bodies along with it (river currents). */
    currents?: boolean;
    /** A bake's settled water, coarse: where it is given it replaces the shapes' surface and flow. */
    flowGrid?: WaterFlowGrid;
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

/** The swell alone: a gentle bob at a world x/z at `time` seconds. */
function swell(spec: Pick<WaterSpec, 'waveAmplitude' | 'waveFrequency'>, x: number, z: number, time: number): number {
    if (!(spec.waveAmplitude > 0)) return 0;
    const phase = time * spec.waveFrequency * Math.PI * 2 + x * 0.37 + z * 0.29;
    return spec.waveAmplitude * Math.sin(phase);
}

/** The surface height at a world x/z at `time` seconds over a resting level of `spec.max[1]`. */
export function waterSurfaceHeight(spec: Pick<WaterSpec, 'max' | 'waveAmplitude' | 'waveFrequency'>, x: number, z: number, time: number): number {
    const level = spec.max[1];
    if (!(spec.waveAmplitude > 0)) return level;
    return level + swell(spec, x, z, time);
}

/** Height the waves add over a column `edge` metres from its shore. */
export function waveHeight(spec: WaterSpec, x: number, z: number, time: number, edge: number, factor = 1): number {
    let h = swell(spec, x, z, time);
    const waves = spec.waves;
    if (waves && waves.length && (spec.waveScale ?? 1) > 0) {
        const fade = spec.shoreFade && spec.shoreFade > 0 ? Math.min(1, Math.max(0, edge / spec.shoreFade)) : 1;
        const scale = (spec.waveScale ?? 1) * factor * fade * fade * (3 - 2 * fade);
        if (scale > 0) h += gerstnerHeightAt(waves, x, z, time * (spec.waveSpeed ?? 1), scale);
    }
    return h;
}

/**
 * The water at (x, z) at `time`: surface (waves included), bed and flow; null where there is none. Exactly
 * what the buoyancy solver reads, and what scripts asking "is this point under water" get.
 */
export function waterSpecColumn(spec: WaterSpec, x: number, z: number, time: number, out?: WaterColumn): WaterColumn | null {
    if (x < spec.min[0] || x > spec.max[0] || z < spec.min[2] || z > spec.max[2]) return null;
    const col = out ?? { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: Infinity, waveFactor: 1 };
    if (spec.shapes && spec.shapes.length) {
        if (!waterColumnAt(spec.shapes, x, z, col)) return null;
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
    col.surface += waveHeight(spec, x, z, time, col.edge, col.waveFactor);
    if (!spec.currents) { col.flowX = 0; col.flowZ = 0; }
    return col;
}

/** What the solver buoys with, at physics time `time`. */
export function buoyancyVolumeFromSpec(spec: WaterSpec, time: number): BuoyancyVolume {
    const layered = !!(spec.shapes && spec.shapes.length) || !!(spec.waves && spec.waves.length);
    if (!layered) {
        // One box, a swell at most: the original (and cheapest) path.
        return {
            min: spec.min, max: spec.max, density: spec.density,
            linearDrag: spec.linearDrag, angularDrag: spec.angularDrag,
            affectCharacters: spec.affectCharacters,
            surfaceAt: spec.waveAmplitude > 0 ? (x, z) => waterSurfaceHeight(spec, x, z, time) : undefined,
        };
    }
    const col: WaterColumn = { shape: -1, surface: 0, floor: 0, flowX: 0, flowZ: 0, edge: Infinity, waveFactor: 1 };
    const sample: WaterColumnSample = { surface: 0, floor: 0, flowX: 0, flowZ: 0 };
    // Waves can lift the surface above the resting box: widen the reject by their reach.
    let reach = Math.max(0, spec.waveAmplitude);
    for (const w of spec.waves ?? []) reach += w.amplitude * (spec.waveScale ?? 1);
    return {
        min: spec.min, max: [spec.max[0], spec.max[1] + reach, spec.max[2]], density: spec.density,
        linearDrag: spec.linearDrag, angularDrag: spec.angularDrag,
        affectCharacters: spec.affectCharacters,
        columnAt: (x, z) => {
            if (!waterSpecColumn(spec, x, z, time, col)) return null;
            sample.surface = col.surface; sample.floor = col.floor; sample.flowX = col.flowX; sample.flowZ = col.flowZ;
            return sample;
        },
    };
}
