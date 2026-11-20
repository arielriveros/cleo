import { describe, it, expect, vi } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationStateMachine, AnimationState, AnimationPose } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import { poseSampleKey, type AnimationField, type AnimationFieldSample } from '../src/animation/animationField';
import { Logger } from '../src/core/logger';

// Poses as blend-space samples (`AnimationFieldSample.pose`). A pose is held, so it has no cycle: a field of
// poses blends them by weight; mixed with a clip, the clip alone sets the cycle. On an additive layer a field
// of a pose's VARIANTS adds what each changes from its base (`AnimationPose.reference`): that is an aim offset
// built from one aim pose, where editing the pose moves every direction.
//
// The rig is a two-bone chain, Hips (node 0) -> Spine (node 1), both at rest identity; everything turns about +Y.

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

/** A clip turning both bones from `fromDeg` to `toDeg` over `duration` seconds. */
function clip(name: string, fromDeg: number, toDeg: number, duration = 1): Animation {
    const a = qy(fromDeg), b = qy(toDeg);
    const out = [a[0], a[1], a[2], a[3], b[0], b[1], b[2], b[3]];
    return {
        name,
        samplers: [{ input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }, { input: [0, duration], output: out.slice(), interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'rotation' }, { samplerIndex: 1, targetNodeIndex: 1, targetPath: 'rotation' }],
    } as Animation;
}

const CLIPS: Animation[] = [clip('Base', 30, 30), clip('Walk', 0, 0, 2)];

function makeAnimator(): Animator {
    const node = {
        position: vec3.create(), quaternion: quat.create(), worldQuaternion: quat.create(),
        setPosition() {}, setQuaternion() {}, parent: null, body: null, currentSpeed: 0,
    };
    return new Animator({ skin: SKIN, animations: CLIPS } as unknown as AnimatedModel, node as any);
}

const pose = (name: string, spineDeg: number, reference?: number): AnimationPose => ({
    name, bones: [{ name: 'Spine', rotation: q4(spineDeg) }],
    ...(reference !== undefined ? { reference: [{ name: 'Spine', rotation: q4(reference) }] } : {}),
});
const poseSample = (id: string, x: number, p: AnimationPose): AnimationFieldSample => ({ clipName: poseSampleKey(id), x, pose: p });

const field = (samples: AnimationFieldSample[]): AnimationField => ({
    mode: '1d', xAxis: { name: 'X', min: 0, max: 1, smoothing: 0 }, weightSmoothing: 0, samples,
});

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

function machine(f: AnimationField, layer?: { blend: 'additive' | 'override' }): AnimationStateMachine {
    const fieldState = state('Field', '', { isEntry: true, field: f, fieldInputs: { x: 'X' } });
    return {
        parameters: [{ name: 'X', type: 'float', default: 0 }],
        states: layer ? [state('Base', 'Base', { isEntry: true })] : [fieldState],
        transitions: [], events: [],
        ...(layer ? { layers: [{ name: 'Aim', blend: layer.blend, states: [fieldState], transitions: [] }] } : {}),
    };
}

/** The Spine's local rotation about +Y, in degrees. */
function spineAngle(a: Animator): number {
    const local = mat4.multiply(mat4.create(), mat4.invert(mat4.create(), a.getJointModelMatrix(0)!)!, a.getJointModelMatrix(1)!);
    const q = quat.normalize(quat.create(), mat4.getRotation(quat.create(), local));
    const axis = vec3.create();
    const angle = quat.getAxisAngle(axis, q) * 180 / Math.PI;
    return axis[1] < 0 ? -angle : angle;
}
const frame = (a: Animator, dt = 1 / 60) => { a.checkTriggers(); a.update(dt); };
/** Long enough for the entry's cross-fade and any probe to settle. */
const settle = (a: Animator) => { for (let i = 0; i < 60; i++) frame(a); };

describe('Animator: poses in blend spaces', () => {
    it('blends two poses by weight', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(field([poseSample('a', 0, pose('A', 0)), poseSample('b', 1, pose('B', 60))])));
        a.setFloat('X', 0.5);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(30, 3);
        a.setFloat('X', 1);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(60, 3);
    });

    it('takes its cycle from the clips alone: a pose has none', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(field([{ clipName: 'Walk', x: 0 }, poseSample('b', 1, pose('B', 60))])));
        a.setFloat('X', 0.5);
        frame(a);
        expect(a.fieldDebug.duration).toBeCloseTo(2, 6);   // the Walk's 2 s, not halved by the pose
        const b = makeAnimator();
        b.setStateMachine(machine(field([poseSample('a', 0, pose('A', 0)), poseSample('b', 1, pose('B', 60))])));
        settle(b);
        expect(b.fieldDebug.duration).toBe(1);
    });

    it('says nothing of a missing clip for a pose sample', () => {
        const warn = vi.spyOn(Logger, 'warn');
        const a = makeAnimator();
        a.setStateMachine(machine(field([poseSample('a', 0, pose('A', 10)), poseSample('b', 1, pose('B', 20))])));
        frame(a);
        expect(warn.mock.calls.some(c => String(c[0]).includes('pose:'))).toBe(false);
        warn.mockRestore();
    });

    it('keeps posing a pose sample that fades out after its sample left the field', () => {
        const a = makeAnimator();
        const f = field([poseSample('a', 0, pose('A', 0)), poseSample('b', 1, pose('B', 60))]);
        f.weightSmoothing = 0.2;
        a.setStateMachine(machine(f));
        a.setFloat('X', 1);
        for (let i = 0; i < 60; i++) settle(a);
        expect(spineAngle(a)).toBeCloseTo(60, 1);
        // B leaves the field: it fades out over the weight smoothing instead of snapping to A.
        a.updateField({ ...f, samples: [f.samples[0]] });
        frame(a);
        const mid = spineAngle(a);
        expect(mid).toBeGreaterThan(5);
        expect(mid).toBeLessThan(60);
    });

    it('shows a new pose object as soon as the field is swapped (an edited pose)', () => {
        const a = makeAnimator();
        const f = field([poseSample('a', 0, pose('A', 10))]);
        a.setStateMachine(machine(f));
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(10, 3);
        a.updateField(field([poseSample('a', 0, pose('A', 35))]));
        expect(spineAngle(a)).toBeCloseTo(35, 3);
    });

    it('on an additive layer, adds only what each variant changes from its base', () => {
        const a = makeAnimator();
        // The base pose is at 20; the variants at 20 (centre) and 80 (60 more). Beneath: the base clip's 30.
        a.setStateMachine(machine(field([poseSample('c', 0, pose('C', 20, 20)), poseSample('r', 1, pose('R', 80, 20))]), { blend: 'additive' }));
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(30, 3);   // the centre adds nothing
        a.setFloat('X', 1);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(90, 3);
        a.setFloat('X', 0.5);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(60, 3);   // half of the 60
    });

    it('reads a pose sample from the field’s pose table: a variant there as what it changes from its base', () => {
        const a = makeAnimator();
        const f = field([{ clipName: 'pose:c', x: 0 }, { clipName: 'pose:r', x: 1 }]);
        // The base at 20; the variant 60 more, stored as just that, naming the base's key.
        f.poses = { 'pose:c': pose('C', 20), 'pose:r': { name: 'R', bones: [{ name: 'Spine', rotation: q4(60) }], base: 'pose:c' } };
        a.setStateMachine(machine(f, { blend: 'additive' }));
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(50, 3);   // the base itself, no base of its own: its 20 from rest over the 30
        a.setFloat('X', 1);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(90, 3);   // the variant: what it changes from its base, 60, over the 30
        const b = makeAnimator();
        b.setStateMachine(machine(f, { blend: 'override' }));
        b.setFloat('X', 1);
        settle(b);
        expect(spineAngle(b)).toBeCloseTo(80, 3);   // held: composed onto its base
    });

    it('as an override layer, holds the poses themselves', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(field([poseSample('c', 0, pose('C', 20, 20)), poseSample('r', 1, pose('R', 80, 20))]), { blend: 'override' }));
        a.setFloat('X', 1);
        settle(a);
        expect(spineAngle(a)).toBeCloseTo(80, 3);
    });
});
