// The numbers the screen-space reflection passes (shaders/wgsl/ssr*.wgsl) are driven by, free of GL so
// they are unit-tested. The shaders take every one of these as a uniform; nothing here is duplicated in
// WGSL.

/** Upper bound the trace is compiled for (MAX_STEPS in ssr.wgsl). */
export const SSR_MAX_STEPS = 128;
export const SSR_MIN_STEPS = 8;

/** Defaults: the high tier's march and the look settings a new project starts with. */
export const SSR_DEFAULTS = {
    steps: 32,
    resolutionScale: 0.5,
    maxRoughness: 0.6,
    maxDistance: 50,
    thickness: 0.3,
} as const;

/**
 * Roughness over which the screen-space share fades out, ending at `maxRoughness`. Past it the
 * environment fallback (probe, environment map or sky) reflects alone, and the trace does not run.
 */
export const SSR_ROUGHNESS_FADE_BAND = 0.1;

/**
 * Share of the GGX lobe the rays are drawn from. The last fifth is the long tail where a ray goes nearly
 * sideways: it is the noisiest part of the estimate and the least visible part of the reflection.
 */
export const SSR_SAMPLE_BIAS = 0.8;

/**
 * Temporal history weight at roughness 0 and at `maxRoughness`. Low for a mirror, whose reflection lags
 * visibly when surface reprojection is wrong by its parallax; high for a rough surface, which is the one
 * that needs the accumulation. See ssrTemporal.wgsl.
 */
export const SSR_FEEDBACK: readonly [number, number] = [0.75, 0.92];

/** A march step count from a setting: whole, finite, and within what the shader loops over. */
export function ssrStepCount(steps: number): number {
    if (!Number.isFinite(steps)) return SSR_DEFAULTS.steps;
    return Math.min(SSR_MAX_STEPS, Math.max(SSR_MIN_STEPS, Math.round(steps)));
}

/** The roughness band [start, end] the screen-space share fades across. */
export function ssrRoughnessFade(maxRoughness: number): [number, number] {
    const end = Math.min(1, Math.max(0, maxRoughness));
    return [Math.max(0, end - SSR_ROUGHNESS_FADE_BAND), end];
}

/** The screen-space share of a surface of `roughness`, 1 below the fade band and 0 past it. */
export function ssrRoughnessWeight(roughness: number, maxRoughness: number): number {
    const [start, end] = ssrRoughnessFade(maxRoughness);
    if (roughness >= end) return 0;
    if (roughness <= start || end <= start) return 1;
    const t = (roughness - start) / (end - start);
    return 1 - t * t * (3 - 2 * t);
}

/** The temporal history weight at `roughness`: SSR_FEEDBACK interpolated over 0..maxRoughness. */
export function ssrFeedback(roughness: number, maxRoughness: number): number {
    const t = Math.min(1, Math.max(0, roughness / Math.max(maxRoughness, 1e-3)));
    return SSR_FEEDBACK[0] + (SSR_FEEDBACK[1] - SSR_FEEDBACK[0]) * t;
}
