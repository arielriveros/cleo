import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState, AnimationLayer, AnimationPose } from '../src/animation/animator';
import type { AnimatedModel, Skin } from '../src/animation/animatedModel';
import { decomposeTRS } from '../src/core/math';

// SUPPORT-HAND IK (`AnimationLayer.handIk`): after every layer, a hand reaches where the layer's OWN pose puts it
// relative to the other hand, so the left hand stays on a rifle held in the right whatever an aim layer above
// does to the right arm.
//
// The rig: Hips -> Spine -> Chest, and from the Chest each arm (Arm -> ForeArm -> Hand), along +-X at rest.

const T = (x: number, y: number, z: number) => mat4.fromTranslation(mat4.create(), [x, y, z]);
const NAMES = ['Hips', 'Spine', 'Chest', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightArm', 'RightForeArm', 'RightHand'];
const PARENT = [-1, 0, 1, 2, 3, 4, 2, 6, 7];
const REST = [T(0, 0, 0), T(0, 10, 0), T(0, 10, 0), T(5, 0, 0), T(10, 0, 0), T(10, 0, 0), T(-5, 0, 0), T(-10, 0, 0), T(-10, 0, 0)];

const SKIN: Skin = {
    joints: NAMES.map((_, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create(), ...(PARENT[i] >= 0 ? { parentIndex: PARENT[i] } : {}) })),
    nodeParents: new Map(PARENT.map((p, i) => [i, p] as [number, number]).filter(([, p]) => p >= 0)),
    nodeTransforms: new Map(REST.map((m, i) => [i, m])),
    nodeNames: new Map(NAMES.map((n, i) => [i, n])),
    sockets: [{ name: 'Rifle Support', bone: 'RightHand' }],
};

const axisQ = (axis: [number, number, number], deg: number) => quat.setAxisAngle(quat.create(), axis, deg * Math.PI / 180);
const q4 = (q: quat) => [q[0], q[1], q[2], q[3]];
const X: [number, number, number] = [1, 0, 0], Y: [number, number, number] = [0, 1, 0], Z: [number, number, number] = [0, 0, 1];

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: [] } as unknown as AnimatedModel, node as any);
}

const state = (name: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName: '', loop: true, speed: 1, ...extra });

// Both arms brought forward, elbows bent down, the hands meeting in front of the chest.
const HOLD: AnimationPose = {
    name: 'Hold', bones: [
        { name: 'RightArm', rotation: q4(axisQ(Y, 60)) }, { name: 'RightForeArm', rotation: q4(axisQ(Z, 25)) },
        { name: 'LeftArm', rotation: q4(axisQ(Y, -60)) }, { name: 'LeftForeArm', rotation: q4(axisQ(Z, -25)) },
        { name: 'LeftHand', rotation: q4(axisQ(X, 20)) },
    ],
};
const ARMS = { LeftArm: 1, LeftForeArm: 1, LeftHand: 1, RightArm: 1, RightForeArm: 1, RightHand: 1 };

function machine(handIk: AnimationLayer['handIk'], aimDeg: number, params: AnimationStateMachine['parameters'] = []): AnimationStateMachine {
    return {
        parameters: params, transitions: [], events: [],
        states: [state('Base', { isEntry: true, pose: { name: 'Rest', bones: [] } })],
        layers: [
            { name: 'Hold', mask: ARMS, transitions: [], states: [state('Hold', { isEntry: true, pose: HOLD })], ...(handIk ? { handIk } : {}) },
            // An aim offset on the right arm only: what pulls the gun hand away from the support hand.
            { name: 'Aim', blend: 'additive', mask: { RightArm: 1 }, transitions: [], states: [state('Aim', { isEntry: true, pose: { name: 'Up', bones: [{ name: 'RightArm', rotation: q4(axisQ(Z, aimDeg)) }] } })] },
        ],
    };
}

const run = (a: Animator, seconds = 0.3) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };
const posed = (sm: AnimationStateMachine) => { const a = makeAnimator(); a.setStateMachine(sm); run(a); return a; };
const joint = (a: Animator, name: string) => a.getJointModelMatrix(NAMES.indexOf(name))!;
/** The left hand in the right hand's frame. */
const relation = (a: Animator) => mat4.multiply(mat4.create(), mat4.invert(mat4.create(), joint(a, 'RightHand'))!, joint(a, 'LeftHand'));
const position = (m: mat4) => mat4.getTranslation(vec3.create(), m);
const turn = (m: mat4) => { const t = vec3.create(), r = quat.create(), s = vec3.create(); decomposeTRS(m, t, r, s); return r; };
const apart = (a: quat, b: quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * 180 / Math.PI;

describe('Animator: support-hand IK on a layer', () => {
    const held = relation(posed(machine(undefined, 0)));   // the hold's own relation, nothing pulling the hands apart

    it('without it, an aim layer on the gun arm pulls the hands apart', () => {
        expect(vec3.distance(position(relation(posed(machine(undefined, 20)))), position(held))).toBeGreaterThan(1);
    });

    it('keeps the support hand where the hold has it relative to the gun hand', () => {
        const a = posed(machine({ hand: 'left' }, 20));
        const rel = relation(a);
        expect(vec3.distance(position(rel), position(held))).toBeLessThan(1e-3);
        expect(apart(turn(rel), turn(held))).toBeLessThan(0.1);
    });

    it('keeps the elbow on the side the pose bends it', () => {
        const bendOf = (a: Animator) => {
            const s = position(joint(a, 'LeftArm')), e = position(joint(a, 'LeftForeArm')), h = position(joint(a, 'LeftHand'));
            const line = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), h, s));
            const off = vec3.sub(vec3.create(), e, s);
            return vec3.normalize(off, vec3.scaleAndAdd(off, off, line, -vec3.dot(off, line)));
        };
        expect(vec3.dot(bendOf(posed(machine({ hand: 'left' }, 20))), bendOf(posed(machine(undefined, 0))))).toBeGreaterThan(0.8);
    });

    it('at weight 0 changes nothing', () => {
        const a = posed(machine({ hand: 'left', weight: 0 }, 20));
        const b = posed(machine(undefined, 20));
        expect(Array.from(joint(a, 'LeftHand'))).toEqual(Array.from(joint(b, 'LeftHand')));
    });

    it('fades by its parameter', () => {
        const params: AnimationStateMachine['parameters'] = [{ name: 'Support', type: 'float', default: 0.5 }];
        const half = position(joint(posed(machine({ hand: 'left', weightParam: 'Support' }, 20, params)), 'LeftHand'));
        const none = position(joint(posed(machine(undefined, 20)), 'LeftHand'));
        const full = position(joint(posed(machine({ hand: 'left' }, 20)), 'LeftHand'));
        expect(vec3.distance(half, none)).toBeGreaterThan(0.1);
        expect(vec3.distance(half, full)).toBeGreaterThan(0.1);
        expect(vec3.distance(half, none) + vec3.distance(half, full)).toBeLessThan(vec3.distance(none, full) * 1.2);
    });

    it('stays finite when the target is out of reach', () => {
        const a = posed(machine({ hand: 'left' }, 170));
        for (const name of NAMES) expect(Array.from(joint(a, name)).every(Number.isFinite)).toBe(true);
    });

    it('reaches a socket instead, when it names one', () => {
        // Put the socket a little off where the hold has the support hand (so it is in reach); the socket list
        // is read on the skin's first socket query, which is this one.
        const at = vec3.add(vec3.create(), position(held), [0.5, -0.5, 0.25]);
        SKIN.sockets![0].offset = { t: Array.from(at) };
        const a = posed(machine({ hand: 'left', socket: 'Rifle Support' }, 20));
        const want = mat4.multiply(mat4.create(), joint(a, 'RightHand'), T(at[0], at[1], at[2]));
        expect(vec3.distance(position(joint(a, 'LeftHand')), position(want))).toBeLessThan(1e-3);
    });
});
