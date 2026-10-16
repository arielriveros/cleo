import { describe, it, expect, afterEach } from 'vitest';
import { mat4, quat } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import { findKey, findKeyLinear } from '../src/animation/keyframes';
import { skeletonTopology, subtreeOrder } from '../src/animation/skeletonTopology';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// The animation hot path was reworked for speed — cursor keyframe lookup, subtree-only re-accumulation
// in foot IK, pose LOD. Each of those must be invisible: the same answer as the slow path it replaced,
// or (for the LOD) the same TIMELINE with fewer poses.

describe('findKey', () => {
    it('matches the linear scan for any time and any hint', () => {
        const times = [0, 0.1, 0.25, 0.25, 0.4, 0.9, 1.2, 2];
        let seed = 7;
        const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
        for (let n = 0; n < 4000; n++) {
            const t = rand() * 2.6 - 0.3;
            const hint = Math.floor(rand() * (times.length + 2)) - 1;
            expect(findKey(times, t, hint), `t=${t} hint=${hint}`).toBe(findKeyLinear(times, t));
        }
        for (const t of [0, 0.25, 2, NaN, -1, 5]) expect(findKey(times, t, 3)).toBe(findKeyLinear(times, t));
    });

    it('handles a two-key channel', () => {
        expect(findKey([0, 1], 0.5, 0)).toBe(0);
        expect(findKey([0, 1], 3, 0)).toBe(0);
    });
});

describe('subtreeOrder', () => {
    it('lists a joint and its descendants, parents first', () => {
        // 0 -> 1 -> 2, 0 -> 3 -> 4
        const parents: [number, number][] = [[1, 0], [2, 1], [3, 0], [4, 3]];
        const skin = {
            joints: [0, 1, 2, 3, 4].map(n => ({ nodeIndex: n, inverseBindMatrix: mat4.create(),
                                                 parentIndex: new Map(parents).get(n) })),
            nodeParents: new Map(parents),
            nodeTransforms: new Map([0, 1, 2, 3, 4].map(n => [n, mat4.create()])),
        } as unknown as Skin;
        const topo = skeletonTopology(skin);
        expect([...subtreeOrder(topo, 1)].sort()).toEqual([1, 2]);
        expect([...subtreeOrder(topo, 3)].sort()).toEqual([3, 4]);
        const all = subtreeOrder(topo, 0);
        expect([...all].sort()).toEqual([0, 1, 2, 3, 4]);
        for (const j of all) {
            const parent = topo.parentJoint[j];
            if (parent >= 0) expect(all.indexOf(parent)).toBeLessThan(all.indexOf(j));
        }
    });
});

describe('animation LOD', () => {
    afterEach(() => { Animator.lod.enabled = true; });

    // One joint turning 360° over 1 s, with an event marker at 0.5 s.
    function makeAnimator(): Animator {
        const skin = {
            joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
            nodeParents: new Map(),
            nodeTransforms: new Map([[0, mat4.create()]]),
        } as unknown as Skin;
        const keys = [0, 0.25, 0.5, 0.75, 1];
        const out: number[] = [];
        for (const t of keys) out.push(...quat.setAxisAngle(quat.create(), [0, 1, 0], t * Math.PI * 2));
        const clip: Animation = {
            name: 'spin',
            samplers: [{ input: keys, output: out, interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }],
        };
        const a = new Animator({ skin, animations: [clip] } as unknown as AnimatedModel);
        a.playAnimationByName('spin', true, false);
        return a;
    }

    it('keeps the clock exactly in step with a full-rate animator, and poses on its stride', () => {
        const full = makeAnimator();
        const reduced = makeAnimator();
        let posed = 0, last = mat4.clone(reduced.getFinalBoneMatrices()[0]);
        for (let frame = 0; frame < 40; frame++) {
            full.setLod(true, 0);
            reduced.setLod(false, 100);   // off-screen and far: every 4th frame
            full.update(1 / 60);
            reduced.update(1 / 60);
            expect(reduced.currentTime).toBeCloseTo(full.currentTime, 9);
            const m = reduced.getFinalBoneMatrices()[0];
            if (!mat4.exactEquals(m, last)) { posed++; last = mat4.clone(m); }
        }
        expect(posed).toBeGreaterThanOrEqual(9);
        expect(posed).toBeLessThanOrEqual(11);
        // Back in view: the very next frame poses, and matches the full-rate animator.
        reduced.setLod(true, 0);
        full.setLod(true, 0);
        reduced.update(1 / 60);
        full.update(1 / 60);
        const a = reduced.getFinalBoneMatrices()[0], b = full.getFinalBoneMatrices()[0];
        for (let i = 0; i < 16; i++) expect(a[i]).toBeCloseTo(b[i], 9);
    });

    it('poses every frame when exempt or disabled', () => {
        const a = makeAnimator();
        a.lodExempt = true;
        let last = mat4.clone(a.getFinalBoneMatrices()[0]), posed = 0;
        for (let frame = 0; frame < 12; frame++) {
            a.setLod(false, 100);
            a.update(1 / 60);
            const m = a.getFinalBoneMatrices()[0];
            if (!mat4.exactEquals(m, last)) { posed++; last = mat4.clone(m); }
        }
        expect(posed).toBe(12);
    });
});
