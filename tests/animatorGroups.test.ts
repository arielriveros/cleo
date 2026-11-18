import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationState, AnimationStateMachine, AnimationTransition } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';

// State groups: several states under one name. A transition FROM a group fires from whichever of its states plays,
// after that state's own transitions; a transition TO a group enters its entry state.

const SKIN: Skin = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) };
const clip = (name: string): Animation => ({
    name,
    samplers: [{ input: [0, 1], output: [0, 0, 0, 0, 0, 0], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
});
const when = (param: string) => ({ op: 'and' as const, children: [{ param, op: 'true' as const }] });
const edge = (from: string, to: string, param: string): AnimationTransition => ({ from, to, conditions: [], condition: when(param), blendTime: 0 });

function machine(transitions: AnimationTransition[], entry = 'B'): AnimationStateMachine {
    const state = (name: string, isEntry = false): AnimationState => ({ name, clipName: name, loop: true, speed: 1, isEntry } as AnimationState);
    return {
        parameters: ['toA', 'toB', 'go', 'back', 'own'].map(name => ({ name, type: 'bool', default: false })) as any,
        states: [state('A', true), state('B'), state('C'), state('D')],
        transitions,
        groups: [{ name: 'Moving', states: ['A', 'B'], entry }],
        events: [],
    };
}

function animatorFor(sm: AnimationStateMachine) {
    const a = new Animator({ skin: SKIN, animations: ['A', 'B', 'C', 'D'].map(clip) } as unknown as AnimatedModel);
    a.setStateMachine(sm);
    a.play();
    const step = () => { a.checkTriggers(); a.update(1 / 60); };
    step();
    return { a, step };
}

describe('Animator: state groups', () => {
    it('fires a transition from the group out of whichever of its states plays', () => {
        for (const start of ['A', 'B']) {
            const { a, step } = animatorFor(machine([edge('A', 'B', 'toB'), edge('Moving', 'C', 'go')]));
            if (start === 'B') { a.setBool('toB', true); step(); a.setBool('toB', false); }
            expect(a.currentStateName).toBe(start);
            a.setBool('go', true);
            step();
            expect(a.currentStateName, `from ${start}`).toBe('C');
        }
    });

    it('tries the state\'s own transitions before its group\'s, wherever they are listed', () => {
        const { a, step } = animatorFor(machine([edge('Moving', 'C', 'go'), edge('A', 'D', 'go')]));
        a.setBool('go', true);
        step();
        expect(a.currentStateName).toBe('D');
    });

    it('enters a group at its entry state, or its first without one', () => {
        for (const [entry, expected] of [['B', 'B'], ['nope', 'A']] as const) {
            const { a, step } = animatorFor(machine([edge('A', 'C', 'go'), edge('C', 'Moving', 'back')], entry));
            a.setBool('go', true); step(); a.setBool('go', false);
            expect(a.currentStateName).toBe('C');
            a.setBool('back', true); step();
            expect(a.currentStateName, `entry ${entry}`).toBe(expected);
        }
    });

    it('does not fire a group transition from a state outside the group', () => {
        const { a, step } = animatorFor(machine([edge('A', 'C', 'toA'), edge('Moving', 'D', 'go')]));
        a.setBool('toA', true); step();
        expect(a.currentStateName).toBe('C');
        a.setBool('go', true); step();
        expect(a.currentStateName).toBe('C');
    });

    it('leaves a machine without groups as it was', () => {
        const sm = machine([edge('A', 'C', 'go')]);
        delete sm.groups;
        const { a, step } = animatorFor(sm);
        a.setBool('go', true); step();
        expect(a.currentStateName).toBe('C');
    });
});

describe('Animator: holdMovement', () => {
    it('tells the character above it to stand still while the state holds, and lets go after', () => {
        const sm = machine([edge('A', 'C', 'go'), edge('C', 'D', 'back')]);
        sm.states.find(s => s.name === 'C')!.holdMovement = true;
        const a = new Animator({ skin: SKIN, animations: ['A', 'B', 'C', 'D'].map(clip) } as unknown as AnimatedModel);
        const character: any = { animationHold: false, parent: null };
        const model: any = { parent: { parent: character }, worldTransform: mat4.create(), position: [0, 0, 0] };
        a.setNode(model);
        a.setStateMachine(sm);
        a.play();
        const step = () => { a.checkTriggers(); a.update(1 / 60); };
        step();
        expect(character.animationHold).toBe(false);
        a.setBool('go', true); step();
        expect(a.currentStateName).toBe('C');
        expect(character.animationHold).toBe(true);
        a.setBool('back', true); step();
        expect(a.currentStateName).toBe('D');
        expect(character.animationHold).toBe(false);
    });
});
