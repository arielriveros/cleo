import { describe, it, expect } from 'vitest';
import { createGestureState, stepTouchGestures } from '../src/input/gestures';
import type { GestureOutput, GestureState, PointerSample } from '../src/input/gestures';
import { DEFAULT_TOUCH_CONFIG } from '../src/input/actionMap';

// Every failure mode that matters in gesture recognition is about SEQUENCE — a long press that also
// fires a tap on release, a pinch that spikes when one finger lifts, a drag that survives its own
// pointercancel. Poking at a real screen exercises none of them reliably, which is the entire reason
// stepTouchGestures is a pure function over a list of samples: here a gesture is written as a literal.

const CONFIG = DEFAULT_TOUCH_CONFIG;
const FRAME = 1 / 60;

function down(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'down' }; }
function move(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'move' }; }
function up(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'up' }; }
function cancel(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'cancel' }; }

/** Play a script of frames, returning the final state and every frame's output. */
function play(frames: readonly (readonly PointerSample[])[], dt = FRAME, from = createGestureState()) {
    let state = from;
    const outputs: GestureOutput[] = [];
    for (const samples of frames) {
        const stepped = stepTouchGestures(state, samples, dt, CONFIG);
        state = stepped.state;
        outputs.push(stepped.output);
    }
    return { state, outputs };
}

/** Frames of nothing happening — how a gesture is held open across time. */
function idle(count: number): PointerSample[][] {
    return Array.from({ length: count }, () => []);
}

describe('tap', () => {
    it('fires exactly once for a quick press and release in place', () => {
        const { outputs } = play([[down(1, 100, 100)], [up(1, 101, 100)], [], []]);
        expect(outputs.filter(o => o.tap)).toHaveLength(1);
        expect(outputs[1].tap).toBe(true);
    });

    it('fires for a down and up inside a single frame', () => {
        // A very fast tap lands both samples between two rAF callbacks; processing them in order is
        // what keeps it from being lost.
        const { outputs } = play([[down(1, 10, 10), up(1, 10, 10)]]);
        expect(outputs[0].tap).toBe(true);
    });

    it('does not fire for a press held past the tap window', () => {
        const frames = [[down(1, 100, 100)], ...idle(40), [up(1, 100, 100)]];
        const { outputs } = play(frames);
        expect(outputs.some(o => o.tap)).toBe(false);
    });

    it('does not fire for a press that travelled', () => {
        const { outputs } = play([[down(1, 100, 100)], [move(1, 160, 100)], [up(1, 160, 100)]]);
        expect(outputs.some(o => o.tap)).toBe(false);
    });
});

describe('doubleTap', () => {
    it('fires on the second of two taps inside the window', () => {
        const { outputs } = play([
            [down(1, 10, 10)], [up(1, 10, 10)],
            ...idle(4),
            [down(1, 10, 10)], [up(1, 10, 10)],
        ]);
        const taps = outputs.filter(o => o.tap);
        expect(taps).toHaveLength(2);
        expect(outputs.filter(o => o.doubleTap)).toHaveLength(1);
        expect(outputs[outputs.length - 1].doubleTap).toBe(true);
    });

    it('does not fire when the two taps are too far apart', () => {
        const { outputs } = play([
            [down(1, 10, 10)], [up(1, 10, 10)],
            ...idle(40),
            [down(1, 10, 10)], [up(1, 10, 10)],
        ]);
        expect(outputs.some(o => o.doubleTap)).toBe(false);
    });

    it('reads three taps as one double and one single, not two doubles', () => {
        const { outputs } = play([
            [down(1, 10, 10)], [up(1, 10, 10)], [],
            [down(1, 10, 10)], [up(1, 10, 10)], [],
            [down(1, 10, 10)], [up(1, 10, 10)],
        ]);
        expect(outputs.filter(o => o.doubleTap)).toHaveLength(1);
    });
});

describe('longPress', () => {
    it('fires once while the finger is still down, not on release', () => {
        const frames = [[down(1, 50, 50)], ...idle(60), [up(1, 50, 50)]];
        const { outputs } = play(frames);
        const firedAt = outputs.findIndex(o => o.longPress);
        expect(firedAt).toBeGreaterThan(0);
        expect(firedAt).toBeLessThan(outputs.length - 1);
        expect(outputs.filter(o => o.longPress)).toHaveLength(1);
    });

    it('suppresses the tap that its release would otherwise produce', () => {
        // "Hold to aim" must not also fire "tap to shoot" when the player lets go.
        const frames = [[down(1, 50, 50)], ...idle(60), [up(1, 50, 50)]];
        const { outputs } = play(frames);
        expect(outputs.some(o => o.tap)).toBe(false);
    });

    it('does not fire for a finger that has moved', () => {
        const frames = [[down(1, 50, 50)], [move(1, 120, 50)], ...idle(60), [up(1, 120, 50)]];
        const { outputs } = play(frames);
        expect(outputs.some(o => o.longPress)).toBe(false);
    });
});

describe('drag', () => {
    it('reports this frame movement once past the threshold, and no tap on release', () => {
        const { outputs } = play([
            [down(1, 100, 100)],
            [move(1, 130, 100)],
            [move(1, 140, 110)],
            [up(1, 140, 110)],
        ]);
        expect(outputs[1].dragActive).toBe(true);
        expect(outputs[1].drag).toEqual([30, 0]);
        expect(outputs[2].drag).toEqual([10, 10]);
        expect(outputs.some(o => o.tap)).toBe(false);
    });

    it('stays silent while the finger is inside the drag threshold', () => {
        const { outputs } = play([[down(1, 100, 100)], [move(1, 103, 100)]]);
        expect(outputs[1].dragActive).toBe(false);
        expect(outputs[1].drag).toEqual([0, 0]);
    });

    it('accumulates several moves within one frame', () => {
        const { outputs } = play([[down(1, 0, 0)], [move(1, 20, 0), move(1, 40, 0), move(1, 40, 15)]]);
        expect(outputs[1].drag).toEqual([40, 15]);
    });

    it('stops the moment a second finger lands', () => {
        // The transition frame is the one that matters: it must not emit both a drag and start a pinch.
        const { outputs } = play([
            [down(1, 100, 100)],
            [move(1, 140, 100)],
            [down(2, 300, 100), move(1, 150, 100)],
        ]);
        expect(outputs[1].dragActive).toBe(true);
        expect(outputs[2].dragActive).toBe(false);
        expect(outputs[2].drag).toEqual([0, 0]);
    });
});

describe('pinch', () => {
    it('reports separation relative to where the pinch began', () => {
        const { outputs } = play([
            [down(1, 100, 100), down(2, 200, 100)],       // 100px apart
            [move(2, 300, 100)],                          // 200px apart
        ]);
        expect(outputs[1].pinchActive).toBe(true);
        expect(outputs[1].pinchScale).toBeCloseTo(2, 10);
        expect(outputs[1].pinch).toBeCloseTo(1, 10);      // doubled since last frame
    });

    it('stays silent until the fingers have moved past the threshold', () => {
        // Two fingers resting on a screen jitter by a pixel a frame; that must not read as a zoom.
        const { outputs } = play([
            [down(1, 100, 100), down(2, 200, 100)],
            [move(2, 202, 100)],
            [move(2, 203, 100)],
        ]);
        expect(outputs[1].pinchActive).toBe(false);
        expect(outputs[2].pinchActive).toBe(false);
    });

    it('ends cleanly when a finger lifts, with no final spike', () => {
        const { outputs } = play([
            [down(1, 100, 100), down(2, 200, 100)],
            [move(2, 400, 100)],
            [up(2, 400, 100)],
            [move(1, 110, 100)],
        ]);
        expect(outputs[1].pinchActive).toBe(true);
        expect(outputs[2].pinchActive).toBe(false);
        expect(outputs[2].pinch).toBe(0);
        expect(outputs[3].pinch).toBe(0);
    });

    it('restarts its reference distance for a new pinch', () => {
        const { outputs } = play([
            [down(1, 100, 100), down(2, 200, 100)],
            [move(2, 400, 100)],
            [up(1, 100, 100), up(2, 400, 100)],
            [down(1, 0, 0), down(2, 100, 0)],
            [move(2, 150, 0)],
        ]);
        expect(outputs[4].pinchScale).toBeCloseTo(1.5, 10);
    });
});

describe('cancel and robustness', () => {
    it('leaves nothing latched when the browser takes a pointer away', () => {
        const { state, outputs } = play([[down(1, 10, 10)], [cancel(1, 10, 10)], []]);
        expect(outputs.some(o => o.tap)).toBe(false);
        expect(state.pointers).toHaveLength(0);
        expect(state.pinchActive).toBe(false);
    });

    it('ignores a move or up for a pointer it never saw go down', () => {
        const { state, outputs } = play([[move(7, 10, 10), up(7, 10, 10)]]);
        expect(outputs[0].tap).toBe(false);
        expect(state.pointers).toHaveLength(0);
    });

    it('restarts a pointer whose down arrives twice, rather than tracking a phantom finger', () => {
        // A lost `up` would otherwise leave a finger holding a pinch open forever.
        const { state } = play([[down(1, 10, 10)], [down(1, 50, 50)]]);
        expect(state.pointers).toHaveLength(1);
        expect(state.pointers[0].startX).toBe(50);
    });

    it('hands the primary drag to a surviving finger when the first one lifts', () => {
        const { state } = play([[down(1, 10, 10), down(2, 200, 10)], [up(1, 10, 10)]]);
        expect(state.primaryId).toBe(2);
    });
});

describe('purity', () => {
    it('never mutates the state it was given, and always returns a new one', () => {
        const before = createGestureState();
        const snapshot = JSON.parse(JSON.stringify(before)) as GestureState;
        const stepped = stepTouchGestures(before, [down(1, 10, 10)], FRAME, CONFIG);
        expect(stepped.state).not.toBe(before);
        expect(JSON.parse(JSON.stringify(before))).toEqual(snapshot);
    });

    it('does not write through to the previous frame tracked pointers', () => {
        const first = stepTouchGestures(createGestureState(), [down(1, 10, 10)], FRAME, CONFIG).state;
        const startX = first.pointers[0].x;
        stepTouchGestures(first, [move(1, 400, 10)], FRAME, CONFIG);
        expect(first.pointers[0].x).toBe(startX);
    });

    it('does not advance its clock on a zero or non-finite dt', () => {
        const stepped = stepTouchGestures(createGestureState(), [], NaN, CONFIG);
        expect(stepped.state.elapsed).toBe(0);
        expect(stepTouchGestures(stepped.state, [], -1, CONFIG).state.elapsed).toBe(0);
    });
});
