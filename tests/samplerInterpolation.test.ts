import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, AnimationSampler, Skin } from '../src/animation/animatedModel';
import { bakeCubicSpline } from '../src/animation/samplerBake';

// Playback used to read every sampler as LINEAR with one value per key: STEP clips blended between keys
// and CUBICSPLINE clips (three values per key) read tangents as values. STEP is now held where sampled and
// CUBICSPLINE is baked to LINEAR keys on the glTF Hermite curve.

function oneJointSkin(): Skin {
    return {
        joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
        nodeParents: new Map(),
        nodeTransforms: new Map([[0, mat4.create()]]),
    };
}

function translationClip(sampler: AnimationSampler): Animation {
    return { name: 'c', samplers: [sampler], channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }] };
}

function rootX(clip: Animation, t: number): number {
    const a = new Animator({ skin: oneJointSkin(), animations: [clip] } as unknown as AnimatedModel);
    a.playAnimationByName('c', false, false);
    a.seek(t);
    return mat4.getTranslation(vec3.create(), a.getFinalBoneMatrices()[0])[0];
}

describe('sampler interpolation', () => {
    it('STEP holds each key until the next', () => {
        const clip = translationClip({ input: [0, 1, 2], output: [0, 0, 0, 4, 0, 0, 8, 0, 0], interpolation: 'STEP' });
        expect(rootX(clip, 0.5)).toBeCloseTo(0, 5);
        expect(rootX(clip, 0.99)).toBeCloseTo(0, 5);
        expect(rootX(clip, 1.5)).toBeCloseTo(4, 5);
        expect(rootX(clip, 2)).toBeCloseTo(8, 5);
    });

    it('LINEAR still blends', () => {
        const clip = translationClip({ input: [0, 1], output: [0, 0, 0, 4, 0, 0], interpolation: 'LINEAR' });
        expect(rootX(clip, 0.5)).toBeCloseTo(2, 5);
    });

    it('CUBICSPLINE bakes to LINEAR keys on the Hermite curve', () => {
        // Two keys, zero tangents: an ease-in-out from 0 to 4 over one second (smoothstep).
        const out = [
            0, 0, 0, /* v0 */ 0, 0, 0, /* b0 */ 0, 0, 0,
            /* a1 */ 0, 0, 0, /* v1 */ 4, 0, 0, 0, 0, 0,
        ];
        const baked = bakeCubicSpline({ input: [0, 1], output: out, interpolation: 'CUBICSPLINE' });
        expect(baked.interpolation).toBe('LINEAR');
        expect(baked.output.length).toBe(baked.input.length * 3);
        expect(baked.input[0]).toBe(0);
        expect(baked.input[baked.input.length - 1]).toBe(1);
        const mid = baked.input.indexOf(0.4);
        expect(baked.output[mid * 3]).toBeCloseTo(4 * (3 * 0.16 - 2 * 0.064), 5);

        // And playback reads the values, not the tangents.
        expect(rootX(translationClip({ input: [0, 1], output: out, interpolation: 'CUBICSPLINE' }), 1)).toBeCloseTo(4, 5);
    });
});
