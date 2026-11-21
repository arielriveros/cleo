import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Animator } from '../src/animation/animator';
import type { AnimationConditionGroup, AnimationState, AnimationStateMachine, AnimationTransition } from '../src/animation/animator';
import type { AnimatedModel, Animation, Skin } from '../src/animation/animatedModel';
import { pathsFrom, staticEnd } from '../src/animation/machineForks';

// Forks: junctions a transition goes THROUGH. A transition into a fork fires only when one of the fork's ways out
// can, and then goes straight on, in the same frame, to the first that holds; the machine never rests in one.

const SKIN: Skin = { joints: [{ nodeIndex: 0, inverseBindMatrix: mat4.create() }], nodeTransforms: new Map([[0, mat4.create()]]) };
const CLIPS = ['A', 'B', 'C', 'D', 'E', 'X', 'Y'];
const clip = (name: string): Animation => ({
    name,
    samplers: [{ input: [0, 1], output: [0, 0, 0, 0, 0, 0], interpolation: 'LINEAR' }],
    channels: [{ samplerIndex: 0, targetNodeIndex: 0, targetPath: 'translation' }],
});
const PARAMS = ['go', 'alt', 'x', 'y', 'z', 'never'];
const TRIGGERS = ['T1', 'T2', 'Hit', 'Kick', 'Roll'];
const when = (...params: string[]): AnimationConditionGroup => ({ op: 'and', children: params.map(param => ({ param, op: TRIGGERS.includes(param) ? 'trigger' as const : 'true' as const })) });
/** A transition: gated on `params` all true (none: always), with extra fields. */
const edge = (from: string, to: string, params: string[] = [], extra: Partial<AnimationTransition> = {}): AnimationTransition =>
    ({ from, to, conditions: [], ...(params.length ? { condition: when(...params) } : {}), ...extra });

function machine(transitions: AnimationTransition[], forks: string[], over: Partial<AnimationStateMachine> = {}): AnimationStateMachine {
    const state = (name: string, isEntry = false): AnimationState => ({ name, clipName: name, loop: true, speed: 1, isEntry } as AnimationState);
    return {
        parameters: [
            ...PARAMS.map(name => ({ name, type: 'bool', default: false })),
            ...TRIGGERS.map(name => ({ name, type: 'trigger', default: false })),
        ] as any,
        states: [state('A', true), state('B'), state('C'), state('D'), state('E')],
        transitions,
        forks: forks.map(name => ({ name })),
        events: [],
        ...over,
    };
}

function animatorFor(sm: AnimationStateMachine) {
    const a = new Animator({ skin: SKIN, animations: CLIPS.map(clip) } as unknown as AnimatedModel);
    a.setStateMachine(sm);
    a.play();
    const entered: string[] = [];
    const step = (dt = 1 / 60) => { a.checkTriggers(); a.update(dt); entered.push(a.currentStateName ?? ''); };
    step();
    return { a, step, entered };
}

describe('Animator: forks', () => {
    it('fires a way in only when a way out holds, and goes straight through to its state', () => {
        const { a, step, entered } = animatorFor(machine([edge('A', 'F'), edge('F', 'B', ['go'])], ['F']));
        for (let i = 0; i < 5; i++) step();
        expect(a.currentStateName, 'no way out holds: the way in waits').toBe('A');
        a.setBool('go', true);
        step();
        expect(a.currentStateName).toBe('B');
        expect(entered, 'never in the fork').not.toContain('F');
    });

    it('takes the first way out that holds, in their order', () => {
        const { a, step } = animatorFor(machine([edge('A', 'F', ['go']), edge('F', 'B', ['alt']), edge('F', 'C', ['go']), edge('F', 'D', ['go'])], ['F']));
        a.setBool('go', true);
        step();
        expect(a.currentStateName).toBe('C');
    });

    it('passes over a way out into the state already playing, and tries the next', () => {
        const { a, step } = animatorFor(machine([edge('A', 'F', ['go']), edge('F', 'A'), edge('F', 'C')], ['F']));
        a.setBool('go', true);
        step();
        expect(a.currentStateName).toBe('C');
    });

    it('restarts the playing state from Any State only when a leg may restart it', () => {
        for (const restart of [false, true]) {
            const { a, step } = animatorFor(machine([edge('*', 'F', [], { canTransitionToSelf: restart }), edge('F', 'A', ['Hit'])], ['F']));
            for (let i = 0; i < 30; i++) step();
            const before = (a as any)._stateTime;
            a.setTrigger('Hit');
            step();
            expect(a.currentStateName).toBe('A');
            if (restart) expect((a as any)._stateTime, 'restarted').toBeLessThan(before);
            else expect((a as any)._stateTime, 'kept playing').toBeGreaterThan(before);
        }
    });

    it('goes through a chain of forks, and back to the next way out of the first when the second has none open', () => {
        const sm = () => machine([edge('A', 'F1', ['go']), edge('F1', 'F2', ['x']), edge('F2', 'C', ['y']), edge('F1', 'D', ['z'])], ['F1', 'F2']);
        {
            const { a, step } = animatorFor(sm());
            a.setBool('go', true); a.setBool('x', true); a.setBool('y', true);
            step();
            expect(a.currentStateName).toBe('C');
        }
        {
            const { a, step } = animatorFor(sm());
            a.setBool('go', true); a.setBool('x', true); a.setBool('z', true);
            step();
            expect(a.currentStateName, 'F2 had no way out open').toBe('D');
        }
    });

    it('enters a group whose entry is a fork through the fork', () => {
        const sm = (alt: boolean) => {
            const m = machine([edge('A', 'G', ['go']), edge('F', 'C', ['alt']), edge('F', 'B')], ['F'], {
                groups: [{ name: 'G', states: ['B', 'C', 'F'], entry: 'F' }],
            });
            return { m, alt };
        };
        for (const { m, alt } of [sm(false), sm(true)]) {
            const { a, step } = animatorFor(m);
            a.setBool('go', true); a.setBool('alt', alt);
            step();
            expect(a.currentStateName).toBe(alt ? 'C' : 'B');
        }
    });

    it('never fires a group\'s own ways out from its fork', () => {
        // The group's way out to E would fire from any of its states; the fork is not one the machine is ever in.
        const { a, step } = animatorFor(machine([edge('A', 'G', ['go']), edge('F', 'B', ['alt']), edge('G', 'E', ['go'])], ['F'], {
            groups: [{ name: 'G', states: ['B', 'F'], entry: 'F' }],
        }));
        a.setBool('go', true);
        step();
        expect(a.currentStateName, 'the fork had no way out open: nothing fired').toBe('A');
    });

    it('cross-fades by the last leg that sets a blend, else the earlier one', () => {
        const blendOf = (transitions: AnimationTransition[]) => {
            const { a, step } = animatorFor(machine(transitions, ['F']));
            a.setBool('go', true);
            step();
            expect(a.currentStateName).toBe('B');
            return (a as any)._activeBlendTime;
        };
        expect(blendOf([edge('A', 'F', ['go'], { blendTime: 0.5 }), edge('F', 'B')])).toBeCloseTo(0.5);
        expect(blendOf([edge('A', 'F', ['go'], { blendTime: 0.5 }), edge('F', 'B', [], { blendTime: 0.1 })])).toBeCloseTo(0.1);
        expect(blendOf([edge('A', 'F', ['go']), edge('F', 'B', [], { blendTime: 0.2 })])).toBeCloseTo(0.2);
    });

    it('consumes the triggers of the path it takes, and none of a way out it only tried', () => {
        const { a, step } = animatorFor(machine([edge('A', 'F', ['T1']), edge('F', 'B', ['T2', 'never']), edge('F', 'C', ['go'])], ['F']));
        a.setTrigger('T1');
        step();
        expect(a.currentStateName, 'no way out open').toBe('A');
        expect(a.getParam('T1'), 'a way in that did not fire keeps its trigger').toBe(true);
        a.setTrigger('T2');
        a.setBool('go', true);
        step();
        expect(a.currentStateName).toBe('C');
        expect(a.getParam('T1'), 'the way in, taken').toBe(false);
        expect(a.getParam('T2'), 'a way out only tried').toBe(true);
        expect(a.activeTrigger(), 'the first trigger along the way').toBe('T1');
    });

    it('tests a way out\'s exit time against the state being left', () => {
        const { a, step } = animatorFor(machine([edge('A', 'F'), edge('F', 'B', [], { hasExitTime: true, exitTime: 0.5 })], ['F']));
        for (let i = 0; i < 20; i++) step();
        expect(a.currentStateName, 'A is a third in').toBe('A');
        for (let i = 0; i < 20; i++) step();
        expect(a.currentStateName, 'A passed half way').toBe('B');
    });

    it('ends a cycle of forks instead of hanging', () => {
        const { a, step } = animatorFor(machine([edge('A', 'F1'), edge('F1', 'F2'), edge('F2', 'F1')], ['F1', 'F2']));
        step();
        expect(a.currentStateName).toBe('A');
        expect(staticEnd({ states: [], transitions: [edge('F1', 'F2'), edge('F2', 'F1')], forks: [{ name: 'F1' }, { name: 'F2' }] }, 'F1')).toBeNull();
    });

    it('lets a state or a group of the same name win over a fork', () => {
        const { a, step } = animatorFor(machine([edge('A', 'B', ['go']), edge('B', 'C', ['alt'])], ['B']));
        a.setBool('go', true);
        step();
        expect(a.currentStateName, 'B is a state first').toBe('B');
    });

    it('runs forks on a layer, which keeps its own', () => {
        const sm = machine([], [], {
            layers: [{
                name: 'Upper',
                states: [{ name: 'X', clipName: 'X', loop: true, speed: 1, isEntry: true }, { name: 'Y', clipName: 'Y', loop: true, speed: 1 }],
                transitions: [edge('X', 'F'), edge('F', 'Y', ['go'])],
                forks: [{ name: 'F' }],
            }],
        });
        const { a, step } = animatorFor(sm);
        expect(a.layerStateName('Upper')).toBe('X');
        a.setBool('go', true);
        step();
        expect(a.layerStateName('Upper')).toBe('Y');
        expect(a.currentStateName, 'the base has no fork F').toBe('A');
    });

    it('tells what a trigger plays through a fork, and whether it plays from anywhere', () => {
        const { a } = animatorFor(machine([
            edge('*', 'F'), edge('F', 'B', ['Hit']),
            edge('A', 'F2'), edge('F2', 'C', ['Kick']),
            edge('*', 'F3', ['Roll']), edge('F3', 'D'), edge('F3', 'E'),
        ], ['F', 'F2', 'F3']));
        expect(a.triggerInfo('Hit')).toMatchObject({ state: 'B', fromAnywhere: true });
        expect(a.triggerInfo('Kick')).toMatchObject({ state: 'C', fromAnywhere: false });
        // On the way in: the fork's first way out is the one told.
        expect(a.triggerInfo('Roll')).toMatchObject({ state: 'D', fromAnywhere: true });
    });

    it('reports a ping-pong pair joined through a fork with every leg', () => {
        const { a } = animatorFor(machine([edge('A', 'F', ['go']), edge('F', 'B', ['x']), edge('B', 'A', ['y'])], ['F']));
        const text: string = (a as any)._describeTransitions('A', 'B');
        expect(text).toContain('A -> B (via F)');
        expect(text).toContain('THEN');
        expect(text).toContain('B -> A');
    });

    it('lists every way through a fork, and a fork-less way as written', () => {
        const m = machine([edge('A', 'F'), edge('F', 'B', ['x']), edge('F', 'G'), edge('A', 'C')], ['F'], { groups: [{ name: 'G', states: ['D'] }] });
        expect(pathsFrom(m, 'A').map(p => [p.legs.map(l => `${l.from}>${l.to}`).join(' '), p.to])).toEqual([
            ['A>F F>B', 'B'],
            ['A>F F>G', 'G'],
            ['A>C', 'C'],
        ]);
    });
});
