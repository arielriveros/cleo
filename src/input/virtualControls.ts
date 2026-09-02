/**
 * On-screen sticks and buttons: where they sit, what a touch on one reads as, and which pointer owns
 * which control.
 *
 * Pure, and shared by three callers that must not be allowed to disagree — the DOM layer that reads
 * touches, the overlay that DRAWS the controls, and the editor's placement UI. If the editor computed a
 * circle's position and the runtime computed it again, a stick would be drawn where it cannot be
 * pressed, and only on some aspect ratios.
 *
 * The geometry rule that makes that work: a control's `radius` is in units of viewport HEIGHT for both
 * axes, so a circle stays a circle. Normalizing each axis against its own extent would turn every stick
 * into an ellipse on an ultrawide monitor and make the deadzone directional.
 */

import { applyDeadzone1D, unsignZero } from "./processors";
import type { Vec2 } from "./processors";
import type { VirtualControl } from "./actionMap";
import type { PointerSample } from "./gestures";

/** A control resolved to pixels for a specific viewport. */
export interface VirtualLayout {
    id: string;
    kind: 'stick' | 'button';
    /** Centre, in CSS pixels relative to the viewport's top-left. */
    cx: number;
    cy: number;
    radius: number;
    /** Copied through from the control so a hit test does not need the authored record too. */
    deadzone: number;
    label?: string;
}

/** Place one control in a viewport of `width` x `height` CSS pixels. */
export function virtualLayoutRect(control: VirtualControl, width: number, height: number): VirtualLayout {
    const layout: VirtualLayout = {
        id: control.id,
        kind: control.kind,
        cx: control.x * width,
        cy: control.y * height,
        // Height for both axes — see the module comment. This is the line that keeps sticks round.
        radius: control.radius * height,
        deadzone: control.kind === 'stick' ? (control.deadzone ?? 0) : 0,
    };
    if (control.label) layout.label = control.label;
    return layout;
}

export function layoutVirtualControls(
    controls: readonly VirtualControl[], width: number, height: number,
): VirtualLayout[] {
    return controls.map(control => virtualLayoutRect(control, width, height));
}

/**
 * The control at `(x, y)`, or null. Later controls win an overlap, matching the paint order of the
 * overlay — whatever is drawn on top is what a finger lands on.
 */
export function hitTestVirtual(layouts: readonly VirtualLayout[], x: number, y: number): VirtualLayout | null {
    for (let i = layouts.length - 1; i >= 0; i--) {
        const layout = layouts[i];
        if (Math.hypot(x - layout.cx, y - layout.cy) <= layout.radius) return layout;
    }
    return null;
}

/**
 * A stick's reading for a touch at `(x, y)`: -1..1 per axis with Y POSITIVE UP, clamped to the unit disc
 * and rescaled past the deadzone.
 *
 * Clamped rather than left unbounded because a thumb routinely slides outside the ring it started in,
 * and "keep going in that direction at full tilt" is what the player means by that — not "go faster than
 * the stick allows".
 */
export function stickVector(out: Vec2, layout: VirtualLayout, x: number, y: number): Vec2 {
    const radius = Math.max(1e-6, layout.radius);
    const dx = (x - layout.cx) / radius;
    // Screen Y grows downward; every other 2D source in this system is Y-up, so flip here rather than
    // making each consumer remember which of its inputs is upside down.
    const dy = -(y - layout.cy) / radius;

    const magnitude = Math.hypot(dx, dy);
    if (magnitude <= 1e-6) { out[0] = 0; out[1] = 0; return out; }

    const shaped = applyDeadzone1D(Math.min(1, magnitude), layout.deadzone, 1);
    const scale = shaped / magnitude;
    out[0] = unsignZero(dx * scale);
    out[1] = unsignZero(dy * scale);
    return out;
}

/**
 * Which pointer is holding which control, and where it currently is. Cleared when the pointer lifts,
 * not when it leaves the circle.
 *
 * The position lives HERE rather than being read from this frame's samples, because a finger resting
 * still on a stick produces no samples at all — a held stick must keep reporting its deflection on
 * every frame in between, not drop to zero and snap back on the next twitch.
 */
export interface VirtualTouch {
    pointerId: number;
    controlId: string;
    x: number;
    y: number;
}

export interface VirtualState {
    touches: VirtualTouch[];
}

/**
 * What one control reads this frame. `kind` is carried through because it is what tells the resolver
 * whether this source produces a direction at all: a stick at rest and a button at rest both read
 * `[0, 0]`, and only the stick should be treated as a 2D contribution.
 */
export interface VirtualReading {
    kind: 'stick' | 'button';
    pressed: boolean;
    vector: [number, number];
}

export function createVirtualState(): VirtualState {
    return { touches: [] };
}

/**
 * Advance the on-screen controls by one frame, and report what each reads.
 *
 * A control is CAPTURED on the touch that lands inside it and stays captured until that pointer lifts,
 * even once the finger has slid outside the circle. Re-testing every frame is the obvious
 * implementation and the wrong one: a stick pushed to its edge would drop out from under the thumb at
 * the exact moment the player is asking for full deflection.
 *
 * Returns a new state; `state` and `samples` are never written to.
 */
export function stepVirtualControls(
    state: VirtualState,
    layouts: readonly VirtualLayout[],
    samples: readonly PointerSample[],
): { state: VirtualState; readings: Map<string, VirtualReading> } {
    const touches = state.touches.map(t => ({ ...t }));

    for (const sample of samples) {
        const index = touches.findIndex(t => t.pointerId === sample.id);

        if (sample.phase === 'down') {
            const hit = hitTestVirtual(layouts, sample.x, sample.y);
            // A touch that lands outside every control is not ours — it belongs to the gesture
            // recognizer, and capturing it would make the whole screen behave like a button.
            if (!hit) { if (index >= 0) touches.splice(index, 1); continue; }
            const touch: VirtualTouch = { pointerId: sample.id, controlId: hit.id, x: sample.x, y: sample.y };
            if (index >= 0) touches[index] = touch;
            else touches.push(touch);
            continue;
        }

        if (index < 0) continue;
        if (sample.phase === 'move') {
            touches[index].x = sample.x;
            touches[index].y = sample.y;
            continue;
        }
        touches.splice(index, 1);                      // up / cancel
    }

    const readings = new Map<string, VirtualReading>();
    const scratch: Vec2 = [0, 0];
    for (const layout of layouts) {
        const touch = touches.find(t => t.controlId === layout.id);
        if (!touch) { readings.set(layout.id, { kind: layout.kind, pressed: false, vector: [0, 0] }); continue; }
        if (layout.kind === 'button') {
            readings.set(layout.id, { kind: 'button', pressed: true, vector: [0, 0] });
            continue;
        }
        stickVector(scratch, layout, touch.x, touch.y);
        readings.set(layout.id, { kind: 'stick', pressed: true, vector: [scratch[0], scratch[1]] });
    }

    return { state: { touches }, readings };
}
