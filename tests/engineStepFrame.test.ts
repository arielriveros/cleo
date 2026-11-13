import { describe, it, expect, vi, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { TimeDilation } from '../src/core/timeDilation';

// A movie render detaches the frame loop and steps the engine itself by exact deltas. The step must be the
// loop's own frame (physics, the scene, then the render) with the delta as given — no wall clock and no
// maxFrameDelta clamp — and nothing may be scheduled while the loop is detached.

/** An engine with its systems stubbed: enough to run a frame without a GPU. */
function stubEngine() {
    const calls: string[] = [];
    const engine = Object.create(CleoEngine.prototype) as CleoEngine & Record<string, unknown>;
    Object.assign(engine, {
        _paused: false,
        _ready: true,
        _loopDetached: false,
        _rafHandle: 0,
        _lastTimestamp: performance.now(),
        _maxFrameDelta: 0.1,
        _timeSinceStart: 0,
        _unscaledDelta: 0,
        _frameTimeScale: 1,
        _dilation: new TimeDilation(),
        _physicsSystem: {
            update: (dt: number) => calls.push(`physics ${dt}`),
            endFrame: () => calls.push('physics.end'),
        },
        _scene: { update: (dt: number, _t: number, _p: boolean, unscaled: number) => calls.push(`scene ${dt} ${unscaled}`) },
        _renderer: { setEffectsTimeScale: () => {}, render: () => calls.push('render') },
        onUpdate: () => {},
    });
    return { engine, calls };
}

describe('CleoEngine.stepFrame', () => {
    afterEach(() => vi.unstubAllGlobals());

    it('runs one whole frame with exactly the delta given, unclamped', () => {
        const { engine, calls } = stubEngine();
        engine.stepFrame(0.25);
        expect(calls).toEqual(['physics 0.25', 'scene 0.25 0.25', 'physics.end', 'render']);
        expect(engine.timeSinceStart).toBeCloseTo(250, 9);
    });

    it('can advance without drawing, and draw without advancing', () => {
        const { engine, calls } = stubEngine();
        engine.stepFrame(1 / 30, { render: false });
        expect(calls).not.toContain('render');
        calls.length = 0;
        engine.renderFrame();
        expect(calls).toEqual(['render']);
    });

    it('applies the time scale to what simulates, not to the real delta', () => {
        const { engine, calls } = stubEngine();
        engine.timeScale = 2;
        engine.stepFrame(0.5);
        expect(calls[0]).toBe('physics 1');
        expect(calls[1]).toBe('scene 1 0.5');
    });

    it('schedules nothing while detached, and starts the loop again when attached', () => {
        const raf = vi.fn(() => 7);
        vi.stubGlobal('requestAnimationFrame', raf);
        vi.stubGlobal('cancelAnimationFrame', vi.fn());
        const { engine } = stubEngine();
        engine.detachLoop();
        expect(engine.loopDetached).toBe(true);
        (engine as unknown as { _gameLoop(): void })._gameLoop();
        engine.stepFrame(1 / 60);
        expect(raf).not.toHaveBeenCalled();
        engine.attachLoop();
        expect(engine.loopDetached).toBe(false);
        expect(raf).toHaveBeenCalledTimes(1);
    });
});
