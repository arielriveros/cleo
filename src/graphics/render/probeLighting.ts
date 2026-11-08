import { mat4, vec3 } from 'gl-matrix';
import type { LightProbeNode } from '../../core/scene/nodes/lightProbeNode';
import { skyAmbient } from '../particles/particleLighting';
import { SH_FLOATS } from '../shProject';

/**
 * Light probes, applied PER PIXEL whatever the camera does: both lobes.
 *
 * LIGHTING: a probe's irradiance is nine spherical-harmonic coefficients (LightProbeNode.irradianceSH), so
 * every lighting probe in view fits in the deferred pass's uniform block. REFLECTIONS: a probe's filtered
 * environment is one layer of the reflection atlas (render/reflectionAtlas.ts), sampled with a dynamic
 * layer. Either way a room's probe lights and reflects in the room wherever the camera stands, which two
 * cubemap slots handed out by the camera's position could not do.
 *
 * Pure, and the CPU twin of deferredLighting.wgsl's loop: forward draws, lit particles and lit sprites take
 * the same probes in the same order at their own positions.
 */

/** Lighting probes per frame. Must match MAX_LIGHT_PROBES in deferredLighting.wgsl. */
export const MAX_LIGHTING_PROBES = 16;

/** Below this share left, the probes have claimed the point and the loop stops (as the shader's does). */
const CLAIMED = 1e-3;

/**
 * The probes that light the frame, in the order they claim a point: every probe set to light with its
 * coefficients projected, whose volume the view can see, the MOST SPECIFIC first (the smallest volume: a
 * room's probe before the hamlet's round it), unbounded probes last. The order is the same from anywhere,
 * so a point's light does not depend on where the camera is. Past `max`, the volumes nearest the camera.
 */
export function orderLightingProbes(probes: Iterable<LightProbeNode>, cameraPos: vec3,
                                    visible?: (min: vec3, max: vec3) => boolean,
                                    max: number = MAX_LIGHTING_PROBES): LightProbeNode[] {
    return orderProbes(probes, p => p.affectsLighting && p.irradianceSH !== null, cameraPos, visible, max);
}

/**
 * The probes that give the frame its REFLECTIONS, in the same claim order and by the same rules as
 * {@link orderLightingProbes}: every probe set to reflect whose filtered environment is in the atlas
 * (`reflectionLayer` >= 0), whose volume the view can see.
 */
export function orderReflectionProbes(probes: Iterable<LightProbeNode>, cameraPos: vec3,
                                      visible?: (min: vec3, max: vec3) => boolean,
                                      max: number = MAX_LIGHTING_PROBES): LightProbeNode[] {
    return orderProbes(probes, p => p.affectsReflections && p.reflectionLayer >= 0, cameraPos, visible, max);
}

function orderProbes(probes: Iterable<LightProbeNode>, use: (p: LightProbeNode) => boolean, cameraPos: vec3,
                     visible: ((min: vec3, max: vec3) => boolean) | undefined, max: number): LightProbeNode[] {
    let out: LightProbeNode[] = [];
    for (const probe of probes) {
        if (!use(probe)) continue;
        if (probe.bounded && visible) {
            const box = probe.getBoundingBox();
            if (!visible(box.min, box.max)) continue;
        }
        out.push(probe);
    }
    if (out.length > max) {
        const distance = new Map(out.map(p => [p, p.distanceToVolume(cameraPos)]));
        out.sort((a, b) => distance.get(a)! - distance.get(b)!);
        out = out.slice(0, max);
    }
    return out.sort(byClaimOrder);
}

function byClaimOrder(a: LightProbeNode, b: LightProbeNode): number {
    const va = a.volumeSize, vb = b.volumeSize;
    if (va !== vb) return va < vb ? -1 : 1;     // Infinity (unbounded) sorts last
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** The arrays deferredLighting.wgsl reads the lighting probes from. */
export interface LightingProbeArrays {
    /** `u_lightProbeSH`: 9 vec4 per probe, radiance-form SH x intensity x the frame's pre-exposure. */
    sh: Float32Array;
    /** `u_lightProbeInvVolume`: world -> unit cube, per probe (identity when unbounded). */
    invVolume: Float32Array;
    /** `u_lightProbeBlend`: xyz the feather as a fraction of the unit cube, w 1 = unbounded. */
    blend: Float32Array;
}

export function createLightingProbeArrays(): LightingProbeArrays {
    return {
        sh: new Float32Array(MAX_LIGHTING_PROBES * SH_FLOATS),
        invVolume: new Float32Array(MAX_LIGHTING_PROBES * 16),
        blend: new Float32Array(MAX_LIGHTING_PROBES * 4),
    };
}

const _identity = mat4.create();

/** The arrays deferredLighting.wgsl reads the reflecting probes from. */
export interface ReflectionProbeArrays {
    /** `u_reflProbeInvVolume`: world -> unit cube, per probe (identity when unbounded). */
    invVolume: Float32Array;
    /** `u_reflProbeBlend`: xyz the feather, w 1 = unbounded. */
    blend: Float32Array;
    /** `u_reflProbeParams`: x atlas layer, y intensity x pre-exposure, z 1 = box projection. */
    params: Float32Array;
    /** `u_reflProbeCapture`: xyz the probe's world position, where it captured from. */
    capture: Float32Array;
    /**
     * `u_reflProbeIrradiance`: the probe's irradiance LUMINANCE as L0 and L1, x intensity x pre-exposure
     * (x constant, yzw linear in the normal's x, y, z; E/pi), for the GI Volumes' reflection normalization.
     * All zero for a probe with no projection yet.
     */
    irradiance: Float32Array;
}

export function createReflectionProbeArrays(): ReflectionProbeArrays {
    return {
        invVolume: new Float32Array(MAX_LIGHTING_PROBES * 16),
        blend: new Float32Array(MAX_LIGHTING_PROBES * 4),
        params: new Float32Array(MAX_LIGHTING_PROBES * 4),
        capture: new Float32Array(MAX_LIGHTING_PROBES * 4),
        irradiance: new Float32Array(MAX_LIGHTING_PROBES * 4),
    };
}

/** Rec. 709 luminance weights. */
const LUMA_R = 0.2126, LUMA_G = 0.7152, LUMA_B = 0.0722;
/** Ramamoorthi & Hanrahan's band constants, as skyIrradiance applies them: c4 on L0, 2 x c2 on L1. */
const SH_C4 = 0.886227, SH_2C2 = 2 * 0.511664;

/**
 * `sh`'s irradiance luminance as L0 and L1 into `out` at `o`: the constant term, then the linear one in
 * the normal's x, y, z (E/pi, x `k`). The cosine lobe of skyIrradiance cut at band 1, which is what a
 * luminance RATIO needs: smooth, never ringing. `sh` is radiance-form, rgb in xyz of 9 vec4s.
 */
export function irradianceLuminanceL1(sh: ArrayLike<number>, k: number, out: Float32Array, o: number): void {
    const lum = (c: number) => sh[c * 4] * LUMA_R + sh[c * 4 + 1] * LUMA_G + sh[c * 4 + 2] * LUMA_B;
    const s = k / Math.PI;
    out[o] = SH_C4 * lum(0) * s;
    // SH order: 1 = L1,-1 (y), 2 = L1,0 (z), 3 = L1,1 (x).
    out[o + 1] = SH_2C2 * lum(3) * s;
    out[o + 2] = SH_2C2 * lum(1) * s;
    out[o + 3] = SH_2C2 * lum(2) * s;
}

/** Pack the reflecting probes (already ordered) for the upload; returns the count the shader loops to. */
export function packReflectionProbes(list: readonly LightProbeNode[], preExposure: number, out: ReflectionProbeArrays): number {
    const n = Math.min(list.length, MAX_LIGHTING_PROBES);
    for (let i = 0; i < n; i++) {
        const probe = list[i];
        out.invVolume.set(probe.bounded ? probe.invVolumeMatrix : _identity, i * 16);
        const b = probe.bounded ? probe.volumeBlend : null;
        out.blend[i * 4] = b ? b[0] : 0; out.blend[i * 4 + 1] = b ? b[1] : 0; out.blend[i * 4 + 2] = b ? b[2] : 0;
        out.blend[i * 4 + 3] = probe.bounded ? 0 : 1;
        out.params[i * 4] = probe.reflectionLayer;
        out.params[i * 4 + 1] = probe.intensity * preExposure;
        out.params[i * 4 + 2] = probe.bounded && probe.boxProjection ? 1 : 0;
        out.params[i * 4 + 3] = 0;
        const p = probe.worldPosition;
        out.capture[i * 4] = p[0]; out.capture[i * 4 + 1] = p[1]; out.capture[i * 4 + 2] = p[2]; out.capture[i * 4 + 3] = 1;
        const sh = probe.irradianceSH;
        if (sh) irradianceLuminanceL1(sh, probe.intensity * preExposure, out.irradiance, i * 4);
        else out.irradiance.fill(0, i * 4, i * 4 + 4);
    }
    return n;
}

/**
 * CPU twin of deferredLighting.wgsl `boxProjected`: the direction the probe saw the point the ray
 * (`worldPos`, `R`) leaves its box at, from `capture`. For tests.
 */
export function boxProjectedDirection(R: ArrayLike<number>, worldPos: ArrayLike<number>, invVolume: ArrayLike<number>,
                                      capture: ArrayLike<number>): [number, number, number] {
    const m = invVolume;
    const o = [
        m[0] * worldPos[0] + m[4] * worldPos[1] + m[8] * worldPos[2] + m[12],
        m[1] * worldPos[0] + m[5] * worldPos[1] + m[9] * worldPos[2] + m[13],
        m[2] * worldPos[0] + m[6] * worldPos[1] + m[10] * worldPos[2] + m[14],
    ];
    const d = [
        m[0] * R[0] + m[4] * R[1] + m[8] * R[2],
        m[1] * R[0] + m[5] * R[1] + m[9] * R[2],
        m[2] * R[0] + m[6] * R[1] + m[10] * R[2],
    ];
    let t = Infinity;
    for (let k = 0; k < 3; k++) {
        const dk = Math.abs(d[k]) < 1e-6 ? 1e-6 : d[k];
        t = Math.min(t, ((dk > 0 ? 0.5 : -0.5) - o[k]) / dk);
    }
    t = Math.max(t, 0);
    const h = [worldPos[0] + R[0] * t - capture[0], worldPos[1] + R[1] * t - capture[1], worldPos[2] + R[2] * t - capture[2]];
    const len = Math.hypot(h[0], h[1], h[2]) || 1;
    return [h[0] / len, h[1] / len, h[2] / len];
}

/** Pack `list` (already ordered) for the upload; returns the count the shader loops to. */
export function packLightingProbes(list: readonly LightProbeNode[], preExposure: number, out: LightingProbeArrays): number {
    const n = Math.min(list.length, MAX_LIGHTING_PROBES);
    for (let i = 0; i < n; i++) {
        const probe = list[i];
        const sh = probe.irradianceSH!;
        const k = probe.intensity * preExposure;
        for (let j = 0; j < SH_FLOATS; j++) out.sh[i * SH_FLOATS + j] = sh[j] * k;
        out.invVolume.set(probe.bounded ? probe.invVolumeMatrix : _identity, i * 16);
        if (probe.bounded) {
            const b = probe.volumeBlend;
            out.blend[i * 4] = b[0]; out.blend[i * 4 + 1] = b[1]; out.blend[i * 4 + 2] = b[2]; out.blend[i * 4 + 3] = 0;
        } else {
            out.blend[i * 4] = 0; out.blend[i * 4 + 1] = 0; out.blend[i * 4 + 2] = 0; out.blend[i * 4 + 3] = 1;
        }
    }
    return n;
}

/**
 * The probes' light at one point, as the deferred pass blends it per pixel: each probe claims its
 * feathered weight of what the probes before it left. `outSH` receives the blended coefficients (x each
 * probe's intensity x `scale`) and the return is the share they took: 0 outside every probe, where the
 * scene ambient and the sky light keep the point; 1 well inside one.
 */
export function probeLightingAt(list: readonly LightProbeNode[], position: vec3, outSH: Float32Array, scale: number = 1): number {
    outSH.fill(0);
    let remaining = 1;
    for (const probe of list) {
        const w = probe.probeWeight(position);
        if (w <= 0) continue;
        const claim = w * remaining;
        const sh = probe.irradianceSH!;
        const k = claim * probe.intensity * scale;
        for (let j = 0; j < SH_FLOATS; j++) outSH[j] += sh[j] * k;
        remaining -= claim;
        if (remaining <= CLAIMED) break;
    }
    return 1 - remaining;
}

/**
 * A flat ambient at one point, for what is lit by one (lit particles, lit sprites): `fallback` (the scene
 * ambient plus the sky light's mean, ParticlePasses.frameLight) where no probe claims the point, each
 * probe's mean irradiance where one does. Same units as `fallback`.
 */
export function probeAmbientAt(list: readonly LightProbeNode[], position: vec3, fallback: ArrayLike<number>,
                               out: number[] = [0, 0, 0]): number[] {
    let remaining = 1;
    let r = 0, g = 0, b = 0;
    for (const probe of list) {
        const w = probe.probeWeight(position);
        if (w <= 0) continue;
        const claim = w * remaining;
        const mean = skyAmbient(probe.irradianceSH, probe.intensity);
        r += mean[0] * claim; g += mean[1] * claim; b += mean[2] * claim;
        remaining -= claim;
        if (remaining <= CLAIMED) break;
    }
    out[0] = fallback[0] * remaining + r;
    out[1] = fallback[1] * remaining + g;
    out[2] = fallback[2] * remaining + b;
    return out;
}
