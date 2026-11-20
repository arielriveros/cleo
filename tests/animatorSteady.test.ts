import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState, AnimationLayer, AnimationPose } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import { decomposeTRS } from '../src/core/math';

// STEADY (`AnimationState.meshSpace`): an override layer's pose keeping its own MODEL-space turn at the top of
// its mask, whatever the hips do, so one held pose sits still over a walk (the chest of a rifle hold) while
// everything below the mask's top rides in local space. Measured against the body as the layers BELOW compose
// it, so a lean layer above still tilts it.
//
// The rig is Armature (a non-joint node: 30 deg yaw and the 0.01 scale of a Mixamo export) -> Hips -> Spine ->
// Chest, all joints at rest identity. The base clip yaws the Hips; the layers hold the Spine and Chest.

const W = quat.setAxisAngle(quat.create(), [0, 1, 0], 30 * Math.PI / 180);
const ARMATURE = mat4.fromRotationTranslationScale(mat4.create(), W, [0, 0, 0], [0.01, 0.01, 0.01]);
const SKIN: Skin = {
    joints: [
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
        { nodeIndex: 2, inverseBindMatrix: mat4.create(), parentIndex: 1 },
        { nodeIndex: 3, inverseBindMatrix: mat4.create(), parentIndex: 2 },
    ],
    nodeParents: new Map([[1, 0], [2, 1], [3, 2]]),
    nodeTransforms: new Map([[0, ARMATURE], [1, mat4.create()], [2, mat4.fromTranslation(mat4.create(), [0, 10, 0])], [3, mat4.fromTranslation(mat4.create(), [0, 10, 0])]]),
    nodeNames: new Map([[0, 'Armature'], [1, 'Hips'], [2, 'Spine'], [3, 'Chest']]),
};

const axisQ = (axis: [number, number, number], deg: number) => quat.setAxisAngle(quat.create(), axis, deg * Math.PI / 180);
const q4 = (q: quat) => [q[0], q[1], q[2], q[3]];
const Y: [number, number, number] = [0, 1, 0], Z: [number, number, number] = [0, 0, 1];

/** A clip holding the Hips at a yaw (and the Spine at rest). */
function hipsClip(name: string, yawDeg: number): Animation {
    const q = axisQ(Y, yawDeg);
    const out = [...q4(q), ...q4(q)];
    return {
        name,
        samplers: [{ input: [0, 1], output: out, interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 1, targetPath: 'rotation' }],
    } as Animation;
}

const CLIPS = [hipsClip('Turn0', 0), hipsClip('Turn40', 40), hipsClip('TurnM25', -25)];

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, node as any);
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });
const HOLD: AnimationPose = { name: 'Hold', bones: [{ name: 'Spine', rotation: q4(axisQ(Z, 20)) }, { name: 'Chest', rotation: q4(axisQ(Z, 10)) }] };

function machine(baseClip: string, layers: AnimationLayer[], params: AnimationStateMachine['parameters'] = []): AnimationStateMachine {
    return { parameters: params, states: [state('Base', baseClip, { isEntry: true })], transitions: [], events: [], layers };
}
const holdLayer = (meshSpace: number | undefined, extra: Partial<AnimationLayer> = {}): AnimationLayer => ({
    name: 'Hold', mask: { Spine: 1, Chest: 1 }, transitions: [],
    states: [state('Hold', '', { isEntry: true, pose: HOLD, ...(meshSpace !== undefined ? { meshSpace } : {}) })],
    ...extra,
});

/** A joint's model-space turn (the scale divided out). */
function modelTurn(a: Animator, joint: number): quat {
    const t = vec3.create(), r = quat.create(), s = vec3.create();
    decomposeTRS(a.getJointModelMatrix(joint)!, t, r, s);
    return r;
}
const apart = (a: quat, b: quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * 180 / Math.PI;
const run = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };
const posed = (sm: AnimationStateMachine, seconds = 0.5) => { const a = makeAnimator(); a.setStateMachine(sm); run(a, seconds); return a; };

/** The chest's model turn the hold's own pose gives it: Armature, the Hips at rest, the Spine and Chest held. */
const HELD_CHEST = quat.multiply(quat.create(), W, quat.multiply(quat.create(), axisQ(Z, 20), axisQ(Z, 10)));

describe('Animator: Steady layers (meshSpace)', () => {
    it('at 1, holds the pose’s own chest whatever the hips do', () => {
        for (const clip of ['Turn0', 'Turn40', 'TurnM25']) {
            const a = posed(machine(clip, [holdLayer(1)]));
            expect(apart(modelTurn(a, 2), HELD_CHEST)).toBeLessThan(0.1);
        }
        // The hips themselves are the walk's: not in the mask.
        expect(apart(modelTurn(posed(machine('Turn40', [holdLayer(1)])), 0), quat.multiply(quat.create(), W, axisQ(Y, 40)))).toBeLessThan(0.1);
    });

    it('at 0 is exactly the layer without it, riding the hips', () => {
        const a = posed(machine('Turn40', [holdLayer(0)]));
        const b = posed(machine('Turn40', [holdLayer(undefined)]));
        for (let j = 0; j < 3; j++) expect(Array.from(a.getJointModelMatrix(j)!)).toEqual(Array.from(b.getJointModelMatrix(j)!));
        expect(apart(modelTurn(a, 2), quat.multiply(quat.create(), axisQ(Y, 40), HELD_CHEST))).toBeLessThan(0.1);
    });

    it('at 0.5 takes back half the hips’ turn', () => {
        const a = posed(machine('Turn40', [holdLayer(0.5)]));
        expect(apart(modelTurn(a, 2), quat.multiply(quat.create(), axisQ(Y, 20), HELD_CHEST))).toBeLessThan(0.1);
    });

    it('keeps the pose’s own hips as its frame, when the pose holds them', () => {
        const pose: AnimationPose = { name: 'Lunge', bones: [{ name: 'Hips', rotation: q4(axisQ(Y, -10)) }, ...HOLD.bones] };
        const a = posed(machine('Turn40', [{ ...holdLayer(1), states: [state('Hold', '', { isEntry: true, pose, meshSpace: 1 })] }]));
        expect(apart(modelTurn(a, 2), quat.multiply(quat.create(), quat.multiply(quat.create(), W, axisQ(Y, -10)), quat.multiply(quat.create(), axisQ(Z, 20), axisQ(Z, 10))))).toBeLessThan(0.1);
    });

    it('eases over the cross-fade between states', () => {
        const layer = holdLayer(0, {
            states: [state('Loose', '', { isEntry: true, pose: HOLD, meshSpace: 0 }), state('Steady', '', { pose: HOLD, meshSpace: 1 })],
            transitions: [{ from: 'Loose', to: 'Steady', conditions: [{ param: 'Aim', op: 'true' }], blendTime: 0.5 }],
        });
        const a = posed(machine('Turn40', [layer], [{ name: 'Aim', type: 'bool', default: false }]));
        const loose = apart(modelTurn(a, 2), HELD_CHEST);
        expect(loose).toBeCloseTo(40, 1);
        a.setBool('Aim', true);
        run(a, 0.25);
        const mid = apart(modelTurn(a, 2), HELD_CHEST);
        expect(mid).toBeGreaterThan(5);
        expect(mid).toBeLessThan(35);
        run(a, 0.5);
        expect(apart(modelTurn(a, 2), HELD_CHEST)).toBeLessThan(0.1);
    });

    it('is measured against the layers below it, so a lean above still tilts the chest', () => {
        const lean: AnimationLayer = {
            name: 'Lean', blend: 'additive', mask: { Hips: 1 }, transitions: [],
            states: [state('Lean', '', { isEntry: true, pose: { name: 'Lean', bones: [{ name: 'Hips', rotation: q4(axisQ(Z, 15)) }] } })],
        };
        const a = posed(machine('Turn0', [holdLayer(1), lean]));
        expect(apart(modelTurn(a, 2), quat.multiply(quat.create(), quat.multiply(quat.create(), W, axisQ(Z, 15)), quat.multiply(quat.create(), axisQ(Z, 20), axisQ(Z, 10))))).toBeLessThan(0.1);
    });

    it('does nothing on a whole-body layer, which has no top to hold', () => {
        const a = posed(machine('Turn40', [holdLayer(1, { mask: undefined })]));
        const b = posed(machine('Turn40', [holdLayer(0, { mask: undefined })]));
        for (let j = 0; j < 3; j++) expect(Array.from(a.getJointModelMatrix(j)!)).toEqual(Array.from(b.getJointModelMatrix(j)!));
    });

    it('nests: a Steady layer on the chest over a Steady layer on the spine', () => {
        const top: AnimationLayer = {
            name: 'Top', mask: { Chest: 1 }, transitions: [],
            states: [state('Top', '', { isEntry: true, meshSpace: 1, pose: { name: 'Top', bones: [{ name: 'Chest', rotation: q4(axisQ(Z, 50)) }] } })],
        };
        for (const clip of ['Turn0', 'Turn40']) {
            const a = posed(machine(clip, [holdLayer(1), top]));
            // The chest's frame in the top layer's own pose: the Armature, the Hips and Spine at rest.
            expect(apart(modelTurn(a, 2), quat.multiply(quat.create(), W, axisQ(Z, 50)))).toBeLessThan(0.1);
            // The spine is still the hold's.
            expect(apart(modelTurn(a, 1), quat.multiply(quat.create(), W, axisQ(Z, 20)))).toBeLessThan(0.1);
        }
    });
});
