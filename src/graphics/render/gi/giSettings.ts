/**
 * What GI Volumes cost at each quality tier, and the clamps on the user-facing settings. Free of GL so the
 * table is unit-tested, like ssilSettings.ts.
 *
 * The apply (giResolve) is the per-frame cost: a full-screen pass, at full resolution on Ultra and half on
 * the others, brought back up by depth and normal (deferredLighting.wgsl `giUpsample`). Half costs about a
 * third (0.54 -> 0.16 ms at 1904x929, Valley street, WebGPU) and shows no difference at creases or edges. The RELIGHT is paid only while something changes —
 * the sun moved past the tier's threshold, a light changed, a capture landed — and is spread over frames
 * by the rays-per-frame budget. The FILL is the runtime capture of volumes that have no saved bake: the
 * scene draws spent on it per frame, nearest probes first.
 */

export type GiTierName = 'ultra' | 'high' | 'medium' | 'low';

export interface GiTier {
    /** GI is applied at all. */
    giEnabled: boolean;
    /** Resolution of the apply pass, a fraction of the render size. */
    giResolutionScale: number;
    /** Rays relit per frame while a relight is due. */
    giRaysPerFrame: number;
    /** Degrees the sun must turn before a volume's shadow map, and so its relight, is redone. */
    giSunThreshold: number;
    /** World size a GI sun-shadow texel aims at, metres. */
    giShadowTexel: number;
    /** The largest GI sun-shadow map side. */
    giShadowMaxSize: number;
    /** Scene draws the runtime fill spends per frame. */
    giFillDrawsPerFrame: number;
    /** The bounces after the first. */
    giMultiBounce: boolean;
}

export const GI_TIERS: Record<GiTierName, GiTier> = {
    ultra: {
        giEnabled: true, giResolutionScale: 1.0, giRaysPerFrame: 262144, giSunThreshold: 1,
        giShadowTexel: 0.1, giShadowMaxSize: 2048, giFillDrawsPerFrame: 96, giMultiBounce: true,
    },
    high: {
        giEnabled: true, giResolutionScale: 0.5, giRaysPerFrame: 131072, giSunThreshold: 2,
        giShadowTexel: 0.1, giShadowMaxSize: 2048, giFillDrawsPerFrame: 64, giMultiBounce: true,
    },
    medium: {
        giEnabled: true, giResolutionScale: 0.5, giRaysPerFrame: 65536, giSunThreshold: 3,
        giShadowTexel: 0.2, giShadowMaxSize: 1024, giFillDrawsPerFrame: 48, giMultiBounce: true,
    },
    low: {
        giEnabled: true, giResolutionScale: 0.5, giRaysPerFrame: 32768, giSunThreshold: 5,
        giShadowTexel: 0.3, giShadowMaxSize: 1024, giFillDrawsPerFrame: 32, giMultiBounce: true,
    },
};

/** The bounds every setting is held to, whatever a saved project or a script asks for. */
export const GI_LIMITS = {
    resolutionScale: [0.25, 1] as const,
    raysPerFrame: [4096, 1 << 20] as const,
    sunThreshold: [0.25, 15] as const,
    shadowTexel: [0.02, 2] as const,
    shadowSize: [256, 4096] as const,
    fillDrawsPerFrame: [0, 512] as const,
};

function clamp(v: number, range: readonly [number, number], fallback: number): number {
    if (!Number.isFinite(v)) return fallback;
    return Math.min(range[1], Math.max(range[0], v));
}

export function clampGiResolutionScale(v: number): number { return clamp(v, GI_LIMITS.resolutionScale, 1); }

/** Rays relit per frame: a whole number, and a multiple of 64 (one coarse probe). */
export function clampGiRaysPerFrame(v: number): number {
    return Math.round(clamp(v, GI_LIMITS.raysPerFrame, GI_TIERS.high.giRaysPerFrame) / 64) * 64;
}

export function clampGiSunThreshold(v: number): number { return clamp(v, GI_LIMITS.sunThreshold, 2); }

export function clampGiFillDrawsPerFrame(v: number): number {
    return Math.round(clamp(v, GI_LIMITS.fillDrawsPerFrame, GI_TIERS.high.giFillDrawsPerFrame));
}

/**
 * Side of a volume's GI sun-shadow map: enough texels to cover its diameter at the tier's texel size, a
 * power of two, between 256 and the tier's largest.
 */
export function giShadowMapSize(diameter: number, texel: number, maxSize: number): number {
    const want = Math.max(1, diameter) / clamp(texel, GI_LIMITS.shadowTexel, 0.1);
    const pow = 1 << Math.ceil(Math.log2(Math.max(1, want)));
    const cap = clamp(maxSize, GI_LIMITS.shadowSize, 2048);
    return Math.min(cap, Math.max(GI_LIMITS.shadowSize[0], pow));
}

/**
 * Probes relit per frame for a volume whose probes have `rays` rays each, from the frame's ray budget: at
 * least one, so a single fine probe never stalls a sweep on a small budget.
 */
export function giProbesPerFrame(raysPerFrame: number, rays: number): number {
    return Math.max(1, Math.floor(clampGiRaysPerFrame(raysPerFrame) / Math.max(1, rays)));
}
