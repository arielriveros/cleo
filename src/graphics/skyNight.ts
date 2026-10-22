/**
 * Night-sky geometry and the per-frame key light, for a scene with a SkyAtmosphere.
 *
 * The engine has exactly one directional light. Rather than asking for a second one, the sun light
 * BECOMES the moon at night: once the sun has set, the renderer uploads (and shadows from) the moon's
 * direction, colour and intensity instead — at upload time only, so the authored light node is never
 * touched. The swap happens while both are dark, so nothing pops: the sun fades out over the last few
 * degrees above the horizon and the moon fades in only after it has gone.
 *
 * Pure functions, so the crossfade can be tested without a renderer.
 */

type Vec3 = [number, number, number];

const smooth = (a: number, b: number, x: number): number => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
};
const DEG = Math.PI / 180;

/**
 * Direction TOWARD the moon: the point opposite the sun, moved by `yawDeg` in azimuth and `pitchDeg` in
 * elevation. Following the sun keeps a scripted day/night cycle moving the moon with no extra work,
 * while the offset stops it rising exactly as the sun sets on the opposite horizon.
 */
export function moonDirection(toSun: ArrayLike<number>, yawDeg: number, pitchDeg: number): Vec3 {
    const len = Math.hypot(toSun[0], toSun[1], toSun[2]) || 1;
    const x = -toSun[0] / len, y = -toSun[1] / len, z = -toSun[2] / len;
    const limit = 89 * DEG;
    const el = Math.min(limit, Math.max(-limit, Math.asin(Math.min(1, Math.max(-1, y))) + pitchDeg * DEG));
    const az = Math.atan2(x, z) + yawDeg * DEG;
    const c = Math.cos(el);
    return [c * Math.sin(az), Math.sin(el), c * Math.cos(az)];
}

/** 0 with the sun above ~2 degrees, 1 once it is ~8 degrees below the horizon (astronomical dusk-ish). */
export function nightFactor(sunElevationSin: number): number {
    return 1 - smooth(-0.139, 0.035, sunElevationSin);
}

export interface MoonLightParams {
    nightEnabled: boolean;
    moonEnabled: boolean;
    moonColor: ArrayLike<number>;
    moonPhase: number;          // 0 = new .. 1 = full
    moonlightIntensity: number; // fraction of the sun light's intensity
}

export interface KeyLight {
    /** TRAVEL direction, like `LightNode.worldForward`. */
    dir: Vec3;
    color: Vec3;
    intensity: number;
    isMoon: boolean;
}

/**
 * The directional light to upload this frame. `toSun`/`toMoon` point toward the bodies; `sunColor` and
 * `sunIntensity` are the authored light's.
 */
export function keyLight(toSun: ArrayLike<number>, toMoon: ArrayLike<number>, sunColor: ArrayLike<number>,
                         sunIntensity: number, p: MoonLightParams): KeyLight {
    const sunY = toSun[1];
    // Sun: full above ~3 degrees, gone at -2 (below that it would light the ground from underneath).
    const sunWeight = smooth(-0.035, 0.052, sunY);
    // Moon: only once the sun has gone (so the direction swap happens in the dark), only above its own
    // horizon, and only as bright as it is lit.
    const moonWeight = p.nightEnabled && p.moonEnabled
        ? (1 - smooth(-0.105, -0.035, sunY)) * smooth(-0.02, 0.08, toMoon[1]) * Math.min(1, Math.max(0, p.moonPhase))
        : 0;
    if (sunWeight > 0 || moonWeight <= 0) {
        return {
            dir: [-toSun[0], -toSun[1], -toSun[2]],
            color: [sunColor[0], sunColor[1], sunColor[2]],
            intensity: sunIntensity * sunWeight,
            isMoon: false,
        };
    }
    return {
        dir: [-toMoon[0], -toMoon[1], -toMoon[2]],
        color: [p.moonColor[0], p.moonColor[1], p.moonColor[2]],
        intensity: sunIntensity * p.moonlightIntensity * moonWeight,
        isMoon: true,
    };
}
