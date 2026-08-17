import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Camera } from '../src/core/camera';
import { Raycaster } from '../src/core/raycaster';

// Unprojection has to be the exact inverse of the projection the renderer uses. The decisive check here is
// therefore a ROUND TRIP: take the ray for a screen point, march it to a plane, project that world point
// back through projection * view, and require the NDC to come out where the screen point said it would.
// One assertion that covers the aspect scaling, the frustum centring and the view transform at once.

const W = 1600, H = 900;   // 16:9, the shape a real editor viewport actually has

/** A camera at +Z looking back down -Z at the z = 0 plane — the editor's 2D rig. */
function camera2D(patch: Partial<Record<'left' | 'right' | 'top' | 'bottom', number>> = {}): Camera {
    const cam = new Camera({ type: 'orthographic', near: 0.1, far: 100 });
    cam.left = patch.left ?? -4;
    cam.right = patch.right ?? 4;
    cam.bottom = patch.bottom ?? -4;
    cam.top = patch.top ?? 4;
    cam.position = vec3.fromValues(0, 0, 10);
    cam.eye = vec3.fromValues(0, 0, 9);
    return cam;
}

/** Where the ray for (screenX, screenY) crosses the z = planeZ plane. */
function hitPlane(cam: Camera, screenX: number, screenY: number, w = W, h = H, planeZ = 0): vec3 {
    const ray = Raycaster.screenToRay(screenX, screenY, w, h, cam);
    const t = (planeZ - ray.origin[2]) / ray.direction[2];
    return vec3.scaleAndAdd(vec3.create(), ray.origin, ray.direction, t);
}

/** Project a world point through the camera and return its NDC x/y. */
function toNdc(cam: Camera, point: vec3): [number, number] {
    const vp = mat4.multiply(mat4.create(), cam.projectionMatrix, cam.viewMatrix);
    const clip = vec3.transformMat4(vec3.create(), point, vp);
    return [clip[0], clip[1]];
}

/** The NDC a screen point implies, by the same formula screenToRay uses. */
const ndcOf = (screenX: number, screenY: number, w = W, h = H): [number, number] =>
    [(2 * screenX) / w - 1, 1 - (2 * screenY) / h];

const SAMPLES: [number, number][] = [
    [W / 2, H / 2],   // centre — correct even with the bug, so it proves nothing on its own
    [0, 0],           // corners, where the aspect error is largest
    [W, 0],
    [0, H],
    [W, H],
    [W * 0.9, H / 2], // near the right edge, on the vertical centre-line
    [W * 0.1, H / 2],
    [W / 2, H * 0.15],
];

describe('Raycaster.screenToRay — orthographic', () => {
    it('round-trips every screen point back to its own NDC', () => {
        const cam = camera2D();
        cam.resize(W, H);
        for (const [sx, sy] of SAMPLES) {
            const [nx, ny] = ndcOf(sx, sy);
            const [rx, ry] = toNdc(cam, hitPlane(cam, sx, sy));
            expect(rx, `x at ${sx},${sy}`).toBeCloseTo(nx, 5);
            expect(ry, `y at ${sx},${sy}`).toBeCloseTo(ny, 5);
        }
    });

    it('the right edge lands at right * aspect, not at right', () => {
        // The regression itself, as a number. Camera.projectionMatrix scales left/right by the aspect and
        // leaves top/bottom alone, so a 16:9 viewport shows x in [-7.11, 7.11] and y in [-4, 4].
        const cam = camera2D();
        cam.resize(W, H);
        expect(hitPlane(cam, W, H / 2)[0]).toBeCloseTo(4 * (W / H), 5);
        expect(hitPlane(cam, 0, H / 2)[0]).toBeCloseTo(-4 * (W / H), 5);
        // Vertical was never scaled, and must not start being.
        expect(hitPlane(cam, W / 2, 0)[1]).toBeCloseTo(4, 5);
        expect(hitPlane(cam, W / 2, H)[1]).toBeCloseTo(-4, 5);
    });

    it('a square viewport still round-trips (the case that already worked)', () => {
        const cam = camera2D();
        cam.resize(800, 800);
        for (const [sx, sy] of SAMPLES.map(([x, y]) => [x * 0.5, y * (800 / H)] as [number, number])) {
            const [nx, ny] = ndcOf(sx, sy, 800, 800);
            const [rx, ry] = toNdc(cam, hitPlane(cam, sx, sy, 800, 800));
            expect(rx).toBeCloseTo(nx, 5);
            expect(ry).toBeCloseTo(ny, 5);
        }
    });

    it('an asymmetric frustum picks off its own centre, not off zero', () => {
        const cam = camera2D({ left: -2, right: 6, bottom: -1, top: 7 });
        cam.resize(W, H);
        for (const [sx, sy] of SAMPLES) {
            const [nx, ny] = ndcOf(sx, sy);
            const [rx, ry] = toNdc(cam, hitPlane(cam, sx, sy));
            expect(rx, `x at ${sx},${sy}`).toBeCloseTo(nx, 5);
            expect(ry, `y at ${sx},${sy}`).toBeCloseTo(ny, 5);
        }
        // The screen centre maps to the frustum's centre, which is no longer the origin.
        const centre = hitPlane(cam, W / 2, H / 2);
        expect(centre[0]).toBeCloseTo(2 * (W / H), 5);
        expect(centre[1]).toBeCloseTo(3, 5);
    });

    it('a zoomed-in frustum stays aligned', () => {
        // Zooming shrinks the extents; picking has to follow, or painting drifts as you zoom.
        const cam = camera2D({ left: -0.5, right: 0.5, bottom: -0.5, top: 0.5 });
        cam.resize(W, H);
        for (const [sx, sy] of SAMPLES) {
            const [nx, ny] = ndcOf(sx, sy);
            const [rx, ry] = toNdc(cam, hitPlane(cam, sx, sy));
            expect(rx).toBeCloseTo(nx, 5);
            expect(ry).toBeCloseTo(ny, 5);
        }
    });

    it('rays are parallel — an orthographic pick must not fan out from the camera', () => {
        const cam = camera2D();
        cam.resize(W, H);
        const a = Raycaster.screenToRay(0, 0, W, H, cam);
        const b = Raycaster.screenToRay(W, H, W, H, cam);
        expect(a.direction[0]).toBeCloseTo(b.direction[0], 6);
        expect(a.direction[1]).toBeCloseTo(b.direction[1], 6);
        expect(a.direction[2]).toBeCloseTo(b.direction[2], 6);
        // Looking down -Z from +Z, as the editor's 2D rig does.
        expect(a.direction[2]).toBeCloseTo(-1, 6);
    });

    it('follows the camera when it pans', () => {
        const cam = camera2D();
        cam.resize(W, H);
        cam.position = vec3.fromValues(12, -7, 10);
        cam.eye = vec3.fromValues(12, -7, 9);
        const centre = hitPlane(cam, W / 2, H / 2);
        expect(centre[0]).toBeCloseTo(12, 5);
        expect(centre[1]).toBeCloseTo(-7, 5);
        const [nx, ny] = ndcOf(W * 0.8, H * 0.3);
        const [rx, ry] = toNdc(cam, hitPlane(cam, W * 0.8, H * 0.3));
        expect(rx).toBeCloseTo(nx, 5);
        expect(ry).toBeCloseTo(ny, 5);
    });
});

describe('Raycaster.screenToRay — perspective (regression guard)', () => {
    it('round-trips every screen point back to its own NDC', () => {
        const cam = new Camera({ type: 'perspective', fov: 60, near: 0.1, far: 100 });
        cam.resize(W, H);
        cam.position = vec3.fromValues(0, 0, 10);
        cam.eye = vec3.fromValues(0, 0, 9);
        for (const [sx, sy] of SAMPLES) {
            const [nx, ny] = ndcOf(sx, sy);
            const [rx, ry] = toNdc(cam, hitPlane(cam, sx, sy));
            expect(rx, `x at ${sx},${sy}`).toBeCloseTo(nx, 5);
            expect(ry, `y at ${sx},${sy}`).toBeCloseTo(ny, 5);
        }
    });

    it('rays fan out from the camera position', () => {
        const cam = new Camera({ type: 'perspective', fov: 60 });
        cam.resize(W, H);
        cam.position = vec3.fromValues(0, 0, 10);
        cam.eye = vec3.fromValues(0, 0, 9);
        const a = Raycaster.screenToRay(0, 0, W, H, cam);
        const b = Raycaster.screenToRay(W, H, W, H, cam);
        expect(a.origin[0]).toBeCloseTo(b.origin[0], 6);
        expect(a.origin[1]).toBeCloseTo(b.origin[1], 6);
        expect(a.direction[0]).not.toBeCloseTo(b.direction[0], 3);
    });
});

describe('Camera.ratio', () => {
    it('reports what resize was given, and drives the ortho projection', () => {
        const cam = camera2D();
        expect(cam.ratio).toBe(1);
        cam.resize(W, H);
        expect(cam.ratio).toBeCloseTo(W / H, 6);
        // The projection's horizontal half-extent is right * ratio; this is the relationship the
        // orthographic unprojection has to mirror.
        const inv = mat4.invert(mat4.create(), cam.projectionMatrix)!;
        const edge = vec3.transformMat4(vec3.create(), vec3.fromValues(1, 0, 0), inv);
        expect(edge[0]).toBeCloseTo(4 * cam.ratio, 5);
    });
});
