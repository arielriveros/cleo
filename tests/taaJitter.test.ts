import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mat4, vec4 } from 'gl-matrix';
import { TAA_PHASES, TAA_JITTER, jitterMatrix } from '../src/graphics/utils/taaJitter';

/**
 * The TAA jitter matrix.
 *
 * This suite exists because the alternative is guessing. The uv/clip relationship is MIRRORED between
 * the two backends, so a sign error in the jitter is invisible on whichever one you happen to be
 * testing and wrong on the other — and the GPU harness that used to catch that class of bug was
 * deleted. Everything below is checkable in a plain vitest run.
 */

const WIDTH = 1920;
const HEIGHT = 1080;

/** Project a point and divide through — NDC, the space the offset is defined in. */
function ndc(m: mat4, p: vec4): [number, number, number, number] {
    const c = vec4.transformMat4(vec4.create(), p, m);
    return [c[0] / c[3], c[1] / c[3], c[2] / c[3], c[3]];
}

const PROJ = mat4.perspective(mat4.create(), Math.PI / 3, WIDTH / HEIGHT, 0.1, 1000);
// Off-centre and well away from the near plane, so a term that only vanishes at the origin cannot hide.
const POINT: vec4 = [1.3, -0.7, -14, 1];

describe('the jitter matrix', () => {
    // gl-matrix stores float32, and the checks below read the shift as a DIFFERENCE of two NDC
    // coordinates of order 0.1 — a cancellation that leaves about 1e-8 of absolute noise however exact
    // the matrix is. 1e-7 is that noise floor and nothing looser: a sign error moves the value by
    // twice its own magnitude, four orders of magnitude outside it.
    const FLOAT32_NDC_NOISE = 7;

    it('shifts NDC by exactly two pixels-worth per pixel of offset, on both axes', () => {
        // Magnitude AND sign, pinned in the one place a sign can be reasoned about rather than
        // observed. NDC x spans [-1, 1] over `width` pixels, so one pixel is 2/width.
        for (let phase = 0; phase < TAA_PHASES; phase++) {
            const j = jitterMatrix(mat4.create(), phase, WIDTH, HEIGHT);
            const jittered = mat4.multiply(mat4.create(), j, PROJ);

            const base = ndc(PROJ, POINT);
            const moved = ndc(jittered, POINT);

            expect(moved[0] - base[0]).toBeCloseTo((2 * TAA_JITTER[phase * 2]) / WIDTH, FLOAT32_NDC_NOISE);
            expect(moved[1] - base[1]).toBeCloseTo((2 * TAA_JITTER[phase * 2 + 1]) / HEIGHT, FLOAT32_NDC_NOISE);
        }
    });

    it('gets the sign right at a scale where float noise cannot hide it', () => {
        // The same assertion on an absurd 8x8 target, where one pixel is a quarter of NDC. The shift is
        // then five orders of magnitude above the cancellation noise, so this pins the sign of both
        // axes on its own — which matters because the uv/clip relationship is MIRRORED between the two
        // backends, and a sign error is invisible on whichever one you happen to be testing.
        for (let phase = 0; phase < TAA_PHASES; phase++) {
            const j = jitterMatrix(mat4.create(), phase, 8, 8);
            const jittered = mat4.multiply(mat4.create(), j, PROJ);
            const dx = ndc(jittered, POINT)[0] - ndc(PROJ, POINT)[0];
            const dy = ndc(jittered, POINT)[1] - ndc(PROJ, POINT)[1];
            expect(dx).toBeCloseTo((2 * TAA_JITTER[phase * 2]) / 8, 6);
            expect(dy).toBeCloseTo((2 * TAA_JITTER[phase * 2 + 1]) / 8, 6);
            expect(Math.sign(dx)).toBe(Math.sign(TAA_JITTER[phase * 2]));
            expect(Math.sign(dy)).toBe(Math.sign(TAA_JITTER[phase * 2 + 1]));
        }
    });

    it('is the same shift at every depth, which is what makes it a sample offset', () => {
        // A jitter that varied with w would be a skew: the near plane would sample somewhere the far
        // plane did not, and the accumulation would never converge on either.
        const j = jitterMatrix(mat4.create(), 3, WIDTH, HEIGHT);
        const jittered = mat4.multiply(mat4.create(), j, PROJ);
        const near = ndc(jittered, [0.2, 0.1, -0.5, 1])[0] - ndc(PROJ, [0.2, 0.1, -0.5, 1])[0];
        const far = ndc(jittered, [80, 40, -400, 1])[0] - ndc(PROJ, [80, 40, -400, 1])[0];
        expect(near).toBeCloseTo(far, FLOAT32_NDC_NOISE);
    });

    it('leaves z and w bit-identical', () => {
        // Depth is compared against the shadow cascades, the SSAO kernel and the disocclusion test.
        // A jitter that touched it would move all three by a different amount than it moved the image.
        const j = jitterMatrix(mat4.create(), 5, WIDTH, HEIGHT);
        const jittered = mat4.multiply(mat4.create(), j, PROJ);
        const base = vec4.transformMat4(vec4.create(), POINT, PROJ);
        const moved = vec4.transformMat4(vec4.create(), POINT, jittered);
        expect(moved[2]).toBe(base[2]);
        expect(moved[3]).toBe(base[3]);
    });

    it('commutes with the WebGPU Z remap', () => {
        // `_rasterProjection` composes as `_clipProjection(J * P)`, i.e. `Z * J * P`. That is only the
        // same thing as jittering the finished clip matrix because Z touches row 2 alone and J touches
        // rows 0 and 1 alone. If anyone edits `_CLIP_Z_ZERO_TO_ONE` into something that also touches
        // x or y, the composition order silently starts mattering — and this fails.
        const Z = mat4.fromValues(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0.5, 0, 0, 0, 0.5, 1);
        const j = jitterMatrix(mat4.create(), 2, WIDTH, HEIGHT);
        const zj = mat4.multiply(mat4.create(), Z, j);
        const jz = mat4.multiply(mat4.create(), j, Z);
        for (let i = 0; i < 16; i++) expect(zj[i]).toBeCloseTo(jz[i], 15);
    });

    it('is checked against the matrix the renderer actually uses', () => {
        // The literal above is a copy, and a copy that drifts proves nothing. Read the real one.
        const source = readFileSync(join(__dirname, '..', 'src', 'graphics', 'renderer.ts'), 'utf-8');
        expect(source).toContain('mat4.fromValues(1, 0, 0, 0,  0, 1, 0, 0,  0, 0, 0.5, 0,  0, 0, 0.5, 1)');
    });

    it('does not write into the projection it is composed with', () => {
        // `_clipProjection` returns its input BY REFERENCE on WebGL2, and that input is Camera's
        // cached `_projection`. A builder that wrote through it would poison `_projDirty` for every
        // other reader in the frame — a bug that would look like the camera drifting under TAA.
        const before = mat4.clone(PROJ);
        const j = jitterMatrix(mat4.create(), 1, WIDTH, HEIGHT);
        mat4.multiply(mat4.create(), j, PROJ);
        expect(Array.from(PROJ)).toEqual(Array.from(before));
    });

    it('wraps the phase rather than reading past the sequence', () => {
        const a = jitterMatrix(mat4.create(), 0, WIDTH, HEIGHT);
        const b = jitterMatrix(mat4.create(), TAA_PHASES, WIDTH, HEIGHT);
        expect(Array.from(b)).toEqual(Array.from(a));
        expect(Number.isNaN(jitterMatrix(mat4.create(), -1, WIDTH, HEIGHT)[12])).toBe(false);
    });
});
