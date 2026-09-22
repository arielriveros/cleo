import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// Per-bone local overrides: the clip editor pins a bone while the clip keeps driving every other one.
//
// The alternative would be to write the key and re-bind the clip, but `playAnimation` re-transcodes every
// channel into fresh `Bone` objects — far too much for a 60 Hz drag, and it would also stop the rest of
// the body animating, which is exactly what you need to see when judging an arm pose against a walk cycle.
//
// A real AnimatedModel builds a GPU Mesh in its constructor, so this uses the same duck-typed stand-in
// animatorRootMotion.test.ts does.

/** Two bones in a chain: node 0 (root) -> node 1. */
const SKIN: Skin = {
    joints: [
        { nodeIndex: 0, inverseBindMatrix: mat4.create() },
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
    ],
    nodeParents: new Map([[1, 0]]),
    nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()]]),
};

const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);

/** A clip rotating BOTH bones from identity to +90 degrees about Y over one second. */
function clip(): Animation {
    const to = qy(90);
    const out = [0, 0, 0, 1, to[0], to[1], to[2], to[3]];
    return {
        name: 'wave',
        samplers: [
            { input: [0, 1], output: out.slice(), interpolation: 'LINEAR' },
            { input: [0, 1], output: out.slice(), interpolation: 'LINEAR' },
        ],
        channels: [
            { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' },
            { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' },
        ],
    };
}

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    const model = { skin: SKIN, animations: [clip()] } as unknown as AnimatedModel;
    return new Animator(model, node as any);
}

/**
 * The ACCUMULATED rotation of one joint, in degrees about Y — what the vertex shader gets.
 *
 * Accumulated, not local: `finalBoneMatrices[j]` is `parentGlobal x local x inverseBind`, and the inverse
 * binds here are identity, so joint 1 reads as the SUM of both bones. That is the point — it is what
 * proves an override reaches the pose the mesh is actually skinned by, rather than merely being stored.
 */
function worldAngleOf(a: Animator, jointIndex: number): number {
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), a.getFinalBoneMatrices()[jointIndex]));
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    // Signed about +Y, so a -30 degree pose does not read as +30 about -Y.
    return (axis[1] < 0 ? -angle : angle);
}

const armed = () => {
    const a = makeAnimator();
    a.playAnimationByName('wave', true, false);
    a.pause();
    a.seek(1); // both bones at +90
    return a;
};

describe('Animator — bone local overrides', () => {
    it('pins the overridden bone and leaves every other one to the clip', () => {
        // The property the whole feature rests on: pose an arm, watch the walk cycle continue underneath.
        const a = armed();
        expect(worldAngleOf(a, 0)).toBeCloseTo(90, 3);
        expect(worldAngleOf(a, 1)).toBeCloseTo(180, 3);  // 90 of its own on top of its parent's 90

        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        expect(worldAngleOf(a, 1)).toBeCloseTo(60, 3);   // pinned to -30 LOCAL, under a parent still at 90
        expect(worldAngleOf(a, 0)).toBeCloseTo(90, 3);   // ...and bone 0 is still where the clip put it
    });

    it('outranks the clip even as the playhead moves', () => {
        // Scrubbing while holding a bone is how you check a pose against the frames around it, so a seek
        // must not quietly hand the bone back to the clip.
        const a = armed();
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        a.seek(0);
        expect(worldAngleOf(a, 0)).toBeCloseTo(0, 3);    // the clip moved bone 0 back to its first frame
        expect(worldAngleOf(a, 1)).toBeCloseTo(-30, 3);  // ...and the pin held, now under an identity parent
    });

    it('propagates down the chain, because it is a LOCAL transform', () => {
        // Overriding a parent has to move its children with it, or posing a shoulder would leave the hand
        // hanging in space.
        const a = armed();
        a.setBoneLocalOverride(0, mat4.fromQuat(mat4.create(), qy(0)));
        expect(worldAngleOf(a, 0)).toBeCloseTo(0, 3);
        expect(worldAngleOf(a, 1)).toBeCloseTo(90, 3);   // bone 1 moved WITH its parent; its own local is untouched
    });

    it('releases on null, and clearBoneLocalOverrides releases all', () => {
        const a = armed();
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        a.setBoneLocalOverride(1, null);
        expect(worldAngleOf(a, 1)).toBeCloseTo(180, 3);
        expect(a.boneLocalOverride(1)).toBeNull();

        a.setBoneLocalOverride(0, mat4.fromQuat(mat4.create(), qy(10)));
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(10)));
        a.clearBoneLocalOverrides();
        expect(worldAngleOf(a, 0)).toBeCloseTo(90, 3);
        expect(worldAngleOf(a, 1)).toBeCloseTo(180, 3);
    });

    it('showBindPose drops every pin', () => {
        // "Show me the rest pose" means exactly that; a bone still held by a drag would sit visibly out
        // of place in it, with nothing on screen explaining why.
        const a = armed();
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        a.showBindPose();
        expect(a.boneLocalOverride(1)).toBeNull();
        expect(worldAngleOf(a, 1)).toBeCloseTo(0, 3);
    });

    it('copies the matrix it is given, so a caller reusing its scratch cannot move the bone', () => {
        const a = armed();
        const scratch = mat4.fromQuat(mat4.create(), qy(-30));
        a.setBoneLocalOverride(1, scratch);
        mat4.fromQuat(scratch, qy(45));                   // the caller reuses its buffer
        expect(worldAngleOf(a, 1)).toBeCloseTo(60, 3);   // still -30 local, under a parent at 90
    });
});

describe('Animator — reading a bone to key it', () => {
    it('boneLocalTransform reports the clip pose under the playhead', () => {
        const a = armed();
        const m = a.boneLocalTransform(1)!;
        const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), m));
        expect(Math.abs(quat.dot(q, qy(90)))).toBeCloseTo(1, 4);
    });

    it('...and the OVERRIDE once one is set, which is what gets keyed', () => {
        const a = armed();
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), a.boneLocalTransform(1)!));
        expect(Math.abs(quat.dot(q, qy(-30)))).toBeCloseTo(1, 4);
    });

    it('falls back to rest for a bone the clip does not drive', () => {
        const rest = mat4.fromTranslation(mat4.create(), [0, 2, 0]);
        const skin: Skin = { ...SKIN, nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()], [5, rest]]) };
        const node = {
            position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
            setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
        };
        const a = new Animator({ skin, animations: [clip()] } as unknown as AnimatedModel, node as any);
        expect(mat4.getTranslation(vec3.create(), a.boneLocalTransform(5)!)[1]).toBeCloseTo(2, 5);
    });

    it('boneRestTransform ignores the pose entirely — a pose is stored as a delta from it', () => {
        const a = armed();
        a.setBoneLocalOverride(1, mat4.fromQuat(mat4.create(), qy(-30)));
        const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), a.boneRestTransform(1)!));
        expect(Math.abs(quat.dot(q, quat.create()))).toBeCloseTo(1, 5);
    });
});
