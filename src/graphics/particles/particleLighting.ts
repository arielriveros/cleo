import { distanceAttenuation, REFERENCE_ILLUMINANCE } from "../lighting";

/**
 * How particles take the scene's light and exposure — pure, so the rules are testable without a GPU.
 *
 * Particles are drawn into the HDR scene buffer before exposure, like every surface, so they are exposed by
 * the same camera. What makes them obey the SAME rule as the world is the two halves here:
 *
 *   - a LIT particle (smoke, dust) is lit by the scene's real light: the scene ambient and sky light the
 *     deferred pass uses, the key light (sun, or the moon at night), and the point and spot lights that
 *     reach the effect — so torch smoke is lit by the torch and is dark on a moonless night;
 *   - an UNLIT particle (fire, sparks, magic) is emissive, and its colour is a luminance on the engine's
 *     internal scale — one unit is REFERENCE_ILLUMINANCE nits — so a flame authored at a real ~8,000 nits
 *     is faint against a sunlit wall and blazes at night, as the torch's light does.
 */

/** cd/m² (nits) in one unit of the engine's internal radiance scale. */
export const NITS_PER_INTERNAL_UNIT = REFERENCE_ILLUMINANCE;

/** An unlit particle's luminance, in nits, from its colour intensity and render brightness (colour 1). */
export function particleLuminanceNits(intensity: number, brightness: number): number {
    return intensity * brightness * NITS_PER_INTERNAL_UNIT;
}

/** The colour intensity that gives `nits` at a given render brightness. */
export function particleIntensityForNits(nits: number, brightness: number): number {
    return brightness > 0 ? nits / (brightness * NITS_PER_INTERNAL_UNIT) : 0;
}

/** A punctual light as particle lighting reads it: the values the light grid uploads. */
export interface ParticleLocalLight {
    position: ArrayLike<number>;
    /** Candela on the internal scale (`PunctualLight.internalIntensity`). */
    intensity: number;
    color: ArrayLike<number>;
    range: number;
    sourceRadius: number;
    /** Spot lights: the direction it points, and `Spotlight.coneScaleOffset`. */
    direction?: ArrayLike<number>;
    cone?: readonly [number, number];
}

export interface ParticleLocalLighting {
    /** Irradiance from every local light but the strongest, as a non-directional fill. */
    fill: [number, number, number];
    /** Direction TO the strongest local light. */
    keyDirection: [number, number, number];
    /** The strongest local light's irradiance (zero when none reaches). */
    keyColor: [number, number, number];
}

/**
 * The point and spot lights reaching `p`, by the same falloff and cone the surface shaders use. The
 * strongest becomes a directional key (so a torch lights the side of the smoke facing it), the rest a
 * fill. Irradiance, not radiance: the diffuse 1/π is the shader's, as for surfaces.
 */
export function gatherParticleLocalLight(p: ArrayLike<number>, lights: Iterable<ParticleLocalLight>): ParticleLocalLighting {
    const fill: [number, number, number] = [0, 0, 0];
    const keyColor: [number, number, number] = [0, 0, 0];
    const keyDirection: [number, number, number] = [0, 1, 0];
    let keyLum = 0;
    for (const light of lights) {
        const dx = light.position[0] - p[0], dy = light.position[1] - p[1], dz = light.position[2] - p[2];
        const d = Math.max(Math.hypot(dx, dy, dz), light.sourceRadius);
        if (d >= light.range) continue;
        let k = light.intensity * distanceAttenuation(d, light.range);
        if (light.cone && light.direction) {
            const f = light.direction;
            const fl = Math.hypot(f[0], f[1], f[2]) || 1;
            // The cone is tested from the light toward the point, as `spotAttenuation` does.
            const cos = -(dx * f[0] + dy * f[1] + dz * f[2]) / (fl * Math.max(d, 1e-6));
            const a = Math.min(1, Math.max(0, cos * light.cone[0] + light.cone[1]));
            k *= a * a;
        }
        if (!(k > 0)) continue;
        const c: [number, number, number] = [light.color[0] * k, light.color[1] * k, light.color[2] * k];
        const lum = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
        if (lum > keyLum) {
            // The previous key, if any, joins the fill.
            fill[0] += keyColor[0]; fill[1] += keyColor[1]; fill[2] += keyColor[2];
            keyColor[0] = c[0]; keyColor[1] = c[1]; keyColor[2] = c[2];
            const inv = 1 / Math.max(Math.hypot(dx, dy, dz), 1e-6);
            keyDirection[0] = dx * inv; keyDirection[1] = dy * inv; keyDirection[2] = dz * inv;
            keyLum = lum;
        } else {
            fill[0] += c[0]; fill[1] += c[1]; fill[2] += c[2];
        }
    }
    return { fill, keyDirection, keyColor };
}

/**
 * The sky light's mean irradiance, divided by π as `skyIrradiance` returns it: the L0 band alone, which is
 * the sky's average over every direction (the L1/L2 bands integrate to zero). `sh` is nine vec4s.
 */
export function skyAmbient(sh: ArrayLike<number> | null, intensity: number): [number, number, number] {
    if (!sh) return [0, 0, 0];
    const k = 0.886227 * intensity / Math.PI;
    return [Math.max(0, sh[0] * k), Math.max(0, sh[1] * k), Math.max(0, sh[2] * k)];
}

/** A luminance for a readout: "8.0k nits", "120 nits". */
export function formatNits(nits: number): string {
    if (!(nits > 0)) return '0 nits';
    if (nits >= 1e6) return `${(nits / 1e6).toFixed(1)}M nits`;
    if (nits >= 1e4) return `${Math.round(nits / 1e3)}k nits`;
    if (nits >= 1e3) return `${(nits / 1e3).toFixed(1)}k nits`;
    return `${Math.round(nits)} nits`;
}
