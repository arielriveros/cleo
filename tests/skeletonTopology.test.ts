import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { skeletonTopology } from '../src/graphics/skeletonTopology';
import { humanoidRigOf } from '../src/graphics/animationRetarget';
import type { Skin } from '../src/graphics/animatedModel';

// A Skin says who a joint's parent is in GLTF NODE indices, while everything that consumes a skeleton works
// in JOINT indices — the ones that index getFinalBoneMatrices(). Five places used to bridge that themselves.
// These tests pin the shared bridge, including the malformed inputs a real asset pipeline produces, because
// posing a character wrongly is recoverable and refusing to pose it at all is not.

/** node indices deliberately NOT equal to joint indices, so the two spaces cannot be confused silently. */
function skin(spec: { node: number; parent?: number; name?: string }[]): Skin {
    return {
        joints: spec.map(s => ({ nodeIndex: s.node, inverseBindMatrix: mat4.create(), parentIndex: s.parent })),
        nodeTransforms: new Map(spec.map(s => [s.node, mat4.create()])),
        nodeNames: new Map(spec.filter(s => s.name).map(s => [s.node, s.name!])),
    };
}

describe('skeletonTopology', () => {
    // hips(10) -> spine(20) -> head(30), and hips -> leg(40)
    const chain = skin([
        { node: 10 },
        { node: 20, parent: 10 },
        { node: 30, parent: 20 },
        { node: 40, parent: 10 },
    ]);

    it('maps node space to joint space', () => {
        const t = skeletonTopology(chain);
        expect(t.jointOfNode.get(10)).toBe(0);
        expect(t.jointOfNode.get(30)).toBe(2);
        expect(t.jointOfNode.get(999)).toBeUndefined();
    });

    it('resolves parents and children in JOINT indices', () => {
        const t = skeletonTopology(chain);
        expect(t.parentJoint).toEqual([-1, 0, 1, 0]);
        expect(t.children[0].sort()).toEqual([1, 3]);
        expect(t.children[2]).toEqual([]);
        expect(t.roots).toEqual([0]);
    });

    it('keeps the parent NODE index even when the parent is outside the skin', () => {
        // A skin's root is routinely parented to an armature or an empty that is not itself a joint. Its
        // transform still applies, so dropping the link would pose the whole character in the wrong place.
        const parented = skin([{ node: 10, parent: 7 }, { node: 20, parent: 10 }]);
        const t = skeletonTopology(parented);
        expect(t.parentNode[0]).toBe(7);
        expect(t.parentJoint[0]).toBe(-1);   // 7 is not a joint
        expect(t.roots).toEqual([0]);        // ...so joint 0 is still a root of the SKIN
    });

    it('orders parents strictly before their children', () => {
        // Declared children-first, to prove the order comes from the hierarchy and not from the array.
        const shuffled = skin([
            { node: 30, parent: 20 },
            { node: 40, parent: 10 },
            { node: 20, parent: 10 },
            { node: 10 },
        ]);
        const t = skeletonTopology(shuffled);
        const at = (j: number) => t.order.indexOf(j);
        expect(t.order).toHaveLength(4);
        for (let j = 0; j < 4; j++) {
            const p = t.parentJoint[j];
            if (p >= 0) expect(at(p)).toBeLessThan(at(j));
        }
    });

    it('exposes the node-keyed parent map the ancestor walks use', () => {
        const t = skeletonTopology(chain);
        expect(t.parentNodeOfNode.get(30)).toBe(20);
        expect(t.parentNodeOfNode.get(10)).toBeUndefined();
    });

    // Everything below is malformed input. None of it should throw, and every joint must still appear in
    // `order` exactly once — a caller iterating it is posing a skeleton, not validating an asset.
    it('survives a self-parented joint', () => {
        const t = skeletonTopology(skin([{ node: 10, parent: 10 }, { node: 20, parent: 10 }]));
        expect(t.roots).toContain(0);
        expect(t.parentJoint[0]).toBe(-1);
        expect(t.order.slice().sort()).toEqual([0, 1]);
    });

    it('survives a cycle without hanging or losing a joint', () => {
        // 10 -> 20 -> 10. There is no root, so the breadth-first pass reaches nothing.
        const t = skeletonTopology(skin([{ node: 10, parent: 20 }, { node: 20, parent: 10 }]));
        expect(t.roots).toEqual([]);
        expect(t.order.slice().sort()).toEqual([0, 1]);
    });

    it('handles an empty skin', () => {
        const t = skeletonTopology({ joints: [] });
        expect(t.order).toEqual([]);
        expect(t.roots).toEqual([]);
    });
});

describe('humanoidRigOf', () => {
    it('finds body parts by meaning, whatever the rig calls them', () => {
        const rig = humanoidRigOf(skin([
            { node: 10, name: 'mixamorig:Hips' },
            { node: 20, name: 'mixamorig:LeftUpLeg' },
            { node: 30, name: 'mixamorig:LeftLeg' },
            { node: 40, name: 'mixamorig:LeftFoot' },
            { node: 50, name: 'DEF-thigh.R' },
            { node: 60, name: 'shin.R' },
            { node: 70, name: 'ankle.R' },
        ]));
        // The left leg chain, from a Mixamo rig...
        expect(rig.get('hips')).toBe(10);
        expect(rig.get('upLeg.L')).toBe(20);
        expect(rig.get('leg.L')).toBe(30);
        expect(rig.get('foot.L')).toBe(40);
        // ...and the right, from a Rigify-flavoured one using entirely different words.
        expect(rig.get('upLeg.R')).toBe(50);
        expect(rig.get('leg.R')).toBe(60);
        expect(rig.get('foot.R')).toBe(70);
    });

    it('returns nothing for a skin with no bone names, rather than guessing', () => {
        expect(humanoidRigOf(skin([{ node: 10 }, { node: 20, parent: 10 }])).size).toBe(0);
    });
});
