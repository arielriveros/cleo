/**
 * The terrain brush's radial weight: 1 at the centre, easing to 0 at the rim.
 *
 * One function for every consumer, because they must agree to the last digit: `Terrain.sculpt` and
 * `Terrain.paint` apply it, and the editor's brush decal DRAWS it — a cursor whose gradient disagreed
 * with the stroke would be lying about what the next click does. The decal's radial pattern evaluates
 * `pow(1 - t, exponent)`, so the brush hands it `brushFalloffExponent(falloff)`; see
 * `radialDecalWeight` in core/scene/nodes/decalNode.ts, which the parity test holds against this.
 *
 * @param t       Distance from the brush centre as a fraction of its radius, 0..1. Callers skip `t > 1`.
 * @param falloff 0 = hard edge (uniform weight), 1 = fully feathered.
 */
export function brushFalloffWeight(t: number, falloff: number): number {
    return falloff <= 0 ? 1 : Math.pow(1 - t, brushFalloffExponent(falloff));
}

/** The power-curve exponent a `falloff` stands for. 0 means the hard, uniform disc. */
export function brushFalloffExponent(falloff: number): number {
    return falloff <= 0 ? 0 : falloff * 3;
}
