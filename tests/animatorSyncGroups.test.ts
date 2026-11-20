import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';
import type { AnimationState, AnimationStateMachine } from '../src/animation/animator';

// Sync groups (AnimationState.syncGroup): a transition between two states of one group carries the stride. The
// report it answers: the Sandbox's stair climb had to blend smoothly out of and into the walk, but every blend
// space started its cycle at phase 0, so a hand-over in mid-stride swapped the legs under the cross-fade. A state
// in a sync group starts where the one it leaves was, and the two advance as one through the blend.

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

/** A single bone sliding along +X over `duration` seconds. */
function clip(name: string, duration: number): Animation {
    return {
        name,
        samplers: [{ input: [0, duration], output: [0, 0, 0, 1, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

const DT = 1 / 60;
/** walk cycles in 1 s, stairs in 2: different lengths, which is what a shared phase is for. */
const WALK = 1, STAIRS = 2;

const field = (clipName: string): AnimationField => ({ mode: '1d', xAxis: { name: 'X', min: 0, max: 1 }, samples: [{ clipName, x: 0 }] });

function makeAnimator(): Animator {
    const model = { skin: SKIN, animations: [clip('walk', WALK), clip('stairs', STAIRS), clip('walkClip', WALK)] } as unknown as AnimatedModel;
    return new Animator(model);
}

function step(a: Animator, seconds: number) {
    for (let t = 0; t < seconds - 1e-9; t += DT) { a.checkTriggers(); a.update(DT); }
}

/** Walk <-> Stairs on the `Go` flag, both blend spaces, in `walkGroup` / `stairsGroup`. */
function machine(walkGroup?: string, stairsGroup?: string, walk: Partial<AnimationState> = {}): AnimationStateMachine {
    return {
        parameters: [{ name: 'Go', type: 'bool', default: false }],
        states: [
            { name: 'Walk', clipName: '', field: field('walk'), loop: true, speed: 1, isEntry: true, ...(walkGroup ? { syncGroup: walkGroup } : {}), ...walk },
            { name: 'Stairs', clipName: '', field: field('stairs'), loop: true, speed: 1, ...(stairsGroup ? { syncGroup: stairsGroup } : {}) },
        ],
        transitions: [
            { from: 'Walk', to: 'Stairs', conditions: [], condition: { op: 'and', children: [{ param: 'Go', op: 'true' }] }, blendTime: 0.4 },
            { from: 'Stairs', to: 'Walk', conditions: [], condition: { op: 'and', children: [{ param: 'Go', op: 'false' }] }, blendTime: 0.4 },
        ],
        events: [],
    } as AnimationStateMachine;
}

describe('Animator — sync groups', () => {
    it('starts the state it enters at the phase the one it left was at', () => {
        const a = makeAnimator();
        a.setStateMachine(machine('Gait', 'Gait'));
        step(a, 0.3);
        const before = a.fieldDebug.phase;
        expect(before).toBeGreaterThan(0.25);
        a.setBool('Go', true);
        a.checkTriggers();
        expect(a.currentStateName).toBe('Stairs');
        // Entered at the walk's phase, not 0.
        expect(a.fieldDebug.phase).toBeCloseTo(before, 6);
        expect(a.fieldDebug.synced).toBe(true);
    });

    it('moves both sides on one phase through the cross-fade, at the mixed cycle\'s rate', () => {
        const a = makeAnimator();
        a.setStateMachine(machine('Gait', 'Gait'));
        step(a, 0.3);
        a.setBool('Go', true);
        a.checkTriggers();
        let alpha = 0;
        for (let k = 0; k < 20; k++) {
            const p0 = a.fieldDebug.phase;
            a.update(DT);
            const d = a.fieldDebug;
            expect(d.previousPhase, `frame ${k}`).toBeCloseTo(d.phase, 9);
            // The cycle the blend shows: the walk's second mixed into the stairs' two by the blend's progress.
            alpha = Math.min(1, (k + 1) * DT / 0.4);
            const cycle = WALK + (STAIRS - WALK) * alpha;
            expect((d.phase - p0 + 1) % 1, `frame ${k} advance`).toBeCloseTo(DT / cycle, 6);
        }
        // Done blending: the stairs' own rate.
        step(a, 0.4);
        expect(a.fieldDebug.synced).toBe(false);
        expect(a.fieldDebug.previousPhase).toBeNull();
        const p0 = a.fieldDebug.phase;
        a.update(DT);
        expect((a.fieldDebug.phase - p0 + 1) % 1).toBeCloseTo(DT / STAIRS, 6);
    });

    it('starts at phase 0 outside a group, or between two groups', () => {
        for (const [walkGroup, stairsGroup] of [[undefined, undefined], ['Gait', undefined], ['Gait', 'Climb']] as const) {
            const a = makeAnimator();
            a.setStateMachine(machine(walkGroup, stairsGroup));
            step(a, 0.3);
            a.setBool('Go', true);
            a.checkTriggers();
            expect(a.currentStateName).toBe('Stairs');
            expect(a.fieldDebug.phase, `${walkGroup} -> ${stairsGroup}`).toBe(0);
            expect(a.fieldDebug.synced).toBe(false);
            // The outgoing side runs on its own clock, as before.
            a.update(DT);
            expect(a.fieldDebug.previousPhase).not.toBeCloseTo(a.fieldDebug.phase, 3);
        }
    });

    it('carries a looping clip\'s time into a blend space of the group', () => {
        const a = makeAnimator();
        a.setStateMachine(machine('Gait', 'Gait', { field: undefined, clipName: 'walkClip' }));
        step(a, 0.45);
        a.setBool('Go', true);
        a.checkTriggers();
        expect(a.currentStateName).toBe('Stairs');
        expect(a.fieldDebug.phase).toBeCloseTo(0.45, 1);
        expect(a.fieldDebug.phase).toBeGreaterThan(0.4);
    });

    it('carries the phase into a looping clip of the group', () => {
        const a = makeAnimator();
        const sm = machine('Gait', 'Gait');
        sm.states[1] = { ...sm.states[1], field: undefined, clipName: 'stairs' };
        a.setStateMachine(sm);
        step(a, 0.3);
        const before = a.fieldDebug.phase;
        a.setBool('Go', true);
        a.checkTriggers();
        expect(a.currentStateName).toBe('Stairs');
        // The clip joins at the walk's phase through its own length.
        expect(a.currentTime).toBeCloseTo(before * STAIRS, 6);
    });

    it('carries the live phase back out of an interrupted synced blend, from the frozen pose', () => {
        const a = makeAnimator();
        a.setStateMachine(machine('Gait', 'Gait'));
        step(a, 0.3);
        a.setBool('Go', true);
        step(a, 0.1);
        expect(a.isBlending).toBe(true);
        const stairsPhase = a.fieldDebug.phase;
        a.setBool('Go', false);
        a.checkTriggers();
        expect(a.currentStateName).toBe('Walk');
        expect(a.fieldDebug.phase).toBeCloseTo(stairsPhase, 6);
        // Out of the pose that was on screen, frozen: nothing to keep in step.
        expect(a.fieldDebug.synced).toBe(false);
    });
});

// A LAYER state in the base's sync group follows the base's phase every frame: the Sandbox's weapon layers hold
// the upper body over the legs' stride, and each layer clip is built against the stride frame it plays with.
describe('Animator — a layer following the base\'s sync group', () => {
    /** The base machine above, plus one override layer `Upper` playing `layerClip` (a 2 s cycle by default). */
    function layered(walkGroup: string | undefined, stairsGroup: string | undefined, layerState: Partial<AnimationState> = {}): Animator {
        const a = makeAnimator();
        const sm = machine(walkGroup, stairsGroup);
        sm.layers = [{
            name: 'Upper',
            states: [{ name: 'Hold', clipName: '', field: field('stairs'), loop: true, speed: 1, isEntry: true, syncGroup: 'Gait', ...layerState }],
            transitions: [],
        }];
        a.setStateMachine(sm);
        return a;
    }
    /** The one bone's x, as posed with the layer over the base: the layer's clip, since it overrides it whole. */
    const x = (a: Animator) => a.getJointModelMatrix(0)![12];

    it('takes the base\'s phase, through a clip of another length', () => {
        const a = layered('Gait', 'Gait');
        for (let k = 0; k < 90; k++) {
            a.checkTriggers();
            a.update(DT);
            expect(a.layerPhase('Upper'), `frame ${k}`).toBeCloseTo(a.fieldDebug.phase, 9);
        }
        // The layer's 2 s clip shows the base's phase, not its own clock (1.5 s in, its own phase would be 0.75).
        expect(x(a)).toBeCloseTo(a.fieldDebug.phase, 6);
    });

    it('follows the shared phase through a synced cross-fade of the base', () => {
        const a = layered('Gait', 'Gait');
        step(a, 0.3);
        a.setBool('Go', true);
        for (let k = 0; k < 30; k++) {
            a.checkTriggers();
            a.update(DT);
            expect(a.layerPhase('Upper'), `frame ${k}`).toBeCloseTo(a.fieldDebug.phase, 9);
        }
    });

    it('runs at its own rate while the base is outside the group', () => {
        const a = layered(undefined, undefined);
        step(a, 0.5);
        const p0 = a.layerPhase('Upper')!;
        a.update(DT);
        // Its own 2 s cycle, not the base's 1 s one.
        expect((a.layerPhase('Upper')! - p0 + 1) % 1).toBeCloseTo(DT / STAIRS, 6);
        expect(a.layerPhase('Upper')).not.toBeCloseTo(a.fieldDebug.phase, 2);
    });

    it('cross-fades back onto the base\'s phase instead of jumping when the base re-enters the group', () => {
        // Stairs is outside the group: the base leaves it, the layer runs free, the base comes back at phase 0.
        const a = layered('Gait', undefined);
        step(a, 0.3);
        a.setBool('Go', true);
        step(a, 0.7);
        expect(a.currentStateName).toBe('Stairs');
        const apart = Math.abs(a.layerPhase('Upper')! - 0);
        expect(Math.min(apart, 1 - apart)).toBeGreaterThan(0.1);
        a.setBool('Go', false);
        let worst = 0, last = x(a);
        for (let k = 0; k < 30; k++) {
            a.checkTriggers();
            a.update(DT);
            worst = Math.max(worst, Math.abs(x(a) - last));
            last = x(a);
        }
        expect(a.currentStateName).toBe('Walk');
        // On the base's phase again...
        expect(a.layerPhase('Upper')).toBeCloseTo(a.fieldDebug.phase, 9);
        // ...without a jump: the clip moves 1/120 a frame at its own rate, the fade a few times that.
        expect(worst).toBeLessThan(0.06);
    });

    it('leaves a held layer state outside any group where it is held', () => {
        const a = layered('Gait', 'Gait', { syncGroup: undefined, speed: 0, field: { ...field('stairs'), samples: [{ clipName: 'stairs', x: 0, phaseOffset: 0.5 }] } });
        step(a, 1);
        expect(a.layerPhase('Upper')).toBe(0);
        expect(x(a)).toBeCloseTo(0.5, 6);
    });
});
