import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { AnimatedModel } from '../src/animation/animatedModel';
import type { Skin } from '../src/animation/animatedModel';
import { socketJoint, socketModelMatrix, socketNames } from '../src/animation/sockets';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { Node } from '../src/core/scene/nodes/node';
import { Scene } from '../src/core/scene/scene';
import { resolveSocketOwner } from '../src/core/scene/socketFollow';

// Sockets: named attach points on bones, followed by any node that is pinned to one.
//
// The rig every test here uses is the shape that breaks naive maths — an FBX-style armature carrying a
// 0.01 scale — because a socket that inherits that scale shrinks a held sword to a centimetre.

const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);

/** armature (node 0, scale 0.01, NOT a joint) -> hips (node 1) -> hand (node 2, 100 cm up the hips). */
function skin(): Skin {
    const armature = mat4.fromScaling(mat4.create(), [0.01, 0.01, 0.01]);
    const hips = mat4.create();
    const hand = mat4.fromRotationTranslation(mat4.create(), qy(90), [0, 100, 0]);
    return {
        joints: [
            { nodeIndex: 1, inverseBindMatrix: mat4.create() },
            { nodeIndex: 2, inverseBindMatrix: mat4.create(), parentIndex: 0 },
        ],
        nodeParents: new Map([[1, 0], [2, 1]]),
        nodeTransforms: new Map([[0, armature], [1, hips], [2, hand]]),
        nodeNames: new Map([[0, 'Armature'], [1, 'Hips'], [2, 'RightHand']]),
        sockets: [
            { name: 'RightHandSocket', bone: 'RightHand', offset: { t: [0, 0, 0.1] } },
            { name: 'Ghost', bone: 'NoSuchBone' },
        ],
    };
}

/** A skinned ModelNode without a GL context: an AnimatedModel shell carrying only the skin. */
function skinnedModelNode(name: string): ModelNode {
    const model = Object.create(AnimatedModel.prototype);
    model._skin = skin();
    model._animations = [];
    return new ModelNode(name, model);
}

const translationOf = (m: mat4) => mat4.getTranslation(vec3.create(), m);
const scaleOf = (m: mat4) => mat4.getScaling(vec3.create(), m);

describe('socket resolution', () => {
    it('resolves a socket by bone NAME and drops one whose bone is missing', () => {
        const s = skin();
        expect(socketJoint(s, 'RightHandSocket')).toBe(1);
        expect(socketJoint(s, 'Ghost')).toBe(-1);
        expect(socketNames(s)).toEqual(['RightHandSocket']);
    });

    it('places the socket where the bone is, but without the armature scale', () => {
        const s = skin();
        // The joint's model matrix as the animator builds it: armature x hips x hand.
        const jointModel = mat4.multiply(mat4.create(), s.nodeTransforms!.get(0)!, s.nodeTransforms!.get(2)!);
        const out = socketModelMatrix(mat4.create(), s, 'RightHandSocket', () => jointModel)!;

        // The hand sits 1 m up (100 cm x 0.01); the 10 cm offset is along the hand's rotated +Z, which a
        // +90 yaw turns into +X — in METRES, unscaled by the armature.
        const t = translationOf(out);
        expect(t[0]).toBeCloseTo(0.1, 5);
        expect(t[1]).toBeCloseTo(1, 5);
        expect(t[2]).toBeCloseTo(0, 5);
        expect(scaleOf(out)[0]).toBeCloseTo(1, 5);
    });
});

describe('ModelNode sockets', () => {
    it('reports the sockets its skeleton can resolve, and their world matrix', () => {
        const node = skinnedModelNode('character');
        node.setPosition([5, 0, 0]);
        node.updateTransforms();
        expect(node.socketNames).toEqual(['RightHandSocket']);
        const world = node.getSocketWorldMatrix('RightHandSocket')!;
        expect(translationOf(world)[0]).toBeCloseTo(5.1, 5);
        expect(translationOf(world)[1]).toBeCloseTo(1, 5);
        expect(node.getSocketWorldMatrix('Ghost')).toBeNull();
    });
});

describe('socket followers', () => {
    function rig() {
        const scene = new Scene();
        const holder = new Node('Character');
        const mesh = skinnedModelNode('Body');
        const sword = new Node('Sword');
        holder.addChild(mesh);
        holder.addChild(sword);   // a SIBLING of the mesh, the way a weapon is dropped under a character
        scene.addNode(holder);
        holder.setPosition([0, 0, 3]);
        sword.attachToSocket('parent', 'RightHandSocket');
        return { scene, holder, mesh, sword };
    }

    it("finds the skinned mesh under the follower's holder", () => {
        const { scene, mesh, sword } = rig();
        expect(resolveSocketOwner(sword, sword.socketAttachment!, id => scene.getNodeById(id) ?? null)).toBe(mesh);
    });

    it('lands on the socket in the SAME frame, with no lag', () => {
        const { scene, sword } = rig();
        scene.update(1 / 60, 0, false);
        const t = sword.worldPosition;
        expect(t[0]).toBeCloseTo(0.1, 5);
        expect(t[1]).toBeCloseTo(1, 5);
        expect(t[2]).toBeCloseTo(3, 5);
        expect(sword.worldScale[0]).toBeCloseTo(1, 5);
    });

    it('stops following once detached, keeping its last transform', () => {
        const { scene, holder, sword } = rig();
        scene.update(1 / 60, 0, false);
        sword.detachFromSocket();
        holder.setPosition([0, 0, 10]);
        scene.update(1 / 60, 0, false);
        expect(sword.worldPosition[2]).toBeCloseTo(10, 5); // moved with its parent, not re-pinned
        expect(sword.position[0]).toBeCloseTo(0.1, 5);      // the local it was left at
    });

    it('round-trips the attachment through serialize', async () => {
        const { sword } = rig();
        const json = await sword.serialize();
        expect(json.socketAttachment).toEqual({ target: 'parent', socket: 'RightHandSocket' });
        const parent = new Node('p');
        Node.parse(parent, json);
        expect(parent.children[0].socketAttachment).toEqual({ target: 'parent', socket: 'RightHandSocket' });
    });
});
