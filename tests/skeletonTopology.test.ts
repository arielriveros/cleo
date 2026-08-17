import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { skeletonTopology, isAncestorJoint, nearestCommonAncestor } from '../src/graphics/skeletonTopology';
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

/**
 * Ancestry, which is the only thing that can tell a leg from three bones that merely have leg-shaped names.
 * A control rig routinely contains a `thigh`, a `shin` and a `foot` that belong to different parts of the
 * skeleton entirely; solving those produces a valid-looking pose with no relation to the character.
 */
describe('isAncestorJoint', () => {
    // hips(10) -> spine(20) -> head(30); hips -> thigh(40) -> shin(50) -> foot(60)
    const rig = skin([
        { node: 10 }, { node: 20, parent: 10 }, { node: 30, parent: 20 },
        { node: 40, parent: 10 }, { node: 50, parent: 40 }, { node: 60, parent: 50 },
    ]);
    const t = skeletonTopology(rig);
    const J = (node: number) => t.jointOfNode.get(node)!;

    it('is true for a direct parent and for any depth above', () => {
        expect(isAncestorJoint(t, J(40), J(50))).toBe(true);   // thigh -> shin
        expect(isAncestorJoint(t, J(40), J(60))).toBe(true);   // thigh -> foot, two levels
        expect(isAncestorJoint(t, J(10), J(60))).toBe(true);   // hips -> foot, three levels
    });

    it('is false downward, sideways, and for a joint against itself', () => {
        expect(isAncestorJoint(t, J(50), J(40))).toBe(false);  // shin is not above thigh
        expect(isAncestorJoint(t, J(20), J(40))).toBe(false);  // spine and thigh are siblings
        expect(isAncestorJoint(t, J(30), J(60))).toBe(false);  // different branches entirely
        expect(isAncestorJoint(t, J(40), J(40))).toBe(false);  // strict: not its own ancestor
    });

    it('is false for out-of-range indices rather than throwing', () => {
        expect(isAncestorJoint(t, -1, J(50))).toBe(false);
        expect(isAncestorJoint(t, J(40), -1)).toBe(false);
    });

    // A malformed skin can contain a cycle; an unbounded walk would hang the render loop rather than
    // report a bad rig.
    it('terminates on a cycle', () => {
        const cyclic = skeletonTopology(skin([{ node: 10, parent: 20 }, { node: 20, parent: 10 }]));
        expect(isAncestorJoint(cyclic, 0, 1)).toBe(true);      // they genuinely are each other's ancestor
        expect(isAncestorJoint(cyclic, 0, 0)).toBe(false);
    });
});

describe('nearestCommonAncestor', () => {
    // root(1) -> hips(10) -> {thighL(40), thighR(41)}, and hips -> spine(20)
    const rig = skin([
        { node: 1 }, { node: 10, parent: 1 }, { node: 20, parent: 10 },
        { node: 40, parent: 10 }, { node: 41, parent: 10 },
    ]);
    const t = skeletonTopology(rig);
    const J = (node: number) => t.jointOfNode.get(node)!;

    /**
     * The reason this exists. `root` and `cog` are both synonyms for `hips` in the bone-name table, and a
     * root-motion bone is usually joint 0 — so guessing the pelvis by NAME hands back the bone at the
     * character's feet, and lowering that sinks the whole character. The nearest common ancestor of the two
     * thighs is the pelvis by construction, whatever anything is called.
     */
    it('finds the pelvis as the common ancestor of the two thighs, not the root', () => {
        expect(nearestCommonAncestor(t, [J(40), J(41)])).toBe(J(10));
        expect(nearestCommonAncestor(t, [J(40), J(41)])).not.toBe(J(1));
    });

    it('takes the DEEPEST common ancestor, not just any', () => {
        expect(nearestCommonAncestor(t, [J(20), J(40)])).toBe(J(10));
    });

    it('handles a joint paired with its own ancestor, and a single joint', () => {
        expect(nearestCommonAncestor(t, [J(10), J(40)])).toBe(J(10));
        expect(nearestCommonAncestor(t, [J(40)])).toBe(J(40));
    });

    it('reports -1 when there is no common ancestor', () => {
        // Two separate roots — a synthetic skin can genuinely have several.
        const split = skeletonTopology(skin([{ node: 1 }, { node: 2 }]));
        expect(nearestCommonAncestor(split, [0, 1])).toBe(-1);
        expect(nearestCommonAncestor(t, [])).toBe(-1);
    });
});

