import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// Root motion: a clip flagged `rootMotion` has its ROOT bone's translation/rotation delta applied to the
// character (the nearest bodied ancestor, else the model node) each frame, while the root bone itself is
// locked to its clip-start pose so the mesh does not also move in model space.
//
// As with animatorField.test.ts, a real AnimatedModel builds a GPU Mesh in its constructor, so this uses a
// duck-typed stand-in plus a duck-typed node the Animator can move.

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], // one parentless joint = the root
    nodeTransforms: new Map([[0, mat4.create()]]),
};

/** A clip translating the root bone (node 0) from origin to `toX` along +X over `duration`. Root motion on. */
function rmTranslate(name: string, toX: number, duration: number): Animation {
    return {
        name,
        rootMotion: true,
        samplers: [{ input: [0, duration], output: [0, 0, 0, toX, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

/** A clip rotating the root bone (node 0) from identity to +90° about Y over `duration`. Root motion on. */
function rmRotateY(name: string, duration: number): Animation {
    const s = Math.sin(Math.PI / 4), c = Math.cos(Math.PI / 4);
    return {
        name,
        rootMotion: true,
        samplers: [{ input: [0, duration], output: [0, 0, 0, 1, 0, s, 0, c], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }],
    };
}

interface DuckNode {
    position: vec3;
    quaternion: quat;
    worldQuaternion: quat;
    setPosition(v: vec3): void;
    setQuaternion(q: quat): void;
    parent: DuckNode | null;
    body: { setQuaternion(q: quat): void; q: quat } | null;
    currentSpeed: number;
}

function makeNode(opts?: { parent?: DuckNode | null; withBody?: boolean }): DuckNode {
    const position = vec3.create();
    const quaternion = quat.create();
    const body = opts?.withBody ? { q: quat.create(), setQuaternion(q: quat) { quat.copy(this.q, q); } } : null;
    return {
        position, quaternion,
        // Parentless test nodes: world rotation == local rotation. Kept in sync on setQuaternion.
        worldQuaternion: quaternion,
        setPosition(v) { vec3.copy(position, v); },
        setQuaternion(q) { quat.copy(quaternion, q); },
        parent: opts?.parent ?? null,
        body,
        currentSpeed: 0,
    };
}

function makeAnimator(animations: Animation[], node: DuckNode): Animator {
    const model = { skin: SKIN, animations } as unknown as AnimatedModel;
    return new Animator(model, node as any);
}

/** X translation of the posed root bone. Inverse bind is identity, so this is its local X. */
function boneX(a: Animator): number {
    const t = vec3.create();
    mat4.getTranslation(t, a.getFinalBoneMatrices()[0]);
    return t[0];
}

describe('Animator — root motion', () => {
    it('moves the node by the root delta and locks the mesh in place', () => {
        const node = makeNode();
        const a = makeAnimator([rmTranslate('walk', 2, 1)], node);
        a.playAnimationByName('walk', true, false);
        a.play();

        a.update(0.5);
        expect(node.position[0]).toBeCloseTo(1);   // half of the 2-unit slide went to the node
        expect(boneX(a)).toBeCloseTo(0);           // the root bone is pinned to its start (origin)

        a.update(0.5);
        expect(node.position[0]).toBeCloseTo(2);   // full slide accumulated on the node
        expect(boneX(a)).toBeCloseTo(0);
    });

    it('keeps advancing across a loop wrap instead of snapping back', () => {
        const node = makeNode();
        const a = makeAnimator([rmTranslate('walk', 2, 1)], node);
        a.playAnimationByName('walk', true, false);
        a.play();

        a.update(0.9);
        expect(node.position[0]).toBeCloseTo(1.8);
        // 0.9 → 1.1 wraps to 0.1: the delta is (end - 0.9) + (0.1 - start) = 0.2 + 0.2 = 0.4, NOT a -1.6 snap.
        a.update(0.2);
        expect(node.position[0]).toBeCloseTo(2.2);
    });

    it('rotates the node by the root rotation and locks the mesh rotation', () => {
        const node = makeNode();
        const a = makeAnimator([rmRotateY('turn', 1)], node);
        a.playAnimationByName('turn', true, false);
        a.play();

        a.update(0.5); // ~45° about Y so far (avoid landing exactly on the loop point)
        a.update(0.4); // to t=0.9

        // The node carries a positive yaw; the posed root bone stays at identity (locked to the ref).
        const nodeYaw = quat.getAxisAngle(vec3.create(), node.quaternion);
        expect(nodeYaw).toBeGreaterThan(0.1);
        const r = quat.create();
        mat4.getRotation(r, a.getFinalBoneMatrices()[0]);
        expect(quat.getAxisAngle(vec3.create(), r)).toBeCloseTo(0); // ~identity: no residual rotation on the mesh
    });

    it('drives the nearest bodied ancestor, pushing rotation into its physics body', () => {
        const root = makeNode({ withBody: true });
        const model = makeNode({ parent: root });
        const a = makeAnimator([rmTranslate('walk', 2, 1)], model);
        a.playAnimationByName('walk', true, false);
        a.play();

        a.update(0.5);
        expect(root.position[0]).toBeCloseTo(1); // the ROOT moved, not the model node
        expect(model.position[0]).toBeCloseTo(0);
        expect(root.body!.q).toBeDefined();      // body.setQuaternion was called (rotation pushed to physics)
    });

    it('does not move the node for a clip without the flag', () => {
        const node = makeNode();
        const plain = rmTranslate('walk', 2, 1);
        delete plain.rootMotion;
        const a = makeAnimator([plain], node);
        a.playAnimationByName('walk', true, false);
        a.play();

        a.update(0.5);
        expect(node.position[0]).toBeCloseTo(0); // no extraction; the slide stays in the pose
        expect(boneX(a)).toBeCloseTo(1);
    });

    // The regression for "the turn rotates on the wrong axis": an FBX-style rig sits under a static armature
    // that converts Z-up authoring to the engine's Y-up (a -90° X rotation). A turn is authored as a yaw about
    // the armature's up-axis (Z). Without conjugating the delta through the armature rotation, that Z-yaw would
    // rotate the character about world Z (a roll); it must come out as a yaw about world Y.
    it('converts a root delta through the static armature so a yaw stays a yaw', () => {
        const armature = mat4.fromXRotation(mat4.create(), -Math.PI / 2); // Z-up → Y-up
        const s = Math.sin(Math.PI / 4), c = Math.cos(Math.PI / 4);
        const skin: Skin = {
            joints: [
                { nodeIndex: 0, inverseBindMatrix: mat4.create() },                 // armature (static, parentless)
                { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 }, // hips (animated root)
            ],
            nodeTransforms: new Map([[0, armature], [1, mat4.create()]]),
        };
        // Hips yaw about its own up (authoring Z) from 0 to 90°.
        const clip: Animation = {
            name: 'turn',
            rootMotion: true,
            samplers: [{ input: [0, 1], output: [0, 0, 0, 1, 0, 0, s, c], interpolation: 'LINEAR' }],
            channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }],
        };
        const node = makeNode();
        const a = new Animator({ skin, animations: [clip] } as unknown as AnimatedModel, node as any);
        a.playAnimationByName('turn', true, false);
        a.play();
        a.update(0.5);
        a.update(0.4); // to t=0.9, staying off the loop point

        // The node must have turned about WORLD Y (0, ±1, 0), not Z or X.
        const axis = vec3.create();
        const angle = quat.getAxisAngle(axis, node.quaternion);
        expect(angle).toBeGreaterThan(0.1);
        expect(Math.abs(axis[1])).toBeCloseTo(1);          // rotation axis is world up
        expect(Math.abs(axis[0])).toBeLessThan(0.05);
        expect(Math.abs(axis[2])).toBeLessThan(0.05);
    });

    it('stops driving the node once a field takes over', () => {
        const node = makeNode();
        const a = makeAnimator([rmTranslate('walk', 2, 1)], node);
        a.playAnimationByName('walk', true, false);
        a.play();
        a.update(0.5);
        const afterClip = node.position[0];

        a.playField({ mode: '1d', xAxis: { name: 'Speed', min: 0, max: 1 }, samples: [{ clipName: 'walk', x: 0 }] }, 0);
        a.update(0.5);
        expect(node.position[0]).toBeCloseTo(afterClip); // the field does not extract root motion
    });
});
