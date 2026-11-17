import { waterNoise as surfNoise, waveOmega, waveSigma, type WaterWave, type WaveSurface } from './waves';

// SURF: the sea's waves as they run in over a beach. Offshore the wave set (waves.ts) is the sea; over
// the last few metres of depth it is shaved off (waterSurface.ts waveAt: no taller than 0.4 of the depth) and
// this takes over: one train of breakers at the sea's own period, slowed by the shallows so its crests bunch
// up and follow the depth contours as real surf does (refraction), growing as the water shoals (Green's law,
// height ~ depth^-1/4), breaking where it stands 0.78 of the depth tall, then running up the beach as a bore
// and draining back. Its crests steepen and lean shoreward as it breaks.
//
// The travel time to the shore over a planar beach (depth h = slope * distance) is 2 * distance / sqrt(g h):
// with the shore grid's distance and depth (water/waterInfo.ts buildOceanShoreInfo) the phase is that time
// times the sea's frequency, so every crest moves in at the local shallow-water speed sqrt(g h).
//
// This file and water.wgsl `surfAt` are twins, operation for operation, so a floater in the surf rides the
// breakers the renderer draws. Domain math kept here (not core/math.ts): the physics worker imports it.

const G = 9.81;
/** Shallowest depth the speed is taken at (metres): the swash sheet on the beach moves as one. */
const SURF_MIN_DEPTH = 0.1;
/** Breakers stand this share of the depth tall when they break. */
const BREAK_RATIO = 0.78;

/** The sea's surf, from its waves. */
export interface SurfWave {
    /** Rad/s on the waves' clock: the waves' energy-weighted frequency (the sea's period). */
    omega: number;
    /** Metres: half the sea's significant height (the breakers' amplitude before the beach shapes them). */
    amplitude: number;
}

/** The surf of a sea of `waves` at `heightScale` (the wind's share of their height). */
export function surfOf(waves: readonly WaterWave[], heightScale: number, out: SurfWave = { omega: 0, amplitude: 0 }): SurfWave {
    let e = 0, eo = 0;
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const a = w.amplitude * heightScale;
        const omega = waveOmega(6.283185307179586 / Math.max(0.01, w.wavelength));
        e += a * a; eo += a * a * omega;
    }
    out.omega = e > 0 ? eo / e : 0;
    // Half the significant height (4 sigma).
    out.amplitude = 2 * waveSigma(waves, heightScale);
    return out;
}

/** Seconds a crest takes from a point `edge` metres from the shore and `depth` deep to reach the shore. */
export function surfTravelTime(edge: number, depth: number): number {
    return 2 * Math.max(edge, 0) / Math.sqrt(G * Math.max(depth, SURF_MIN_DEPTH));
}

// The breakers' phase and height wander a little along the shore by waves.ts waterNoise (water.wgsl
// valueNoise), the same noise the shader reads.

/** What the surf does at a point (see surfAt). */
export interface SurfSample {
    /** Metres above the resting level. */
    height: number;
    /** Metres per second of the waves' clock the height changes at. */
    rate: number;
    /** d height / dx and / dz. */
    slopeX: number; slopeZ: number;
    /** 0 offshore of the surf, 1 where it breaks. */
    breaking: number;
    /** The breaker's phase (0 on a crest, growing behind it): where its foam trails. */
    phase: number;
    /** Metres: the breakers' length here, for band limiting. */
    wavelength: number;
}

/**
 * The surf at world (x, z) on the waves' clock `t`, `edge` metres from the shore and `depth` deep, the travel
 * time's gradient (s/m) being (tx, tz). Into `out`; zero where the water is too deep for surf.
 */
export function surfAt(s: SurfWave, x: number, z: number, t: number, edge: number, depth: number,
                       tx: number, tz: number, out: SurfSample): SurfSample {
    out.height = 0; out.rate = 0; out.slopeX = 0; out.slopeZ = 0; out.breaking = 0; out.phase = 0; out.wavelength = 1e4;
    if (!(s.amplitude > 0) || !(s.omega > 0)) return out;
    // Sets: the breakers come in groups of about seven, the groups differing along the shore.
    const group = 0.6 + 0.4 * Math.sin(s.omega * t / 7.3 + 6.2831853 * surfNoise(x / 90, z / 90));
    const a0 = s.amplitude * group;
    const hb = Math.max(2 * a0 / BREAK_RATIO, 0.05);
    const h = Math.max(depth, 0);
    if (h >= 8 * hb) return out;
    // In over four breaking depths, full from there, breaking at one.
    const inW = Math.min(1, Math.max(0, (8 * hb - h) / (4 * hb)));
    const fadeIn = inW * inW * (3 - 2 * inW);
    const b = Math.min(1, Math.max(0, (4 * hb - h) / (3 * hb)));
    const shoal = a0 * Math.pow(4 * hb / Math.max(h, hb), 0.25);
    const a = fadeIn * Math.min(shoal, BREAK_RATIO * 0.5 * h + 0.5 * a0);
    // The phase: the sea's frequency times the time left to the shore, the crests broken up along it.
    const theta = s.omega * (t + surfTravelTime(edge, depth)) + 2.5 * surfNoise(x / 37 + 17.3, z / 37);
    // The crest sharpens (trochoid-like) and leans shoreward as it breaks: phase distortion, monotonic.
    const q = 0.5 * b, k = 0.45 * b;
    const st = Math.sin(theta), ct = Math.cos(theta);
    const phase = theta + q * st + k * ct;
    const dPhase = 1 + q * ct - k * st;
    out.height = a * Math.cos(phase);
    const dh = -a * Math.sin(phase) * dPhase * s.omega;
    out.rate = dh;
    out.slopeX = dh * tx;
    out.slopeZ = dh * tz;
    out.breaking = b * fadeIn;
    out.phase = phase - 6.2831853 * Math.floor(phase / 6.2831853);
    out.wavelength = 6.2831853 * Math.sqrt(G * Math.max(h, SURF_MIN_DEPTH)) / s.omega;
    return out;
}

const _sample: SurfSample = { height: 0, rate: 0, slopeX: 0, slopeZ: 0, breaking: 0, phase: 0, wavelength: 0 };

/**
 * The surf added to the waves at a point (waterSurface.ts waterSpecColumn): its height, and the water's
 * motion in it, rising and falling and, in shallow water, running with the crest toward the shore at
 * height * sqrt(g / depth) (long-wave particle speed). `speed` is the waves' clock rate, as in waveSurfaceAt.
 */
export function addSurf(s: SurfWave, x: number, z: number, t: number, speed: number, edge: number, depth: number,
                        tx: number, tz: number, out: WaveSurface): void {
    const r = surfAt(s, x, z, t, edge, depth, tx, tz, _sample);
    if (r.height === 0 && r.rate === 0) return;
    out.height += r.height;
    out.vy += r.rate * speed;
    const len = Math.hypot(tx, tz);
    if (len > 1e-6) {
        const u = r.height * Math.sqrt(G / Math.max(depth, 0.3));
        out.vx -= u * tx / len;
        out.vz -= u * tz / len;
    }
}
