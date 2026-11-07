import { mat4, vec3 } from 'gl-matrix';

/** How a sprite turns to the camera (SpriteNode.constraints). */
export type BillboardConstraint = 'free' | 'spherical' | 'cylindrical';

const _axis = vec3.create();
const _back = vec3.create();
const _right = vec3.create();

/**
 * A sprite's world matrix with its camera-facing constraint applied, written into `out`.
 *
 * - `free`: the node's own transform.
 * - `spherical`: SCREEN-ALIGNED, the quad lies in the view plane (the camera's right, up and back), the
 *   convention for particles and icons: a row of them stays one flat sheet however the view turns.
 * - `cylindrical`: the AXIAL billboard. The quad keeps the node's own world up (world Y for an upright
 *   sprite) and turns about it to face the camera's POSITION, so a flame or a tree card at the corner of a
 *   wide view faces the eye instead of lying parallel to the screen, where it reads squashed and leaning.
 *   An orthographic view has no position to face: there it turns to the view direction instead. When the
 *   eye is straight up or down the axis it keeps the view's right, so the quad never collapses.
 *
 * The rotation is orthonormal and then scaled by `worldScale`, as the node's own scale.
 *
 * @param view      the camera's view matrix (world to view); its rows are the camera's axes in world space
 * @param eye       the camera's world position
 * @param perspective false for an orthographic camera
 */
export function billboardMatrix(out: mat4, world: mat4, worldScale: vec3, constraint: BillboardConstraint,
                                view: mat4, eye: vec3, perspective: boolean = true): mat4 {
    mat4.copy(out, world);
    if (constraint === 'spherical') {
        out[0] = view[0]; out[1] = view[4]; out[2] = view[8];
        out[4] = view[1]; out[5] = view[5]; out[6] = view[9];
        out[8] = view[2]; out[9] = view[6]; out[10] = view[10];
        return mat4.scale(out, out, worldScale);
    }
    if (constraint !== 'cylindrical') return out;

    // The axis: the node's own up, without its scale.
    vec3.set(_axis, world[4], world[5], world[6]);
    if (vec3.length(_axis) < 1e-8) vec3.set(_axis, 0, 1, 0);
    vec3.normalize(_axis, _axis);

    // Toward the eye, then everything along the axis taken out of it.
    if (perspective) vec3.set(_back, eye[0] - world[12], eye[1] - world[13], eye[2] - world[14]);
    else vec3.set(_back, view[2], view[6], view[10]);
    vec3.scaleAndAdd(_back, _back, _axis, -vec3.dot(_back, _axis));
    if (vec3.length(_back) < 1e-6) {
        // Looking down the axis: keep the view's right, and take back from it.
        vec3.set(_right, view[0], view[4], view[8]);
        vec3.scaleAndAdd(_right, _right, _axis, -vec3.dot(_right, _axis));
        if (vec3.length(_right) < 1e-6) vec3.set(_right, Math.abs(_axis[0]) < 0.9 ? 1 : 0, Math.abs(_axis[0]) < 0.9 ? 0 : 1, 0);
        vec3.normalize(_right, _right);
        vec3.cross(_back, _right, _axis);
        vec3.normalize(_back, _back);
    } else {
        vec3.normalize(_back, _back);
        // right x up = back, the frame of a camera (and of the quad, whose front faces +Z).
        vec3.cross(_right, _axis, _back);
        vec3.normalize(_right, _right);
    }
    out[0] = _right[0]; out[1] = _right[1]; out[2] = _right[2];
    out[4] = _axis[0]; out[5] = _axis[1]; out[6] = _axis[2];
    out[8] = _back[0]; out[9] = _back[1]; out[10] = _back[2];
    return mat4.scale(out, out, worldScale);
}
