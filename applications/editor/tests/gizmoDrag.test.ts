import { describe, it, expect } from 'vitest';
import { vec3, quat, mat4 } from 'gl-matrix';
import {
    beginDrag,
    solveDrag,
    rotateAngleFromPlane,
    rotateAngleFromScreen,
    frameAxes,
    formatUnits,
    formatDegrees,
    formatFactor,
    MIN_SCALE,
    ROTATE_PLANE_MIN_FACING,
    type DragTarget,
    type DragViewContext,
    type DragSession,
} from '../src/features/gizmo/gizmoDrag';
import { HANDLE_LENGTH, type GizmoFrame, type HandleId } from '../src/features/gizmo/gizmoPick';
import type { GizmoSpace } from '../src/utils/gizmoMath';
import type { GizmoMode } from '../src/features/engineContextTypes';

// gl-matrix stores in Float32Array, so anything routed through it carries ~1e-6 of error at these
// magnitudes. Tolerances below are set accordingly, not loosened to hide a real disagreement.

const unit = (x: number, y: number, z: number) => vec3.normalize(vec3.create(), vec3.fromValues(x, y, z));

/**
 * A camera 20 units back on +Z looking at the origin, with a real perspective projection — enough for
 * the screen-space branches (uniform scale, the edge-on rotation fallback) to be exercised for real.
 */
function makeView(eye: number[] = [0, 0, 20], up: number[] = [0, 1, 0]): DragViewContext {
    const view = mat4.lookAt(mat4.create(), eye as vec3, [0, 0, 0], up as vec3);
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000);
    return {
        viewProj: mat4.multiply(mat4.create(), proj, view),
        viewportWidth: 1600,
        viewportHeight: 900,
        cursor: { x: 800, y: 450 },
        cursorDelta: { x: 0, y: 0 },
    };
}

const worldFrame = (over: Partial<GizmoFrame> = {}): GizmoFrame => ({
    origin: vec3.fromValues(0, 0, 0),
    axes: frameAxes('world', quat.create()),
    scale: 1,
    toCamera: unit(0, 0, 1),
    ...over,
});

const identityTarget = (over: Partial<DragTarget> = {}): DragTarget => ({
    worldPosition: vec3.fromValues(0, 0, 0),
    worldQuaternion: quat.create(),
    localPosition: vec3.fromValues(0, 0, 0),
    localScale: vec3.fromValues(1, 1, 1),
    parentWorldTransform: null,
    parentWorldQuaternion: quat.create(),
    ...over,
});

/** A ray that meets `axis` at parameter `s`, approached perpendicular from `from`. */
function rayOntoAxis(origin: vec3, axis: vec3, s: number, from: vec3, distance = 30) {
    const point = vec3.scaleAndAdd(vec3.create(), origin, axis, s);
    return {
        origin: vec3.scaleAndAdd(vec3.create(), point, from, distance),
        dir: vec3.negate(vec3.create(), from),
    };
}

function start(
    handle: HandleId,
    mode: GizmoMode,
    space: GizmoSpace,
    frame: GizmoFrame,
    target: DragTarget,
    ray: { origin: vec3; dir: vec3 },
    view = makeView(),
): DragSession {
    return beginDrag(handle, mode, space, frame, target, ray.origin, ray.dir, view);
}

describe('translate', () => {
    const down = vec3.fromValues(0, 1, 0);

    it('moves exactly as far as the cursor ray travels along the axis', () => {
        const frame = worldFrame();
        const target = identityTarget();
        const grab = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0.6, down);
        const session = start('x', 'position', 'world', frame, target, grab);

        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 3.6, down);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);

        expect(out.degenerate).toBe(false);
        expect(out.patch.kind).toBe('position');
        if (out.patch.kind !== 'position') return;
        expect(out.patch.local[0]).toBeCloseTo(3, 5);
        expect(out.patch.local[1]).toBeCloseTo(0, 5);
        expect(out.patch.local[2]).toBeCloseTo(0, 5);
    });

    it('lands on the intended WORLD point under a translated and rotated parent', () => {
        // The bug this whole module exists to fix: the old gizmo computed a world-space delta and wrote it
        // straight into the parent-local transform, so a node under a rotated parent went somewhere else.
        const parentQuat = quat.fromEuler(quat.create(), 20, -55, 12);
        const parentWorld = mat4.fromRotationTranslation(mat4.create(), parentQuat, [7, -3, 2]);
        const nodeWorld = vec3.fromValues(9, 1, 5);

        const target = identityTarget({
            worldPosition: nodeWorld,
            localPosition: vec3.transformMat4(vec3.create(), nodeWorld, mat4.invert(mat4.create(), parentWorld)!),
            parentWorldTransform: parentWorld,
            parentWorldQuaternion: parentQuat,
        });
        const frame = worldFrame({ origin: nodeWorld });

        const grab = rayOntoAxis(nodeWorld, frame.axes[1] as vec3, 0, vec3.fromValues(0, 0, 1));
        const session = start('y', 'position', 'world', frame, target, grab);

        const move = rayOntoAxis(nodeWorld, frame.axes[1] as vec3, 2.5, vec3.fromValues(0, 0, 1));
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');

        // Push the parent-local answer back out through the parent: it must be exactly 2.5 up in WORLD.
        const back = vec3.transformMat4(vec3.create(), out.patch.local, parentWorld);
        expect(back[0]).toBeCloseTo(nodeWorld[0], 4);
        expect(back[1]).toBeCloseTo(nodeWorld[1] + 2.5, 4);
        expect(back[2]).toBeCloseTo(nodeWorld[2], 4);
    });

    it('follows the node\'s own axis in local space', () => {
        // A node yawed 90 degrees: its local +X points along world -Z.
        const nodeQuat = quat.fromEuler(quat.create(), 0, 90, 0);
        const target = identityTarget({ worldQuaternion: nodeQuat });
        const frame = worldFrame({ axes: frameAxes('local', nodeQuat) });

        const axis = frame.axes[0] as vec3;
        const session = start('x', 'position', 'local', frame, target, rayOntoAxis(vec3.create(), axis, 0, down));
        const out = solveDrag(session, ...Object.values(rayOntoAxis(vec3.create(), axis, 2, down)) as [vec3, vec3], makeView(), false);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');

        expect(out.patch.local[0]).toBeCloseTo(axis[0] * 2, 4);
        expect(out.patch.local[1]).toBeCloseTo(axis[1] * 2, 4);
        expect(out.patch.local[2]).toBeCloseTo(axis[2] * 2, 4);
    });

    it('snaps the delta to whole units when asked', () => {
        const frame = worldFrame();
        const session = start('x', 'position', 'world', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0, down));
        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 2.7, down);
        const out = solveDrag(session, move.origin, move.dir, makeView(), true);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');
        expect(out.patch.local[0]).toBeCloseTo(3, 5);
    });

    it('holds still on a degenerate axis instead of jumping or emitting NaN', () => {
        const frame = worldFrame();
        const session = start('z', 'position', 'world', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[2] as vec3, 0, down));

        // Sighting straight down the Z axis: the closest-point solve has no answer.
        const out = solveDrag(session, [0, 0, 30], [0, 0, -1], makeView(), false);
        expect(out.degenerate).toBe(true);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');
        expect(Array.from(out.patch.local).every(Number.isFinite)).toBe(true);
        expect(Array.from(out.patch.local)).toEqual([0, 0, 0]);
    });

    it('leaves the normal component untouched on a plane drag', () => {
        const frame = worldFrame();
        // XY plane: the normal is world Z, so a drag in it must never change Z.
        const grabRay = { origin: vec3.fromValues(0.5, 0.5, 30), dir: vec3.fromValues(0, 0, -1) };
        const session = start('xy', 'position', 'world', frame, identityTarget(), grabRay);

        const out = solveDrag(session, [3.5, -1.5, 30], [0, 0, -1], makeView(), false);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');
        expect(out.patch.local[0]).toBeCloseTo(3, 4);
        expect(out.patch.local[1]).toBeCloseTo(-2, 4);
        expect(out.patch.local[2]).toBeCloseTo(0, 6);
    });

    it('drags the centre handle in the plane facing the camera', () => {
        const frame = worldFrame();
        // Grabbed and moved along a ray aimed down -Z, so the drag plane is the XY plane.
        const session = start('screen', 'position', 'world', frame, identityTarget(), { origin: vec3.fromValues(0, 0, 30), dir: vec3.fromValues(0, 0, -1) });
        const out = solveDrag(session, [2, -1, 30], [0, 0, -1], makeView(), false);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');

        expect(out.patch.local[0]).toBeCloseTo(2, 4);
        expect(out.patch.local[1]).toBeCloseTo(-1, 4);
        expect(out.patch.local[2]).toBeCloseTo(0, 4);
        // One label carrying all three components, since no single axis names this drag.
        expect(out.overlay.labels[0].text).toBe('+2.00 -1.00 +0.00');
    });

    it('ignores snapping on the centre handle', () => {
        // The screen plane is not aligned to anything a user can reason about, so a snapped step there
        // would land on an arbitrary lattice. Deliberately unsnapped.
        const frame = worldFrame();
        const session = start('screen', 'position', 'world', frame, identityTarget(), { origin: vec3.fromValues(0, 0, 30), dir: vec3.fromValues(0, 0, -1) });
        const out = solveDrag(session, [2.7, 0, 30], [0, 0, -1], makeView(), true);
        if (out.patch.kind !== 'position') throw new Error('expected a position patch');
        expect(out.patch.local[0]).toBeCloseTo(2.7, 4);
    });

    it('draws a dashed guide plus a measure segment and one signed label', () => {
        const frame = worldFrame();
        const session = start('x', 'position', 'world', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0, down));
        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, -0.25, down);
        const { overlay } = solveDrag(session, move.origin, move.dir, makeView(), false);

        expect(overlay.lines.filter(l => l.dashed)).toHaveLength(1);
        expect(overlay.lines.filter(l => !l.dashed)).toHaveLength(1);
        expect(overlay.labels).toHaveLength(1);
        expect(overlay.labels[0].text).toBe('X -0.25');
        expect(overlay.labels[0].color).toBe('x');
    });
});

describe('rotate', () => {
    /** Grab a ring at angle 0 and swing the ray round to `angle`, staying in the ring's plane. */
    function ringRay(normal: vec3, angle: number, radius = 1) {
        const u = Math.abs(normal[1]) < 0.9 ? vec3.fromValues(0, 1, 0) : vec3.fromValues(1, 0, 0);
        const e1 = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), normal, u));
        const e2 = vec3.cross(vec3.create(), normal, e1);
        const point = vec3.create();
        vec3.scaleAndAdd(point, point, e1, Math.cos(angle) * radius);
        vec3.scaleAndAdd(point, point, e2, Math.sin(angle) * radius);
        return {
            origin: vec3.scaleAndAdd(vec3.create(), point, normal, 30),
            dir: vec3.negate(vec3.create(), normal),
        };
    }

    it('turns a quarter turn into the matching world quaternion', () => {
        const frame = worldFrame();
        const n = frame.axes[1] as vec3;
        const session = start('y', 'rotation', 'world', frame, identityTarget(), ringRay(n, 0));
        const move = ringRay(n, Math.PI / 2);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'rotation') throw new Error('expected a rotation patch');

        const expected = quat.setAxisAngle(quat.create(), n, Math.PI / 2);
        expect(Math.abs(quat.dot(out.patch.localQuat, expected))).toBeCloseTo(1, 5);
    });

    it('keeps counting past a full turn while the quaternion stays correct mod 2pi', () => {
        const frame = worldFrame();
        const n = frame.axes[1] as vec3;
        const session = start('y', 'rotation', 'world', frame, identityTarget(), ringRay(n, 0));

        // 1.25 turns, sampled finely enough that no single step exceeds half a turn.
        const total = 1.25 * Math.PI * 2;
        let out = solveDrag(session, ...([ringRay(n, 0).origin, ringRay(n, 0).dir] as [vec3, vec3]), makeView(), false);
        for (let i = 1; i <= 40; i++) {
            const r = ringRay(n, (total * i) / 40);
            out = solveDrag(session, r.origin, r.dir, makeView(), false);
        }

        expect(session.accumulatedAngle).toBeCloseTo(total, 3);
        expect(out.overlay.labels[0].text).toContain('450.0');

        if (out.patch.kind !== 'rotation') throw new Error('expected a rotation patch');
        const expected = quat.setAxisAngle(quat.create(), n, total);
        expect(Math.abs(quat.dot(out.patch.localQuat, expected))).toBeCloseTo(1, 4);
    });

    it('snaps to 15 degree steps', () => {
        const frame = worldFrame();
        const n = frame.axes[1] as vec3;
        for (const [deg, want] of [[37, 30], [38, 45]] as const) {
            const session = start('y', 'rotation', 'world', frame, identityTarget(), ringRay(n, 0));
            const move = ringRay(n, (deg * Math.PI) / 180);
            const out = solveDrag(session, move.origin, move.dir, makeView(), true);
            if (out.patch.kind !== 'rotation') throw new Error('expected a rotation patch');
            const expected = quat.setAxisAngle(quat.create(), n, (want * Math.PI) / 180);
            expect(Math.abs(quat.dot(out.patch.localQuat, expected))).toBeCloseTo(1, 5);
        }
    });

    it('produces the right WORLD orientation under a rotated parent', () => {
        const parentQuat = quat.fromEuler(quat.create(), 25, 40, -10);
        const parentWorld = mat4.fromRotationTranslation(mat4.create(), parentQuat, [1, 2, 3]);
        const nodeWorldQuat = quat.fromEuler(quat.create(), 5, -30, 15);
        const target = identityTarget({
            worldQuaternion: nodeWorldQuat,
            parentWorldTransform: parentWorld,
            parentWorldQuaternion: parentQuat,
        });

        const frame = worldFrame();
        const n = frame.axes[2] as vec3;
        const session = start('z', 'rotation', 'world', frame, target, ringRay(n, 0));
        const move = ringRay(n, Math.PI / 3);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'rotation') throw new Error('expected a rotation patch');

        const back = quat.normalize(quat.create(), quat.multiply(quat.create(), parentQuat, out.patch.localQuat));
        const expected = quat.normalize(quat.create(),
            quat.multiply(quat.create(), quat.setAxisAngle(quat.create(), n, Math.PI / 3), nodeWorldQuat));
        expect(Math.abs(quat.dot(back, expected))).toBeCloseTo(1, 4);
    });

    it('freezes the local axis at grab time so the ring cannot spin out from under the cursor', () => {
        const nodeQuat = quat.fromEuler(quat.create(), 0, 45, 0);
        const frame = worldFrame({ axes: frameAxes('local', nodeQuat) });
        const session = start('y', 'rotation', 'local', frame, identityTarget({ worldQuaternion: nodeQuat }), ringRay(frame.axes[1] as vec3, 0));

        const before = vec3.clone(session.axes[1]);
        solveDrag(session, ...([ringRay(frame.axes[1] as vec3, 0.4).origin, ringRay(frame.axes[1] as vec3, 0.4).dir] as [vec3, vec3]), makeView(), false);
        expect(Array.from(session.axes[1])).toEqual(Array.from(before));
    });

    it('still has a usable starting angle when the ring is grabbed dead centre', () => {
        // A ray through the exact middle of the ring gives no radial direction to measure from; the
        // session falls back to an arbitrary in-plane axis rather than emitting NaN.
        const frame = worldFrame();
        const n = frame.axes[1] as vec3;
        const session = start('y', 'rotation', 'world', frame, identityTarget(), { origin: vec3.fromValues(0, 30, 0), dir: vec3.fromValues(0, -1, 0) });

        expect(Array.from(session.grabBasisU).every(Number.isFinite)).toBe(true);
        expect(vec3.length(session.grabBasisU)).toBeCloseTo(1, 5);
        expect(vec3.dot(session.grabBasisU, n)).toBeCloseTo(0, 5);

        const move = ringRay(n, 0.5);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'rotation') throw new Error('expected a rotation patch');
        expect(Array.from(out.patch.localQuat).every(Number.isFinite)).toBe(true);
    });

    it('agrees between the plane and screen-tangent branches at the crossover', () => {
        // This is what pins the fallback's handedness: at the threshold the two solvers must produce the
        // same increment, or crossing it mid-drag would snap the object round.
        const view = makeView([0, 0, 20]);
        const frame = worldFrame();

        // Tilt the ring normal until it sits exactly at the threshold against the ray direction.
        const rayDir = vec3.fromValues(0, 0, -1);
        const theta = Math.asin(ROTATE_PLANE_MIN_FACING);
        const n = unit(Math.cos(theta), 0, -Math.sin(theta));
        expect(Math.abs(vec3.dot(n, rayDir))).toBeCloseTo(ROTATE_PLANE_MIN_FACING, 6);

        const axes: [vec3, vec3, vec3] = [n, unit(0, 1, 0), unit(0, 0, 1)];
        const grabRay = { origin: vec3.fromValues(0, 1, 30), dir: vec3.fromValues(0, 0, -1) };
        const session = start('x', 'rotation', 'world', { ...frame, axes }, identityTarget(), grabRay, view);

        // Take one small step and measure it with the plane solver...
        const stepPx = 4;
        const p0 = uiProject(view, session, 0);
        const p1 = uiProject(view, session, 0.02);
        const dir = { x: p1.x - p0.x, y: p1.y - p0.y };
        const len = Math.hypot(dir.x, dir.y);
        const cursorDelta = { x: (dir.x / len) * stepPx, y: (dir.y / len) * stepPx };

        const screenOnly = { ...session, accumulatedAngle: 0 } as DragSession;
        const viaScreen = rotateAngleFromScreen(screenOnly, { ...view, cursorDelta });

        // ...and with the plane solver, aiming the ray at where that screen step lands on the ring.
        const planeOnly = { ...session, accumulatedAngle: 0 } as DragSession;
        const targetPoint = ringWorld(planeOnly, viaScreen!);
        const viaPlane = rotateAngleFromPlane(planeOnly, vec3.scaleAndAdd(vec3.create(), targetPoint, [0, 0, 1], 30), [0, 0, -1]);

        expect(viaPlane).not.toBeNull();
        expect(viaPlane!).toBeCloseTo(viaScreen!, 3);
    });
});

// Small helpers for the crossover test — kept out of the module so the production path has no test hooks.
function ringWorld(session: DragSession, angle: number): vec3 {
    const out = vec3.clone(session.origin);
    vec3.scaleAndAdd(out, out, session.grabBasisU, Math.cos(angle) * session.gizmoScale);
    vec3.scaleAndAdd(out, out, session.grabBasisW, Math.sin(angle) * session.gizmoScale);
    return out;
}
function uiProject(view: DragViewContext, session: DragSession, angle: number) {
    const p = ringWorld(session, angle);
    const vp = view.viewProj;
    const cx = vp[0] * p[0] + vp[4] * p[1] + vp[8] * p[2] + vp[12];
    const cy = vp[1] * p[0] + vp[5] * p[1] + vp[9] * p[2] + vp[13];
    const cw = vp[3] * p[0] + vp[7] * p[1] + vp[11] * p[2] + vp[15];
    return {
        x: (cx / cw * 0.5 + 0.5) * view.viewportWidth,
        y: (1 - (cy / cw * 0.5 + 0.5)) * view.viewportHeight,
    };
}

describe('scale', () => {
    const down = vec3.fromValues(0, 1, 0);

    it('doubles when dragged out one handle length and halves when dragged in half of one', () => {
        const frame = worldFrame();
        for (const [travel, want] of [[HANDLE_LENGTH, 2], [-HANDLE_LENGTH / 2, 0.5]] as const) {
            const session = start('x', 'scale', 'local', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0.5, down));
            const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0.5 + travel, down);
            const out = solveDrag(session, move.origin, move.dir, makeView(), false);
            if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
            expect(out.patch.local[0]).toBeCloseTo(want, 5);
            expect(out.patch.local[1]).toBeCloseTo(1, 6);
            expect(out.patch.local[2]).toBeCloseTo(1, 6);
        }
    });

    it('clamps at MIN_SCALE however far inward the drag goes', () => {
        const frame = worldFrame();
        const session = start('x', 'scale', 'local', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0.5, down));
        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, -500, down);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
        // Float32 storage, so compare against the clamp rather than for exact identity; what matters is
        // that it never reaches zero, which would leave the node with a singular, unrecoverable transform.
        expect(out.patch.local[0]).toBeCloseTo(MIN_SCALE, 8);
        expect(out.patch.local[0]).toBeGreaterThan(0);
    });

    it('uses the node\'s own axes even when the space preference says world', () => {
        // The toolbar greys the toggle in scale mode, but the solver must not depend on that: a world
        // scale on a rotated node has no TRS representation at all.
        const nodeQuat = quat.fromEuler(quat.create(), 0, 90, 0);
        const frame = worldFrame({ axes: frameAxes('local', nodeQuat) });
        const axis = frame.axes[0] as vec3;
        const session = start('x', 'scale', 'local', frame, identityTarget({ worldQuaternion: nodeQuat }), rayOntoAxis(vec3.create(), axis, 0.5, down));

        const move = rayOntoAxis(vec3.create(), axis, 1.5, down);
        const out = solveDrag(session, move.origin, move.dir, makeView(), false);
        if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
        // Only the node's own X component changed, even though that axis points along world -Z.
        expect(out.patch.local[0]).toBeCloseTo(2, 5);
        expect(out.patch.local[1]).toBeCloseTo(1, 6);
        expect(out.patch.local[2]).toBeCloseTo(1, 6);
    });

    it('snaps the factor to 0.1 steps', () => {
        const frame = worldFrame();
        const session = start('x', 'scale', 'local', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0, down));
        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0.73, down);
        const out = solveDrag(session, move.origin, move.dir, makeView(), true);
        if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
        expect(out.patch.local[0]).toBeCloseTo(1.7, 5);
    });

    it('spreads the factor over both in-plane components and leaves the third alone', () => {
        const frame = worldFrame();
        const grabRay = { origin: vec3.fromValues(0.5, 0.5, 30), dir: vec3.fromValues(0, 0, -1) };
        const session = start('xy', 'scale', 'local', frame, identityTarget(), grabRay);

        const out = solveDrag(session, [1, 1, 30], [0, 0, -1], makeView(), false);
        if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
        expect(out.patch.local[0]).toBeCloseTo(out.patch.local[1], 6);
        expect(out.patch.local[0]).toBeGreaterThan(1);
        expect(out.patch.local[2]).toBeCloseTo(1, 6);
    });

    it('scales all three components from the centre handle', () => {
        const view = makeView();
        const frame = worldFrame();
        const session = beginDrag('screen', 'scale', 'local', frame, identityTarget(), [0.2, 0.2, 30], [0, 0, -1],
            { ...view, cursor: { x: 900, y: 450 } });
        const out = solveDrag(session, [0.2, 0.2, 30], [0, 0, -1], { ...view, cursor: { x: 1000, y: 450 } }, false);
        if (out.patch.kind !== 'scale') throw new Error('expected a scale patch');
        expect(out.patch.local[0]).toBeCloseTo(out.patch.local[1], 6);
        expect(out.patch.local[1]).toBeCloseTo(out.patch.local[2], 6);
        expect(out.patch.local[0]).toBeGreaterThan(1);
    });

    it('draws the original handle muted beside the current one', () => {
        const frame = worldFrame();
        const session = start('x', 'scale', 'local', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0, down));
        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 1, down);
        const { overlay } = solveDrag(session, move.origin, move.dir, makeView(), false);

        expect(overlay.lines).toHaveLength(2);
        expect(overlay.lines.map(l => l.color)).toEqual(['muted', 'x']);
        expect(overlay.labels[0].text).toBe('×2.00');
    });
});

describe('purity', () => {
    it('gives identical output for identical input on a cloned session', () => {
        const frame = worldFrame();
        const down = vec3.fromValues(0, 1, 0);
        const a = start('x', 'position', 'world', frame, identityTarget(), rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 0, down));
        const b: DragSession = { ...a, axes: [...a.axes] as [vec3, vec3, vec3] };

        const move = rayOntoAxis(vec3.create(), frame.axes[0] as vec3, 1.7, down);
        const first = solveDrag(a, move.origin, move.dir, makeView(), false);
        const second = solveDrag(b, move.origin, move.dir, makeView(), false);

        if (first.patch.kind !== 'position' || second.patch.kind !== 'position') throw new Error('expected position patches');
        expect(Array.from(second.patch.local)).toEqual(Array.from(first.patch.local));
    });
});

describe('formatters', () => {
    it('always carries a sign on units and degrees', () => {
        expect(formatUnits(3)).toBe('+3.00');
        expect(formatUnits(-0.25)).toBe('-0.25');
        expect(formatUnits(0)).toBe('+0.00');
        expect(formatDegrees(450)).toBe('+450.0°');
        expect(formatDegrees(-127.45)).toBe('-127.5°');
    });

    it('shows scale as a multiplier', () => {
        expect(formatFactor(1.75)).toBe('×1.75');
        expect(formatFactor(0.5)).toBe('×0.50');
    });
});
