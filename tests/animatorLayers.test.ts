import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// Controller layers, bone masks, pose states, action slots and clip-owned events.
//
// The rig is a two-bone chain, Hips (node 0) -> Spine (node 1), both at rest identity. Every clip rotates
// about +Y, so each bone's pose reads as one signed angle — and a mask that leaks shows up as the wrong
// bone moving.

const SKIN: Skin = {
    joints: [
        { nodeIndex: 0, inverseBindMatrix: mat4.create() },
        { nodeIndex: 1, inverseBindMatrix: mat4.create(), parentIndex: 0 },
    ],
    nodeParents: new Map([[1, 0]]),
    nodeTransforms: new Map([[0, mat4.create()], [1, mat4.create()]]),
    nodeNames: new Map([[0, 'Hips'], [1, 'Spine']]),
};

const qy = (deg: number) => quat.setAxisAngle(quat.create(), [0, 1, 0], deg * Math.PI / 180);

/** A clip turning BOTH bones from `fromDeg` to `toDeg` over `duration` seconds. */
function clip(name: string, fromDeg: number, toDeg: number, duration = 1, events?: Animation['events']): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
    return {
        name,
        samplers: [
            { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' },
            { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' },
        ],
        channels: [
            { samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' },
            { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' },
        ],
        ...(events ? { events } : {}),
    } as Animation;
}

const CLIPS: Animation[] = [
    clip('Base', 30, 30),          // both bones held at +30
    clip('Hold', -40, -40),        // both bones held at -40
    clip('Nod', 0, 60),            // 0 -> 60 over a second: an ADDITIVE source, referenced to its first frame
    clip('Swing', 10, 10, 0.5, [{ time: 0.25, name: 'hit' }]),
];

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, node as any);
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

function machine(over: Partial<AnimationStateMachine> = {}): AnimationStateMachine {
    return {
        parameters: [{ name: 'Aim', type: 'float', default: 1 }],
        states: [state('Base', 'Base', { isEntry: true })],
        transitions: [],
        events: [],
        ...over,
    };
}

/** A bone's LOCAL rotation about +Y in degrees, read from the posed model-space joints. */
function localAngle(a: Animator, joint: 0 | 1): number {
    const model = a.getJointModelMatrix(joint)!;
    const local = joint === 0
        ? model
        : mat4.multiply(mat4.create(), mat4.invert(mat4.create(), a.getJointModelMatrix(0)!)!, model);
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    return axis[1] < 0 ? -angle : angle;
}

const frame = (a: Animator, dt = 1 / 60) => { a.checkTriggers(); a.update(dt); };

describe('Animator — layers', () => {
    it('plays a machine with no layers exactly as before', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
        expect(a.layerNames).toEqual([]);
    });

    it('overrides only the masked bones', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], mask: { Spine: 1 } }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips: not in the mask, still the base
        expect(localAngle(a, 1)).toBeCloseTo(-40, 3);  // Spine: the layer
        expect(a.layerStateName('Upper')).toBe('Hold');
    });

    it('mixes by weight, and reads it from a parameter when one is named', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            parameters: [{ name: 'Aim', type: 'float', default: 0.5 }],
            layers: [{ name: 'Upper', states: [state('Hold', 'Hold', { isEntry: true })], transitions: [], weightParam: 'Aim' }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(-5, 2);   // halfway between +30 and -40
        a.setFloat('Aim', 0);
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);
    });

    it('adds an additive layer relative to its clip’s first frame', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            layers: [{ name: 'Breathe', blend: 'additive', states: [state('Nod', 'Nod', { isEntry: true })], transitions: [] }],
        }));
        frame(a, 0);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // the first frame IS the reference: nothing added
        frame(a, 0.5);
        expect(localAngle(a, 0)).toBeCloseTo(60, 2);   // +30 base, +30 of nod added on top
    });

    it('contributes nothing from an empty state, and fades in when it leaves it', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({
            parameters: [{ name: 'Armed', type: 'bool', default: false }],
            layers: [{
                name: 'Upper',
                states: [state('Empty', '', { isEntry: true }), state('Hold', 'Hold')],
                transitions: [{ from: 'Empty', to: 'Hold', conditions: [{ param: 'Armed', op: 'true' }], blendTime: 0.2 }],
            }],
        }));
        frame(a);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
        a.setBool('Armed', true);
        frame(a, 0.1);
        const mid = localAngle(a, 1);
        expect(mid).toBeLessThan(30);
        expect(mid).toBeGreaterThan(-40);              // part-way through the fade
        for (let i = 0; i < 10; i++) frame(a, 0.05);
        expect(localAngle(a, 1)).toBeCloseTo(-40, 2);
    });
});

describe('Animator — pose states', () => {
    it('holds a pose — delta x rest — on just the bones it lists', () => {
        const a = makeAnimator();
        const d = qy(25);
        a.setStateMachine(machine({
            layers: [{
                name: 'Grip',
                states: [state('Grip', '', { isEntry: true, pose: { name: 'Grip', bones: [{ name: 'Spine', rotation: [d[0], d[1], d[2], d[3]] }] } })],
                transitions: [],
            }],
        }));
        frame(a);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips not in the pose: the base shows through
        expect(localAngle(a, 1)).toBeCloseTo(25, 3);   // Spine: rest (identity) x 25
    });
});

describe('Animator — actions', () => {
    it('fades an action in over the base, then out again on its own', async () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        frame(a);
        const handle = a.playAction('Swing', { blendIn: 0.1, blendOut: 0.1 });
        frame(a, 0.05);
        const fadingIn = localAngle(a, 0);
        expect(fadingIn).toBeLessThan(30);
        expect(fadingIn).toBeGreaterThan(10);
        frame(a, 0.1);
        expect(localAngle(a, 0)).toBeCloseTo(10, 2);   // fully in
        expect(a.isActionPlaying()).toBe(true);
        for (let i = 0; i < 20; i++) frame(a, 0.05);
        expect(handle.done).toBe(true);
        await handle.finished;
        expect(a.isActionPlaying()).toBe(false);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // back on the base
    });

    it('stops on request, and keeps the legs through a masked slot', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ slots: [{ name: 'UpperBody', mask: { Spine: 1 } }] }));
        frame(a);
        const handle = a.playAction('Hold', { loop: true, blendIn: 0.01 });
        frame(a, 0.05);
        expect(localAngle(a, 0)).toBeCloseTo(30, 3);   // Hips: outside the slot's mask
        expect(localAngle(a, 1)).toBeCloseTo(-40, 3);
        handle.stop(0.05);
        for (let i = 0; i < 3; i++) frame(a, 0.05);
        expect(handle.done).toBe(true);
        expect(localAngle(a, 1)).toBeCloseTo(30, 3);
    });

    it('resolves at once for a clip that does not exist', async () => {
        const a = makeAnimator();
        const handle = a.playAction('Nope');
        expect(handle.done).toBe(true);
        await handle.finished;
    });
});

describe('Animator — clip-owned events', () => {
    it('fires a clip’s own marker from an action slot', () => {
        const a = makeAnimator();
        a.setStateMachine(machine());
        const fired: string[] = [];
        a.onAnimationEvent(name => fired.push(name));
        frame(a);
        a.playAction('Swing');
        frame(a, 0.2);
        expect(fired).toEqual([]);
        frame(a, 0.1);                                 // crosses t = 0.25
        expect(fired).toEqual(['hit']);
    });

    it('fires a clip’s own marker from the base state too', () => {
        const a = makeAnimator();
        a.setStateMachine(machine({ states: [state('Swing', 'Swing', { isEntry: true })] }));
        const fired: string[] = [];
        a.onAnimationEvent(name => fired.push(name));
        frame(a, 0.2);
        frame(a, 0.1);
        expect(fired).toEqual(['hit']);
    });
});
