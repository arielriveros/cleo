import { describe, it, expect } from 'vitest';
import { mat4, quat, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationState, AnimationStateMachine } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';

// Stop motion (AnimationState.fps): a stepped state SAMPLES its clips at a held frame, taken from the continuous
// clock on a beat of `fps` frames per second of game time. The clock itself -- events, exit time, root travel,
// cross-fade and blend weights -- stays continuous.
//
// One joint sliding along +X, so the pose reads as one number: the joint's model-space X.

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

const DT = 1 / 60;

/** The joint sliding from X 0 to `toX` over `duration` seconds. */
function slide(name: string, duration: number, toX = 1, extra: Partial<Animation> = {}): Animation {
    return {
        name,
        samplers: [{ input: [0, duration], output: [0, 0, 0, toX, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
        ...extra,
    };
}

/** The joint held at X = `x`. */
const hold = (name: string, x: number): Animation => ({
    name,
    samplers: [{ input: [0, 1], output: [x, 0, 0, x, 0, 0], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
});

const CLIPS: Animation[] = [
    slide('Slide', 1),
    slide('Slow', 2, 2),
    slide('Once', 0.95),
    slide('Marked', 1, 1, { events: [{ time: 0.06, name: 'step' }] }),
    hold('Hold', 5),
];

function makeAnimator(clips: Animation[] = CLIPS, node?: unknown): Animator {
    const a = new Animator({ skin: SKIN, animations: clips } as unknown as AnimatedModel, node as any);
    // The animator starts on its first clip; entering the machine's entry state must not cross-fade out of it.
    a.blendTime = 0;
    return a;
}

const state = (name: string, clipName: string, extra: Partial<AnimationState> = {}): AnimationState =>
    ({ name, clipName, loop: true, speed: 1, ...extra });

/** A → B on the `Go` flag. */
function machine(a: AnimationState, b?: AnimationState, blendTime = 0): AnimationStateMachine {
    return {
        parameters: [{ name: 'Go', type: 'bool', default: false }, { name: 'X', type: 'float', default: 0.5 }],
        states: [{ ...a, isEntry: true }, ...(b ? [b] : [])],
        transitions: b ? [{ from: a.name, to: b.name, conditions: [],
            condition: { op: 'and', children: [{ param: 'Go', op: 'true' }] }, blendTime }] : [],
        events: [],
    } as AnimationStateMachine;
}

const x = (a: Animator) => a.getJointModelMatrix(0)![12];
const frame = (a: Animator) => { a.checkTriggers(); a.update(DT); };
/** X after each of `n` frames. */
function run(a: Animator, n: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) { frame(a); out.push(x(a)); }
    return out;
}

describe('Animator — state frame rate (stop motion)', () => {
    it('holds each frame for 1/fps of a second, sampled from the clock at its beat', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('Walk', 'Slide', { fps: 12 })));
        const xs = run(a, 59);
        // 12 fps at 60 Hz: five frames per pose. Frame k shows the clip at the last beat, floor(k/5) * 5/60.
        xs.forEach((v, i) => {
            const k = i + 1;
            expect(v, `frame ${k}`).toBeCloseTo(Math.floor(k / 5) * 5 * DT, 6);
        });
    });

    it('plays smooth without one, as before', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('Walk', 'Slide')));
        run(a, 30).forEach((v, i) => expect(v, `frame ${i + 1}`).toBeCloseTo((i + 1) * DT, 6));
    });

    it('fires clip events on the continuous clock, not on the beat', () => {
        const a = makeAnimator();
        const fired: number[] = [];
        a.onAnimationEvent(() => fired.push(x(a)));
        a.setStateMachine(machine(state('Walk', 'Marked', { fps: 12 })));
        run(a, 3);
        expect(fired).toEqual([]);
        run(a, 1);   // 0.0667 s crosses the 0.06 s marker; the next frame of the pose is not until 0.0833 s
        expect(fired).toHaveLength(1);
        expect(fired[0]).toBe(0);
    });

    it('steps every clip of a blend space together', () => {
        const a = makeAnimator();
        const field: AnimationField = { mode: '1d', xAxis: { name: 'X', min: 0, max: 1 },
            samples: [{ clipName: 'Slide', x: 0 }, { clipName: 'Slow', x: 1 }] };
        a.setStateMachine(machine(state('Move', '', { field, fieldInputs: { x: 'X' }, fps: 12 })));
        const xs = run(a, 30);
        for (let i = 0; i < xs.length; i++) {
            const k = i + 1;
            if (k % 5 === 0) expect(xs[i], `frame ${k} takes a new frame`).not.toBeCloseTo(xs[i - 1], 6);
            else if (i > 0) expect(xs[i], `frame ${k} holds`).toBeCloseTo(xs[i - 1], 6);
        }
        expect(xs[29]).toBeGreaterThan(0);
    });

    it('keeps the outgoing clip stepping on the same beat while the cross-fade weight moves every frame', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('A', 'Slide', { fps: 12 }), state('B', 'Hold'), 0.5));
        run(a, 12);   // beats at frames 5 and 10: A shows 10/60
        a.setBool('Go', true);
        const xs = run(a, 12);
        expect(a.currentStateName).toBe('B');
        xs.forEach((v, i) => {
            const k = i + 1;
            const alpha = k * DT / 0.5;
            // The mix moves every frame...
            if (i > 0) expect(v, `blend frame ${k}`).not.toBeCloseTo(xs[i - 1], 6);
            // ...while A's own sample holds between beats, which carry on at global frames 15, 20, 25.
            const heldA = (v - 5 * alpha) / (1 - alpha);
            const global = 12 + k;
            expect(heldA, `blend frame ${k}`).toBeCloseTo(Math.floor(global / 5) * 5 * DT, 6);
        });
    });

    it('carries the beat into the next stepped state, which shows its first frame at once', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('A', 'Slide', { fps: 12 }), state('B', 'Slow', { fps: 12 })));
        run(a, 12);
        a.setBool('Go', true);
        const xs = run(a, 8);
        expect(a.currentStateName).toBe('B');
        // B starts at 0 and takes its next frame on A's beat (global frame 15 = 3 frames in), not 5 frames later.
        expect(xs[0]).toBeCloseTo(0, 6);
        expect(xs[1]).toBeCloseTo(0, 6);
        expect(xs[2]).toBeCloseTo(2 * (3 * DT) / 2, 6);   // Slow: 2 m over 2 s, 3 frames into B
        expect(xs[7]).toBeCloseTo(2 * (8 * DT) / 2, 6);   // the next beat, global frame 20
    });

    it('ends a clip that does not loop on its last key', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('Land', 'Once', { fps: 12, loop: false })));
        const xs = run(a, 80);
        expect(xs[79]).toBeCloseTo(1, 6);
        // 0.95 s is not a whole number of frames: the last beat before the end shows 0.9167 s, then the end.
        const shown = [...new Set(xs.map(v => v.toFixed(6)))];
        expect(shown[shown.length - 1]).toBe((1).toFixed(6));
        expect(Number(shown[shown.length - 2])).toBeCloseTo(55 * DT / 0.95, 6);
    });

    it('moves the character every frame with the clip\'s root motion while the pose holds', () => {
        const position = vec3.create();
        const quaternion = quat.create();
        const node = {
            position, quaternion, worldQuaternion: quaternion, worldPosition: position,
            setPosition(v: vec3) { vec3.copy(position, v); }, setQuaternion(q: quat) { quat.copy(quaternion, q); },
            setWorldPosition(v: vec3) { vec3.copy(position, v); }, setWorldQuaternion(q: quat) { quat.copy(quaternion, q); },
            parent: null, body: null, ownBody: null, currentSpeed: 0,
        };
        const a = makeAnimator([slide('Travel', 1, 1, { rootMotion: true })], node);
        a.setStateMachine(machine(state('Walk', 'Travel', { fps: 12 })));
        for (let k = 1; k <= 12; k++) {
            frame(a);
            expect(position[0], `frame ${k}`).toBeCloseTo(k * DT, 6);
        }
    });

    it('scrubs through the frames playback would show', () => {
        const a = makeAnimator();
        a.setStateMachine(machine(state('Walk', 'Slide', { fps: 12 })));
        a.seek(0.2);
        expect(x(a)).toBeCloseTo(2 / 12, 6);
        a.seek(0.26);
        expect(x(a)).toBeCloseTo(3 / 12, 6);
        a.seek(1);
        expect(x(a)).toBeCloseTo(1, 6);
    });

    it('takes an edited frame rate at once, through updateStateMachine', () => {
        const a = makeAnimator();
        const smooth = machine(state('Walk', 'Slide'));
        a.setStateMachine(smooth);
        run(a, 6);
        expect(a.updateStateMachine({ ...smooth, states: [{ ...smooth.states[0], fps: 12 }] })).toBe(true);
        const stepped = run(a, 5);
        // Held from the frame on the clock at the edit (6/60) until the first beat, five frames on.
        for (let i = 0; i < 4; i++) expect(stepped[i], `frame ${i + 1}`).toBeCloseTo(6 * DT, 6);
        expect(stepped[4]).toBeCloseTo(11 * DT, 6);
        // And back to smooth.
        expect(a.updateStateMachine(smooth)).toBe(true);
        run(a, 2).forEach((v, i) => expect(v).toBeCloseTo((12 + i) * DT, 6));
    });
});
