import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import type { AnimationField } from '../src/animation/animationField';
import type { AnimationParameter, AnimationState, AnimationStateMachine, AnimationTransition } from '../src/animation/animator';

// A cross-fade interrupted by another one fades out of the pose ON SCREEN. It used to fade out of the
// interrupted blend's target alone, so whatever that blend was still fading out of vanished in one frame: a
// run-to-stop cut dead when a turn-in-place fired during its blend into idle.

/** A clip holding one bone at x = `x`. */
function holdClip(name: string, x: number, duration = 1): Animation {
    return {
        name,
        samplers: [{ input: [0, duration], output: [x, 0, 0, x, 0, 0], interpolation: 'LINEAR' }],
        channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
    };
}

const SKIN: Skin = {
    joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }],
    nodeTransforms: new Map([[0, mat4.create()]]),
};

function makeAnimator(): Animator {
    const animations = [holdClip('A', 0), holdClip('B', 10), holdClip('C', 20), holdClip('D', 30)];
    const a = new Animator({ skin: SKIN, animations } as unknown as AnimatedModel);
    a.blendTime = 1;
    return a;
}

function boneX(animator: Animator): number {
    return mat4.getTranslation(vec3.create(), animator.getFinalBoneMatrices()[0])[0];
}

describe('Animator — an interrupted cross-fade', () => {
    it('blends exactly as before when nothing interrupts it', () => {
        const a = makeAnimator();
        a.playAnimationByName('A', true, false);
        a.play();
        a.update(0.01);
        a.playAnimationByName('B');
        a.update(0.5);
        expect(boneX(a)).toBeCloseTo(5, 5);
        a.update(0.6);
        expect(boneX(a)).toBeCloseTo(10, 5);
        expect(a.isBlending).toBe(false);
    });

    it('starts the new blend from the pose on screen, not from the interrupted blend’s target', () => {
        const a = makeAnimator();
        a.playAnimationByName('A', true, false);
        a.play();
        a.update(0.01);
        a.playAnimationByName('B');
        a.update(0.3);
        const onScreen = boneX(a);
        expect(onScreen).toBeCloseTo(3, 5);

        a.playAnimationByName('C');
        a.update(1e-4);
        // Before the fix this jumped to B's 10.
        expect(Math.abs(boneX(a) - onScreen)).toBeLessThan(0.01);
        a.update(0.5);
        expect(boneX(a)).toBeCloseTo(onScreen + (20 - onScreen) * 0.5, 2);
        a.update(0.6);
        expect(boneX(a)).toBeCloseTo(20, 5);
        expect(a.isBlending).toBe(false);
    });

    it('survives being interrupted twice in a row', () => {
        const a = makeAnimator();
        a.playAnimationByName('A', true, false);
        a.play();
        a.update(0.01);
        a.playAnimationByName('B');
        a.update(0.5);               // 5
        a.playAnimationByName('C');
        a.update(0.5);               // 5 + (20 - 5) / 2 = 12.5
        const onScreen = boneX(a);
        expect(onScreen).toBeCloseTo(12.5, 2);
        a.playAnimationByName('D');
        a.update(1e-4);
        expect(Math.abs(boneX(a) - onScreen)).toBeLessThan(0.01);
    });

    it('freezes a field mid-blend the same way, inside a state machine', () => {
        const a = makeAnimator();
        const field: AnimationField = {
            mode: '1d',
            xAxis: { name: 'Speed', min: 0, max: 1 },
            samples: [{ clipName: 'B', x: 0 }, { clipName: 'C', x: 1 }],
        };
        const go = (value: number) => ({ op: 'and' as const, children: [{ param: 'Go', op: 'eq' as const, value }] });
        const machine = {
            parameters: [
                { name: 'Go', type: 'int', default: 0 },
                { name: 'Speed', type: 'float', default: 0.5 },
            ] as AnimationParameter[],
            states: [
                { name: 'Idle', clipName: 'A', loop: true, speed: 1, isEntry: true },
                { name: 'Move', clipName: '', loop: true, speed: 1, field, fieldInputs: { x: 'Speed' } },
                { name: 'Turn', clipName: 'D', loop: true, speed: 1 },
            ] as AnimationState[],
            transitions: [
                { from: 'Idle', to: 'Move', conditions: [], condition: go(1), blendTime: 1 },
                { from: 'Move', to: 'Turn', conditions: [], condition: go(2), blendTime: 1 },
            ] as AnimationTransition[],
            events: [],
        } as AnimationStateMachine;
        a.setStateMachine(machine);
        a.play();
        const step = (seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += 1 / 60) { a.checkTriggers(); a.update(1 / 60); } };
        step(0.1);
        a.setFloat('Go', 1);
        step(0.4);                   // the field poses 15: about 0.4 of the way there
        const onScreen = boneX(a);
        expect(onScreen).toBeGreaterThan(4);
        expect(onScreen).toBeLessThan(8);
        a.setFloat('Go', 2);
        a.checkTriggers();
        a.update(1e-4);
        expect(Math.abs(boneX(a) - onScreen)).toBeLessThan(0.05);
        step(1.1);
        expect(boneX(a)).toBeCloseTo(30, 5);
    });
});
