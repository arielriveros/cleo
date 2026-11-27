import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState, AnimationPose } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';

// `updateStateMachine`: an edited copy of the machine (an edited pose, a blend space's poses) swapped in WITHOUT
// restarting it, so the pose editor's drag shows on a character mid-stride: parameters, states and phases carry
// on. A machine of another shape falls back to `setStateMachine`.

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
const q4 = (deg: number) => { const q = qy(deg); return [q[0], q[1], q[2], q[3]]; };

function clip(name: string, fromDeg: number, toDeg: number, duration = 1): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
    return {
        name,
        samplers: [{ input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }, { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }, { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' }],
    } as Animation;
}

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: [clip('Walk', 0, 90, 2), clip('Idle', 0, 0)] } as unknown as AnimatedModel, node as any);
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });
const pose = (deg: number): AnimationPose => ({ name: 'Hold', bones: [{ name: 'Spine', rotation: q4(deg) }] });
const field = (deg: number): AnimationField => ({
    mode: '1d', xAxis: { name: 'X', min: 0, max: 1, smoothing: 0 }, weightSmoothing: 0,
    samples: [{ clipName: 'pose:p', x: 0, pose: pose(deg) }],
});

/** Walk on the base (both bones 0 -> 90 over 2 s), a pose on the Spine layer, a blend space of poses on another. */
function machine(holdDeg: number, fieldDeg: number, extra: Partial<AnimationStateMachine> = {}): AnimationStateMachine {
    return {
        parameters: [{ name: 'Speed', type: 'float', default: 0 }],
        states: [state('Walk', 'Walk', { isEntry: true })],
        transitions: [], events: [],
        layers: [
            { name: 'Hold', mask: { Spine: 1 }, states: [state('Hold', '', { isEntry: true, pose: pose(holdDeg) })], transitions: [] },
            { name: 'Lean', mask: { Spine: 1 }, weight: 0, states: [state('Lean', '', { isEntry: true, speed: 0, field: field(fieldDeg) })], transitions: [] },
        ],
        ...extra,
    };
}

function angle(a: Animator, joint: 0 | 1): number {
    const model = a.getJointModelMatrix(joint)!;
    const local = joint === 0 ? model : mat4.multiply(mat4.create(), mat4.invert(mat4.create(), a.getJointModelMatrix(0)!)!, model);
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
    const axis = vec3.create();
    const deg = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    return axis[1] < 0 ? -deg : deg;
}
const run = (a: Animator, seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };

describe('Animator.updateStateMachine', () => {
    it('shows an edited pose at once, keeping the states, their time and the parameters', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(20, 0));
        run(a, 1);
        a.setFloat('Speed', 3);
        const hipsBefore = angle(a, 0);
        expect(angle(a, 1)).toBeCloseTo(20, 2);
        expect(a.updateStateMachine(machine(35, 0))).toBe(true);
        expect(angle(a, 1)).toBeCloseTo(35, 2);              // no tick needed, no cross-fade
        expect(angle(a, 0)).toBeCloseTo(hipsBefore, 4);      // the walk did not restart
        expect(a.currentStateName).toBe('Walk');
        expect(a.getParam('Speed')).toBe(3);
        run(a, 0.5);
        expect(angle(a, 0)).toBeGreaterThan(hipsBefore);      // and carries on from there
        expect(angle(a, 1)).toBeCloseTo(35, 2);
    });

    it('shows an edited pose sample of a blend space at once', () => {
        const a = makeAnimator();
        const sm = machine(20, 10);
        sm.layers![1].weight = 1;
        a.setStateMachine(sm);
        run(a, 0.5);
        expect(angle(a, 1)).toBeCloseTo(10, 2);
        const next = machine(20, 40);
        next.layers![1].weight = 1;
        expect(a.updateStateMachine(next)).toBe(true);
        expect(angle(a, 1)).toBeCloseTo(40, 2);
    });

    it('takes a new layer weight and mask in place', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(20, 10));
        run(a, 0.5);
        const next = machine(20, 10);
        next.layers![0].weight = 0;
        expect(a.updateStateMachine(next)).toBe(true);
        expect(angle(a, 1)).not.toBeCloseTo(20, 1);           // the Hold layer is off: the walk shows
    });

    it('falls back to setStateMachine for another shape', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(20, 0));
        run(a, 1);
        const other = machine(20, 0, { states: [state('Idle', 'Idle', { isEntry: true })] });
        expect(a.updateStateMachine(other)).toBe(false);
        expect(a.currentStateName).toBe('Idle');
        const renamedParam = machine(20, 0, { parameters: [{ name: 'Pace', type: 'float', default: 0 }] });
        expect(a.updateStateMachine(renamedParam)).toBe(false);
    });

    it('re-poses a paused animator, which no tick would', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(20, 0));
        run(a, 0.2);
        a.pause();
        a.updateStateMachine(machine(-15, 0));
        expect(angle(a, 1)).toBeCloseTo(-15, 2);
    });

    it('reads back the final local of a bone (posedLocal)', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(25, 0));
        run(a, 0.2);
        const local = a.posedLocal(1)!;
        const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
        expect(Math.abs(quat.dot(q, qy(25)))).toBeCloseTo(1, 5);
        expect(a.posedLocal(99)).toBeNull();
    });
});

describe('Animator.updateStateMachine and reaction states', () => {
    it('re-enters when a state becomes (or stops being) a Ragdoll or Get Up state, or a Get Up its clips', () => {
        const a = makeAnimator();
        const base = machine(10, 0);
        a.setStateMachine(base);
        const withKind = (patch: Partial<AnimationState>) => ({ ...base, states: [{ ...base.states[0], ...patch }] });
        expect(a.updateStateMachine(withKind({ reactions: { react: 'none' } }))).toBe(true);
        expect(a.updateStateMachine(withKind({ ragdoll: { start: 'fall' } }))).toBe(false);
        expect(a.updateStateMachine(withKind({ ragdoll: { start: 'trip' } }))).toBe(true);
        expect(a.updateStateMachine(withKind({ ragdoll: undefined, getUp: { faceUp: 'Walk' } }))).toBe(false);
        expect(a.updateStateMachine(withKind({ getUp: { faceUp: 'Idle' } }))).toBe(false);
    });

    it("carries a layer's Plays over reactions in place", () => {
        const a = makeAnimator();
        const base = machine(10, 0);
        a.setStateMachine(base);
        const layers = base.layers!.map((l, i) => i === 0 ? { ...l, overReactions: true } : l);
        expect(a.updateStateMachine({ ...base, layers })).toBe(true);
        expect(((a as any)._overlays as any[])[0].overReactions).toBe(true);
    });
});
