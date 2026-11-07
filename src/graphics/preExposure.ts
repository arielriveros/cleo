/**
 * Pre-exposure: the factor every radiance source is multiplied by BEFORE it is stored in the frame's
 * half-float buffers, so the stored values sit near 0..1 at every time of day (Lagarde & de Rousiers,
 * "Moving Frostbite to PBR", 2014; Filament's "pre-exposed lights"; Unreal's r.UsePreExposure).
 *
 * Why it exists. Radiance is stored on the engine's internal scale (lux / REFERENCE_ILLUMINANCE) and the
 * camera's exposure was applied only at present. A sunlit frame stores values around 0.1 and is exposed
 * by ~2-8; a moonlit one stores values around 1e-6 and is exposed by ~1e4-1e5. Half floats lose their
 * normal precision below 6.1e-5: a 2 lx moonlit wall had about 68 distinct levels left in it, which the
 * present then stretched across the whole display range. Nights banded, TAA and SSIL accumulated noise in
 * the last few bits, and torch falloffs stepped. Multiplying the sources by the exposure first keeps every
 * frame in the same well-conditioned range, and the present multiplies by what is left (exposure / k).
 *
 * The factor is a whole POWER OF TWO, which is exact in both fp16 and fp32: rescaling a history from one
 * k to the next (`k_now / k_written`) loses nothing. It is 1 at the engine's reference exposure (EV100
 * 15), so a daytime frame — and every thumbnail and preview, which render at that exposure — is
 * bit-identical to what it was without pre-exposure. And it changes only when the exposure has moved
 * more than `PRE_EXPOSURE_HYSTERESIS_STOPS` away from it, so an exposure easing back and forth across a
 * boundary does not flip it every frame.
 *
 * Pure, so the quantisation is testable without a renderer.
 */

/** The exposure at which pre-exposure is 1: `AutoExposure.PREVIEW_EXPOSURE`, EV100 15. */
export const PRE_EXPOSURE_REFERENCE = 2.0;

/** How far (stops) the exposure must move from the current factor before a new one is picked. */
export const PRE_EXPOSURE_HYSTERESIS_STOPS = 0.75;

/** The factor's range: 2^-8 (brighter than any sunlit scene meters) to 2^15 (darker than a moonless night). */
export const PRE_EXPOSURE_MIN_LOG2 = -8;
export const PRE_EXPOSURE_MAX_LOG2 = 15;

/**
 * The largest value a pre-exposed source writes. Half floats overflow at 65504 and TAA's sanitize turns an
 * Inf into black, so a sun disc seen by a dark-adapted camera (looking out of a cave) is clamped here
 * rather than punched out of the frame. Still far past anything the display can show after exposure.
 */
export const HDR_STORE_MAX = 32768;

/**
 * The pre-exposure for a frame that expects to render at `exposure`, given the factor in force now.
 * Returns `current` while the exposure stays within the hysteresis band around it.
 */
export function quantizePreExposure(exposure: number, current: number): number {
    if (!(exposure > 0) || !Number.isFinite(exposure)) return clampPreExposure(current);
    const target = Math.log2(exposure / PRE_EXPOSURE_REFERENCE);
    if (current > 0 && Number.isFinite(current)) {
        const held = Math.log2(current);
        if (Math.abs(target - held) <= PRE_EXPOSURE_HYSTERESIS_STOPS) return clampPreExposure(current);
    }
    return clampPreExposure(Math.pow(2, Math.round(target)));
}

/** Clamp a factor into range and snap it to the nearest power of two. */
export function clampPreExposure(k: number): number {
    if (!(k > 0) || !Number.isFinite(k)) return 1;
    const e = Math.min(PRE_EXPOSURE_MAX_LOG2, Math.max(PRE_EXPOSURE_MIN_LOG2, Math.round(Math.log2(k))));
    return Math.pow(2, e);
}
