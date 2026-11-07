import { describe, expect, it } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { billboardMatrix } from '../src/graphics/render/billboard';

/** A camera at `eye` looking at `target`, world Y up. */
function view(eye: vec3, target: vec3): mat4 {
    return mat4.lookAt(mat4.create(), eye, target, [0, 1, 0]);
}
const col = (m: mat4, i: number) => vec3.fromValues(m[i * 4], m[i * 4 + 1], m[i * 4 + 2]);
const at = (x: number, y: number, z: number) => mat4.fromTranslation(mat4.create(), [x, y, z]);
const ONE = vec3.fromValues(1, 1, 1);

function expectOrthonormal(m: mat4) {
    const r = col(m, 0), u = col(m, 1), b = col(m, 2);
    for (const v of [r, u, b]) expect(vec3.length(v)).toBeCloseTo(1, 5);
    expect(vec3.dot(r, u)).toBeCloseTo(0, 5);
    expect(vec3.dot(r, b)).toBeCloseTo(0, 5);
    expect(vec3.dot(u, b)).toBeCloseTo(0, 5);
    // A right-handed frame: right x up = back.
    const c = vec3.cross(vec3.create(), r, u);
    expect(vec3.distance(c, b)).toBeCloseTo(0, 5);
}

describe('billboardMatrix', () => {
    it('turns a cylindrical sprite about its upright axis to face the camera POSITION', () => {
        // The camera looks straight ahead (-Z); the sprite stands far off to the right of the view.
        const eye = vec3.fromValues(0, 1.7, 0);
        const v = view(eye, [0, 1.7, -10]);
        const m = billboardMatrix(mat4.create(), at(8, 0, -6), ONE, 'cylindrical', v, eye);
        expectOrthonormal(m);
        // Upright stays upright.
        expect(col(m, 1)[1]).toBeCloseTo(1, 6);
        // Its front (+Z, "back" toward the viewer) points at the eye on the ground plane, not along the view.
        const toEye = vec3.normalize(vec3.create(), [eye[0] - 8, 0, eye[2] + 6]);
        expect(vec3.dot(col(m, 2), toEye)).toBeCloseTo(1, 5);
        // ...which is NOT the screen-parallel answer the old code gave (the view's back is +Z).
        expect(col(m, 2)[2]).toBeLessThan(0.9);
    });

    it('keeps the axis upright with the camera above, unlike the old skewed frame', () => {
        const eye = vec3.fromValues(0, 6, 4);
        const v = view(eye, [0, 0, 0]);
        const m = billboardMatrix(mat4.create(), at(0, 0, 0), ONE, 'cylindrical', v, eye);
        expectOrthonormal(m);
        expect(col(m, 1)).toEqual(new Float32Array([0, 1, 0]));
        expect(col(m, 2)[1]).toBeCloseTo(0, 6);
        expect(col(m, 2)[2]).toBeCloseTo(1, 5);
    });

    it('falls back to the view right when the eye is straight above', () => {
        const eye = vec3.fromValues(0, 10, 0);
        const v = mat4.lookAt(mat4.create(), eye, [0, 0, 0], [0, 0, -1]);
        const m = billboardMatrix(mat4.create(), at(0, 0, 0), ONE, 'cylindrical', v, eye);
        expectOrthonormal(m);
        expect(Number.isFinite(m[0])).toBe(true);
        expect(col(m, 1)[1]).toBeCloseTo(1, 6);
    });

    it('turns about a tilted node up axis, not world Y', () => {
        const eye = vec3.fromValues(0, 0, 10);
        const v = view(eye, [0, 0, 0]);
        const world = mat4.fromZRotation(mat4.create(), Math.PI / 6);
        const m = billboardMatrix(mat4.create(), world, ONE, 'cylindrical', v, eye);
        expectOrthonormal(m);
        expect(vec3.distance(col(m, 1), col(world, 1))).toBeCloseTo(0, 5);
    });

    it('faces the view direction, not a position, for an orthographic camera', () => {
        const eye = vec3.fromValues(0, 0, 10);
        const v = view(eye, [0, 0, 0]);
        const m = billboardMatrix(mat4.create(), at(30, 0, 0), ONE, 'cylindrical', v, eye, false);
        expect(col(m, 2)[2]).toBeCloseTo(1, 5);
    });

    it('applies the world scale to the faced frame', () => {
        const eye = vec3.fromValues(0, 0, 10);
        const v = view(eye, [0, 0, 0]);
        const m = billboardMatrix(mat4.create(), at(1, 2, 3), vec3.fromValues(2, 3, 1), 'cylindrical', v, eye);
        expect(vec3.length(col(m, 0))).toBeCloseTo(2, 5);
        expect(vec3.length(col(m, 1))).toBeCloseTo(3, 5);
        expect([m[12], m[13], m[14]]).toEqual([1, 2, 3]);
    });

    it('keeps spherical sprites screen-aligned and free sprites as placed', () => {
        const eye = vec3.fromValues(3, 4, 10);
        const v = view(eye, [0, 0, 0]);
        const s = billboardMatrix(mat4.create(), at(8, 0, 0), ONE, 'spherical', v, eye);
        expect([s[0], s[1], s[2]]).toEqual([v[0], v[4], v[8]]);
        expect([s[8], s[9], s[10]]).toEqual([v[2], v[6], v[10]]);
        const world = mat4.fromYRotation(mat4.create(), 0.7);
        const f = billboardMatrix(mat4.create(), world, ONE, 'free', v, eye);
        expect(Array.from(f)).toEqual(Array.from(world));
    });
});
