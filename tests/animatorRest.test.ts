import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// A bone animated by a ROTATION-ONLY channel must hold its bind translation, not collapse to its parent's
// origin. This is the normal shape of skeletal animation (non-root bones rotate, they don't translate), and
// it is exactly what a cross-rig retarget produces after dropping per-bone translation channels. Before the
// fix every such bone snapped to the origin and the whole skeleton piled up at the center.
//
// A real AnimatedModel builds a GPU Mesh in its constructor, so this uses a duck-typed stand-in — the
// Animator only reads `skin` and `animations`.

/** Local transform matrix for a node, from TRS. */
function trs(t: [number, number, number], r: quat = quat.create(), s: [number, number, number] = [1, 1, 1]): mat4 {
    return mat4.fromRotationTranslationScale(mat4.create(), r, t, s);
}

/**
 * A two-joint skin: root at the origin, child resting at a non-zero offset. Inverse bind matrices are the
 * IDENTITY so `getFinalBoneMatrices()` (= globalTransform × IBM) returns the joint's accumulated WORLD pose
 * directly, letting the test read where a bone actually lands.
 */
function twoBoneSkin(childOffset: [number, number, number]): Skin {
    return {
        joints: [
            { nodeIndex: 0, inverseBindMatrix: mat4.create() },
            { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
        ],
        nodeParents: new Map([[1, 0]]),
        nodeTransforms: new Map([[0, mat4.create()], [1, trs(childOffset)]]), // child rest = its offset
    };
}

function makeAnimator(skin: Skin, animations: Animation[]): Animator {
    return new Animator({ skin, animations } as unknown as AnimatedModel);
}

/** Accumulated world translation of a joint in the current pose (final = global, IBMs are identity). */
function jointPos(a: Animator, joint: number): vec3 {
    const t = vec3.create();
    mat4.getTranslation(t, a.getFinalBoneMatrices()[joint]);
    return t;
}

/** A clip with a single ROTATION channel on `node`, no translation. */
function rotationOnly(name: string, node: number, r: quat): Animation {
    return {
        name,
        samplers: [{ input: [0], output: Array.from(r), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: node, targetPath: 'rotation' }],
    };
}

describe('Animator — rest fallback for missing channels', () => {
    it('holds the bind offset for a bone with a rotation-only channel', () => {
        const skin = twoBoneSkin([2, 0, 0]);
        // Rotate the ROOT 90° about Y; the child has only a rotation channel (identity), no translation.
        const clip: Animation = {
            name: 'r',
            samplers: [
                { input: [0], output: Array.from(quat.setAxisAngle(quat.create(), [0, 1, 0], Math.PI / 2)), interpolation: 'LINEAR' },
                { input: [0], output: Array.from(quat.create()), interpolation: 'LINEAR' },
            ],
            channels: [
                { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' },
                { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' },
            ],
        };
        const a = makeAnimator(skin, [clip]);
        a.playAnimationByName('r', false, false);
        a.seek(0);

        // Child rests at [2,0,0]; with the root rotated 90° about Y, its world position swings to ~[0,0,-2].
        // The magnitude must stay 2 — the child keeps its bind offset rather than collapsing to the origin.
        const p = jointPos(a, 1);
        expect(vec3.length(p)).toBeCloseTo(2, 4);
        expect(p[0]).toBeCloseTo(0, 4);
        expect(p[2]).toBeCloseTo(-2, 4);
    });

    it('collapses nothing: the child is NOT at the origin', () => {
        const skin = twoBoneSkin([2, 0, 0]);
        const a = makeAnimator(skin, [rotationOnly('r', 1, quat.create())]);
        a.playAnimationByName('r', false, false);
        a.seek(0);
        expect(vec3.length(jointPos(a, 1))).toBeGreaterThan(1.9); // would be ~0 before the fix
    });

    it('still honours an explicit translation channel', () => {
        const skin = twoBoneSkin([2, 0, 0]);
        // Child has a translation channel moving it to [5,0,0] — must win over the [2,0,0] rest.
        const clip: Animation = {
            name: 't',
            samplers: [{ input: [0], output: [5, 0, 0], interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'translation' }],
        };
        const a = makeAnimator(skin, [clip]);
        a.playAnimationByName('t', false, false);
        a.seek(0);
        expect(jointPos(a, 1)[0]).toBeCloseTo(5, 4);
    });
});
