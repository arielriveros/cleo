/**
 * Light flicker: a fire's light, flame and embers driven by ONE signal.
 *
 * A point or spot light can flicker (`PunctualLight.flickerAmount` / `flickerSpeed`): its intensity wanders
 * by layered smooth noise, seeded per light, so no two torches pulse together and none visibly repeats. The
 * renderer multiplies the light's intensity by it as it packs the frame's lights — intensity only, never
 * position, so a shadow-casting light keeps its cached shadow map.
 *
 * Anything that should burn WITH the light follows it (`followLight` on sprites and particle systems): a
 * flame brightens and an ember stream thickens on the same beat the light swells, instead of three
 * unrelated clocks. That coupling is most of what makes a torch read as one object.
 *
 * Pure, and on one clock (`lightFlickerClock`), advanced once per frame by the renderer: every reader in
 * the frame — the light grid, the sprites, the particles — sees the same value.
 */

/** The frame's flicker time in seconds. Set by the renderer at the top of every frame. */
export const lightFlickerClock = { time: 0 };

/** A stable seed for a light, from its node id: the same torch flickers the same way every run. */
export function flickerSeed(id: string): number {
    let h = 2166136261;
    for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
    return (h >>> 0) / 4294967296;
}

/** Hash of an integer lattice point and a seed, in [-1, 1]. */
function lattice(i: number, seed: number): number {
    const x = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453;
    return (x - Math.floor(x)) * 2 - 1;
}

/** Smooth 1D value noise in [-1, 1]. */
function valueNoise(t: number, seed: number): number {
    const i = Math.floor(t), f = t - i;
    const u = f * f * (3 - 2 * f);
    return lattice(i, seed) * (1 - u) + lattice(i + 1, seed) * u;
}

/**
 * The flicker multiplier at `time`: 1 + amount x (three octaves of smooth noise, at unrelated rates), never
 * below 0. `speed` is roughly the swells per second of the slowest octave. `amount` 0 is exactly 1.
 */
export function flickerFactor(time: number, amount: number, speed: number, seed: number): number {
    if (!(amount > 0)) return 1;
    const t = time * Math.max(0, speed);
    const n = valueNoise(t, seed) * 0.55
            + valueNoise(t * 2.37 + 13.1, seed + 0.31) * 0.3
            + valueNoise(t * 5.91 + 41.7, seed + 0.67) * 0.15;
    return Math.max(0, 1 + amount * n);
}

/** How a follower takes a light's flicker: `amount` 0 ignores it, 1 follows it fully. */
export function followFlicker(factor: number, amount: number): number {
    const a = Math.min(1, Math.max(0, amount));
    return 1 + (factor - 1) * a;
}
