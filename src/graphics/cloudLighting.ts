/**
 * CPU-side light inputs for the volumetric clouds: the clouds are lit by the sun as the ATMOSPHERE has
 * attenuated it at the clouds' altitude, and by the sky's own radiance as ambient. Both are
 * per-frame constants, so they are computed here once rather than per sample in the raymarch.
 */

export interface AtmosphereParams {
    rayleigh: [number, number, number]; // scattering coefficients, per metre
    mie: number;                        // per metre
    rayleighHeight: number;             // scale height, m
    mieHeight: number;                  // scale height, m
    planetRadius: number;               // m
    atmosphereRadius: number;           // m
}

const STEPS = 32;

/**
 * Sun transmittance from `altitude` metres above the ground toward the (unit) direction `toSun`,
 * through the same Rayleigh + Mie atmosphere the sky bake integrates (`skyAtmosphere.wgsl`'s light
 * loop, including its 1.1 Mie extinction factor). Zero when the planet blocks the sun.
 */
export function atmosphereTransmittance(p: AtmosphereParams, altitude: number,
                                        toSun: ArrayLike<number>): [number, number, number] {
    const r0 = p.planetRadius + Math.max(0, altitude);
    // Ray from (0, r0, 0) along toSun against the atmosphere and planet spheres.
    const b = r0 * toSun[1];
    const cAtm = r0 * r0 - p.atmosphereRadius * p.atmosphereRadius;
    const dAtm = b * b - cAtm;
    if (dAtm <= 0) return [1, 1, 1];
    const tEnd = -b + Math.sqrt(dAtm);
    if (tEnd <= 0) return [1, 1, 1];
    const cPlanet = r0 * r0 - p.planetRadius * p.planetRadius;
    const dPlanet = b * b - cPlanet;
    // From outside the planet the ray hits it iff it heads inward (b < 0) and the discriminant is positive.
    if (b < 0 && dPlanet > 0) return [0, 0, 0];

    const step = tEnd / STEPS;
    let odR = 0;
    let odM = 0;
    for (let i = 0; i < STEPS; i++) {
        const t = (i + 0.5) * step;
        const x = toSun[0] * t, y = r0 + toSun[1] * t, z = toSun[2] * t;
        const h = Math.hypot(x, y, z) - p.planetRadius;
        odR += Math.exp(-h / p.rayleighHeight) * step;
        odM += Math.exp(-h / p.mieHeight) * step;
    }
    const m = p.mie * 1.1 * odM;
    return [Math.exp(-(p.rayleigh[0] * odR + m)),
            Math.exp(-(p.rayleigh[1] * odR + m)),
            Math.exp(-(p.rayleigh[2] * odR + m))];
}

/**
 * Mean radiance of the upper (+Y) and lower (-Y) hemispheres of an order-2 SH projection laid out as
 * `Renderer._projectEquirectToSH` writes it (9 coefficients, 4 floats apart, basis order y, z, x for
 * l = 1). Over a hemisphere about Y every basis function except Y00 and the `y` one integrates to
 * zero, so each mean is `0.282095 c0 ± 0.244301 c1` (the second is 0.488603 * pi / 2pi).
 */
export function shHemisphereMeans(sh: ArrayLike<number>): { up: [number, number, number], down: [number, number, number] } {
    const up: [number, number, number] = [0, 0, 0];
    const down: [number, number, number] = [0, 0, 0];
    for (let ch = 0; ch < 3; ch++) {
        const l0 = 0.282095 * sh[ch];
        const l1 = 0.244301 * sh[4 + ch];
        up[ch] = Math.max(0, l0 + l1);
        down[ch] = Math.max(0, l0 - l1);
    }
    return { up, down };
}
