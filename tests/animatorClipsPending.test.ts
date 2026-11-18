import { describe, it, expect, vi, afterEach } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import { Logger } from '../src/core/logger';

// A model on SHARED clips (its skeleton's) is parsed with none: they are attached after it is built. Its machine
// is set first, so every state was entered with nothing to play. That logged a warning per state and layer ("has
// no animations", "plays LeanLeft, which this model does not have", "Animation "Idle" not found") on every load of
// the Sandbox, and worse, nothing re-entered the states once the clips came: the base stood in Idle playing
// nothing and the lean layers stayed empty until some transition fired. No clips at all is "not yet".

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
function clip(name: string, fromDeg: number, toDeg: number): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [...a, ...b];
    return {
        name,
        samplers: [{ input: [0, 1], output: out.slice(), interpolation: 'LINEAR' }, { input: [0, 1], output: out.slice(), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }, { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' }],
    } as Animation;
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

/** The Sandbox's shape: a base entry state, an additive lean layer, a layer playing a blend space. */
const machine = (): AnimationStateMachine => ({
    parameters: [{ name: 'Lean', type: 'float', default: 1 }, { name: 'X', type: 'float', default: 0 }],
    states: [state('Idle', 'Idle', { isEntry: true })],
    transitions: [],
    events: [],
    layers: [
        { name: 'Lean', blend: 'additive', weightParam: 'Lean', states: [state('Lean', 'Lean', { isEntry: true, loop: false })], transitions: [] },
        {
            name: 'Look', blend: 'additive', transitions: [], mask: { Spine: 1 },
            states: [state('Look', '', { isEntry: true, field: { mode: '1d', xAxis: { name: 'X', min: -1, max: 1 }, samples: [{ clipName: 'LookC', x: 0 }] }, fieldInputs: { x: 'X' } })],
        },
    ] as any,
});

function model(animations: Animation[]) {
    const node = { position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(), setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0 };
    const m = { skin: SKIN, animations } as unknown as AnimatedModel;
    return { m, animator: new Animator(m, node as any) };
}

/** Hips' local rotation about +Y, degrees. */
const hipsAngle = (a: Animator) => {
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), a.getJointModelMatrix(0)!));
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    return axis[1] < 0 ? -angle : angle;
};

afterEach(() => vi.restoreAllMocks());

describe('an Animator whose clips come after its machine', () => {
    it('says nothing while the model has no clips at all', () => {
        const warn = vi.spyOn(Logger, 'warn');
        const { animator } = model([]);
        animator.setStateMachine(machine());
        animator.checkTriggers();
        animator.update(1 / 60);
        expect(warn.mock.calls.map(c => String(c[0]))).toEqual([]);
    });

    it('enters its states again once they arrive: the base plays its clip and the layers add theirs', () => {
        const { m, animator } = model([]);
        animator.setStateMachine(machine());
        animator.setFloat('Lean', 1);
        for (let k = 0; k < 3; k++) { animator.checkTriggers(); animator.update(1 / 60); }
        // The skeleton's clips, attached afterwards (as attachSharedAnimations does, straight onto the list).
        m.animations.push(clip('Idle', 30, 30), clip('Lean', 0, 20), clip('LookC', 0, 0));
        animator.checkTriggers();
        animator.update(0.5);
        expect(animator.currentStateName).toBe('Idle');
        expect(animator.layerStateName('Lean')).toBe('Lean');
        // Idle's 30 plus half of the lean's 20 (its clip at 0.5 s), added: the layer is present.
        expect(hipsAngle(animator)).toBeCloseTo(40, 0);
        // The parameter set before the clips came is kept.
        expect(animator.getParam('Lean')).toBe(1);
    });

    it('still reports a clip the model really lacks, when it has others', () => {
        const warn = vi.spyOn(Logger, 'warn');
        const { animator } = model([clip('Idle', 0, 0)]);
        animator.setStateMachine(machine());
        animator.checkTriggers();
        animator.update(1 / 60);
        const said = warn.mock.calls.map(c => String(c[0]));
        expect(said.some(s => s.includes('"Lean"') && s.includes('which this model does not have'))).toBe(true);
        expect(said.some(s => s.includes('"LookC"'))).toBe(true);
    });
});
