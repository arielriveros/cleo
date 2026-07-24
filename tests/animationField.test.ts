import { describe, it, expect } from 'vitest';
import { fieldWeights, rateScaleOf, AnimationField, AnimationFieldSample } from '../src/graphics/animationField';

// Weighting is the whole contract of a blend space: the Animator turns whatever comes out of fieldWeights
// straight into a pose, so a weight set that does not sum to 1 shows up as a character melting towards the
// bind pose, and a wrong bracket shows up as the wrong clip playing. None of it needs a GL context.

const axis = (min: number, max: number) => ({ name: 'x', min, max });

const field1D = (samples: AnimationFieldSample[], min = 0, max = 100): AnimationField =>
    ({ mode: '1d', xAxis: axis(min, max), samples });

const field2D = (samples: AnimationFieldSample[]): AnimationField =>
    ({ mode: '2d', xAxis: { name: 'x', min: 0, max: 100 }, yAxis: { name: 'y', min: 0, max: 100 }, samples });

const sum = (ws: { weight: number }[]) => ws.reduce((a, w) => a + w.weight, 0);
const byClip = (ws: { sample: AnimationFieldSample; weight: number }[]) =>
    Object.fromEntries(ws.map(w => [w.sample.clipName, w.weight]));

describe('fieldWeights — shared', () => {
    it('returns nothing for an empty field', () => {
        expect(fieldWeights(field1D([]), 50)).toEqual([]);
        expect(fieldWeights(field2D([]), 50, 50)).toEqual([]);
    });

    it('gives a lone sample full weight regardless of the probe', () => {
        const f = field1D([{ clipName: 'idle', x: 10 }]);
        expect(fieldWeights(f, -999)).toEqual([{ sample: f.samples[0], weight: 1 }]);
        expect(fieldWeights(f, 999)).toEqual([{ sample: f.samples[0], weight: 1 }]);
    });

    // A row the user has added but not yet pointed at a clip must not steal weight — that would leave a
    // hole in the blend rather than simply not contributing.
    it('ignores samples with no clip bound', () => {
        const f = field1D([{ clipName: 'idle', x: 0 }, { clipName: '', x: 50 }, { clipName: 'run', x: 100 }]);
        const w = fieldWeights(f, 50);
        expect(w.map(x => x.sample.clipName).sort()).toEqual(['idle', 'run']);
        expect(sum(w)).toBeCloseTo(1);
    });
});

describe('fieldWeights — 1D', () => {
    const f = field1D([
        { clipName: 'idle', x: 0 },
        { clipName: 'walk', x: 50 },
        { clipName: 'run', x: 100 },
    ]);

    it('cross-fades linearly between the bracketing pair', () => {
        const w = byClip(fieldWeights(f, 25));
        expect(w.idle).toBeCloseTo(0.5);
        expect(w.walk).toBeCloseTo(0.5);
        expect(w.run).toBeUndefined(); // the far sample must not leak in
    });

    it('gives an exact hit full weight to that sample alone', () => {
        expect(fieldWeights(f, 50)).toHaveLength(1);
        expect(fieldWeights(f, 50)[0].sample.clipName).toBe('walk');
    });

    // Clamping, not extrapolation: past the end of the authored range the last clip simply holds.
    it('pins to the end samples outside the authored span', () => {
        expect(byClip(fieldWeights(f, -20))).toEqual({ idle: 1 });
        expect(byClip(fieldWeights(f, 500))).toEqual({ run: 1 });
    });

    it('does not care what order the samples were authored in', () => {
        const shuffled = field1D([
            { clipName: 'run', x: 100 },
            { clipName: 'idle', x: 0 },
            { clipName: 'walk', x: 50 },
        ]);
        expect(byClip(fieldWeights(shuffled, 25))).toEqual(byClip(fieldWeights(f, 25)));
    });

    it('always sums to 1 across the range', () => {
        for (let x = -10; x <= 110; x += 7) expect(sum(fieldWeights(f, x))).toBeCloseTo(1);
    });

    // Two samples at the same coordinate divide by a zero span.
    it('survives duplicated coordinates', () => {
        const dup = field1D([{ clipName: 'a', x: 50 }, { clipName: 'b', x: 50 }]);
        const w = fieldWeights(dup, 50);
        expect(sum(w)).toBeCloseTo(1);
        expect(w.every(x => Number.isFinite(x.weight))).toBe(true);
    });
});

describe('fieldWeights — 2D gradient band', () => {
    const f = field2D([
        { clipName: 'fwd', x: 50, y: 100 },
        { clipName: 'back', x: 50, y: 0 },
        { clipName: 'left', x: 0, y: 50 },
        { clipName: 'right', x: 100, y: 50 },
    ]);

    it('always normalizes to 1 across the plane', () => {
        for (let x = -20; x <= 120; x += 13) {
            for (let y = -20; y <= 120; y += 13) {
                expect(sum(fieldWeights(f, x, y))).toBeCloseTo(1);
            }
        }
    });

    it('gives an exact hit full weight to that sample', () => {
        expect(byClip(fieldWeights(f, 50, 100))).toEqual({ fwd: 1 });
    });

    it('splits evenly at the midpoint of two adjacent samples', () => {
        const w = byClip(fieldWeights(f, 25, 75)); // halfway between fwd and left
        expect(w.fwd).toBeCloseTo(w.left);
        expect(w.back ?? 0).toBeLessThan(w.fwd);
        expect(w.right ?? 0).toBeLessThan(w.fwd);
    });

    it('weights the nearer sample more heavily', () => {
        const w = byClip(fieldWeights(f, 50, 90));
        expect(w.fwd).toBeGreaterThan(w.back ?? 0);
    });

    // Normalization matters precisely because axes have wildly different units. A Speed axis of 0..600 and
    // a Direction axis of -180..180 must contribute equally per unit of AUTHORED range, not per raw unit.
    it('normalizes each axis by its own range', () => {
        const wide: AnimationField = {
            mode: '2d',
            xAxis: { name: 'speed', min: 0, max: 600 },
            yAxis: { name: 'dir', min: -180, max: 180 },
            samples: [
                { clipName: 'a', x: 0, y: -180 },
                { clipName: 'b', x: 600, y: -180 },
                { clipName: 'c', x: 0, y: 180 },
                { clipName: 'd', x: 600, y: 180 },
            ],
        };
        // Dead centre of both ranges: all four corners are equidistant in normalized space.
        const w = fieldWeights(wide, 300, 0);
        expect(sum(w)).toBeCloseTo(1);
        for (const entry of w) expect(entry.weight).toBeCloseTo(0.25);
    });

    it('survives coincident samples', () => {
        const dup = field2D([{ clipName: 'a', x: 50, y: 50 }, { clipName: 'b', x: 50, y: 50 }]);
        const w = fieldWeights(dup, 50, 50);
        expect(sum(w)).toBeCloseTo(1);
        expect(w.every(x => Number.isFinite(x.weight))).toBe(true);
    });

    it('survives collinear samples (no triangle to interpolate inside)', () => {
        const line = field2D([
            { clipName: 'a', x: 0, y: 50 },
            { clipName: 'b', x: 50, y: 50 },
            { clipName: 'c', x: 100, y: 50 },
        ]);
        for (let x = -10; x <= 110; x += 11) {
            const w = fieldWeights(line, x, 50);
            expect(sum(w)).toBeCloseTo(1);
            expect(w.every(e => Number.isFinite(e.weight))).toBe(true);
        }
    });

    // A degenerate axis is reachable just by typing in the editor's min/max fields.
    it('survives a zero-width axis without producing NaN', () => {
        const flat: AnimationField = {
            mode: '2d',
            xAxis: { name: 'x', min: 5, max: 5 },
            yAxis: { name: 'y', min: 0, max: 100 },
            samples: [{ clipName: 'a', x: 5, y: 0 }, { clipName: 'b', x: 5, y: 100 }],
        };
        const w = fieldWeights(flat, 5, 50);
        expect(sum(w)).toBeCloseTo(1);
        expect(w.every(e => Number.isFinite(e.weight))).toBe(true);
    });
});

describe('rateScaleOf', () => {
    // A 0 or negative rate scale would divide the weighted duration into Infinity/NaN and freeze the phase.
    it('falls back to 1 for absent, zero and negative values', () => {
        expect(rateScaleOf({ clipName: 'a', x: 0 })).toBe(1);
        expect(rateScaleOf({ clipName: 'a', x: 0, rateScale: 0 })).toBe(1);
        expect(rateScaleOf({ clipName: 'a', x: 0, rateScale: -2 })).toBe(1);
    });

    it('passes a positive value through', () => {
        expect(rateScaleOf({ clipName: 'a', x: 0, rateScale: 0.5 })).toBe(0.5);
    });
});
