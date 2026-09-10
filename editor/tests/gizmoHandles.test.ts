import { describe, it, expect } from 'vitest';
import { vec3, quat } from 'gl-matrix';
import {
    handleSpecs,
    placementFor,
    placeHandles,
    tintHandles,
    thickenHandles,
    AXIS_CSS_COLORS,
    CENTRE_CSS_COLOR,
    type GizmoHandle,
    type HandleSpec,
} from '../src/features/gizmo/gizmoHandles';
import { planeQuadGeometry, type GizmoFrame } from '../src/features/gizmo/gizmoPick';
import { frameAxes } from '../src/features/gizmo/gizmoDrag';

/**
 * Placement of the drawn handles.
 *
 * The contract worth defending here is that the drawn plane quad and the PICKABLE plane quad are the
 * same rectangle. They are computed from one call (`planeQuadGeometry`) precisely so they cannot drift,
 * and the test below is what keeps it that way — a drifted pair looks fine and simply refuses to grab.
 *
 * `buildHandles` itself is absent: a `Model` allocates GPU buffers on construction, so it needs a device
 * this suite deliberately does not have. Everything downstream of it takes the handle list as an argument
 * precisely so it can be driven by the stub below.
 */

/** A handle with just the surface `placeHandles` and `tintHandles` touch. */
function stubHandle(spec: HandleSpec): GizmoHandle {
    const node = {
        name: spec.name,
        visible: true,
        position: vec3.create(),
        quaternion: quat.create(),
        scale: vec3.fromValues(1, 1, 1),
        setPosition(p: vec3) { vec3.copy(this.position, p); return this; },
        setQuaternion(q: quat) { quat.copy(this.quaternion, q); return this; },
        setScale(s: vec3) { vec3.copy(this.scale, s); return this; },
    };
    // Stand-ins for the two prebuilt Geometry objects; `thickenHandles` only ever compares identity.
    const shapes = { rest: { id: 'rest' }, hover: spec.shape === 'quad' || spec.shape === 'sphere' ? null : { id: 'hover' } };
    const model = {
        geometry: shapes.rest,
        uploads: 0,
        setGeometry(g: unknown) { this.geometry = g; this.uploads++; },
    };
    return { spec, node, model, material: { properties: new Map<string, unknown>() }, shapes } as unknown as GizmoHandle;
}

const stubHandles = (mode: 'position' | 'rotation' | 'scale') => handleSpecs(mode).map(stubHandle);

const unit = (x: number, y: number, z: number) => vec3.normalize(vec3.create(), vec3.fromValues(x, y, z));

const frame = (over: Partial<GizmoFrame> = {}): GizmoFrame => ({
    origin: vec3.fromValues(2, -1, 4),
    axes: frameAxes('world', quat.create()),
    scale: 1.5,
    toCamera: unit(1, 1, 1),
    ...over,
});

describe('placementFor', () => {
    it('lays the drawn plane quad exactly over the pickable one', () => {
        const f = frame();
        for (const id of ['xy', 'yz', 'zx'] as const) {
            const spec = handleSpecs('position').find(s => s.id === id)!;
            const place = placementFor(spec, f);
            const quad = planeQuadGeometry(f, id);

            // The unit quad runs 0..1 on its local X and Z, so its four corners in world space are the
            // node's position plus the rotated, scaled unit square.
            const corners = [[0, 0], [1, 0], [1, 1], [0, 1]].map(([u, w]) => {
                const p = vec3.clone(place.position);
                const local = vec3.fromValues(u * place.scale, 0, w * place.scale);
                vec3.transformQuat(local, local, place.quaternion);
                return vec3.add(p, p, local);
            });

            // Every corner must sit at half-width from the pick quad's centre along both in-plane axes.
            for (const corner of corners) {
                const rel = vec3.subtract(vec3.create(), corner, quad.centre);
                expect(Math.abs(vec3.dot(rel, quad.u)), `${id} u`).toBeCloseTo(quad.half, 4);
                expect(Math.abs(vec3.dot(rel, quad.w)), `${id} w`).toBeCloseTo(quad.half, 4);
                expect(vec3.dot(rel, quad.normal), `${id} normal`).toBeCloseTo(0, 4);
            }
        }
    });

    it('hides a plane handle that is too edge-on to grab', () => {
        const spec = handleSpecs('position').find(s => s.id === 'xy')!;
        expect(placementFor(spec, frame()).visible).toBe(true);
        // Looking along +Y leaves the XY plane a sliver on screen.
        expect(placementFor(spec, frame({ toCamera: vec3.fromValues(0, 1, 0) })).visible).toBe(false);
    });

    it('aims an axis handle down its own axis and sits it on the gizmo origin', () => {
        const f = frame({ axes: frameAxes('local', quat.fromEuler(quat.create(), 0, 90, 0)) });
        const spec = handleSpecs('position').find(s => s.id === 'x')!;
        const place = placementFor(spec, f);

        // The geometry points along +Y before it is turned, so local +Y must land on the handle's axis.
        const aimed = vec3.transformQuat(vec3.create(), [0, 1, 0], place.quaternion);
        expect(vec3.dot(aimed, f.axes[0])).toBeCloseTo(1, 4);
        expect(Array.from(place.position)).toEqual(Array.from(f.origin));
        expect(place.scale).toBe(f.scale);
    });

    it('rolls a rotation ring so its thick arc faces the viewer', () => {
        // `GizmoGeometry.Ring` swells its tube toward local +X, and only the near half of a ring is
        // pickable. If the roll ever stops tracking the camera the two disagree, and the rim that looks
        // heaviest is one you cannot grab.
        for (const axis of [0, 1, 2]) {
            const spec = handleSpecs('rotation')[axis];
            const f = frame({ toCamera: unit(0.3, 0.9, -0.4) });
            const place = placementFor(spec, f);

            const thick = vec3.transformQuat(vec3.create(), [1, 0, 0], place.quaternion);
            // In the ring's own plane, and pointing the same way as the viewer does.
            expect(vec3.dot(thick, f.axes[axis]), `axis ${axis} in plane`).toBeCloseTo(0, 4);
            const inPlane = vec3.scaleAndAdd(vec3.create(), f.toCamera, f.axes[axis], -vec3.dot(f.toCamera, f.axes[axis]));
            vec3.normalize(inPlane, inPlane);
            expect(vec3.dot(thick, inPlane), `axis ${axis} toward camera`).toBeCloseTo(1, 4);
        }
    });

    it('still gives a ring a usable roll when the camera looks straight down its axis', () => {
        const spec = handleSpecs('rotation')[1];
        const f = frame({ toCamera: vec3.fromValues(0, 1, 0) });
        const place = placementFor(spec, f);
        // No in-plane direction exists, so any perpendicular will do — but it must stay a unit rotation.
        expect(quat.length(place.quaternion)).toBeCloseTo(1, 4);
        const thick = vec3.transformQuat(vec3.create(), [1, 0, 0], place.quaternion);
        expect(vec3.dot(thick, f.axes[1])).toBeCloseTo(0, 4);
    });

    it('leaves the centre handle unrotated on the origin', () => {
        const f = frame();
        const spec = handleSpecs('scale').find(s => s.id === 'screen')!;
        const place = placementFor(spec, f);
        expect(Array.from(place.position)).toEqual(Array.from(f.origin));
        expect(Array.from(place.quaternion)).toEqual([0, 0, 0, 1]);
    });
});

describe('placeHandles', () => {
    it('writes nothing on a second identical frame', () => {
        // Every Node setter emits SCENE_CHANGED and this runs once per animation frame, so an ungated
        // placement would push a steady stream of events through the editor bus for a still camera.
        const handles = stubHandles('position');
        const f = frame();
        placeHandles(handles, f, false);

        const writes = countWrites(handles, () => placeHandles(handles, f, false));
        expect(writes).toBe(0);

        // ...and does write when the frame actually moves.
        expect(countWrites(handles, () => placeHandles(handles, frame({ scale: 3 }), false))).toBeGreaterThan(0);
    });

    it('hides everything when asked, whatever the frame says', () => {
        const handles = stubHandles('position');
        placeHandles(handles, frame(), true);
        expect(handles.every(h => !h.node.visible)).toBe(true);
    });
});

describe('tintHandles', () => {
    it('brightens the hovered handle and leaves the rest alone', () => {
        const handles = stubHandles('position');
        tintHandles(handles, 'x', null);

        const x = handles.find(h => h.spec.id === 'x')!;
        const y = handles.find(h => h.spec.id === 'y')!;
        expect(colorOf(x)[0]).toBeGreaterThan(x.spec.color[0]);
        expect(colorOf(y)).toEqual(y.spec.color);
    });

    it('dims everything but the handle being dragged', () => {
        const handles = stubHandles('position');
        tintHandles(handles, null, 'z');

        const z = handles.find(h => h.spec.id === 'z')!;
        const y = handles.find(h => h.spec.id === 'y')!;
        expect(colorOf(z)[2]).toBeGreaterThan(z.spec.color[2]);
        expect(colorOf(y)[1]).toBeLessThan(y.spec.color[1]);
    });
});

describe('thickenHandles', () => {
    it('swaps only the active handle onto its hover shape', () => {
        const handles = stubHandles('position');
        thickenHandles(handles, 'x', null);

        for (const h of handles)
            expect(shapeOf(h), h.spec.id).toBe(h.spec.id === 'x' ? h.shapes.hover : h.shapes.rest);
    });

    it('keeps the dragged handle thick and outranks the hover', () => {
        const handles = stubHandles('rotation');
        thickenHandles(handles, 'x', 'z');

        expect(shapeOf(handles.find(h => h.spec.id === 'z')!)).toBe(handles.find(h => h.spec.id === 'z')!.shapes.hover);
        expect(shapeOf(handles.find(h => h.spec.id === 'x')!)).toBe(handles.find(h => h.spec.id === 'x')!.shapes.rest);
    });

    it('leaves the plane quads and the centre at their pickable size', () => {
        // Both are drawn at exactly what `buildPickShapes` tests, so they have no hover shape to swap to.
        const handles = stubHandles('position');
        for (const id of ['xy', 'yz', 'zx', 'screen'] as const) {
            thickenHandles(handles, id, null);
            const h = handles.find(x => x.spec.id === id)!;
            expect(h.shapes.hover, id).toBeNull();
            expect(shapeOf(h), id).toBe(h.shapes.rest);
        }
    });

    it('re-uploads nothing while the hover holds still', () => {
        // A geometry swap costs a vertex re-upload and this runs once per animation frame, so an
        // ungated version would rebuild three meshes a frame for a cursor that never moved.
        const handles = stubHandles('position');
        thickenHandles(handles, 'y', null);
        const before = handles.map(uploadsOf);
        thickenHandles(handles, 'y', null);
        expect(handles.map(uploadsOf)).toEqual(before);

        thickenHandles(handles, 'z', null);
        expect(handles.map(uploadsOf).reduce((a, b) => a + b, 0)).toBeGreaterThan(before.reduce((a, b) => a + b, 0));
    });

    it('restores every handle once the cursor leaves', () => {
        const handles = stubHandles('scale');
        thickenHandles(handles, 'y', null);
        thickenHandles(handles, null, null);
        expect(handles.every(h => shapeOf(h) === h.shapes.rest)).toBe(true);
    });
});

describe('the shared palette', () => {
    it('gives the SVG readout the same colours as the 3D handles', () => {
        // One source of truth, so a recoloured axis cannot leave the readout showing the old hue.
        const specs = handleSpecs('position');
        for (const [i, id] of (['x', 'y', 'z'] as const).entries()) {
            const spec = specs.find(s => s.id === id && s.shape !== 'quad')!;
            expect(AXIS_CSS_COLORS[i]).toBe(`rgb(${spec.color.map(c => Math.round(c * 255)).join(' ')})`);
        }
        expect(CENTRE_CSS_COLOR).toMatch(/^rgb\(\d+ \d+ \d+\)$/);
    });
});

const colorOf = (h: GizmoHandle): number[] => h.material.properties.get('color');
const shapeOf = (h: GizmoHandle): unknown => h.model.geometry;
const uploadsOf = (h: GizmoHandle): number => (h.model as unknown as { uploads: number }).uploads;

/** How many handle nodes `run` actually moves, resizes, re-aims or toggles. */
function countWrites(handles: GizmoHandle[], run: () => void): number {
    const before = handles.map(h => [
        Array.from(h.node.position), Array.from(h.node.quaternion), Array.from(h.node.scale), h.node.visible,
    ]);
    run();
    const after = handles.map(h => [
        Array.from(h.node.position), Array.from(h.node.quaternion), Array.from(h.node.scale), h.node.visible,
    ]);
    return before.filter((b, i) => JSON.stringify(b) !== JSON.stringify(after[i])).length;
}
