import { describe, it, expect } from 'vitest';
import { vec3, quat, mat4 } from 'gl-matrix';
import {
    beginDrag,
    buildRotateOverlay,
    ringPointAt,
    frameAxes,
    type DragSession,
    type DragViewContext,
} from '../src/features/gizmo/gizmoDrag';
import type { GizmoFrame } from '../src/features/gizmo/gizmoPick';

/**
 * The readout's world-space model. Projection and DOM live in `GizmoDragOverlay`; everything decided
 * here — how finely the arc is sampled, where it starts and ends, what the label says — is testable
 * without a browser, which is the point of the split.
 */

const view: DragViewContext = {
    viewProj: mat4.multiply(
        mat4.create(),
        mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000),
        mat4.lookAt(mat4.create(), [0, 0, 20], [0, 0, 0], [0, 1, 0]),
    ),
    viewportWidth: 1600,
    viewportHeight: 900,
    cursor: { x: 800, y: 450 },
    cursorDelta: { x: 0, y: 0 },
};

const frame: GizmoFrame = {
    origin: vec3.create(),
    axes: frameAxes('world', quat.create()),
    scale: 1,
    toCamera: vec3.fromValues(0, 0, 1),
};

/** A rotation drag about world Y, grabbed on the +X side of the ring. */
function rotationSession(): DragSession {
    return beginDrag(
        'y', 'rotation', 'world', frame,
        {
            worldPosition: vec3.create(),
            worldQuaternion: quat.create(),
            localPosition: vec3.create(),
            localScale: vec3.fromValues(1, 1, 1),
            parentWorldTransform: null,
            parentWorldQuaternion: quat.create(),
        },
        [1, 30, 0], [0, -1, 0], view,
    );
}

describe('rotation arc', () => {
    it('runs from the grab point to the current angle', () => {
        const session = rotationSession();
        const angle = Math.PI / 3;
        const { lines } = buildRotateOverlay(session, angle, 60);

        const arc = lines[0].points;
        expect(distance(arc[0], ringPointAt(session, 0))).toBeLessThan(1e-5);
        expect(distance(arc[arc.length - 1], ringPointAt(session, angle))).toBeLessThan(1e-5);
    });

    it('samples more finely the further it sweeps, and caps out', () => {
        const session = rotationSession();
        const count = (angle: number) => buildRotateOverlay(session, angle, 0).lines[0].points.length;

        expect(count(0.01)).toBe(2);
        expect(count(Math.PI / 2)).toBeGreaterThan(count(Math.PI / 8));
        // A drag can wind arbitrarily far; the polyline must not grow with it without bound.
        expect(count(400 * Math.PI)).toBe(256);
    });

    it('marks where the drag started as well as where it is now', () => {
        const { lines } = buildRotateOverlay(rotationSession(), 1, 57.3);
        // Arc, a muted radial at the grab angle, and a coloured radial at the current one.
        expect(lines).toHaveLength(3);
        expect(lines[1].color).toBe('muted');
        expect(lines[1].dashed).toBe(true);
        expect(lines[2].color).toBe('y');
    });

    it('labels the accumulated angle, so a double spin reads 720 and not 0', () => {
        const { labels } = buildRotateOverlay(rotationSession(), 4 * Math.PI, 720);
        expect(labels).toHaveLength(1);
        expect(labels[0].text).toBe('Y +720.0°');
        expect(labels[0].color).toBe('y');
    });

    it('puts the label halfway round the sweep', () => {
        const session = rotationSession();
        const angle = Math.PI / 2;
        const { labels } = buildRotateOverlay(session, angle, 90);
        expect(distance(labels[0].at, ringPointAt(session, angle / 2))).toBeLessThan(1e-5);
    });
});

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
