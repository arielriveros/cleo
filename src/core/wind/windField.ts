/**
 * The scene's wind as a VECTOR FIELD: air velocity in m/s at any point and time, the same function on the
 * CPU (here) and the GPU (shaders/wgsl/chunks/windField.wgsl). It follows Ghost of Tsushima (Rockenbeck,
 * "Blowing from the West", GDC 2021):
 *
 *   BASE. One authored vector (the WindNode's direction and strength). Its MAGNITUDE is modulated by 2D
 *   Perlin noise in world XZ, scrolled along the wind at the gust speed, so gusts visibly roll across a
 *   field. `gustiness` is how much of the air the gusts carry: 0 a steady stream, 1 nothing between them.
 *   VEER. A second, broader Perlin field turns the direction by up to `veer` either way, carried with the
 *   wind too. This is what makes the wind a field rather than one arrow: neighbouring meadows lean apart.
 *   SOURCES. GoT's "vorticles": local wind added on top, brute-force summed. Here they are the Force
 *   Fields flagged `affectsWind`: directional gusts, inflow/blasts, whirlwinds, eddies, and drag as a
 *   shelter. Their strength is air speed (m/s), or for drag the fraction of the wind it blocks.
 *
 * The two sides agree to float rounding: an integer hash (PCG), exact gradients, no sin-hash. Every
 * literal the WGSL shares is in WIND_FIELD_CONSTANTS, which a test finds in the chunk.
 *
 * One clock: the renderer advances `windFieldClock` with the foliage's own wind time, so a script, the
 * editor's field overlay and the particles all read the gust the plants are showing (a frame behind the
 * GPU at most).
 */
import type { WindNode } from "../scene/nodes/windNode";
import type { ForceFieldNode } from "../scene/nodes/forceFieldNode";
import { smoothstep, windPerlin, windPerlinGrad } from "../math";

/** Air speed (m/s) of strength 1 at the crest of a gust: what wind-enabled materials are authored for. */
export const WIND_REFERENCE_SPEED = 7;
/** Scales the gust noise around 0.5. 1 keeps the spread of the value noise it replaced. */
export const WIND_GUST_GAIN = 1;
/** Scales the veer noise before it is clamped to ±1 (of `veer`). */
export const WIND_VEER_GAIN = 2;
/** Scales the turbulence curl so its mean eddy speed is about the field's strength. */
export const WIND_CURL_GAIN = 1.2;
/** Wind sources that take effect at once; the rest are ignored everywhere, CPU and GPU alike. */
export const MAX_WIND_SOURCES = 8;
/** Floats per packed source: ForceFieldNode.packInto's four texels. */
export const WIND_SOURCE_FLOATS = 16;
export const WIND_DEFAULT_GUSTINESS = 0.8;
/** Degrees. */
export const WIND_DEFAULT_VEER = 20;

/** The literals windField.wgsl must carry verbatim (pinned by tests/windField.test.ts). */
export const WIND_FIELD_CONSTANTS = {
    WIND_REFERENCE_SPEED, WIND_GUST_GAIN, WIND_VEER_GAIN, WIND_CURL_GAIN,
    GUST_OCTAVE_WEIGHTS: [0.7, 0.3], GUST_OCTAVE_SCALE: 2.13, GUST_OCTAVE_OFFSET: [17, 3],
    VEER_SCALE: 3, VEER_OFFSET: [41.3, -7.9], CORE: 0.2, EDDY_DRIFT: [0.11, 0.07],
} as const;

const [GUST_W0, GUST_W1] = WIND_FIELD_CONSTANTS.GUST_OCTAVE_WEIGHTS;
const GUST_SCALE = WIND_FIELD_CONSTANTS.GUST_OCTAVE_SCALE;
const [GUST_OX, GUST_OY] = WIND_FIELD_CONSTANTS.GUST_OCTAVE_OFFSET;
const VEER_SCALE = WIND_FIELD_CONSTANTS.VEER_SCALE;
const [VEER_OX, VEER_OY] = WIND_FIELD_CONSTANTS.VEER_OFFSET;
const CORE = WIND_FIELD_CONSTANTS.CORE;
const [EDDY_DX, EDDY_DY] = WIND_FIELD_CONSTANTS.EDDY_DRIFT;

/**
 * The frame's wind time in seconds, advanced by the renderer with the foliage's (see renderer.ts), and
 * `gustTravel`: how far the gusts have rolled on that clock, in gust wavelengths (`advanceGustTravel`).
 */
export const windFieldClock = { time: 0, gustTravel: 0 };

/**
 * Roll the gusts on by `dt` seconds of `wind` (the scene's WindNode, or none for the defaults): `gustSpeed`
 * over the gust wavelength, integrated, so a gust speed or size that changes — a preset blending in, a
 * storm building — moves the gusts on from where they are instead of re-deriving their place from
 * `speed × time`, which would race them across the field while it changed. The direction is not
 * integrated: the gusts roll along the wind as it points now (wind presets never turn it).
 */
export function advanceGustTravel(clock: { gustTravel: number }, wind: WindNode | null, dt: number): void {
    if (!(dt > 0)) return;
    const speed = wind ? wind.gustSpeed : 4;
    const lambda = Math.max(wind ? wind.gustScale : 18, 0.5);
    clock.gustTravel += speed / lambda * dt;
}

// ---- Noise ------------------------------------------------------------------------------------------
//
// The field's noise (windPcg, windLatticeHash, windPerlin, windPerlinGrad) is pure math and lives in
// core/math.ts, operation for operation the WGSL's; re-exported here, where the tests and the barrel find it.

export { windLatticeHash, windPcg, windPerlin, windPerlinGrad } from "../math";

// ---- The field --------------------------------------------------------------------------------------

/**
 * The field's per-frame parameters, 8 floats: [dirX, dirZ, strength (0 = no base wind), gust wavelength (m),
 * time (s), gust speed (m/s), gustiness (0..1), veer (radians)]. The GPU gets the same eight as two vec4s.
 */
export type WindFieldParams = Float32Array | number[];

/** One sample: the air velocity, the gust (0..1) and the ungusted horizontal speed, both in m/s. */
export interface WindSample { velocity: [number, number, number]; gust: number; steady: number; }

export function createWindSample(): WindSample { return { velocity: [0, 0, 0], gust: 0, steady: 0 }; }

/** The gust at world (x, z), 0..1: two octaves of Perlin scrolled along the wind (GoT). */
export function windGustAt(x: number, z: number, params: WindFieldParams): number {
    const lambda = Math.max(params[3], 0.5);
    const scroll = params[5] * params[4] / lambda;
    const px = x / lambda - params[0] * scroll, py = z / lambda - params[1] * scroll;
    const n = windPerlin(px, py) * GUST_W0 + windPerlin(px * GUST_SCALE + GUST_OX, py * GUST_SCALE + GUST_OY) * GUST_W1;
    return Math.min(1, Math.max(0, 0.5 + WIND_GUST_GAIN * n));
}

/** The base direction at world (x, z), turned by the veer field. Written into `out` [x, z]. */
export function windVeerAt(x: number, z: number, params: WindFieldParams, out: number[] = [0, 0]): number[] {
    const dx = params[0], dz = params[1], veer = params[7];
    if (!(veer > 0)) { out[0] = dx; out[1] = dz; return out; }
    const lambda = VEER_SCALE * Math.max(params[3], 0.5);
    const scroll = params[5] * params[4] / lambda;
    const n = windPerlin(x / lambda - dx * scroll + VEER_OX, z / lambda - dz * scroll + VEER_OY);
    const a = veer * Math.min(1, Math.max(-1, WIND_VEER_GAIN * n));
    const c = Math.cos(a), s = Math.sin(a);
    out[0] = dx * c - dz * s; out[1] = dx * s + dz * c;
    return out;
}

const _dir = [0, 0], _curl = [0, 0, 0];

/**
 * The wind at world (x, y, z): `params` (see WindFieldParams), plus `count` sources packed in `sources` by
 * ForceFieldNode.packInto (records whose 16th float is below 0.5 are particle-only and skipped).
 * `windFieldAt` in windField.wgsl, line for line.
 */
export function sampleWindField(params: WindFieldParams, sources: ArrayLike<number>, count: number,
                                x: number, y: number, z: number, out: WindSample = createWindSample()): WindSample {
    const t = params[4], gustSpeed = params[5];
    const gust = windGustAt(x, z, params);
    const strength = params[2];
    const dir = strength > 0 ? windVeerAt(x, z, params, _dir) : (_dir[0] = params[0], _dir[1] = params[1], _dir);
    const steadyBase = strength * WIND_REFERENCE_SPEED;
    const g = Math.min(1, Math.max(0, params[6]));
    const env = 1 - g + g * gust;
    let vx = dir[0] * steadyBase * env, vy = 0, vz = dir[1] * steadyBase * env;
    let sx = dir[0] * steadyBase, sz = dir[1] * steadyBase;
    let shelter = 1;
    const n = Math.min(count, MAX_WIND_SOURCES);
    for (let i = 0; i < n; i++) {
        const o = i * WIND_SOURCE_FLOATS;
        if (sources[o + 15] < 0.5) continue;
        const kind = Math.round(sources[o + 3]);
        const shape = Math.round(sources[o + 8]);
        const tx = x - sources[o], ty = y - sources[o + 1], tz = z - sources[o + 2];
        // Weight: 1 in the core, fading to 0 at the edge (forceFieldAccel's, in particleSimCore.wgsl).
        const fall = Math.max(Math.min(1, Math.max(0, sources[o + 10])), 1e-3);
        let w = 1, reach = 4;
        if (shape === 1) {
            const r = Math.max(1e-4, sources[o + 9]);
            w = 1 - smoothstep(1 - fall, 1, Math.hypot(tx, ty, tz) / r);
            reach = r;
        } else if (shape === 2) {
            const ex = Math.max(sources[o + 12], 1e-4), ey = Math.max(sources[o + 13], 1e-4), ez = Math.max(sources[o + 14], 1e-4);
            w = 1 - smoothstep(1 - fall, 1, Math.max(Math.abs(tx) / ex, Math.abs(ty) / ey, Math.abs(tz) / ez));
            reach = Math.min(ex, ez);
        }
        if (w <= 0) continue;
        const s = sources[o + 7] * w;
        const core = Math.max(CORE * reach, 1e-3);
        let ax = 0, ay = 0, az = 0;
        if (kind === 0) {                                  // directional: along the field's +Y
            ax = sources[o + 4] * s; ay = sources[o + 5] * s; az = sources[o + 6] * s;
        } else if (kind === 1) {                           // radial: + flows in, - blasts out
            const d = Math.hypot(tx, ty, tz);
            if (d > 1e-4) { const k = -s * Math.min(1, d / core) / d; ax = tx * k; ay = ty * k; az = tz * k; }
        } else if (kind === 2) {                           // vortex round the axis, a solid core
            let ux = sources[o + 4], uy = sources[o + 5] + 1e-6, uz = sources[o + 6];
            const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
            const along = tx * ux + ty * uy + tz * uz;
            const rx = tx - ux * along, ry = ty - uy * along, rz = tz - uz * along;
            const rl = Math.hypot(rx, ry, rz);
            if (rl > 1e-4) {
                const cx = uy * rz - uz * ry, cy = uz * rx - ux * rz, cz = ux * ry - uy * rx;
                const k = s * Math.min(1, rl / core) / rl;    // |cross(unit axis, radial)| = rl
                ax = cx * k; ay = cy * k; az = cz * k;
            }
        } else if (kind === 3) {                           // eddies: the 2D curl of carried Perlin
            const f = Math.max(1e-3, sources[o + 11]);
            const c = windPerlinGrad((x - params[0] * gustSpeed * t) * f + t * EDDY_DX,
                                     (z - params[1] * gustSpeed * t) * f + t * EDDY_DY, _curl);
            ax = c[2] * s * WIND_CURL_GAIN; az = -c[1] * s * WIND_CURL_GAIN;
        } else if (kind === 4) {                           // drag: a shelter
            shelter *= 1 - Math.min(1, Math.max(0, sources[o + 7])) * w;
            continue;
        }
        vx += ax; vy += ay; vz += az;
        sx += ax; sz += az;
    }
    out.velocity[0] = vx * shelter; out.velocity[1] = vy * shelter; out.velocity[2] = vz * shelter;
    out.gust = gust;
    out.steady = Math.hypot(sx, sz) * shelter;
    return out;
}

// ---- The scene's field ------------------------------------------------------------------------------

/** What a field is read from: the scene's WindNode and its force fields. */
export interface WindFieldSource {
    readonly wind: WindNode | null;
    readonly forceFields: Iterable<ForceFieldNode>;
}

/**
 * Pack the force fields that move the air (enabled, visible, `affectsWind`) into `out`, at most `max`, in
 * scene order. The one selection rule: foliage, particles and the CPU all see the same sources.
 */
export function packWindSources(fields: Iterable<ForceFieldNode>, out: Float32Array, max = MAX_WIND_SOURCES): number {
    let n = 0;
    for (const f of fields) {
        if (n >= max) break;
        if (!f.enabled || !f.visible || !f.affectsWind) continue;
        f.packInto(out, n * WIND_SOURCE_FLOATS);
        n++;
    }
    return n;
}

/** The field as it stands this frame: the WindNode's parameters and the packed sources. */
export class WindFieldSnapshot {
    public readonly params = new Float32Array(8);
    public readonly sources = new Float32Array(MAX_WIND_SOURCES * WIND_SOURCE_FLOATS);
    public count = 0;
    /** A visible WindNode with strength > 0. */
    public baseOn = false;
    /** The fade distances of the scene's WindNode, or its defaults. */
    public fadeStart = 40;
    public fadeEnd = 70;

    /** Any wind at all: a base wind or a source. */
    public get active(): boolean { return this.baseOn || this.count > 0; }

    /**
     * `gustTravel` (windFieldClock's, wavelengths) places the gusts by how far they have actually rolled:
     * the gust speed in the params becomes the one that reaches there at `time`, `travel × λ / time`, so
     * every reader of the eight floats (this file, windField.wgsl, the particles) scrolls them the same
     * way. Without it (or with no travel yet, or at time 0) the speed is the wind's own and the gusts sit
     * at `speed × time`.
     */
    public capture(scene: WindFieldSource, time: number, gustTravel?: number): this {
        const wind = scene.wind;
        const p = this.params;
        this.baseOn = !!wind && wind.visible && wind.strength > 0;
        const [dx, dz] = wind ? wind.directionXZ : [1, 0];
        p[0] = dx; p[1] = dz;
        p[2] = this.baseOn ? wind!.strength : 0;
        p[3] = wind ? wind.gustScale : 18;
        p[4] = time;
        p[5] = wind ? wind.gustSpeed : 4;
        if (gustTravel !== undefined && gustTravel > 0 && Number.isFinite(gustTravel) && time > 1e-3) p[5] = gustTravel * Math.max(p[3], 0.5) / time;
        p[6] = wind ? wind.gustiness : WIND_DEFAULT_GUSTINESS;
        p[7] = (wind ? wind.veer : WIND_DEFAULT_VEER) * Math.PI / 180;
        this.fadeStart = wind ? wind.fadeStart : 40;
        this.fadeEnd = wind ? wind.fadeEnd : 70;
        this.count = packWindSources(scene.forceFields, this.sources);
        return this;
    }

    /** The air velocity (m/s) at world (x, y, z). */
    public sample(x: number, y: number, z: number, out: WindSample = createWindSample()): WindSample {
        return sampleWindField(this.params, this.sources, this.count, x, y, z, out);
    }
}

const _scratch = new WindFieldSnapshot();
const _sample = createWindSample();

/**
 * The air velocity (m/s) at `position` in `scene`: its WindNode's gusting, veering base wind plus every
 * force field that `affectsWind`. Written into `out`. `time` defaults to the frame's wind clock, so the
 * answer is the gust the foliage is showing.
 */
export function sampleSceneWind(scene: WindFieldSource, position: ArrayLike<number>, out: number[] | Float32Array = [0, 0, 0],
                                time: number = windFieldClock.time): number[] | Float32Array {
    // On the frame's own clock, the gusts are where the renderer rolled them to (`gustTravel`).
    _scratch.capture(scene, time, time === windFieldClock.time ? windFieldClock.gustTravel : undefined)
        .sample(position[0], position[1], position[2], _sample);
    out[0] = _sample.velocity[0]; out[1] = _sample.velocity[1]; out[2] = _sample.velocity[2];
    return out;
}
