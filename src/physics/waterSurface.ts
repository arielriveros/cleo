import type { BuoyancyVolume } from './buoyancy';

// A water volume as plain data, and the surface it waves. Shared by the scene's WaterVolumeNode and the
// physics worker (physics/worker/), which buoys bodies in a thread that has no scene: both build the
// BuoyancyVolume the solver reads from the same numbers with the same formula, so a crate floats the same
// on either side. A leaf: no engine imports.

/** Everything buoyancy needs from one water volume, cloneable across threads. */
export interface WaterSpec {
    /** World-space box: `max[1]` is the resting surface, `min[1]` the floor. */
    min: [number, number, number];
    max: [number, number, number];
    density: number;
    linearDrag: number;
    angularDrag: number;
    affectCharacters: boolean;
    /** The swell: metres, and cycles per second. 0 amplitude is a flat surface. */
    waveAmplitude: number;
    waveFrequency: number;
}

/** The surface height at a world x/z at `time` seconds: the resting level plus a gentle swell. */
export function waterSurfaceHeight(spec: Pick<WaterSpec, 'max' | 'waveAmplitude' | 'waveFrequency'>, x: number, z: number, time: number): number {
    const level = spec.max[1];
    if (!(spec.waveAmplitude > 0)) return level;
    const phase = time * spec.waveFrequency * Math.PI * 2 + x * 0.37 + z * 0.29;
    return level + spec.waveAmplitude * Math.sin(phase);
}

/** What the solver buoys with, at physics time `time`. */
export function buoyancyVolumeFromSpec(spec: WaterSpec, time: number): BuoyancyVolume {
    return {
        min: spec.min, max: spec.max, density: spec.density,
        linearDrag: spec.linearDrag, angularDrag: spec.angularDrag,
        affectCharacters: spec.affectCharacters,
        surfaceAt: spec.waveAmplitude > 0 ? (x, z) => waterSurfaceHeight(spec, x, z, time) : undefined,
    };
}
