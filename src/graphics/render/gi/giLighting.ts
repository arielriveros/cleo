import { gridCage } from './giLayout';
import { GI_PROBE_ACTIVE } from './giClassify';

/**
 * The CPU twin of the GI Volumes' lighting: what a forward draw, a lit particle system or a lit sprite takes
 * from the volumes at ONE point (its bounds centre), the way the deferred pass takes them per pixel. Pure.
 *
 * The GPU keeps each probe's irradiance as an octahedral tile; the CPU keeps an AMBIENT CUBE per probe —
 * the irradiance arriving from +X, -X, +Y, -Y, +Z and -Z (E/pi, at the store scale divided out), read back
 * after each relight. A point blends the cubes of the eight probes round it (trilinear, inactive and
 * uncaptured probes left out and the rest renormalized, as the shader does), and the cube becomes the nine
 * radiance-form L2 coefficients the forward programs already evaluate (`u_probeSH`, chunks/shIrradiance.wgsl
 * `shEval`), so no forward shader changes.
 *
 * What the CPU twin does not have is the visibility test: it trusts the cage. A forward draw is lit at
 * one point anyway.
 *
 * Volumes claim as light probes do: the smallest first, each its feathered weight times its coverage of
 * what the ones before it left. What is left over goes to the light probes, then the sky and the ambient.
 */

/** Floats in one probe's ambient cube: six directions, rgb. */
export const GI_AMBIENT_CUBE_FLOATS = 18;
/** Floats in one radiance-form L2 SH set: 9 coefficients padded to vec4 (shProject.ts's SH_FLOATS). */
export const GI_SH_FLOATS = 36;
/** Below this share left, the volumes have claimed the point. */
const CLAIMED = 1e-3;
/** The valid trilinear weight at which a cage counts as fully covering a point (giResolve.wgsl's). */
export const GI_FULL_COVERAGE_WEIGHT = 0.25;

/** One volume as the CPU twin reads it. */
export interface GiVolumeCpu {
    /** Probes along each axis. */
    counts: ArrayLike<number>;
    /** World -> fractional grid coordinates (column-major mat4). */
    worldToGrid: ArrayLike<number>;
    /** Feathered containment weight of a world point (GIVolumeNode.weightAt). */
    weightAt(p: ArrayLike<number>): number;
    /** The volume's intensity. */
    intensity: number;
    /** Per probe, its state (giClassify.ts). */
    states: ArrayLike<number>;
    /** Per probe, its ambient cube: {@link GI_AMBIENT_CUBE_FLOATS} floats, E/pi. */
    ambient: ArrayLike<number>;
}

const _cageIndex = new Int32Array(8);
const _cageWeight = new Float32Array(8);
const _grid = [0, 0, 0];
const _cube = new Float32Array(GI_AMBIENT_CUBE_FLOATS);

/**
 * The ambient cube at a world point inside one volume, blended from its cage: written into `out`
 * (normalized over the valid probes). Returns the volume's coverage of the point, 0..1: the valid share of
 * the trilinear weight over {@link GI_FULL_COVERAGE_WEIGHT}, so a cage with no captured probe gives 0 and
 * the point falls through to whatever lights it otherwise.
 */
export function ambientCubeAt(volume: GiVolumeCpu, p: ArrayLike<number>, out: Float32Array): number {
    const m = volume.worldToGrid;
    _grid[0] = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    _grid[1] = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    _grid[2] = m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14];
    gridCage(_grid, volume.counts, _cageIndex, _cageWeight);
    out.fill(0);
    let valid = 0;
    for (let s = 0; s < 8; s++) {
        const w = _cageWeight[s];
        const probe = _cageIndex[s];
        if (w <= 0 || volume.states[probe] !== GI_PROBE_ACTIVE) continue;
        const base = probe * GI_AMBIENT_CUBE_FLOATS;
        for (let k = 0; k < GI_AMBIENT_CUBE_FLOATS; k++) out[k] += volume.ambient[base + k] * w;
        valid += w;
    }
    if (valid <= 0) return 0;
    const inv = 1 / valid;
    for (let k = 0; k < GI_AMBIENT_CUBE_FLOATS; k++) out[k] *= inv;
    return Math.min(1, valid / GI_FULL_COVERAGE_WEIGHT);
}

/** An ambient cube's irradiance (E/pi) at normal `n`: Valve's n_i^2 blend of the three facing sides. */
export function evalAmbientCube(cube: ArrayLike<number>, n: ArrayLike<number>, out: number[] | Float32Array): void {
    const xx = n[0] * n[0], yy = n[1] * n[1], zz = n[2] * n[2];
    const ox = n[0] >= 0 ? 0 : 3, oy = n[1] >= 0 ? 6 : 9, oz = n[2] >= 0 ? 12 : 15;
    for (let c = 0; c < 3; c++) out[c] = xx * cube[ox + c] + yy * cube[oy + c] + zz * cube[oz + c];
}

// The projection of the six ambient-cube lobes (n_x^2 on x > 0, and so on) onto the real L2 basis
// shProject.ts uses, in its coefficient order (L00, L1-1 (y), L10 (z), L11 (x), L2-2, L2-1, L20, L21, L22):
// analytic hemisphere integrals, e.g. the +X lobe gives integral x^2 = 2pi/3, x^3 = pi/2,
// x^2 (3z^2 - 1) = -4pi/15, x^2 (x^2 - y^2) = 4pi/15.
const Y0 = 0.282095, Y1 = 0.488603, Y20 = 0.315392, Y22 = 0.546274;
const P = Math.PI;
const BAND0 = Y0 * 2 * P / 3;
const BAND1 = Y1 * P / 2;
const SIDE20 = Y20 * -4 * P / 15, AXIS20 = Y20 * 8 * P / 15;
const X22 = Y22 * 4 * P / 15;

/**
 * Irradiance coefficients -> the radiance form `shEval` reads: band l divided by Ramamoorthi's A_l / pi
 * (1, 2/3, 1/4). The light probes project their RADIANCE cube straight into that form (sky.ts
 * `_projectProbe`); an ambient cube already holds irradiance, so it takes the division instead.
 */
const BAND_SCALE = [1, 1.5, 1.5, 1.5, 4, 4, 4, 4, 4];

/**
 * An ambient cube -> nine radiance-form L2 coefficients (rgb, 4 floats apart), `scale` times, ADDED into
 * `out`. Evaluated with `shEval` and divided by pi, they give back the cube's best L2 fit: a uniform cube
 * of value c comes back as c in every direction.
 */
export function addAmbientCubeSH(cube: ArrayLike<number>, scale: number, out: Float32Array): void {
    for (let c = 0; c < 3; c++) {
        const px = cube[c], nx = cube[3 + c], py = cube[6 + c], ny = cube[9 + c], pz = cube[12 + c], nz = cube[15 + c];
        const coeff = [
            BAND0 * (px + nx + py + ny + pz + nz),
            BAND1 * (py - ny),
            BAND1 * (pz - nz),
            BAND1 * (px - nx),
            0,
            0,
            SIDE20 * (px + nx + py + ny) + AXIS20 * (pz + nz),
            0,
            X22 * (px + nx - py - ny),
        ];
        for (let k = 0; k < 9; k++) out[k * 4 + c] += coeff[k] * BAND_SCALE[k] * scale;
    }
}

/**
 * CPU twin of chunks/shIrradiance.wgsl `shEval` (before its clamp): the irradiance E at a surface facing
 * `n`. Divide by pi for E/pi.
 */
export function giShEval(sh: ArrayLike<number>, n: ArrayLike<number>, channel: number): number {
    const c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
    const x = n[0], y = n[1], z = n[2];
    const L = (k: number) => sh[k * 4 + channel];
    return c4 * L(0)
        + 2 * c2 * (L(3) * x + L(1) * y + L(2) * z)
        + c3 * L(6) * (z * z) - c5 * L(6)
        + c1 * L(8) * (x * x - y * y)
        + 2 * c1 * (L(4) * (x * y) + L(7) * (x * z) + L(5) * (y * z));
}

/**
 * The volumes' light at one point as radiance-form SH: `outSH` receives the blend (x each volume's
 * intensity x `scale`), the return is the share the volumes took — 0 outside them all, 1 well inside a
 * captured one. `volumes` is in claim order ({@link orderGiVolumes}).
 */
export function giLightingAt(volumes: readonly GiVolumeCpu[], p: ArrayLike<number>, outSH: Float32Array,
                             scale: number = 1): number {
    outSH.fill(0);
    let remaining = 1;
    for (const volume of volumes) {
        const w = volume.weightAt(p);
        if (w <= 0) continue;
        const coverage = ambientCubeAt(volume, p, _cube);
        const claim = w * coverage * remaining;
        if (claim <= 0) continue;
        addAmbientCubeSH(_cube, claim * volume.intensity * scale, outSH);
        remaining -= claim;
        if (remaining <= CLAIMED) break;
    }
    return 1 - remaining;
}

/**
 * The volumes' light at one point as one flat colour — the mean irradiance (E/pi) over every direction,
 * which is the mean of the cube's six sides — for what is lit by a single ambient value (lit particles,
 * lit sprites). `out` receives the blend x intensity x `scale`; the return is the share the volumes took.
 */
export function giAmbientAt(volumes: readonly GiVolumeCpu[], p: ArrayLike<number>, out: number[] | Float32Array,
                            scale: number = 1): number {
    out[0] = 0; out[1] = 0; out[2] = 0;
    let remaining = 1;
    for (const volume of volumes) {
        const w = volume.weightAt(p);
        if (w <= 0) continue;
        const coverage = ambientCubeAt(volume, p, _cube);
        const claim = w * coverage * remaining;
        if (claim <= 0) continue;
        const k = claim * volume.intensity * scale / 6;
        for (let c = 0; c < 3; c++) {
            out[c] += (_cube[c] + _cube[3 + c] + _cube[6 + c] + _cube[9 + c] + _cube[12 + c] + _cube[15 + c]) * k;
        }
        remaining -= claim;
        if (remaining <= CLAIMED) break;
    }
    return 1 - remaining;
}

/** What {@link orderGiVolumes} needs of a volume. */
export interface GiOrderable {
    enabled: boolean;
    volumeSize: number;
    id: string;
    distanceToVolume(p: ArrayLike<number>): number;
    getBoundingBox(): { min: ArrayLike<number>; max: ArrayLike<number> };
}

/** Volumes per frame, the most the apply pass loops over. Must match MAX_GI_VOLUMES in the shaders. */
export const MAX_GI_VOLUMES = 16;

/**
 * The volumes that light the frame, in the order they claim a point: enabled, in view, the MOST SPECIFIC
 * (smallest) first, so a room's volume claims before the hamlet's round it wherever the camera is. Past
 * `max`, the volumes nearest the camera.
 */
export function orderGiVolumes<T extends GiOrderable>(volumes: Iterable<T>, cameraPos: ArrayLike<number>,
                                                    visible?: (min: ArrayLike<number>, max: ArrayLike<number>) => boolean,
                                                    max: number = MAX_GI_VOLUMES): T[] {
    let out: T[] = [];
    for (const v of volumes) {
        if (!v.enabled) continue;
        if (visible) {
            const box = v.getBoundingBox();
            if (!visible(box.min, box.max)) continue;
        }
        out.push(v);
    }
    if (out.length > max) {
        const distance = new Map(out.map(v => [v, v.distanceToVolume(cameraPos)]));
        out.sort((a, b) => distance.get(a)! - distance.get(b)!);
        out = out.slice(0, max);
    }
    return out.sort((a, b) => a.volumeSize !== b.volumeSize ? a.volumeSize - b.volumeSize : (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
