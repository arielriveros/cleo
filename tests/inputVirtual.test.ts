import { describe, it, expect } from 'vitest';
import {
    createVirtualState, hitTestVirtual, layoutVirtualControls, stepVirtualControls, stickVector,
    virtualLayoutRect,
} from '../src/input/virtualControls';
import type { VirtualLayout } from '../src/input/virtualControls';
import type { VirtualControl } from '../src/input/actionMap';
import type { PointerSample } from '../src/input/gestures';
import type { Vec2 } from '../src/input/processors';

// Three callers compute this geometry — the runtime that reads touches, the overlay that draws the
// controls, and the editor that places them. If any two disagreed, a stick would be drawn where it
// cannot be pressed, and only on some aspect ratios. So the tests here are mostly about the aspect
// ratio, and about the one stateful rule: a stick stays captured by the finger that grabbed it.

const STICK: VirtualControl = { id: 'moveStick', kind: 'stick', x: 0.2, y: 0.8, radius: 0.1, deadzone: 0.1 };
const BUTTON: VirtualControl = { id: 'jump', kind: 'button', x: 0.85, y: 0.8, radius: 0.08, label: 'Jump' };

function down(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'down' }; }
function move(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'move' }; }
function up(id: number, x: number, y: number): PointerSample { return { id, x, y, phase: 'up' }; }

describe('virtualLayoutRect', () => {
    it('measures radius in viewport HEIGHT on both axes, so a stick stays round', () => {
        // Normalizing each axis against its own extent would make every stick an ellipse on an
        // ultrawide monitor — and its deadzone directional with it.
        const wide = virtualLayoutRect(STICK, 3440, 1440);
        const square = virtualLayoutRect(STICK, 1440, 1440);
        expect(wide.radius).toBe(square.radius);
        expect(wide.radius).toBeCloseTo(144, 10);
    });

    it('places the centre by fraction of each axis', () => {
        const layout = virtualLayoutRect(STICK, 1000, 500);
        expect(layout.cx).toBeCloseTo(200, 10);
        expect(layout.cy).toBeCloseTo(400, 10);
    });

    it('carries deadzone for sticks only, and a label for buttons only', () => {
        expect(virtualLayoutRect(STICK, 800, 600).deadzone).toBeCloseTo(0.1, 10);
        expect(virtualLayoutRect(BUTTON, 800, 600).deadzone).toBe(0);
        expect(virtualLayoutRect(BUTTON, 800, 600).label).toBe('Jump');
    });
});

describe('hitTestVirtual', () => {
    const layouts = layoutVirtualControls([STICK, BUTTON], 1000, 1000);

    it('hits inside the circle and misses outside it', () => {
        expect(hitTestVirtual(layouts, 200, 800)!.id).toBe('moveStick');
        expect(hitTestVirtual(layouts, 500, 500)).toBeNull();
    });

    it('is circular, not square — a corner of the bounding box is a miss', () => {
        const layout = layouts[0];
        const corner = layout.radius * 0.72;                     // inside the box, outside the circle
        expect(hitTestVirtual(layouts, layout.cx + corner, layout.cy + corner)).toBeNull();
        expect(hitTestVirtual(layouts, layout.cx + layout.radius * 0.9, layout.cy)).not.toBeNull();
    });

    it('gives an overlap to the control drawn last', () => {
        const overlapping = layoutVirtualControls(
            [{ ...STICK, id: 'under' }, { ...STICK, id: 'over' }], 1000, 1000,
        );
        expect(hitTestVirtual(overlapping, 200, 800)!.id).toBe('over');
    });
});

describe('stickVector', () => {
    const layout: VirtualLayout = { id: 's', kind: 'stick', cx: 100, cy: 100, radius: 50, deadzone: 0.2 };

    it('is [0, 0] at the centre and inside the dead radius', () => {
        const out: Vec2 = [9, 9];
        expect(stickVector(out, layout, 100, 100)).toEqual([0, 0]);
        stickVector(out, layout, 105, 100);                      // 0.1 of the radius, inside 0.2
        expect(out).toEqual([0, 0]);
    });

    it('is Y-UP, matching every other 2D source in the system', () => {
        // Screen Y grows downward; flipping here rather than at each consumer is what keeps a virtual
        // stick and an analog stick from disagreeing about which way is forward.
        const out: Vec2 = [0, 0];
        stickVector(out, layout, 100, 60);                       // above the centre
        expect(out[1]).toBeGreaterThan(0);
    });

    it('clamps to the unit disc when the thumb slides outside the ring', () => {
        // "Keep going that way at full tilt" is what the player means by sliding off the stick — not
        // "go faster than the stick allows".
        const out: Vec2 = [0, 0];
        stickVector(out, layout, 400, 100);
        expect(Math.hypot(out[0], out[1])).toBeCloseTo(1, 10);
    });

    it('rescales past the deadzone rather than clipping, so there is no notch', () => {
        const out: Vec2 = [0, 0];
        stickVector(out, layout, 100 + 50 * 0.21, 100);          // just past a 0.2 deadzone
        expect(out[0]).toBeGreaterThan(0);
        expect(out[0]).toBeLessThan(0.05);
    });
});

describe('stepVirtualControls', () => {
    const layouts = layoutVirtualControls([STICK, BUTTON], 1000, 1000);

    it('reports every control as released when nothing is touching', () => {
        const { readings } = stepVirtualControls(createVirtualState(), layouts, []);
        expect(readings.get('moveStick')).toEqual({ kind: 'stick', pressed: false, vector: [0, 0] });
        expect(readings.get('jump')).toEqual({ kind: 'button', pressed: false, vector: [0, 0] });
    });

    it('presses a button on a touch inside it', () => {
        const { readings } = stepVirtualControls(createVirtualState(), layouts, [down(1, 850, 800)]);
        expect(readings.get('jump')!.pressed).toBe(true);
        expect(readings.get('moveStick')!.pressed).toBe(false);
    });

    it('ignores a touch that lands outside every control', () => {
        // Capturing it would make the whole screen behave like a button and swallow the gesture layer.
        const { state, readings } = stepVirtualControls(createVirtualState(), layouts, [down(1, 500, 500)]);
        expect(state.touches).toHaveLength(0);
        expect([...readings.values()].some(r => r.pressed)).toBe(false);
    });

    it('keeps a held stick reporting its deflection on a frame with no samples', () => {
        // A thumb resting still on a stick produces no events at all; re-reading from this frame's
        // samples alone would drop the value to zero and snap it back on the next twitch.
        let state = createVirtualState();
        state = stepVirtualControls(state, layouts, [down(1, 200, 800), move(1, 260, 800)]).state;
        const { readings } = stepVirtualControls(state, layouts, []);
        expect(readings.get('moveStick')!.vector[0]).toBeGreaterThan(0.5);
    });

    it('keeps the stick captured after the thumb slides outside its ring', () => {
        // Re-testing the circle every frame would drop the stick from under the thumb at exactly the
        // moment the player is asking for full deflection.
        let state = createVirtualState();
        state = stepVirtualControls(state, layouts, [down(1, 200, 800)]).state;
        const { readings } = stepVirtualControls(state, layouts, [move(1, 900, 800)]);
        expect(readings.get('moveStick')!.pressed).toBe(true);
        expect(readings.get('moveStick')!.vector[0]).toBeCloseTo(1, 10);
    });

    it('releases on up and on cancel', () => {
        let state = createVirtualState();
        state = stepVirtualControls(state, layouts, [down(1, 850, 800)]).state;
        const released = stepVirtualControls(state, layouts, [up(1, 850, 800)]);
        expect(released.state.touches).toHaveLength(0);
        expect(released.readings.get('jump')!.pressed).toBe(false);

        state = stepVirtualControls(createVirtualState(), layouts, [down(2, 850, 800)]).state;
        const cancelled = stepVirtualControls(state, layouts, [{ id: 2, x: 850, y: 800, phase: 'cancel' }]);
        expect(cancelled.readings.get('jump')!.pressed).toBe(false);
    });

    it('lets two fingers hold two controls at once', () => {
        const { readings } = stepVirtualControls(
            createVirtualState(), layouts, [down(1, 200, 800), down(2, 850, 800)],
        );
        expect(readings.get('moveStick')!.pressed).toBe(true);
        expect(readings.get('jump')!.pressed).toBe(true);
    });

    it('never mutates the state it was given', () => {
        const before = createVirtualState();
        stepVirtualControls(before, layouts, [down(1, 200, 800)]);
        expect(before.touches).toHaveLength(0);
    });
});
