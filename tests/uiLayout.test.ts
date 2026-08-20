import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
    UIRect, setRect, solveRect, rootScale, projectToScreen, worldUIScale,
    intersectRect, rectOffscreen, stackLayout, edgeClamp, quadHomography,
} from '../src/core/uiLayout';

const rect = (x: number, y: number, w: number, h: number): UIRect => ({ x, y, width: w, height: h });
const out = (): UIRect => ({ x: 0, y: 0, width: 0, height: 0 });

describe('solveRect', () => {
    const parent = rect(0, 0, 1000, 600);

    it('pins to the top-left when both anchors are (0,0)', () => {
        // The legacy migration target: absolute CSS left/top/width/height becomes a top-left pin.
        const r = solveRect(out(), parent, [0, 0], [0, 0], [20, 30], [120, 80]);
        expect(r).toEqual(rect(20, 30, 100, 50));
    });

    it('pins to each corner independently', () => {
        // Bottom-right: anchor (1,1) means offsets are measured back from the far corner, so both are
        // negative. Y grows DOWN, so anchor y=1 is the BOTTOM edge.
        expect(solveRect(out(), parent, [1, 1], [1, 1], [-110, -60], [-10, -10]))
            .toEqual(rect(890, 540, 100, 50));
        // Top-right.
        expect(solveRect(out(), parent, [1, 0], [1, 0], [-110, 10], [-10, 60]))
            .toEqual(rect(890, 10, 100, 50));
    });

    it('stretches across an axis when the anchors differ, reading offsets as insets', () => {
        const r = solveRect(out(), parent, [0, 0], [1, 0], [16, 0], [-16, 48]);
        expect(r).toEqual(rect(16, 0, 968, 48));
    });

    it('full-stretch with zero offsets fills the parent exactly', () => {
        expect(solveRect(out(), parent, [0, 0], [1, 1], [0, 0], [0, 0])).toEqual(parent);
    });

    it('is relative to the parent origin, so nesting composes', () => {
        const child = solveRect(out(), rect(100, 50, 400, 300), [0, 0], [0, 0], [10, 10], [60, 40]);
        expect(child).toEqual(rect(110, 60, 50, 30));
    });

    it('clamps a crossed-over rect to zero rather than inverting it', () => {
        // A negative width has no meaning to the DOM and would silently mirror the element.
        const r = solveRect(out(), parent, [0, 0], [0, 0], [100, 100], [40, 40]);
        expect(r.width).toBe(0);
        expect(r.height).toBe(0);
    });
});

describe('rootScale', () => {
    it('constantPixel ignores the viewport entirely', () => {
        expect(rootScale('constantPixel', 640, 480, 1920, 1080, 0.5)).toBe(1);
    });

    it('scaleWithScreen follows width at match=0 and height at match=1', () => {
        expect(rootScale('scaleWithScreen', 960, 1080, 1920, 1080, 0)).toBeCloseTo(0.5, 10);
        expect(rootScale('scaleWithScreen', 960, 1080, 1920, 1080, 1)).toBeCloseTo(1, 10);
    });

    it('interpolates in log space, not linearly', () => {
        // The whole point of the log-lerp: sqrt(0.5 * 1) = 0.7071, NOT the linear midpoint 0.75.
        const s = rootScale('scaleWithScreen', 960, 1080, 1920, 1080, 0.5);
        expect(s).toBeCloseTo(Math.SQRT1_2, 10);
        expect(s).not.toBeCloseTo(0.75, 3);
    });

    it('is 1 at the reference resolution regardless of match', () => {
        for (const match of [0, 0.25, 0.5, 0.75, 1])
            expect(rootScale('scaleWithScreen', 1920, 1080, 1920, 1080, match)).toBeCloseTo(1, 10);
    });

    it('survives a zero reference resolution instead of returning NaN', () => {
        // Authorable in the inspector for as long as it takes to type over the old value.
        expect(rootScale('scaleWithScreen', 1920, 1080, 0, 1080, 0.5)).toBe(1);
        expect(rootScale('scaleWithScreen', 1920, 1080, 1920, 0, 0.5)).toBe(1);
    });

    it('constantPhysical tracks the device pixel ratio', () => {
        expect(rootScale('constantPhysical', 1920, 1080, 1920, 1080, 0, 2, 1)).toBe(2);
        expect(rootScale('constantPhysical', 1920, 1080, 1920, 1080, 0, 3, 3)).toBe(1);
    });
});

describe('projectToScreen', () => {
    // A camera at the origin looking down +Z, matching Node.worldForward.
    const view = mat4.lookAt(mat4.create(), [0, 0, 0], [0, 0, 1], [0, 1, 0]);
    const proj = mat4.perspective(mat4.create(), Math.PI / 2, 1, 0.1, 100);
    const viewProj = mat4.multiply(mat4.create(), proj, view);

    it('puts a point straight ahead at the centre of the viewport', () => {
        const p = projectToScreen(viewProj, vec3.fromValues(0, 0, 10), 800, 600);
        expect(p.inFront).toBe(true);
        expect(p.x).toBeCloseTo(400, 6);
        expect(p.y).toBeCloseTo(300, 6);
    });

    // The bug every implementation of this ships once: WebGL NDC is bottom-up, the DOM is top-down.
    // Without the flip a HUD is mirrored vertically, which looks "roughly right" near screen centre.
    it('flips Y so that a point ABOVE the camera lands in the UPPER half', () => {
        const above = projectToScreen(viewProj, vec3.fromValues(0, 5, 10), 800, 600);
        const below = projectToScreen(viewProj, vec3.fromValues(0, -5, 10), 800, 600);
        expect(above.y).toBeLessThan(300);
        expect(below.y).toBeGreaterThan(300);
        // Symmetric about the centre line.
        expect(above.y + below.y).toBeCloseTo(600, 6);
    });

    // X is NOT flipped by the projection -- but the engine's camera convention still puts world +X on
    // screen-LEFT for a default-oriented camera, because CameraNode drives `eye = worldPosition +
    // worldForward` and worldForward is +Z: facing +Z, your right hand points at -X. (This is why the
    // editor's 2D rig rotates its camera by 180 degrees to make +X read as "right".) Asserting the real
    // handedness here rather than the intuitive one is the point of the test.
    it('maps world +X to screen-left for a camera facing +Z, and is symmetric', () => {
        const plusX = projectToScreen(viewProj, vec3.fromValues(5, 0, 10), 800, 600);
        const minusX = projectToScreen(viewProj, vec3.fromValues(-5, 0, 10), 800, 600);
        expect(plusX.x).toBeLessThan(400);
        expect(minusX.x).toBeGreaterThan(400);
        expect(plusX.x + minusX.x).toBeCloseTo(800, 6);
    });

    // Without the w guard a point behind the camera projects to a plausible on-screen coordinate,
    // mirrored across the origin — a world label that should be hidden instead appears in the wrong place.
    it('reports a point behind the camera as not in front', () => {
        const behind = projectToScreen(viewProj, vec3.fromValues(0, 0, -10), 800, 600);
        expect(behind.inFront).toBe(false);
    });

    it('reports a point on the camera plane as not in front', () => {
        expect(projectToScreen(viewProj, vec3.fromValues(0, 0, 0), 800, 600).inFront).toBe(false);
    });

    it('returns camera-space depth as the distance', () => {
        expect(projectToScreen(viewProj, vec3.fromValues(0, 0, 25), 800, 600).distance).toBeCloseTo(25, 6);
    });
});

describe('worldUIScale', () => {
    it('shrinks with distance under perspective', () => {
        const near = worldUIScale(false, 5, 10, 0.1, 10, 600, 8);
        const far = worldUIScale(false, 20, 10, 0.1, 10, 600, 8);
        expect(near).toBeCloseTo(2, 10);
        expect(far).toBeCloseTo(0.5, 10);
        expect(far).toBeLessThan(near);
    });

    it('clamps to the authored min/max', () => {
        expect(worldUIScale(false, 0.001, 10, 0.5, 3, 600, 8)).toBe(3);
        expect(worldUIScale(false, 10000, 10, 0.5, 3, 600, 8)).toBe(0.5);
    });

    // Ortho has no perspective divide, so a distance-based scale would make a label breathe while the
    // world stayed put. Pixels-per-world-unit is taken from the VERTICAL extent because
    // Camera.projectionMatrix scales left/right by the aspect ratio but leaves top/bottom alone.
    it('ignores distance entirely under orthographic projection', () => {
        const a = worldUIScale(true, 5, 10, 0.01, 1000, 600, 8);
        const b = worldUIScale(true, 500, 10, 0.01, 1000, 600, 8);
        expect(a).toBe(b);
        expect(a).toBeCloseTo(75, 10); // 600px / 8 world units
    });
});

describe('intersectRect / rectOffscreen', () => {
    it('intersects overlapping rects', () => {
        expect(intersectRect(out(), rect(0, 0, 100, 100), rect(50, 25, 100, 100)))
            .toEqual(rect(50, 25, 50, 75));
    });

    it('yields a zero-size rect for disjoint inputs rather than a negative one', () => {
        const r = intersectRect(out(), rect(0, 0, 10, 10), rect(100, 100, 10, 10));
        expect(r.width).toBe(0);
        expect(r.height).toBe(0);
    });

    it('detects fully-outside rects, honouring the margin', () => {
        const bounds = rect(0, 0, 800, 600);
        expect(rectOffscreen(rect(-200, 0, 100, 100), bounds)).toBe(true);
        expect(rectOffscreen(rect(-50, 0, 100, 100), bounds)).toBe(false); // straddles the edge
        expect(rectOffscreen(rect(-200, 0, 100, 100), bounds, 150)).toBe(false); // inside the margin
        expect(rectOffscreen(rect(0, 700, 100, 100), bounds)).toBe(true);
    });
});

describe('stackLayout', () => {
    it('lays fixed children out in order with the gap between them', () => {
        const r = stackLayout([], [{ size: 100, flex: 0 }, { size: 50, flex: 0 }], 400, 10, 'start', false);
        expect(r).toEqual([{ offset: 0, size: 100 }, { offset: 110, size: 50 }]);
    });

    it('centres and end-aligns the leftover space', () => {
        const items = [{ size: 100, flex: 0 }, { size: 100, flex: 0 }];
        // used = 200 + one 0 gap = 200; slack = 100.
        expect(stackLayout([], items, 300, 0, 'center', false)[0].offset).toBe(50);
        expect(stackLayout([], items, 300, 0, 'end', false)[0].offset).toBe(100);
    });

    it('spaceBetween pushes the first and last to the edges', () => {
        const r = stackLayout([], [{ size: 50, flex: 0 }, { size: 50, flex: 0 }], 300, 0, 'spaceBetween', false);
        expect(r[0].offset).toBe(0);
        expect(r[1].offset + r[1].size).toBe(300);
    });

    it('distributes leftover space by flex weight', () => {
        const r = stackLayout([], [{ size: 0, flex: 1 }, { size: 0, flex: 3 }], 400, 0, 'start', false);
        expect(r[0].size).toBe(100);
        expect(r[1].size).toBe(300);
    });

    it('collapses flex children to zero instead of going negative when fixed children overflow', () => {
        const r = stackLayout([], [{ size: 500, flex: 0 }, { size: 0, flex: 1 }], 300, 0, 'start', false);
        expect(r[1].size).toBe(0);
    });

    it('reverse walks the children back-to-front without changing their sizes', () => {
        const items = [{ size: 100, flex: 0 }, { size: 50, flex: 0 }];
        const r = stackLayout([], items, 400, 10, 'start', true);
        expect(r[1]).toEqual({ offset: 0, size: 50 });   // last child sits first
        expect(r[0]).toEqual({ offset: 60, size: 100 });
    });

    it('handles an empty stack', () => {
        expect(stackLayout([], [], 400, 10, 'center', false)).toEqual([]);
    });
});

describe('edgeClamp', () => {
    const VP = { w: 800, h: 600 };

    it('leaves an on-screen anchor alone and reports it on-screen', () => {
        const r = edgeClamp(300, 200, 100, 50, VP.w, VP.h);
        expect(r).toMatchObject({ x: 300, y: 200, offscreen: false });
    });

    it('pins an anchor that has left the viewport', () => {
        const left = edgeClamp(-500, 200, 100, 50, VP.w, VP.h);
        expect(left.x).toBe(0);
        expect(left.offscreen).toBe(true);

        const right = edgeClamp(5000, 200, 100, 50, VP.w, VP.h);
        expect(right.x).toBe(VP.w - 100);
        expect(right.offscreen).toBe(true);
    });

    it('honours a margin', () => {
        expect(edgeClamp(-500, -500, 40, 40, VP.w, VP.h, 12).x).toBe(12);
        expect(edgeClamp(5000, 5000, 40, 40, VP.w, VP.h, 12).y).toBe(VP.h - 40 - 12);
    });

    it('reports the direction clockwise from screen-right, matching CSS rotate()', () => {
        // Y is DOWN in UI space, so a target below centre is +90, not -90. Getting this backwards makes
        // every offscreen marker point at its mirror image.
        const right = edgeClamp(VP.w / 2 + 300, VP.h / 2 - 25, 100, 50, VP.w, VP.h);
        expect(right.angleDeg).toBeCloseTo(0, 4);
        const below = edgeClamp(VP.w / 2 - 50, VP.h / 2 + 300, 100, 50, VP.w, VP.h);
        expect(below.angleDeg).toBeCloseTo(90, 4);
        const above = edgeClamp(VP.w / 2 - 50, VP.h / 2 - 400, 100, 50, VP.w, VP.h);
        expect(above.angleDeg).toBeCloseTo(-90, 4);
    });

    // A point behind the camera projects to the OPPOSITE side of the screen from where the object is, so
    // an unmirrored marker points exactly wrong — the standard trap in offscreen indicators.
    it('mirrors a behind-camera anchor through the centre, and is always offscreen', () => {
        const front = edgeClamp(VP.w / 2 + 300, VP.h / 2 - 25, 100, 50, VP.w, VP.h, 0, false);
        const behind = edgeClamp(VP.w / 2 + 300, VP.h / 2 - 25, 100, 50, VP.w, VP.h, 0, true);
        expect(Math.abs(behind.angleDeg)).toBeCloseTo(180, 4);
        expect(behind.x).toBeLessThan(front.x);
        expect(behind.offscreen).toBe(true);
    });

    it('reports a fully on-screen anchor as offscreen when it is behind', () => {
        expect(edgeClamp(300, 200, 100, 50, VP.w, VP.h, 0, true).offscreen).toBe(true);
    });
});

describe('quadHomography', () => {
    /** Apply a CSS column-major matrix3d to a 2D point, as the browser would. */
    const apply = (m: number[], x: number, y: number): [number, number] => {
        const X = m[0] * x + m[4] * y + m[12];
        const Y = m[1] * x + m[5] * y + m[13];
        const W = m[3] * x + m[7] * y + m[15];
        return [X / W, Y / W];
    };

    it('maps the rect corners exactly onto the projected corners', () => {
        const corners: [number, number][] = [[100, 50], [400, 80], [380, 300], [120, 260]];
        const m = quadHomography(corners, 200, 100)!;
        expect(m).not.toBeNull();
        const src: [number, number][] = [[0, 0], [200, 0], [200, 100], [0, 100]];
        src.forEach(([x, y], i) => {
            const [px, py] = apply(m, x, y);
            expect(px).toBeCloseTo(corners[i][0], 6);
            expect(py).toBeCloseTo(corners[i][1], 6);
        });
    });

    it('reduces to a plain translate+scale for an axis-aligned quad', () => {
        const m = quadHomography([[10, 20], [110, 20], [110, 70], [10, 70]], 200, 100)!;
        expect(apply(m, 100, 50)[0]).toBeCloseTo(60, 6);  // centre maps to centre
        expect(apply(m, 100, 50)[1]).toBeCloseTo(45, 6);
    });

    it('returns null for a degenerate or unprojectable quad', () => {
        expect(quadHomography([[0, 0], [0, 0], [0, 0], [0, 0]], 200, 100)).toBeNull();
        expect(quadHomography([[0, 0], [1, 0], null, [0, 1]], 200, 100)).toBeNull();
        expect(quadHomography([[0, 0], [1, 0], [1, 1], [0, 1]], 0, 100)).toBeNull();
        expect(quadHomography([[0, 0], [1, 0], [1, 1]], 200, 100)).toBeNull();
    });
});
