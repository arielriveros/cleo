import { describe, it, expect } from 'vitest';
import { mat4, vec4 } from 'gl-matrix';

/**
 * The arithmetic behind `MaterialConfig.depthNudge`, which separates a coplanar editor overlay from
 * the surface it describes.
 *
 * The renderer folds the nudge into the projection instead of biasing a pipeline or offsetting
 * vertices, and the claim that makes that legal is one identity:
 *
 *     clip.z = (m[10] + nudge) * z_view + m[14]   ==   clip.z - nudge * clip.w
 *
 * because `clip.w` is `-z_view` under perspective. The tests below pin that identity, and — much more
 * importantly — pin the PROPERTY it buys, which is the whole reason the previous fix failed: the
 * separation must be constant in NDC, so it survives at any distance. A world-space lift does not,
 * and the last test measures exactly where it gives out.
 *
 * Kept as pure matrix maths rather than a render test because that is what the bug was. Nothing about
 * a GPU was ever wrong here.
 */

/**
 * Decimal places every comparison below uses.
 *
 * gl-matrix stores a `mat4` as a `Float32Array`, so the identity holds to about 1.7e-8 and no
 * further. That is six orders of magnitude tighter than the nudge being measured and six orders
 * looser than double precision, so it is worth stating rather than discovering.
 */
const F32_PLACES = 6;

/** One step of a 24-bit non-reversed depth buffer, in NDC. The range is [-1, 1], hence the 2. */
const DEPTH_ULP = 2 / 2 ** 24;

/** Project a view-space point and return its NDC depth. */
function ndcDepth(projection: mat4, zView: number): number {
    const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(0, 0, zView, 1), projection);
    return clip[2] / clip[3];
}

/** What `Renderer._nudgedProjection` does, in isolation. */
function nudged(projection: mat4, nudge: number): mat4 {
    const out = mat4.clone(projection);
    if (out[11] === 0) out[14] -= nudge; // orthographic
    else out[10] += nudge;               // perspective
    return out;
}

const NEAR = 0.1;
const FAR = 10_000; // what editor scenes actually use — see createEmptyScene
const perspective = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, NEAR, FAR);
const ortho = mat4.ortho(mat4.create(), -10, 10, -10, 10, NEAR, FAR);

// View space looks down -Z, so anything in front of the camera has a negative z.
const DISTANCES = [-1, -5, -50, -180, -1000, -5000];

describe('the perspective nudge', () => {
    it('is the same as subtracting nudge * clip.w from clip.z', () => {
        const nudge = 1e-4;
        const biased = nudged(perspective, nudge);
        for (const z of DISTANCES) {
            const clip = vec4.transformMat4(vec4.create(), vec4.fromValues(0, 0, z, 1), perspective);
            const byIdentity = (clip[2] - nudge * clip[3]) / clip[3];
            expect(ndcDepth(biased, z)).toBeCloseTo(byIdentity, F32_PLACES);
        }
    });

    it('moves the surface TOWARD the camera, never away', () => {
        // Sign errors here are invisible in a still frame and catastrophic in motion: the overlay
        // would sink INTO the floor and be occluded by it everywhere instead of nowhere.
        const biased = nudged(perspective, 1e-4);
        for (const z of DISTANCES) expect(ndcDepth(biased, z)).toBeLessThan(ndcDepth(perspective, z));
    });

    it('separates by the SAME NDC amount at 1 metre and at 5 kilometres', () => {
        // The property the whole fix exists for.
        const nudge = 1e-4;
        const biased = nudged(perspective, nudge);
        const deltas = DISTANCES.map(z => ndcDepth(perspective, z) - ndcDepth(biased, z));
        for (const d of deltas) expect(d).toBeCloseTo(nudge, F32_PLACES);
    });

    it('is a no-op at zero, so every other helper is untouched', () => {
        const same = nudged(perspective, 0);
        for (const z of DISTANCES) expect(ndcDepth(same, z)).toBe(ndcDepth(perspective, z));
    });
});

describe('the orthographic nudge', () => {
    it('uses the translation term, since clip.w is 1 and depth is already linear', () => {
        // Nudging [10] under ortho would scale with distance instead of offsetting — correct at one
        // depth and wrong everywhere else. The 2D editor mode makes this a real path, not a nicety.
        const nudge = 1e-4;
        const biased = nudged(ortho, nudge);
        expect(biased[10]).toBe(ortho[10]);
        for (const z of DISTANCES) {
            expect(ndcDepth(ortho, z) - ndcDepth(biased, z)).toBeCloseTo(nudge, F32_PLACES);
        }
    });

    it('also moves toward the camera', () => {
        const biased = nudged(ortho, 1e-4);
        for (const z of DISTANCES) expect(ndcDepth(biased, z)).toBeLessThan(ndcDepth(ortho, z));
    });
});

describe('why the old world-space lift could not work', () => {
    /** NDC separation a world-space lift of `lift` buys at `zView`. */
    const liftSeparation = (zView: number, lift: number) =>
        Math.abs(ndcDepth(perspective, zView) - ndcDepth(perspective, zView + lift));

    const LIFT = 0.02; // what these overlays used to carry

    it('a 2 cm lift is comfortably resolvable close up', () => {
        expect(liftSeparation(-5, LIFT)).toBeGreaterThan(DEPTH_ULP);
    });

    it('...and is under one depth step by 500 metres, which is the reported stippling', () => {
        expect(liftSeparation(-500, LIFT)).toBeLessThan(DEPTH_ULP);
    });

    it('gives out at about 180 metres, which is well inside an editor camera pull-back', () => {
        expect(liftSeparation(-150, LIFT)).toBeGreaterThan(DEPTH_ULP);
        expect(liftSeparation(-220, LIFT)).toBeLessThan(DEPTH_ULP);
    });

    it('the nudge is still resolvable at the distance where the lift is not', () => {
        const far = -500;
        const delta = ndcDepth(perspective, far) - ndcDepth(nudged(perspective, 1e-4), far);
        expect(delta).toBeGreaterThan(DEPTH_ULP);
    });
});
