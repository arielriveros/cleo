// Gerstner waves: a water surface as a sum of trochoidal waves. This CPU half and the WGSL twin
// (graphics/shaders/wgsl/chunks/waterGerstner.wgsl) evaluate the same sum, operation for operation, so a
// body the physics floats rides exactly the wave the renderer draws.
//
// Domain math kept out of core/math.ts on purpose: the physics worker imports it, and the worker bundle may
// import nothing outside src/physics (tests/physicsWorkerParity.test.ts).

/** One wave. Direction is a unit XZ vector; the phase speed follows deep-water dispersion. */
export interface GerstnerWave {
    dirX: number; dirZ: number;
    /** Metres, crest to rest level. */
    amplitude: number;
    /** Metres, crest to crest. */
    wavelength: number;
    /** 0..1: how sharp the crest is (0 a sine, 1 the cusp). */
    steepness: number;
    /** Radians, so waves of the same length do not all crest at the origin. */
    phase: number;
}

/** Gerstner waves the set holds at most (the shader's array length). */
export const GERSTNER_MAX_WAVES = 8;

const GERSTNER_G = 9.81;

/**
 * Displacement of the undisplaced surface point (x, z) at `time`: `out` = [dx, dy, dz]. `scale` multiplies
 * every amplitude (wind strength, shore damping), 0..1 typically.
 */
export function gerstnerDisplacement(waves: readonly GerstnerWave[], x: number, z: number, time: number, scale: number,
                                     out: number[] = [0, 0, 0]): number[] {
    let dx = 0, dy = 0, dz = 0;
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const k = 6.283185307179586 / Math.max(0.01, w.wavelength);
        const omega = Math.sqrt(GERSTNER_G * k);
        const a = w.amplitude * scale;
        const theta = k * (w.dirX * x + w.dirZ * z) - omega * time + w.phase;
        const q = a > 0 ? w.steepness / (k * a * waves.length) : 0;
        const c = Math.cos(theta), s = Math.sin(theta);
        dx += q * a * w.dirX * c;
        dz += q * a * w.dirZ * c;
        dy += a * s;
    }
    out[0] = dx; out[1] = dy; out[2] = dz;
    return out;
}

const _gerstnerTmp = [0, 0, 0];

/**
 * Height of the displaced surface above its rest level at WORLD (x, z): the waves move surface points
 * sideways as well as up, so the point that ends up over (x, z) is found by fixed-point iteration
 * (three steps converge well below a millimetre for waves that do not cusp).
 */
export function gerstnerHeightAt(waves: readonly GerstnerWave[], x: number, z: number, time: number, scale: number): number {
    if (!waves.length || !(scale > 0)) return 0;
    let ux = x, uz = z;
    for (let i = 0; i < 3; i++) {
        gerstnerDisplacement(waves, ux, uz, time, scale, _gerstnerTmp);
        ux = x - _gerstnerTmp[0]; uz = z - _gerstnerTmp[2];
    }
    return gerstnerDisplacement(waves, ux, uz, time, scale, _gerstnerTmp)[1];
}

/** Small deterministic hash to 0..1, for wave set spreads. */
function waveHash(i: number, seed: number): number {
    let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(seed + 7, 1597334677)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * A wave set for wind of `windSpeed` m/s blowing toward `directionDeg` (0 = +Z, 90 = +X), over `fetch`
 * metres of open water (Infinity = the open sea). Sverdrup-Munk-Bretschneider: the significant height and
 * peak period grow with wind and with fetch until the sea is fully developed. `scale` multiplies the
 * height, `choppiness` (0..1) the crest sharpness, `spread` (degrees) how far the waves fan around the
 * wind. Deterministic in `seed`.
 */
export function gerstnerWavesForWind(windSpeed: number, directionDeg: number, fetch: number,
                                     options: { scale?: number; choppiness?: number; spread?: number; seed?: number; count?: number } = {}): GerstnerWave[] {
    const U = Math.max(0, windSpeed);
    const scale = Math.max(0, options.scale ?? 1);
    if (U < 0.05 || scale <= 0) return [];
    const g = GERSTNER_G;
    // Fully developed (Pierson-Moskowitz) and fetch-limited (SMB) significant height and peak period.
    const hsFull = 0.21 * U * U / g, tpFull = 2 * Math.PI * U / (0.877 * g);
    const F = Number.isFinite(fetch) ? Math.max(1, fetch) : Infinity;
    const hsFetch = Number.isFinite(F) ? 0.0016 * U * Math.sqrt(F / g) : hsFull;
    const tpFetch = Number.isFinite(F) ? 0.286 * Math.cbrt(g * F / (U * U)) * U / g : tpFull;
    const hs = Math.min(hsFull, hsFetch) * scale;
    const tp = Math.max(0.3, Math.min(tpFull, tpFetch));
    const lp = g * tp * tp / (2 * Math.PI);
    const count = Math.max(1, Math.min(GERSTNER_MAX_WAVES, Math.round(options.count ?? GERSTNER_MAX_WAVES)));
    const spread = (options.spread ?? 35) * Math.PI / 180;
    const chop = Math.max(0, Math.min(1, options.choppiness ?? 0.5));
    const seed = options.seed ?? 0;
    const base = directionDeg * Math.PI / 180;
    const waves: GerstnerWave[] = [];
    let weightSum = 0;
    const weights: number[] = [];
    for (let i = 0; i < count; i++) { const w = Math.pow(0.72, i); weights.push(w); weightSum += w; }
    for (let i = 0; i < count; i++) {
        const wavelength = lp * Math.pow(0.72, i);
        const angle = base + (waveHash(i, seed) * 2 - 1) * spread * (0.4 + 0.6 * i / Math.max(1, count - 1));
        // Half the significant height is the mean crest; shared by weight, longest waves biggest.
        const amplitude = 0.5 * hs * weights[i] / weightSum * 1.6;
        waves.push({
            // The set's steepness is shared across its waves (see gerstnerDisplacement), so the summed
            // crests never loop over themselves.
            dirX: Math.sin(angle), dirZ: Math.cos(angle), amplitude, wavelength, steepness: chop,
            phase: waveHash(i + 31, seed) * Math.PI * 2,
        });
    }
    return waves;
}
