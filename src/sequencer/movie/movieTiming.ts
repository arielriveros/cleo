import { haltonSequence } from '../../graphics/utils/halton';

/**
 * When a movie's frames and samples are taken (render/movieCapture.ts draws them, renderMovie.ts steps to them).
 *
 * Every time here is derived from a frame's INDEX, never accumulated and never measured: frame `i` starts at
 * exactly `i / fps` seconds of the movie, its timestamp in the file is that time rounded to microseconds, and
 * its samples sit at fixed fractions of its shutter. However long a frame takes to draw, none of it can
 * reach the file — which is what "no frame-time lag" means for a rendered movie.
 */

/** A frame rate as an exact ratio: 30000/1001 for 29.97, 24/1 for 24. */
export interface FrameRate {
    num: number;
    den: number;
}

/** The NTSC rates, held exactly: their decimal spellings are approximations. */
const NTSC: ReadonlyArray<[number, number]> = [[23.976, 24000], [29.97, 30000], [47.952, 48000], [59.94, 60000], [119.88, 120000]];

/**
 * `fps` as an exact ratio. The NTSC rates (23.976, 29.97, 59.94 …) become n×1000/1001; anything else is
 * taken to the thousandth, so 12.5 is 25/2.
 */
export function frameRateOf(fps: number): FrameRate {
    if (!(fps > 0) || !Number.isFinite(fps)) throw new Error(`A frame rate must be a positive number (got ${fps})`);
    for (const [approx, num] of NTSC) if (Math.abs(fps - approx) < 0.0015) return { num, den: 1001 };
    let num = Math.round(fps * 1000), den = 1000;
    const g = gcd(num, den);
    num /= g; den /= g;
    return { num, den };
}

function gcd(a: number, b: number): number {
    while (b) [a, b] = [b, a % b];
    return Math.abs(a);
}

/** The rate as a plain number of frames a second. */
export function framesPerSecond(rate: FrameRate): number {
    return rate.num / rate.den;
}

/** Where frame `index` starts on the movie's clock, in seconds. */
export function frameStart(index: number, rate: FrameRate): number {
    return (index * rate.den) / rate.num;
}

/** Frame `index`'s presentation timestamp, in whole microseconds (what WebCodecs and MP4 carry). */
export function frameTimestampUs(index: number, rate: FrameRate): number {
    return Math.round((index * rate.den * 1e6) / rate.num);
}

/**
 * Frame `index`'s duration in microseconds: up to the next one's timestamp, so the durations of any run of
 * frames sum to exactly the run's length, with no rounding drift.
 */
export function frameDurationUs(index: number, rate: FrameRate): number {
    return frameTimestampUs(index + 1, rate) - frameTimestampUs(index, rate);
}

/** How a movie frame is sampled. */
export interface SampleSettings {
    /** Renders averaged into each frame, at least 1. */
    samples: number;
    /**
     * The shutter, as a fraction of the frame (a 180° shutter is 0.5): how much of the frame's time its
     * samples spread across. 0 takes every sample at the frame's start, so they only anti-alias.
     */
    shutter: number;
}

/** The shutter fraction for a shutter angle in degrees, clamped to [0, 360]. */
export function shutterFromAngle(degrees: number): number {
    return Math.min(360, Math.max(0, Number.isFinite(degrees) ? degrees : 0)) / 360;
}

/**
 * Where sample `k` of frame `index` is taken, in movie seconds: spread evenly over the open shutter from the
 * frame's start, `t_i + k · shutter / (samples · fps)`. The last sample stops one sample short of the
 * shutter closing, so with a 360° shutter consecutive frames tile time exactly.
 */
export function sampleTime(index: number, k: number, rate: FrameRate, s: SampleSettings): number {
    const n = Math.max(1, Math.floor(s.samples));
    const shutter = Math.min(1, Math.max(0, s.shutter));
    return frameStart(index, rate) + (k * shutter * rate.den) / (n * rate.num);
}

const jitterCache = new Map<number, Float32Array>();

/**
 * Sample `k`'s sub-pixel offset among `samples` (pixels, each component within ±0.5): Halton(2, 3),
 * recentred to average zero, so the frame's mean is a box filter over its pixel with no bias. The same
 * pattern every frame — a pattern that moved from frame to frame would shimmer at the edges. One sample
 * is not jittered at all (null): it is the picture Play shows, anti-aliased the way Play does it.
 */
export function sampleJitter(k: number, samples: number): [number, number] | null {
    const n = Math.max(1, Math.floor(samples));
    if (n <= 1) return null;
    let set = jitterCache.get(n);
    if (!set) { set = haltonSequence(n); jitterCache.set(n, set); }
    const i = ((Math.floor(k) % n) + n) % n;
    return [set[i * 2], set[i * 2 + 1]];
}

/**
 * How many frames a movie of `seconds` takes at `rate`: every frame that starts before the end. A
 * sequence played at time ×1 from In to Out has exactly this many; time-scale keys change it, which is
 * why the render ends on the sequence and uses this only to estimate.
 */
export function frameCountFor(seconds: number, rate: FrameRate): number {
    if (!(seconds > 0)) return 0;
    return Math.ceil((seconds * rate.num) / rate.den - 1e-9);
}
