import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';

// Blend spaces on layers. A look-at is the case: a 2D blend space of POSE clips (rest at t = 0, the pose after)
// on an ADDITIVE layer, its axes the aim's yaw and pitch. Before, an additive layer playing a field added
// nothing at all, with nothing said: the field owns no single clip, so the layer had no reference to add from.
// And a layer going from an empty state into a field state stayed faded out.
//
// The rig is a two-bone chain, Hips (node 0) -> Spine (node 1). Each clip turns one bone about +Y (yaw) or +X
// (pitch), so a pose reads as angles.

const SKIN: Skin = {
    joints: [
        { nodeIndex: 0, inverseBindMatrix: mat4.create() },
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
    ],
    nodeParents: new Map([[1, 0]]),
    nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()]]),
    nodeNames: new Map([[0, 'Hips'], [1, 'Spine']]),
};

const axisQ = (axis: [number, number, number], deg: number) => quat.setAxisAngle(quat.create(), axis, deg * Math.PI / 180);

/** A clip holding both bones at `q` (from 0 s to 1 s), or easing from rest to it when `pose` is set. */
function clip(name: string, q: quat, pose = false): Animation {
    const rest = quat.create();
    const a = pose ? rest : q;
    const out = [a[0], a[1], a[2], a[3], q[0], q[1], q[2], q[3], q[0], q[1], q[2], q[3]];
    const input = pose ? [0, 0.05, 1] : [0, 0.5, 1];
    return {
        name,
        samplers: [
            { input, output: out.slice(), interpolation: 'LINEAR' },
            { input, output: out.slice(), interpolation: 'LINEAR' },
        ],
        channels: [
            { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' },
            { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' },
        ],
    } as Animation;
}

const CLIPS: Animation[] = [
    clip('Base', axisQ([0, 1, 0], 30)),             // both bones held at +30 yaw
    clip('LookC', quat.create(), true),             // rest throughout
    clip('LookL', axisQ([0, 1, 0], 40), true),      // rest -> 40 yaw
    clip('LookR', axisQ([0, 1, 0], -40), true),
    clip('LookU', axisQ([1, 0, 0], -20), true),     // rest -> 20 up (pitch about +X)
    clip('LookD', axisQ([1, 0, 0], 20), true),
    clip('Hold', axisQ([0, 1, 0], -40)),
];

const LOOK: AnimationField = {
    mode: '2d',
    xAxis: { name: 'Yaw', min: -90, max: 90, smoothing: 0 },
    yAxis: { name: 'Pitch', min: -45, max: 45, smoothing: 0 },
    weightSmoothing: 0,
    samples: [
        { clipName: 'LookC', x: 0, y: 0 },
        { clipName: 'LookL', x: 90, y: 0 },
        { clipName: 'LookR', x: -90, y: 0 },
        { clipName: 'LookU', x: 0, y: -45 },
        { clipName: 'LookD', x: 0, y: 45 },
    ],
};

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, node as any);
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

const lookState = (extra: Partial<AnimationState> = {}): AnimationState =>
    state('Look', '', { field: JSON.parse(JSON.stringify(LOOK)), fieldInputs: { x: 'LookYaw', y: 'LookPitch' }, ...extra });

function machine(layer: Partial<AnimationStateMachine['layers'] extends (infer L)[] | undefined ? L : never>, params: AnimationStateMachine['parameters'] = []): AnimationStateMachine {
    return {
        parameters: [
            { name: 'LookYaw', type: 'float', default: 0 },
            { name: 'LookPitch', type: 'float', default: 0 },
            { name: 'LookWeight', type: 'float', default: 1 },
            ...params,
        ],
        states: [state('Base', 'Base', { isEntry: true })],
        transitions: [],
        events: [],
        layers: [{ name: 'Look', states: [], transitions: [], ...layer } as any],
    };
}

/** The Spine's local rotation, as the posed joints give it. */
function spineLocal(a: Animator): quat {
    const hips = a.getJointModelMatrix(0)!, spine = a.getJointModelMatrix(1)!;
    const local = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), hips)!, spine);
    return quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
}
/** Degrees from `a` to `b`. */
const apart = (a: quat, b: quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * 180 / Math.PI;
const run = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };

describe('Animator: blend spaces on layers', () => {
    it('adds a pose blend space on an additive layer, relative to each sample’s rest', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ blend: 'additive', states: [lookState({ isEntry: true })], mask: { Spine: 1 } }));
        run(a, 0.3);
        const base = axisQ([0, 1, 0], 30);
        // Centred: every sample adds nothing over its rest, so the Spine is the base.
        expect(apart(spineLocal(a), base)).toBeLessThan(0.5);
        // All the way left: the base turned a further 40 about yaw.
        a.setFloat('LookYaw', 90);
        run(a, 0.3);
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 70))).toBeLessThan(1);
        // Halfway up: the base, then half of the 20 degree pitch.
        a.setFloat('LookYaw', 0);
        a.setFloat('LookPitch', -22.5);
        run(a, 0.3);
        const want = quat.multiply(quat.create(), base, axisQ([1, 0, 0], -10));
        expect(apart(spineLocal(a), want)).toBeLessThan(1.5);
    });

    it('holds a pose blend space still at speed 0, sampled inside its poses, and keeps following its axes', () => {
        // A looping blend space of pose clips wraps back to their first frame (the rest the delta is taken from),
        // and the pose snaps to centre for a few frames. Held at speed 0 and sampled half way in, it never does.
        const a = makeAnimator();
        const field = JSON.parse(JSON.stringify(LOOK));
        for (const sample of field.samples) sample.phaseOffset = 0.5;
        a.setStateMachine(machine({ blend: 'additive', mask: { Spine: 1 }, states: [lookState({ isEntry: true, speed: 0, field })] }));
        a.setFloat('LookYaw', 90);
        run(a, 0.3);
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 70))).toBeLessThan(1);
        let worst = 0;
        for (let k = 0; k < 300; k++) { a.checkTriggers(); a.update(1 / 60); worst = Math.max(worst, apart(spineLocal(a), axisQ([0, 1, 0], 70))); }
        expect(worst, 'never drops back toward the rest pose').toBeLessThan(1);
        a.setFloat('LookYaw', -90);
        run(a, 0.3);
        expect(apart(spineLocal(a), axisQ([0, 1, 0], -10))).toBeLessThan(1);
    });

    it('adds nothing at weight 0, and nothing to the bones outside its mask', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ blend: 'additive', states: [lookState({ isEntry: true })], mask: { Spine: 1 }, weightParam: 'LookWeight' }));
        a.setFloat('LookYaw', 90);
        run(a, 0.3);
        const hips = quat.normalize(quat.create(), mat4.getRotation(quat.create(), a.getJointModelMatrix(0)!));
        expect(apart(hips, axisQ([0, 1, 0], 30))).toBeLessThan(0.5);
        a.setFloat('LookWeight', 0);
        run(a, 0.1);
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 30))).toBeLessThan(0.5);
    });

    it('fades in from an empty state into a blend space', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            blend: 'additive', mask: { Spine: 1 },
            states: [state('Empty', '', { isEntry: true }), lookState()],
            transitions: [{ from: 'Empty', to: 'Look', conditions: [{ param: 'Idle', op: 'true' }], blendTime: 0.2 }],
        }, [{ name: 'Idle', type: 'bool', default: false }]));
        a.setFloat('LookYaw', 90);
        run(a, 0.2);
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 30))).toBeLessThan(0.5);
        a.setBool('Idle', true);
        run(a, 0.6);
        expect(a.layerStateName('Look')).toBe('Look');
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 70))).toBeLessThan(1);
    });

    it('still overrides with a blend space on an override layer', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ states: [lookState({ isEntry: true })], mask: { Spine: 1 } }));
        a.setFloat('LookYaw', -90);
        run(a, 0.3);
        // Override: the Spine IS the sample's pose (-40 yaw), not the base plus it.
        expect(apart(spineLocal(a), axisQ([0, 1, 0], -40))).toBeLessThan(1);
    });

    it('keeps an additive clip layer as it was', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ blend: 'additive', states: [state('Hold', 'Hold', { isEntry: true })], mask: { Spine: 1 } }));
        run(a, 0.3);
        // A held clip adds nothing over its own first frame.
        expect(apart(spineLocal(a), axisQ([0, 1, 0], 30))).toBeLessThan(0.5);
    });
});
