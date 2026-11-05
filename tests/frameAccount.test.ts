import { describe, it, expect } from 'vitest';
import { FrameAccount, type EngineFrame } from '../src/core/engineStats';

/**
 * The Performance panel's frame-budget rows come from FrameAccount: every engine loop turn, timed by the
 * loop itself. The old "Unattributed" row took the panel's AVERAGED rAF interval minus the LAST frame's
 * phase figures, which mixed display-refresh idle, the renderer prologue and sampling noise into one
 * number. These pin the per-frame split that replaced it.
 */
const frame = (o: Partial<EngineFrame>): EngineFrame =>
    ({ periodMs: 0, loopMs: 0, inputMs: 0, physicsMs: 0, sceneMs: 0, renderMs: 0, ...o });

describe('FrameAccount', () => {
    it('splits a turn into untimed engine work, the render prologue and time outside the loop', () => {
        const a = new FrameAccount();
        // 13.3 ms display interval, 10 ms of loop: 3.3 ms waited outside. Render took 7, of which the
        // passes were 6: 1 ms of prologue. 0.2 ms of the loop is in no phase.
        a.add(frame({ periodMs: 13.3, loopMs: 10, inputMs: 0.3, physicsMs: 0.5, sceneMs: 2, renderMs: 7 }), 6);
        const s = a.drain();
        expect(s.frames).toBe(1);
        expect(s.untimedMs).toBeCloseTo(0.2, 9);
        expect(s.outsideMs).toBeCloseTo(3.3, 9);
        expect(s.renderExtraMs).toBeCloseTo(1, 9);
        expect(s.renderPassesMs).toBe(6);
    });

    it('averages over the turns since the last drain and keeps each peak', () => {
        const a = new FrameAccount();
        a.add(frame({ periodMs: 16, loopMs: 10, renderMs: 10 }), 9);
        a.add(frame({ periodMs: 30, loopMs: 12, sceneMs: 2, renderMs: 4 }), 4);
        const s = a.drain();
        expect(s.frames).toBe(2);
        expect(s.outsideMs).toBeCloseTo((6 + 18) / 2, 9);
        expect(s.outsidePeakMs).toBe(18);
        expect(s.untimedPeakMs).toBe(6);
        expect(s.renderExtraPeakMs).toBe(1);
        expect(s.periodMs).toBe(23);
    });

    it('starts again after a drain, and reports zeros when no turn ran', () => {
        const a = new FrameAccount();
        a.add(frame({ periodMs: 50, loopMs: 10 }), 0);
        a.drain();
        const s = a.drain();
        expect(s.frames).toBe(0);
        expect(s.outsideMs).toBe(0);
        expect(s.outsidePeakMs).toBe(0);
    });

    it('never reports negative time when the phases overlap the measured loop', () => {
        const a = new FrameAccount();
        a.add(frame({ periodMs: 5, loopMs: 8, sceneMs: 5, renderMs: 4 }), 6);
        const s = a.drain();
        expect(s.untimedMs).toBe(0);
        expect(s.outsideMs).toBe(0);
        expect(s.renderExtraMs).toBe(0);
    });
});
