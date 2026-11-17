// A SEA'S WAVES, after afl_ext's "Very fast procedural ocean" (Shadertoy MdXyzX, MIT licence, see
// THIRD_PARTY_NOTICES.md): a sum of waves each shaped exp(sin(theta) - 1), a sharp crest over a broad flat
// trough as wind waves are, running in scattered directions, every wave DRAGGING the shorter ones after it:
// the point the next wave is evaluated at slides along the wave by its slope, so the small waves crowd onto
// the crests of the big ones and stretch out in their troughs. That coupling is what makes a sum of waves
// read as water instead of as a pattern.
//
// And from TDM's Seascape (Shadertoy Ms2SD1), the technique only: every wave's crest is bent by a smooth noise
// at the wave's own scale (Seascape moves each octave's coordinates by noise before its sine), so the crests
// break into the short, staggered segments of a real wind sea instead of lining up into a lattice.
//
// What is measured rather than tuned: the longest wave and the set's height come from the wind and the
// fetch (Pierson-Moskowitz fully developed, Sverdrup-Munk-Bretschneider fetch-limited); each wave is 0.82 of
// the length of the last, down to capillary ripples of 1.5 cm; every wave runs at its own speed (deep water,
// with surface tension for the shortest); and the height is shared out so the whole set has the sea's
// significant height AND the mean square slope Cox and Munk measured from sun glitter for that wind
// (0.003 + 0.00512 per m/s). The shape's mean is taken off, so the waves ride the water's resting level.
//
// This CPU half and water.wgsl (`waveHeight`, `waveStack`) are twins, operation for operation, so a body the
// physics floats rides exactly the surface the renderer draws. Domain math kept here (not core/math.ts): the
// physics worker imports it, and its bundle may import nothing outside src/physics.

/** One wave of a set. */
export interface WaterWave {
    /** Unit XZ direction it travels. */
    dirX: number; dirZ: number;
    /**
     * Metres: the wave's scale. Its crest stands {@link WAVE_CREST} of it above the resting level, its
     * trough {@link WAVE_MEAN} - e^-2 (0.33) of it below.
     */
    amplitude: number;
    /** Metres, crest to crest. */
    wavelength: number;
    /**
     * How far it drags the shorter waves along it, per metre of its amplitude per unit of its slope: 0 none,
     * 2 the waves crowding hard onto its crests.
     */
    drag: number;
}

/** Waves a set holds at most (the shader's array length). */
export const WAVE_MAX = 40;
/** Each wave's length against the one before. */
export const WAVE_RATIO = 0.82;
/** The shortest wave (metres): capillary ripples. */
export const WAVE_SHORTEST = 0.015;

const G = 9.81;
/** Surface tension over density (m^3/s^2): water's 0.074 N/m over 1000 kg/m^3. */
const TENSION = 7.4e-5;

/** The mean of exp(sin(theta) - 1) over a cycle: e^-1 I0(1). */
export const WAVE_MEAN = 0.46575961;
/** How far a wave's crest stands above the resting level, per metre of amplitude. */
export const WAVE_CREST = 1 - WAVE_MEAN;
/** The variance of exp(sin(theta) - 1): e^-2 I0(2) - WAVE_MEAN^2. */
const SHAPE_VARIANCE = 0.09157631;
/** The mean square of its derivative, exp(sin(theta) - 1) cos(theta): e^-2 I1(2) / 2. */
export const WAVE_SLOPE_VARIANCE = 0.10763481;
const SLOPE_VARIANCE = WAVE_SLOPE_VARIANCE;

/** Rad/s of a wave `k` rad/m long: gravity, and surface tension for ripples. */
export function waveOmega(k: number): number {
    return Math.sqrt(G * k + TENSION * k * k * k);
}

/** Radians a wave's crest is bent by, across the noise's 0..1. */
export const WAVE_BEND = 1.6;

// water.wgsl hash12 / valueNoise, in doubles. The noise only bends the crests, so the last float bits the GPU
// drops do not matter.
const fract = (v: number) => v - Math.floor(v);
function hash12(x: number, y: number): number {
    let p0 = fract(x * 0.1031), p1 = fract(y * 0.1031), p2 = fract(x * 0.1031);
    const d = p0 * (p1 + 33.33) + p1 * (p2 + 33.33) + p2 * (p0 + 33.33);
    p0 += d; p1 += d; p2 += d;
    return fract((p0 + p1) * p2);
}

/** Smooth value noise in 0..1 (water.wgsl valueNoise). */
export function waterNoise(x: number, y: number): number {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    const a = hash12(ix, iy), b = hash12(ix + 1, iy), c = hash12(ix, iy + 1), d = hash12(ix + 1, iy + 1);
    return (a + (b - a) * ux) + ((c + (d - c) * ux) - (a + (b - a) * ux)) * uy;
}

/** How wave `i`, `lambda` metres long, has its crest bent at world (x, z): radians on its phase. */
export function waveBend(i: number, lambda: number, x: number, z: number): number {
    return WAVE_BEND * (waterNoise(x / lambda + i * 17.3, z / lambda + i * 7.1) - 0.5);
}

/** Wave `i`'s phase: spread by the golden ratio, so no two waves crest together at the origin. */
export function wavePhase(i: number): number {
    const v = i * 0.61803398875 + 0.1;
    return (v - Math.floor(v)) * 6.283185307179586;
}

/**
 * The share of a wave `lambda` metres long a look's ripple strength `strength` keeps (water.wgsl reads it
 * folded into the amplitude): the waves under a metre only, so physics, which never reads those, is untouched.
 */
export function rippleShare(lambda: number, strength: number): number {
    const t = Math.min(1, Math.max(0, (lambda - 0.5) / 0.5));
    return strength + (1 - strength) * t * t * (3 - 2 * t);
}

/** How much of a wave `lambda` metres long a grid of `cell` metres draws (water.wgsl bandLimit). */
export function waveBandLimit(lambda: number, cell: number): number {
    const t = Math.min(1, Math.max(0, (lambda - 2 * cell) / (2 * cell)));
    return t * t * (3 - 2 * t);
}

/**
 * The grid physics evaluates the waves for (metres): the finest the renderer draws an ocean with (16 m tiles of
 * 32 quads), so near the camera, where bodies are watched, they ride the very mesh that is drawn.
 */
export const PHYSICS_WAVE_CELL = 0.5;

/** What the waves do over a WORLD point (x, z). */
export interface WaveSurface {
    /** Metres above the resting level. */
    height: number;
    /** The water's velocity there (m/s): the waves' orbits, carrying what floats on a crest forward. */
    vx: number; vy: number; vz: number;
    /** Amplitude-weighted wavenumber: how fast that motion fades below the surface (e^(-k depth)). */
    k: number;
}

/**
 * The waves over world (x, z) at `time` on the waves' own clock. `scale` multiplies every amplitude (wind,
 * shoaling); `speed` is how fast the clock runs against real time, which the velocities are scaled by;
 * `cell` the grid they are band-limited to (as the vertex stage limits them to its mesh).
 */
export function waveSurfaceAt(waves: readonly WaterWave[], x: number, z: number, time: number, scale: number,
                              speed: number, cell: number, out: WaveSurface): WaveSurface {
    out.height = 0; out.vx = 0; out.vy = 0; out.vz = 0; out.k = 0;
    if (!waves.length || !(scale > 0)) return out;
    let px = x, pz = z;
    // How the sample point moves with time (the drag of the waves already summed moves with them).
    let ptx = 0, ptz = 0;
    let ka = 0, as = 0;
    for (let i = 0; i < waves.length; i++) {
        const w = waves[i];
        const band = waveBandLimit(w.wavelength, cell);
        if (band <= 0) break;   // shortest last: none after it are drawn either
        const k = 6.283185307179586 / Math.max(0.01, w.wavelength);
        const omega = waveOmega(k);
        const a = w.amplitude * scale * band;
        const theta = k * (w.dirX * px + w.dirZ * pz) - omega * time + wavePhase(i) + waveBend(i, w.wavelength, x, z);
        const s = Math.sin(theta), c = Math.cos(theta);
        const e = Math.exp(s - 1);
        const thetaT = -omega + k * (w.dirX * ptx + w.dirZ * ptz);
        out.height += a * (e - WAVE_MEAN);
        out.vy += a * e * c * thetaT * speed;
        // Linear theory: at the surface the water moves along the wave at omega times its height there.
        const u = omega * a * (e - WAVE_MEAN) * speed;
        out.vx += w.dirX * u;
        out.vz += w.dirZ * u;
        // The drag: the next waves are read where this one has carried the water.
        const shift = -w.drag * a * e * c;
        const dShift = -w.drag * a * e * (c * c - s);
        px += w.dirX * shift; pz += w.dirZ * shift;
        ptx += w.dirX * dShift * thetaT; ptz += w.dirZ * dShift * thetaT;
        ka += k * a; as += a;
    }
    out.k = as > 0 ? ka / as : 0;
    return out;
}

const _surface: WaveSurface = { height: 0, vx: 0, vy: 0, vz: 0, k: 0 };

/** Height of the waves above the resting level at world (x, z), at physics resolution. */
export function waveHeightAt(waves: readonly WaterWave[], x: number, z: number, time: number, scale: number,
                             cell = PHYSICS_WAVE_CELL): number {
    return waveSurfaceAt(waves, x, z, time, scale, 1, cell, _surface).height;
}

/** Standard deviation of the set's height (metres): a quarter of its significant height. */
export function waveSigma(waves: readonly WaterWave[], scale = 1): number {
    let v = 0;
    for (const w of waves) v += (w.amplitude * scale) ** 2;
    return Math.sqrt(v * SHAPE_VARIANCE);
}

/** The highest the set can stand above its resting level (every crest at once: a bound, never reached). */
export function waveReach(waves: readonly WaterWave[], scale = 1): number {
    let s = 0;
    for (const w of waves) s += w.amplitude * scale;
    return s * WAVE_CREST;
}

/**
 * A tall crest of the set (metres above the resting level): 0.7 of the significant height, about the
 * highest one in a few hundred. What a wave grows to before shallow water trips it.
 */
export function waveCrest(waves: readonly WaterWave[], scale = 1): number {
    return 2.8 * waveSigma(waves, scale);
}

/** The set's mean square slope (both axes): Cox and Munk's figure, at full height. */
export function waveSlopeVariance(waves: readonly WaterWave[], scale = 1): number {
    let v = 0;
    for (const w of waves) v += (6.283185307179586 / w.wavelength * w.amplitude * scale) ** 2;
    return v * SLOPE_VARIANCE;
}

/**
 * How a set shares its height among its waves: `count` waves from `longest` metres down by WAVE_RATIO, the
 * first `a0` in amplitude and each `fall` of the last. The set's height variance is the sea's (Hs / 4)^2 for
 * any fall; its slope variance grows with the fall, so the fall is solved for the slope variance `slope`.
 */
function shareHeight(longest: number, hs: number, slope: number, most?: number): { count: number; fall: number; a0: number } {
    const limit = Math.max(1, Math.min(WAVE_MAX, Math.round(most ?? WAVE_MAX)));
    const count = Math.max(1, Math.min(limit, Math.floor(Math.log(WAVE_SHORTEST / longest) / Math.log(WAVE_RATIO)) + 1));
    const k0 = 2 * Math.PI / longest;
    const sigma2 = (hs / 4) ** 2;
    const slopeFor = (fall: number) => {
        let sh = 0, ss = 0;
        for (let i = 0; i < count; i++) {
            const a2 = fall ** (2 * i);
            sh += a2;
            ss += a2 / WAVE_RATIO ** (2 * i);
        }
        return { a0: Math.sqrt(sigma2 / (SHAPE_VARIANCE * sh)), mss: sigma2 / sh * k0 * k0 * ss * SLOPE_VARIANCE / SHAPE_VARIANCE };
    };
    let lo = 0.3, hi = 0.999;
    for (let it = 0; it < 48; it++) {
        const mid = 0.5 * (lo + hi);
        if (slopeFor(mid).mss < slope) lo = mid; else hi = mid;
    }
    const fall = 0.5 * (lo + hi);
    return { count, fall, a0: slopeFor(fall).a0 };
}

// ---- the waves a CURRENT raises (a river's) -----------------------------------------------------------------
//
// Running water makes its own waves: the bed's roughness and every bend and rock throw the flow about, and
// what shows on top is a chop that goes with the current. Two measures set it, both the flow's own:
//  - its longest wave is the one that can stand still against the current, whose own speed (sqrt(g L / 2 pi)
//    in deep water) is the water's: L = 2 pi v^2 / g, 0.6 m at 1 m/s, 2.6 m at 2 m/s, 5.8 m at 3;
//  - its height is a share of the flow's velocity head, v^2 / 2g (what the water would rise to if stopped):
//    a few centimetres at 1 m/s, a hand's width at 3.
// The waves run every way (no wind picks a heading), and the set is as rough as a breezy sea's. It is built
// for one speed, the river's own (`reference`), and scaled where the water runs faster or slower
// (flowWaveScale): both measures go with v^2, so the scale does.

/** The share of the velocity head a current's waves stand (significant height over v^2 / 2g). */
const CURRENT_WAVE_SHARE = 0.35;
/** The mean square slope of a current's chop: Cox and Munk's for a 7 m/s wind. */
const CURRENT_WAVE_SLOPE = 0.039;
/** The longest wave a current's set is given, metres (a deep, fast river's standing waves). */
const CURRENT_WAVE_LONGEST = 6;
/** How still the water of a current's set is where it does not move at all. */
export const CURRENT_WAVE_CALM = 0.04;

/**
 * The waves of water running at `speed` m/s (see above): `scale` multiplies their height, `choppiness` (0..1)
 * how hard the long ones drag the short ones onto their crests. Deterministic in `seed`.
 */
export function wavesForCurrent(speed: number, options: { scale?: number; choppiness?: number; seed?: number; count?: number } = {}): WaterWave[] {
    const v = Math.max(0, speed);
    const scale = Math.max(0, options.scale ?? 1);
    if (v < 0.05 || scale <= 0) return [];
    const longest = Math.min(CURRENT_WAVE_LONGEST, Math.max(WAVE_SHORTEST * 4, 2 * Math.PI * v * v / G));
    const hs = CURRENT_WAVE_SHARE * v * v / (2 * G);
    const { count, fall, a0 } = shareHeight(longest, hs, CURRENT_WAVE_SLOPE, options.count);
    const drag = 2 * Math.max(0, Math.min(1, options.choppiness ?? 0.5));
    const seed = options.seed ?? 0;
    const waves: WaterWave[] = [];
    for (let i = 0; i < count; i++) {
        const angle = waveHash(i, seed + 101) * 2 * Math.PI;
        waves.push({ dirX: Math.sin(angle), dirZ: Math.cos(angle), amplitude: a0 * fall ** i * scale, wavelength: longest * WAVE_RATIO ** i, drag });
    }
    return waves;
}

/**
 * What a current's waves are scaled by where the water runs at `speed` and the set was built for `reference`
 * (water.wgsl flowWaveScale): with the square of the speed, as their length and height go, up to 1.6; nearly
 * still where the water is. 1 for water with no such set (`reference` 0).
 */
export function flowWaveScale(speed: number, reference: number): number {
    if (!(reference > 0)) return 1;
    const s = speed / reference;
    return Math.max(CURRENT_WAVE_CALM, Math.min(1.6, s * s));
}

/** Seconds a patch of waves is carried by the current before it is swapped for a fresh one (water.wgsl FLOW_CYCLE). */
export const FLOW_CYCLE = 3;

const _flowA: WaveSurface = { height: 0, vx: 0, vy: 0, vz: 0, k: 0 };
const _flowB: WaveSurface = { height: 0, vx: 0, vy: 0, vz: 0, k: 0 };

/**
 * {@link waveSurfaceAt} for water moving at (flowX, flowZ) m/s: the waves are carried by the current, as the
 * surface draws them (water.wgsl flowPhases). A wave field carried rigidly would shear apart where the
 * current varies, so two copies are read, each carried for FLOW_CYCLE seconds and then put back, half a cycle
 * apart, and cross-faded so neither is seen at its jump (a flow map's two phases); they are blended to keep
 * their height (the sum of two unlike fields weighted a and b stands sqrt(a^2 + b^2) as tall). Each place
 * runs its cycle at its own offset (a slow noise), so a river does not pulse as a whole.
 */
export function waveSurfaceInFlow(waves: readonly WaterWave[], x: number, z: number, time: number, scale: number, speed: number,
                                  cell: number, flowX: number, flowZ: number, out: WaveSurface): WaveSurface {
    if (flowX * flowX + flowZ * flowZ < 1e-6) return waveSurfaceAt(waves, x, z, time, scale, speed, cell, out);
    const jitter = waterNoise(x * 0.15, z * 0.15);
    const u0 = time / FLOW_CYCLE + jitter, u1 = u0 + 0.5;
    const ph0 = u0 - Math.floor(u0), ph1 = u1 - Math.floor(u1);
    const w1 = Math.abs(ph0 * 2 - 1), w0 = 1 - w1;
    const norm = 1 / Math.sqrt(w0 * w0 + w1 * w1);
    const a = waveSurfaceAt(waves, x - flowX * (ph0 - 0.5) * FLOW_CYCLE, z - flowZ * (ph0 - 0.5) * FLOW_CYCLE, time, scale, speed, cell, _flowA);
    const b = waveSurfaceAt(waves, x - flowX * (ph1 - 0.5) * FLOW_CYCLE + 3.7, z - flowZ * (ph1 - 0.5) * FLOW_CYCLE + 1.9, time, scale, speed, cell, _flowB);
    out.height = (a.height * w0 + b.height * w1) * norm;
    out.vx = (a.vx * w0 + b.vx * w1) * norm; out.vy = (a.vy * w0 + b.vy * w1) * norm; out.vz = (a.vz * w0 + b.vz * w1) * norm;
    out.k = a.k * w0 + b.k * w1;
    return out;
}

/** Small deterministic hash to 0..1, for the directions' spread. */
function waveHash(i: number, seed: number): number {
    let h = (Math.imul(i + 1, 2654435761) ^ Math.imul(seed + 7, 1597334677)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Significant height (m) and peak wavelength (m) of a sea under `windSpeed` m/s over `fetch` metres. */
export function seaState(windSpeed: number, fetch: number): { hs: number; peak: number } {
    const U = Math.max(0, windSpeed);
    // Fully developed (Pierson-Moskowitz) and fetch-limited (SMB) significant height and peak period.
    const hsFull = 0.21 * U * U / G, tpFull = 2 * Math.PI * U / (0.877 * G);
    const F = Number.isFinite(fetch) ? Math.max(1, fetch) : Infinity;
    const hsFetch = Number.isFinite(F) ? 0.0016 * U * Math.sqrt(F / G) : hsFull;
    const tpFetch = Number.isFinite(F) && U > 0 ? 0.286 * Math.cbrt(G * F / (U * U)) * U / G : tpFull;
    const tp = Math.max(0.3, Math.min(tpFull, tpFetch));
    return { hs: Math.min(hsFull, hsFetch), peak: G * tp * tp / (2 * Math.PI) };
}

/**
 * The waves of a sea under wind of `windSpeed` m/s blowing toward `directionDeg` (0 = +Z, 90 = +X), over
 * `fetch` metres of open water (Infinity = the open sea). `scale` multiplies their height, `choppiness`
 * (0..1) how hard the long waves drag the short ones onto their crests, `spread` (degrees) how far the
 * longest fan round the wind (the shortest run every way). Deterministic in `seed`.
 */
export function wavesForWind(windSpeed: number, directionDeg: number, fetch: number,
                             options: { scale?: number; choppiness?: number; spread?: number; seed?: number; count?: number } = {}): WaterWave[] {
    const U = Math.max(0, windSpeed);
    const scale = Math.max(0, options.scale ?? 1);
    if (U < 0.05 || scale <= 0) return [];
    const { hs, peak } = seaState(U, fetch);
    const longest = Math.max(peak, WAVE_SHORTEST * 2);
    const { count, fall, a0 } = shareHeight(longest, hs, 0.003 + 0.00512 * U, options.count);
    const spreadDeg = options.spread ?? 50;
    const drag = 2 * Math.max(0, Math.min(1, options.choppiness ?? 0.5));
    const seed = options.seed ?? 0;
    const base = directionDeg * Math.PI / 180;
    const waves: WaterWave[] = [];
    for (let i = 0; i < count; i++) {
        // The longest waves run with the wind; the short ones, raised by every gust, run every way.
        const f = Math.min(1, i / Math.max(1, 0.6 * count));
        const spread = (spreadDeg + (170 - spreadDeg) * f * f * (3 - 2 * f)) * Math.PI / 180;
        const angle = base + (waveHash(i, seed) * 2 - 1) * spread;
        waves.push({
            dirX: Math.sin(angle), dirZ: Math.cos(angle),
            amplitude: a0 * fall ** i * scale,
            wavelength: longest * WAVE_RATIO ** i,
            drag,
        });
    }
    return waves;
}
