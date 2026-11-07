import { describe, expect, it } from 'vitest';
import {
    GI_HYSTERESIS, GI_RESET_BOUNCE_SWEEPS, GI_SETTLE_RESIDUAL, GiSweepState, angleBetween, hashNumbers, isLightJump, nearestUncaptured,
    needsRelight, needsShadowRender, planRelightFrame, settleSweeps, type GiLightInputs,
} from '../src/graphics/render/gi/giJobs';

const light = (o: Partial<GiLightInputs> = {}): GiLightInputs => ({
    sunDir: [0, 1, 0], sunIntensity: 100000, skyL0: 5000, lightSignature: 1, ...o,
});
const tilt = (deg: number): [number, number, number] => {
    const r = deg * Math.PI / 180;
    return [Math.sin(r), Math.cos(r), 0];
};

describe('GI capture order', () => {
    it('takes the uncaptured probes nearest the camera, over every volume', () => {
        const volumes = [
            { positions: [0, 0, 0, 10, 0, 0, 20, 0, 0], states: [0, 0, 0] },
            { positions: [3, 0, 0, 4, 0, 0], states: [1, 0] },
        ];
        const picks = nearestUncaptured(volumes, [4.5, 0, 0], 2);
        expect(picks.map(p => [p.volume, p.probe])).toEqual([[1, 1], [0, 0]]);
        expect(picks[0].distance).toBeCloseTo(0.5);
        expect(nearestUncaptured(volumes, [5, 0, 0], 10)).toHaveLength(4);
        expect(nearestUncaptured(volumes, [5, 0, 0], 0)).toHaveLength(0);
    });

    it('keeps the nearest k over a big grid', () => {
        const n = 5000;
        const positions = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) positions[i * 3] = (i * 7919) % n;   // shuffled along x
        const picks = nearestUncaptured([{ positions, states: new Uint8Array(n) }], [0, 0, 0], 8);
        expect(picks.map(p => p.distance)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    });
});

describe('GI relight triggers', () => {
    it('measures angles in degrees', () => {
        expect(angleBetween([0, 1, 0], tilt(30))).toBeCloseTo(30, 5);
    });

    it('calls a jump on a big sun step, a sun appearing, or a brightness ratio over 2', () => {
        expect(isLightJump(null, light())).toBe(true);
        expect(isLightJump(light(), light({ sunDir: tilt(5) }))).toBe(false);
        expect(isLightJump(light(), light({ sunDir: tilt(15) }))).toBe(true);
        expect(isLightJump(light({ sunDir: null }), light())).toBe(true);
        expect(isLightJump(light(), light({ sunIntensity: 40000 }))).toBe(true);
        expect(isLightJump(light(), light({ skyL0: 12000 }))).toBe(true);
        expect(isLightJump(light(), light({ skyL0: 6000 }))).toBe(false);
        expect(isLightJump(light({ skyL0: 0 }), light({ skyL0: 0 }))).toBe(false);
    });

    it('relights on a light change or a sky change past 2%, not on the sun turning', () => {
        expect(needsRelight(null, light())).toBe(true);
        expect(needsRelight(light(), light({ sunDir: tilt(8) }))).toBe(false);
        expect(needsRelight(light(), light({ lightSignature: 2 }))).toBe(true);
        expect(needsRelight(light(), light({ skyL0: 5050 }))).toBe(false);
        expect(needsRelight(light(), light({ skyL0: 5200 }))).toBe(true);
        expect(needsRelight(light(), light({ sunIntensity: 97000 }))).toBe(true);
    });

    it('redraws a volume shadow once the sun has turned past the threshold', () => {
        expect(needsShadowRender(null, [0, 1, 0], 2)).toBe(true);
        expect(needsShadowRender([0, 1, 0], tilt(1.5), 2)).toBe(false);
        expect(needsShadowRender([0, 1, 0], tilt(2.5), 2)).toBe(true);
        expect(needsShadowRender([0, 1, 0], null, 2)).toBe(false);
    });

    it('hashes the baked lights stably', () => {
        expect(hashNumbers([1, 2, 3])).toBe(hashNumbers([1, 2, 3]));
        expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([1, 2, 3.01]));
        expect(hashNumbers([1, 2, 3])).not.toBe(hashNumbers([3, 2, 1]));
    });
});

describe('GI sweeps', () => {
    it('settle under the residual', () => {
        const n = settleSweeps();
        expect(Math.pow(GI_HYSTERESIS, n)).toBeLessThan(GI_SETTLE_RESIDUAL);
        expect(Math.pow(GI_HYSTERESIS, n - 1)).toBeGreaterThanOrEqual(GI_SETTLE_RESIDUAL);
        expect(settleSweeps(0)).toBe(1);
    });

    it('reset: one sweep without bounces, then the bounce sweeps, each replacing the old light', () => {
        const s = new GiSweepState(10);
        s.request('reset');
        const sweeps: { bounce: boolean; h: number }[] = [];
        for (let i = 0; i < 20; i++) {
            const b = s.take(10);
            if (!b) break;
            expect(b.first).toBe(0);
            expect(b.count).toBe(10);
            expect(b.endsSweep).toBe(true);
            sweeps.push({ bounce: b.bounce, h: b.hysteresis });
        }
        expect(sweeps).toEqual([{ bounce: false, h: 0 }, ...Array(GI_RESET_BOUNCE_SWEEPS).fill({ bounce: true, h: 0 })]);
        expect(s.idle).toBe(true);
    });

    it('relight: settle sweeps with hysteresis, then idle', () => {
        const s = new GiSweepState(4);
        expect(s.take(4)).toBeNull();
        s.request('relight');
        let sweeps = 0;
        for (let b = s.take(4); b; b = s.take(4)) {
            expect(b.hysteresis).toBe(GI_HYSTERESIS);
            expect(b.bounce).toBe(true);
            sweeps++;
        }
        expect(sweeps).toBe(settleSweeps());
        expect(s.idle).toBe(true);
    });

    it('queues a change that arrives mid-sweep instead of restarting', () => {
        const s = new GiSweepState(10);
        s.request('relight');
        expect(s.take(4)).toMatchObject({ first: 0, count: 4 });
        s.request('relight');
        expect(s.take(4)).toMatchObject({ first: 4, count: 4 });
        expect(s.take(4)).toMatchObject({ first: 8, count: 2, endsSweep: true });
        let rest = 0;
        while (s.take(10)) rest++;
        // The settle sweeps left of the first change, then a fresh settle for the second.
        expect(rest).toBe(settleSweeps() - 1 + settleSweeps());
    });

    it('a reset mid-sweep starts over at once', () => {
        const s = new GiSweepState(10);
        s.request('relight');
        s.take(4);
        s.request('reset');
        expect(s.take(10)).toMatchObject({ first: 0, count: 10, bounce: false, hysteresis: 0 });
    });

    it('without multi-bounce, a reset is one sweep and nothing bounces', () => {
        const s = new GiSweepState(3, false);
        s.request('reset');
        expect(s.take(3)).toMatchObject({ bounce: false, hysteresis: 0, endsSweep: true });
        expect(s.take(3)).toBeNull();
        s.request('relight');
        expect(s.take(3)!.bounce).toBe(false);
    });
});

describe('planRelightFrame', () => {
    it('spends the ray budget over the volumes in order, at least one batch', () => {
        const a = new GiSweepState(100), b = new GiSweepState(100);
        a.request('reset');
        b.request('reset');
        const frame = planRelightFrame([{ state: a, rays: 64 }, { state: b, rays: 256 }], 64 * 150);
        // a's whole first sweep (100 probes), then 50 more of its second; b waits.
        expect(frame.map(f => [f.volume, f.first, f.count])).toEqual([[0, 0, 100], [0, 0, 50]]);
        const tiny = planRelightFrame([{ state: b, rays: 256 }], 10);
        expect(tiny).toHaveLength(1);
        expect(tiny[0].count).toBe(1);
        expect(planRelightFrame([{ state: new GiSweepState(5), rays: 64 }], 1e6)).toEqual([]);
    });
});
