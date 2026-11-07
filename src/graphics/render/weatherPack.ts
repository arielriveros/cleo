import { mat4 } from 'gl-matrix';
import type { ReadonlyVec3 } from 'gl-matrix';
import type { WeatherNode } from '../../core/scene/nodes/weatherNode';
import { boxWeight } from '../../core/scene/nodes/boxVolume';

/**
 * The weather volumes a frame draws, packed for the shaders (chunks/weatherVolumes.wgsl), and the CPU
 * twins of what the shaders do with them. Pure: no GPU, no renderer, so all of it is unit-tested.
 *
 * COMPOSITING. Volumes apply in ASCENDING priority, each mixed over what is below it by its own weight
 * (`acc = mix(acc, volume, w)`): a dry box nested inside a snowy one carves out a dry pocket, and two
 * boxes of equal weather meet without a seam. Equal priorities: the nearer last, so it wins.
 */

/** Mirrors `MAX_WEATHER_VOLUMES` in chunks/weatherVolumes.wgsl. */
export const MAX_WEATHER_VOLUMES = 4;
/** Bounded volumes further than this (metres, to the box) from the camera are not drawn. */
export const WEATHER_REACH = 400;

/** One frame's volumes in shader layout. */
export interface WeatherPack {
    count: number;
    /** world -> unit cube per volume (identity for an unbounded one), 16 floats each. */
    inv: Float32Array;
    /** Per volume: feather fractions xyz, w = 1 when unbounded. */
    blend: Float32Array;
    /** Per volume: wetness, snow, puddles, shelter 0/1. */
    amount: Float32Array;
    /** Per volume: cos(snowSlope), snowBreakup, 0, 0. */
    shape: Float32Array;
    /** The volumes, in composite order (ascending priority). */
    volumes: WeatherNode[];
    /** Changes whenever anything above does: what the foliage shadow cache keys its droop on. */
    hash: number;
}

export function emptyWeatherPack(): WeatherPack {
    return {
        count: 0, inv: new Float32Array(16 * MAX_WEATHER_VOLUMES), blend: new Float32Array(4 * MAX_WEATHER_VOLUMES),
        amount: new Float32Array(4 * MAX_WEATHER_VOLUMES), shape: new Float32Array(4 * MAX_WEATHER_VOLUMES),
        volumes: [], hash: 0,
    };
}

/** Distance from `p` to a volume's world box (0 inside, and always 0 for an unbounded one). */
export function distanceToWeather(v: WeatherNode, p: ReadonlyVec3): number {
    if (!v.bounded) return 0;
    const b = v.getBoundingBox();
    let d2 = 0;
    for (let a = 0; a < 3; a++) {
        const e = p[a] < b.min[a] ? b.min[a] - p[a] : p[a] > b.max[a] ? p[a] - b.max[a] : 0;
        d2 += e * e;
    }
    return Math.sqrt(d2);
}

/**
 * The volumes a frame draws: active ones (enabled, visible, wet or snowy) within WEATHER_REACH of the
 * camera, the highest priority first and the nearest among equals, at most MAX_WEATHER_VOLUMES; returned
 * in COMPOSITE order (ascending priority, the nearer last among equals).
 */
export function gatherWeather(volumes: Iterable<WeatherNode>, camera: ReadonlyVec3, reach: number = WEATHER_REACH): WeatherNode[] {
    const found: { v: WeatherNode, d: number }[] = [];
    for (const v of volumes) {
        if (!v.active) continue;
        const d = distanceToWeather(v, camera);
        if (d > reach) continue;
        found.push({ v, d });
    }
    found.sort((a, b) => (b.v.priority - a.v.priority) || (a.d - b.d));
    const kept = found.slice(0, MAX_WEATHER_VOLUMES);
    kept.sort((a, b) => (a.v.priority - b.v.priority) || (b.d - a.d));
    return kept.map(f => f.v);
}

const IDENTITY = mat4.create();

/** Pack composite-ordered volumes (see gatherWeather) into `out`. */
export function packWeather(volumes: readonly WeatherNode[], out: WeatherPack = emptyWeatherPack()): WeatherPack {
    out.inv.fill(0); out.blend.fill(0); out.amount.fill(0); out.shape.fill(0);
    const n = Math.min(MAX_WEATHER_VOLUMES, volumes.length);
    let h = 2166136261 >>> 0;
    const mix = (x: number) => { h = Math.imul(h ^ Math.round(x * 4096), 16777619) >>> 0; };
    for (let i = 0; i < n; i++) {
        const v = volumes[i];
        const bounded = v.bounded;
        out.inv.set(bounded ? v.invVolumeMatrix : IDENTITY, i * 16);
        const f = bounded ? v.blendFractions : [0, 0, 0];
        out.blend.set([f[0], f[1], f[2], bounded ? 0 : 1], i * 4);
        out.amount.set([v.wetness, v.snow, v.puddles, v.shelter ? 1 : 0], i * 4);
        out.shape.set([Math.cos(v.snowSlope * Math.PI / 180), v.snowBreakup, 0, 0], i * 4);
        for (let k = 0; k < 16; k++) mix(out.inv[i * 16 + k]);
        for (let k = 0; k < 4; k++) { mix(out.blend[i * 4 + k]); mix(out.amount[i * 4 + k]); mix(out.shape[i * 4 + k]); }
    }
    mix(n);
    out.count = n;
    out.volumes = volumes.slice(0, n);
    out.hash = h;
    return out;
}

/** What the weather is at one point: mirrors `WeatherSample` / `weatherAt` in chunks/weatherVolumes.wgsl. */
export interface WeatherSample {
    wet: number;
    snow: number;
    puddles: number;
    /** 0..1: how much shelter applies here (the volumes' `shelter` flags, weighted). */
    shelter: number;
    slopeCos: number;
    breakup: number;
}

/** Feathered weight of packed volume `i` at `p`: mirrors `weatherBoxWeight`. */
export function packedWeatherWeight(pack: WeatherPack, i: number, p: ReadonlyVec3): number {
    if (pack.blend[i * 4 + 3] > 0.5) return 1;
    const inv = pack.inv.subarray(i * 16, i * 16 + 16) as unknown as mat4;
    return boxWeight(p, inv, [pack.blend[i * 4], pack.blend[i * 4 + 1], pack.blend[i * 4 + 2]]);
}

/** The CPU twin of `weatherAt`: the packed volumes composited at `p`. */
export function resolveWeatherAt(pack: WeatherPack, p: ReadonlyVec3): WeatherSample {
    const s: WeatherSample = { wet: 0, snow: 0, puddles: 0, shelter: 0, slopeCos: Math.SQRT1_2, breakup: 0.4 };
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    for (let i = 0; i < pack.count; i++) {
        const w = packedWeatherWeight(pack, i, p);
        if (w <= 0) continue;
        s.wet = lerp(s.wet, pack.amount[i * 4], w);
        s.snow = lerp(s.snow, pack.amount[i * 4 + 1], w);
        s.puddles = lerp(s.puddles, pack.amount[i * 4 + 2], w);
        s.shelter = lerp(s.shelter, pack.amount[i * 4 + 3], w);
        s.slopeCos = lerp(s.slopeCos, pack.shape[i * 4], w);
        s.breakup = lerp(s.breakup, pack.shape[i * 4 + 1], w);
    }
    return s;
}

/**
 * The volume whose snow material a landscape draws its snow with: the highest-priority active one with
 * snow, a snow material, and a box that reaches the landscape (an unbounded one always does). Chosen per
 * landscape rather than per camera, so walking about never re-bakes the landscape's surface arrays.
 */
export function snowForLandscape(volumes: Iterable<WeatherNode>, landscape: { min: ReadonlyVec3, max: ReadonlyVec3 }): WeatherNode | null {
    let best: WeatherNode | null = null;
    for (const v of volumes) {
        if (!v.active || !(v.snow > 0) || !v.snowMaterial) continue;
        if (v.bounded) {
            const b = v.getBoundingBox();
            let overlaps = true;
            for (let a = 0; a < 3; a++) if (b.max[a] < landscape.min[a] || b.min[a] > landscape.max[a]) overlaps = false;
            if (!overlaps) continue;
        }
        if (!best || v.priority > best.priority) best = v;
    }
    return best;
}

/** The square the shelter map covers this frame, and the vertical span its depth reaches. */
export interface ShelterFootprint {
    centre: [number, number];
    /** Side of the square, metres. */
    size: number;
    top: number;
    bottom: number;
}

/** Metres the shelter map covers round the camera. */
export const SHELTER_RANGE = 96;
/** Metres of open sky a surface must have over it, at least, to count as uncovered. */
export const SHELTER_CLEARANCE = 0.25;

/**
 * Where the shelter map goes: a SHELTER_RANGE square round the camera, re-centred only once the camera
 * has moved an eighth of it from the last centre (so a static scene redraws it rarely), snapped to whole
 * texels so the casters rasterise the same way frame after frame. Null when no volume that keeps
 * shelter reaches it. Vertically: from below the lowest such box to above the highest (or 200 m round
 * the camera for an unbounded one).
 */
export function shelterFootprint(volumes: readonly WeatherNode[], camera: ReadonlyVec3, resolution: number,
                                 previous: ShelterFootprint | null, range: number = SHELTER_RANGE): ShelterFootprint | null {
    const texel = range / Math.max(1, resolution);
    let centre: [number, number];
    if (previous && previous.size === range
        && Math.max(Math.abs(camera[0] - previous.centre[0]), Math.abs(camera[2] - previous.centre[1])) <= range / 8) {
        centre = previous.centre;
    } else {
        centre = [Math.round(camera[0] / texel) * texel, Math.round(camera[2] / texel) * texel];
    }
    const half = range / 2;
    let top = -Infinity, bottom = Infinity, any = false;
    for (const v of volumes) {
        if (!v.shelter || !v.active) continue;
        if (v.bounded) {
            const b = v.getBoundingBox();
            if (b.max[0] < centre[0] - half || b.min[0] > centre[0] + half || b.max[2] < centre[1] - half || b.min[2] > centre[1] + half) continue;
            top = Math.max(top, b.max[1]);
            bottom = Math.min(bottom, b.min[1]);
        } else {
            top = Math.max(top, camera[1] + 200);
            bottom = Math.min(bottom, camera[1] - 200);
        }
        any = true;
    }
    if (!any) return null;
    // A metre of headroom over the highest box, so a roof at its very top still rasterises.
    return { centre, size: range, top: top + 1, bottom: bottom - 1 };
}

/**
 * The shelter map's world -> clip matrix (the GL convention the shadow casters render through): an
 * orthographic box looking straight down over the footprint, near plane at its top.
 */
export function shelterMatrix(out: mat4, f: ShelterFootprint): mat4 {
    const view = mat4.lookAt(mat4.create(), [f.centre[0], f.top, f.centre[1]], [f.centre[0], f.top - 1, f.centre[1]], [0, 0, -1]);
    const half = f.size / 2;
    const proj = mat4.ortho(mat4.create(), -half, half, -half, half, 0, Math.max(0.01, f.top - f.bottom));
    return mat4.multiply(out, proj, view);
}

/** SHELTER_CLEARANCE in the shelter map's depth units (0..1 across top - bottom). */
export function shelterClearanceDepth(f: ShelterFootprint): number {
    return SHELTER_CLEARANCE / Math.max(0.01, f.top - f.bottom);
}

/** Hash of a footprint, for the shelter map's redraw cache. */
export function footprintKey(f: ShelterFootprint, resolution: number): string {
    return `${f.centre[0]},${f.centre[1]},${f.size},${f.top.toFixed(2)},${f.bottom.toFixed(2)},${resolution}`;
}

/** Whether a point is inside the footprint's square (the shader's out-of-map test returns "open sky"). */
export function inFootprint(f: ShelterFootprint, p: ReadonlyVec3): boolean {
    const half = f.size / 2;
    return Math.abs(p[0] - f.centre[0]) <= half && Math.abs(p[2] - f.centre[1]) <= half;
}

