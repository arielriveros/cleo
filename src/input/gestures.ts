/**
 * Touch gesture recognition, written as a pure step function over a list of pointer samples.
 *
 * `stepTouchGestures` takes last frame's state and this frame's samples and returns a NEW state plus the
 * gestures that fired. It never mutates its arguments, holds no module-level state, and has never heard
 * of `PointerEvent` — a sample is four plain numbers. That is what makes gesture behaviour testable by
 * writing a script of touches by hand, which is the only practical way to test this: the failure modes
 * here (a long press that also fires a tap, a pinch that spikes when one finger lifts) are all about
 * SEQUENCE, and no amount of poking at a real screen exercises them reliably.
 *
 * The recognizer is deliberately small. It resolves the ambiguities that actually bite —
 *   * a press that has become a long press can never also become a tap on release,
 *   * a pointer that has travelled past the drag threshold can never become a tap,
 *   * a second finger converts a drag into a pinch rather than producing both,
 *   * a finger lifting out of a pinch ends it without a final frame of garbage delta
 * — and leaves anything more elaborate (rotation, three-finger anything, flick velocity) to game code
 * reading the raw pointer set.
 */

import type { TouchGestureConfig } from "./actionMap";

/** One pointer observation. Plain numbers in CSS pixels, so a test can write a gesture as a literal. */
export interface PointerSample {
    id: number;
    x: number;
    y: number;
    phase: 'down' | 'move' | 'up' | 'cancel';
}

/** A pointer currently down, and what has happened to it since. */
export interface TrackedPointer {
    id: number;
    startX: number;
    startY: number;
    x: number;
    y: number;
    /** Value of {@link GestureState.elapsed} when it went down. */
    downAt: number;
    /** Has travelled past `dragMinPixels`, so it can no longer become a tap. */
    moved: boolean;
    longPressFired: boolean;
}

/**
 * Everything the recognizer remembers between frames. Carried by the caller rather than held here, so
 * two engines — or a test and a running game — cannot share a half-finished gesture.
 */
export interface GestureState {
    /** Seconds since recognition began. A monotonic clock, not wall time: it advances by `dt`. */
    elapsed: number;
    pointers: TrackedPointer[];
    /** When the last tap completed, for double-tap detection. `-Infinity` means "never". */
    lastTapAt: number;
    /** The pointer a one-finger drag follows: the first one down while nothing else was. */
    primaryId: number | null;
    pinchStartDistance: number;
    pinchDistance: number;
    pinchActive: boolean;
}

/** What fired this frame. One-shot flags are true for exactly one frame; the rest are per-frame deltas. */
export interface GestureOutput {
    tap: boolean;
    doubleTap: boolean;
    longPress: boolean;
    /** Movement of the primary pointer this frame, in CSS pixels. Zero while a pinch is in progress. */
    drag: [number, number];
    dragActive: boolean;
    /** Per-frame relative change in finger separation: `+0.1` means they spread 10% since last frame. */
    pinch: number;
    /** Separation relative to where the pinch began. 2 means "twice as far apart as at the start". */
    pinchScale: number;
    pinchActive: boolean;
}

export function createGestureState(): GestureState {
    return {
        elapsed: 0,
        pointers: [],
        lastTapAt: -Infinity,
        primaryId: null,
        pinchStartDistance: 0,
        pinchDistance: 0,
        pinchActive: false,
    };
}

function emptyOutput(): GestureOutput {
    return {
        tap: false, doubleTap: false, longPress: false,
        drag: [0, 0], dragActive: false,
        pinch: 0, pinchScale: 1, pinchActive: false,
    };
}

/** A deep copy of the tracked set, so the caller's previous state is never written through. */
function clonePointers(pointers: readonly TrackedPointer[]): TrackedPointer[] {
    return pointers.map(p => ({ ...p }));
}

/**
 * Advance the recognizer by one frame.
 *
 * `samples` are in the order they arrived, which matters: a down/up pair inside a single frame is a
 * legitimate very fast tap, and processing them out of order would lose it.
 */
export function stepTouchGestures(
    state: GestureState,
    samples: readonly PointerSample[],
    dt: number,
    config: TouchGestureConfig,
): { state: GestureState; output: GestureOutput } {
    const next: GestureState = {
        elapsed: state.elapsed + (Number.isFinite(dt) && dt > 0 ? dt : 0),
        pointers: clonePointers(state.pointers),
        lastTapAt: state.lastTapAt,
        primaryId: state.primaryId,
        pinchStartDistance: state.pinchStartDistance,
        pinchDistance: state.pinchDistance,
        pinchActive: state.pinchActive,
    };
    const output = emptyOutput();

    // Two or more fingers at ANY point in the frame means the frame belongs to a pinch, not a drag.
    // Sampled across the whole frame rather than at the end, so the transition frame — where the second
    // finger lands — does not also emit the drag that the first finger's movement would otherwise be.
    let multiTouched = next.pointers.length >= 2;
    let dragX = 0;
    let dragY = 0;

    for (const sample of samples) {
        const index = next.pointers.findIndex(p => p.id === sample.id);

        if (sample.phase === 'down') {
            // A duplicate down for a live id is a lost `up`. Restart the pointer rather than tracking it
            // twice, which would leave a phantom finger holding a pinch open forever.
            const pointer: TrackedPointer = {
                id: sample.id, startX: sample.x, startY: sample.y, x: sample.x, y: sample.y,
                downAt: next.elapsed, moved: false, longPressFired: false,
            };
            if (index >= 0) next.pointers[index] = pointer;
            else next.pointers.push(pointer);
            if (next.primaryId === null) next.primaryId = sample.id;
            if (next.pointers.length >= 2) multiTouched = true;
            continue;
        }

        if (index < 0) continue;                       // a move/up for a pointer we never saw go down
        const pointer = next.pointers[index];

        if (sample.phase === 'move') {
            const dx = sample.x - pointer.x;
            const dy = sample.y - pointer.y;
            pointer.x = sample.x;
            pointer.y = sample.y;
            if (!pointer.moved &&
                Math.hypot(sample.x - pointer.startX, sample.y - pointer.startY) > config.dragMinPixels)
                pointer.moved = true;
            if (pointer.id === next.primaryId) { dragX += dx; dragY += dy; }
            continue;
        }

        if (sample.phase === 'up') {
            // A long press already consumed this press, and a pointer that travelled was a drag. Either
            // way it is not a tap — this is the rule that stops "hold to aim" also firing "tap to shoot".
            const travelled = Math.hypot(sample.x - pointer.startX, sample.y - pointer.startY);
            const heldFor = next.elapsed - pointer.downAt;
            if (!pointer.longPressFired && !pointer.moved &&
                heldFor <= config.tapMaxSeconds && travelled <= config.tapMaxPixels) {
                output.tap = true;
                if (next.elapsed - next.lastTapAt <= config.doubleTapMaxSeconds) {
                    output.doubleTap = true;
                    // Cleared, so three taps are one double and one single rather than two doubles.
                    next.lastTapAt = -Infinity;
                } else {
                    next.lastTapAt = next.elapsed;
                }
            }
        }

        // Both `up` and `cancel` end tracking; `cancel` (the browser took the pointer away — a system
        // gesture, a context menu) additionally emits nothing at all.
        next.pointers.splice(index, 1);
        if (next.primaryId === sample.id) next.primaryId = next.pointers.length ? next.pointers[0].id : null;
    }

    // Long press fires while the finger is still down, not on release — that is what makes it feel like
    // a long press rather than a slow tap.
    for (const pointer of next.pointers) {
        if (pointer.longPressFired || pointer.moved) continue;
        if (next.elapsed - pointer.downAt >= config.longPressSeconds) {
            pointer.longPressFired = true;
            output.longPress = true;
        }
    }

    stepPinch(next, output, config);

    if (!output.pinchActive && !multiTouched) {
        const primary = next.pointers.find(p => p.id === next.primaryId);
        if (primary?.moved) {
            output.drag[0] = dragX;
            output.drag[1] = dragY;
            output.dragActive = true;
        }
    }

    return { state: next, output };
}

/**
 * Pinch, kept separate because its end conditions are the subtle part: a pinch must stop the moment it
 * is not two fingers any more, and must not report the jump in separation that lifting one of them
 * would otherwise produce.
 */
function stepPinch(state: GestureState, output: GestureOutput, config: TouchGestureConfig): void {
    if (state.pointers.length !== 2) {
        state.pinchActive = false;
        state.pinchStartDistance = 0;
        state.pinchDistance = 0;
        return;
    }

    const [a, b] = state.pointers;
    const distance = Math.hypot(a.x - b.x, a.y - b.y);

    if (state.pinchStartDistance <= 0) {
        state.pinchStartDistance = distance;
        state.pinchDistance = distance;
        state.pinchActive = false;
        return;
    }

    const previous = state.pinchDistance;
    state.pinchDistance = distance;

    // The threshold is on total travel from where the fingers started, not on this frame's movement:
    // two fingers resting on a screen jitter by a pixel a frame and would otherwise trip it instantly.
    if (!state.pinchActive && Math.abs(distance - state.pinchStartDistance) >= config.pinchMinPixels)
        state.pinchActive = true;

    if (!state.pinchActive) return;

    output.pinchActive = true;
    output.pinchScale = state.pinchStartDistance > 1e-6 ? distance / state.pinchStartDistance : 1;
    output.pinch = previous > 1e-6 ? distance / previous - 1 : 0;
}
