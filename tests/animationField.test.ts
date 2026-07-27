import { describe, it, expect } from 'vitest';
import {
    fieldWeights, rateScaleOf, phaseOffsetOf, coincidentSamples,
    AnimationField, AnimationFieldSample,
} from '../src/graphics/animationField';

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

// A heading axis closes on itself: -180 and +180 are the same direction. Without `wrap`, normalization is
// linear, so a character turning through that seam moves the probe across the ENTIRE axis in one frame and
// every weight in the field changes at once. That is the violent version of the jitter this exists to fix,
// so these tests are about continuity across the seam, not just about which clips come out.
describe('fieldWeights — wrapping axes', () => {
    const dirAxis = { name: 'Direction', min: -180, max: 180, wrap: true };

    const dir1D = (samples: AnimationFieldSample[]): AnimationField =>
        ({ mode: '1d', xAxis: dirAxis, samples });

    const dir2D = (samples: AnimationFieldSample[]): AnimationField => ({
        mode: '2d',
        xAxis: { name: 'Speed', min: 0, max: 100 },
        yAxis: dirAxis,
        samples,
    });

    const fwd = { clipName: 'fwd', x: 0 };
    const left = { clipName: 'left', x: -90 };
    const right = { clipName: 'right', x: 90 };
    const back = { clipName: 'back', x: 180 };

    it('1D: brackets across the seam instead of pinning to an end sample', () => {
        const f = dir1D([fwd, left, right, back]);
        // Halfway between 'right' (90) and 'back' (180) going one way round...
        expect(byClip(fieldWeights(f, 135))).toEqual({ right: 0.5, back: 0.5 });
        // ...and halfway between 'back' (180 === -180) and 'left' (-90) going the other. Unwrapped, -135 is
        // outside nothing and would bracket left/fwd or clamp — it must not reach 'fwd' at all.
        expect(byClip(fieldWeights(f, -135))).toEqual({ back: 0.5, left: 0.5 });
    });

    it('1D: crossing +/-180 changes every weight by a hair', () => {
        const f = dir1D([fwd, left, right, back]);
        const before = byClip(fieldWeights(f, 179.5));
        const after = byClip(fieldWeights(f, -179.5));

        // The bracketing PAIR does change across the seam — right|back becomes back|left, because that is
        // genuinely the next segment round the circle. What must not change is any clip's actual share: 'back'
        // holds ~0.99 either side, and the sliver hands over from 'right' to 'left'. Comparing over the union
        // of both key sets is the honest check; comparing key sets alone would fail on a correct result.
        for (const clip of new Set([...Object.keys(before), ...Object.keys(after)])) {
            expect(Math.abs((after[clip] ?? 0) - (before[clip] ?? 0))).toBeLessThan(0.02);
        }
        expect(after.back).toBeGreaterThan(0.98);
    });

    it('1D: without wrap the same crossing swaps the entire weight set', () => {
        const f: AnimationField = { mode: '1d', xAxis: { ...dirAxis, wrap: false }, samples: [fwd, left, right, back] };
        // This is the bug, pinned so the fix cannot be quietly reverted: 'back' owns +179.5, and one degree of
        // turn later the probe has fallen off the other end of the axis onto 'left'.
        expect(byClip(fieldWeights(f, 179.5))).toEqual({ right: expect.any(Number), back: expect.any(Number) });
        expect(Object.keys(byClip(fieldWeights(f, -179.5)))).toEqual(['left']);
    });

    it('2D: a wrapped Y axis measures the short way round', () => {
        const f = dir2D([
            { clipName: 'fwd', x: 100, y: 0 },
            { clipName: 'back', x: 100, y: 180 },
        ]);
        // A probe just past the seam is 5 degrees from 'back' and 175 from 'fwd', so 'back' must dominate.
        const w = byClip(fieldWeights(f, 100, -175));
        expect(w.back).toBeGreaterThan(w.fwd ?? 0);
        expect(sum(fieldWeights(f, 100, -175))).toBeCloseTo(1);
    });

    it('2D: weights stay continuous while the probe sweeps a full turn', () => {
        const f = dir2D([
            { clipName: 'fwd', x: 100, y: 0 },
            { clipName: 'left', x: 100, y: -90 },
            { clipName: 'right', x: 100, y: 90 },
            { clipName: 'back', x: 100, y: 180 },
        ]);
        // The seam must be no more of a discontinuity than any other step of the same size.
        let worst = 0;
        let prev = byClip(fieldWeights(f, 100, -180));
        for (let y = -179; y <= 180; y++) {
            const cur = byClip(fieldWeights(f, 100, y));
            for (const clip of ['fwd', 'left', 'right', 'back']) {
                worst = Math.max(worst, Math.abs((cur[clip] ?? 0) - (prev[clip] ?? 0)));
            }
            prev = cur;
        }
        expect(worst).toBeLessThan(0.05);
    });

    it('ignores wrap on a degenerate range rather than dividing by it', () => {
        const f: AnimationField = {
            mode: '1d',
            xAxis: { name: 'd', min: 0, max: 0, wrap: true },
            samples: [{ clipName: 'a', x: 0 }, { clipName: 'b', x: 0 }],
        };
        const w = fieldWeights(f, 0);
        expect(sum(w)).toBeCloseTo(1);
        expect(w.every(e => Number.isFinite(e.weight))).toBe(true);
    });
});

// Two samples on the same coordinate used to each claim a FULL share, so a duplicated point pulled the blend
// towards its clip and moved the true midpoint between it and its neighbours off where the plot drew it.
// This is not a corner case: a wrapping axis makes its two ends the same point, and the project's own README
// used to prescribe placing the backward clip at both +180 and -180.
describe('fieldWeights — coincident samples', () => {
    it('splits one sample’s worth of weight rather than counting each in full', () => {
        const single = field1D([{ clipName: 'a', x: 0 }, { clipName: 'b', x: 100 }]);
        const doubled = field1D([{ clipName: 'a', x: 0 }, { clipName: 'b', x: 100 }, { clipName: 'b2', x: 100 }]);

        // 1D brackets a pair, so use 2D where the gradient band sees every sample at once.
        const s2 = field2D([{ clipName: 'a', x: 0, y: 0 }, { clipName: 'b', x: 100, y: 0 }]);
        const d2 = field2D([
            { clipName: 'a', x: 0, y: 0 }, { clipName: 'b', x: 100, y: 0 }, { clipName: 'b2', x: 100, y: 0 },
        ]);
        const a = byClip(fieldWeights(s2, 50, 0));
        const d = byClip(fieldWeights(d2, 50, 0));

        // 'a' must keep exactly the share it had; the duplicated point splits b's share between its members.
        expect(d.a).toBeCloseTo(a.a, 10);
        expect(d.b + d.b2).toBeCloseTo(a.b, 10);
        expect(d.b).toBeCloseTo(d.b2, 10);
        expect(sum(fieldWeights(d2, 50, 0))).toBeCloseTo(1);

        // Unused in 1D, but assert the pair still normalizes so the setup above cannot rot silently.
        expect(sum(fieldWeights(single, 50))).toBeCloseTo(1);
        expect(sum(fieldWeights(doubled, 50))).toBeCloseTo(1);
    });

    it('treats the two ends of a wrapping axis as one point', () => {
        const dirAxis = { name: 'Direction', min: -180, max: 180, wrap: true };
        const mk = (samples: AnimationFieldSample[]): AnimationField =>
            ({ mode: '2d', xAxis: { name: 'Speed', min: 0, max: 100 }, yAxis: dirAxis, samples });

        const once = mk([
            { clipName: 'fwd', x: 100, y: 0 },
            { clipName: 'side', x: 100, y: 90 },
            { clipName: 'back', x: 100, y: 180 },
        ]);
        // The old advice: the same backward clip authored at BOTH ends of the axis.
        const twice = mk([
            { clipName: 'fwd', x: 100, y: 0 },
            { clipName: 'side', x: 100, y: 90 },
            { clipName: 'back', x: 100, y: 180 },
            { clipName: 'back2', x: 100, y: -180 },
        ]);

        // At 135 — halfway between side and back — the duplicate must not tip the balance.
        const a = byClip(fieldWeights(once, 100, 135));
        const b = byClip(fieldWeights(twice, 100, 135));
        expect(b.side).toBeCloseTo(a.side, 6);
        expect((b.back ?? 0) + (b.back2 ?? 0)).toBeCloseTo(a.back, 6);
    });

    it('reports coincident groups for the authoring warning', () => {
        const dirAxis = { name: 'Direction', min: -180, max: 180, wrap: true };
        const f: AnimationField = {
            mode: '2d', xAxis: { name: 'Speed', min: 0, max: 100 }, yAxis: dirAxis,
            samples: [
                { clipName: 'fwd', x: 100, y: 0 },
                { clipName: 'back', x: 100, y: 180 },
                { clipName: 'back2', x: 100, y: -180 },
            ],
        };
        // +180 and -180 draw at opposite edges of the plot while being the same point — exactly the case a
        // user cannot see and therefore has to be told about.
        expect(coincidentSamples(f)).toEqual([[1, 2]]);

        f.yAxis = { ...dirAxis, wrap: false };
        expect(coincidentSamples(f)).toEqual([]);   // without wrap they really are two different points
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

describe('phaseOffsetOf', () => {
    // A cycle position has no invalid value, only one that needs wrapping — so nothing is rejected.
    it('folds any number into [0, 1)', () => {
        expect(phaseOffsetOf({ clipName: 'a', x: 0 })).toBe(0);
        expect(phaseOffsetOf({ clipName: 'a', x: 0, phaseOffset: 0.5 })).toBe(0.5);
        expect(phaseOffsetOf({ clipName: 'a', x: 0, phaseOffset: 1 })).toBe(0);
        expect(phaseOffsetOf({ clipName: 'a', x: 0, phaseOffset: 1.25 })).toBeCloseTo(0.25);
        expect(phaseOffsetOf({ clipName: 'a', x: 0, phaseOffset: -0.25 })).toBeCloseTo(0.75);
        expect(phaseOffsetOf({ clipName: 'a', x: 0, phaseOffset: NaN })).toBe(0);
    });
});
