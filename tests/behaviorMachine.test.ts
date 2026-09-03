import { describe, it, expect } from 'vitest';
import {
    AI_GOALS, createBehaviorRuntime, entryState, isDefaultBehaviorMachine, parseBehaviorMachine,
    stateNamed, stepBehavior,
} from '../src/core/control/behavior';
import type { BehaviorMachine, BehaviorRuntime } from '../src/core/control/behavior';

// A behaviour machine fails the way every state machine fails: it holds the wrong state, or it flips
// between two of them forever, and nothing reports either. The guards against that — minDwell, entry
// selection, trigger consumption, machine-wide latch refresh — are all one-liners whose absence is
// invisible until an NPC starts twitching.
//
// The condition evaluation itself is `tests/conditions.test.ts`'s job; this file is about the walk.

const FRAME = 1 / 60;

function machine(): BehaviorMachine {
    return parseBehaviorMachine({
        parameters: [
            { name: 'distance', type: 'number', default: 99, source: { kind: 'sense', name: 'distanceToTarget' } },
            { name: 'alarm', type: 'trigger', default: false, source: { kind: 'blackboard', key: 'alarm' } },
        ],
        states: [
            { name: 'Patrol', goal: 'wander', isEntry: true, speedScale: 0.4 },
            { name: 'Chase', goal: 'seek', targetKey: 'enemy' },
            { name: 'Flee', goal: 'flee' },
        ],
        transitions: [
            { from: 'Patrol', to: 'Chase', condition: { op: 'and', children: [{ param: 'distance', op: 'lt', value: 10 }] } },
            { from: 'Chase', to: 'Patrol', condition: { op: 'and', children: [{ param: 'distance', op: 'gt', value: 20 }] } },
            { from: '*', to: 'Flee', condition: { op: 'and', children: [{ param: 'alarm', op: 'trigger' }] }, minDwell: 0.5 },
        ],
    });
}

/** Run one frame with the given parameter values already in place. */
function step(m: BehaviorMachine, runtime: BehaviorRuntime, values: Record<string, number | boolean>, dt = FRAME) {
    for (const [k, v] of Object.entries(values)) runtime.ctx.values.set(k, v);
    return stepBehavior(m, runtime, dt);
}

describe('entering', () => {
    it('starts in the flagged entry state', () => {
        const m = machine();
        const first = stepBehavior(m, createBehaviorRuntime(), FRAME);
        expect(first.state?.name).toBe('Patrol');
        expect(first.entered).toBe(true);
    });

    it('falls back to the first state when nothing is flagged', () => {
        const m = parseBehaviorMachine({ states: [{ name: 'A', goal: 'idle' }, { name: 'B', goal: 'seek' }] });
        expect(entryState(m)?.name).toBe('A');
    });

    it('re-enters when the held state is deleted underneath it', () => {
        // An author deleting a state while playing must not leave the machine holding a name nothing
        // answers to — it falls back to the entry rather than freezing.
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        runtime = step(m, runtime, { distance: 5 }).next;
        expect(runtime.current).toBe('Chase');

        const trimmed = parseBehaviorMachine({
            states: [{ name: 'Patrol', goal: 'wander', isEntry: true }],
            transitions: [],
        });
        const recovered = stepBehavior(trimmed, runtime, FRAME);
        expect(recovered.state?.name).toBe('Patrol');
        expect(recovered.entered).toBe(true);
    });

    it('reports nothing for an empty machine', () => {
        const stepped = stepBehavior(parseBehaviorMachine(null), createBehaviorRuntime(), FRAME);
        expect(stepped.state).toBeNull();
        expect(stepped.entered).toBe(false);
    });
});

describe('transitions', () => {
    it('fires when its condition holds, and reports the entry frame', () => {
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        const chased = step(m, runtime, { distance: 5 });
        expect(chased.state?.name).toBe('Chase');
        expect(chased.entered).toBe(true);
        // ...and only on that frame.
        const held = step(m, chased.next, { distance: 5 });
        expect(held.entered).toBe(false);
        expect(held.state?.name).toBe('Chase');
    });

    it('does not fire while its condition does not hold', () => {
        const m = machine();
        const runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        expect(step(m, runtime, { distance: 50 }).state?.name).toBe('Patrol');
    });

    it('matches any source state with *', () => {
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        // Past the minDwell, so only the alarm decides.
        for (let i = 0; i < 40; i++) runtime = step(m, runtime, { distance: 50, alarm: false }).next;
        expect(step(m, runtime, { distance: 50, alarm: true }).state?.name).toBe('Flee');
    });

    it('honours minDwell, which is the guard against a ping-ponging pair', () => {
        const m = machine();
        const runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        // The alarm is up immediately, but 0.5s has not passed.
        expect(step(m, runtime, { distance: 50, alarm: true }).state?.name).toBe('Patrol');
    });

    it('checks minDwell BEFORE the conditions, so a trigger is not eaten by a blocked transition', () => {
        // Consuming it early would drop the alarm entirely: the transition cannot fire yet, and by the
        // time it can the trigger is gone.
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        runtime = step(m, runtime, { distance: 50, alarm: true }).next;
        expect(runtime.ctx.values.get('alarm')).toBe(true);
    });

    it('consumes a trigger when the transition does fire', () => {
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        for (let i = 0; i < 40; i++) runtime = step(m, runtime, { distance: 50, alarm: false }).next;
        const fled = step(m, runtime, { alarm: true });
        expect(fled.state?.name).toBe('Flee');
        expect(fled.next.ctx.values.get('alarm')).toBe(false);
    });

    it('resets the dwell clock on entry', () => {
        const m = machine();
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        for (let i = 0; i < 20; i++) runtime = step(m, runtime, { distance: 50 }).next;
        expect(runtime.stateTime).toBeGreaterThan(0.3);
        const chased = step(m, runtime, { distance: 5 });
        expect(chased.next.stateTime).toBe(0);
    });

    it('ignores a transition back into the state already held', () => {
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle', isEntry: true }],
            transitions: [{ from: 'A', to: 'A' }],
        });
        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        expect(step(m, runtime, {}).entered).toBe(false);
    });

    it('treats an absent condition as no constraint', () => {
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle', isEntry: true }, { name: 'B', goal: 'seek' }],
            transitions: [{ from: 'A', to: 'B' }],
        });
        const runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        expect(step(m, runtime, {}).state?.name).toBe('B');
    });
});

describe('hysteresis across states', () => {
    it('advances every latch in the machine, not only the current state\'s', () => {
        // The `>`/`<` pair sits on two different states. A latch that only advanced while its own state
        // was current would leave both halves engaged and the machine flipping every frame.
        const m = parseBehaviorMachine({
            states: [{ name: 'Idle', goal: 'idle', isEntry: true }, { name: 'Move', goal: 'seek' }],
            transitions: [
                { from: 'Idle', to: 'Move', condition: { op: 'and', children: [{ param: 'speed', op: 'gt', value: 1, hysteresis: 0.6 }] } },
                { from: 'Move', to: 'Idle', condition: { op: 'and', children: [{ param: 'speed', op: 'lt', value: 1, hysteresis: 0.6 }] } },
            ],
        });

        let runtime = stepBehavior(m, createBehaviorRuntime(), FRAME).next;
        const visited: string[] = [];
        // Ramp up through the band and back down, one frame at a time.
        for (const speed of [0.5, 0.9, 1.1, 1.4, 1.8, 1.4, 1.1, 0.9, 0.5, 0.2]) {
            const stepped = step(m, runtime, { speed });
            runtime = stepped.next;
            visited.push(stepped.state!.name);
        }
        // It settles into Move and comes back out — but never oscillates within one direction of travel.
        expect(visited).toContain('Move');
        expect(visited[visited.length - 1]).toBe('Idle');
        let flips = 0;
        for (let i = 1; i < visited.length; i++) if (visited[i] !== visited[i - 1]) flips++;
        expect(flips).toBe(2);
    });
});

describe('the tolerant reader', () => {
    it('reads junk as an empty machine rather than throwing', () => {
        for (const junk of [null, undefined, 'machine', 42, [], {}])
            expect(parseBehaviorMachine(junk)).toEqual({ parameters: [], states: [], transitions: [] });
    });

    it('drops a state with no name and keeps its siblings in order', () => {
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle' }, { goal: 'seek' }, { name: 'C', goal: 'flee' }],
        });
        expect(m.states.map(s => s.name)).toEqual(['A', 'C']);
    });

    it('keeps the first of two states sharing a name', () => {
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle' }, { name: 'A', goal: 'seek' }],
        });
        expect(m.states).toHaveLength(1);
        expect(m.states[0].goal).toBe('idle');
    });

    it('drops a transition naming a state that does not exist', () => {
        // It could never fire, and leaving it would show a row in the editor that does nothing.
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle' }],
            transitions: [{ from: 'A', to: 'Nowhere' }, { from: 'Ghost', to: 'A' }, { from: '*', to: 'A' }],
        });
        expect(m.transitions).toHaveLength(1);
        expect(m.transitions[0].from).toBe('*');
    });

    it('falls back to idle for an unreadable goal, and reads every real one', () => {
        expect(parseBehaviorMachine({ states: [{ name: 'A', goal: 'teleport' }] }).states[0].goal).toBe('idle');
        for (const goal of AI_GOALS)
            expect(parseBehaviorMachine({ states: [{ name: 'A', goal }] }).states[0].goal).toBe(goal);
    });

    it('writes no speedScale for an untouched state, so a round trip adds no bytes', () => {
        const m = parseBehaviorMachine({ states: [{ name: 'A', goal: 'idle', speedScale: 1 }] });
        expect('speedScale' in m.states[0]).toBe(false);
    });

    it('wraps a bare condition leaf in a group, which is the shape the editor appends to', () => {
        const m = parseBehaviorMachine({
            states: [{ name: 'A', goal: 'idle' }, { name: 'B', goal: 'seek' }],
            transitions: [{ from: 'A', to: 'B', condition: { param: 'x', op: 'true' } }],
        });
        expect(m.transitions[0].condition).toEqual({ op: 'and', children: [{ param: 'x', op: 'true' }] });
    });

    it('repairs a parameter source it cannot read into a constant', () => {
        // Every source kind needs a name to read FROM. One missing it can never produce a value, so it
        // degrades to a constant the author can see in the panel rather than to a silent zero.
        const cases: unknown[] = [
            { kind: 'sense', name: 'vibes' },
            { kind: 'builtin', name: '' },
            { kind: 'variable' },
            { kind: 'blackboard', key: '   ' },
            { kind: 'telepathy' },
            undefined,
        ];
        for (const source of cases) {
            const m = parseBehaviorMachine({ parameters: [{ name: 'p', type: 'number', source }] });
            expect(m.parameters[0].source, JSON.stringify(source)).toEqual({ kind: 'const', value: 0 });
        }
    });

    it('reads every source kind that names something', () => {
        const cases: [unknown, unknown][] = [
            [{ kind: 'builtin', name: 'planarSpeed' }, { kind: 'builtin', name: 'planarSpeed' }],
            [{ kind: 'variable', varName: 'mood' }, { kind: 'variable', varName: 'mood' }],
            [{ kind: 'blackboard', key: 'enemy' }, { kind: 'blackboard', key: 'enemy' }],
            [{ kind: 'sense', name: 'distanceToTarget' }, { kind: 'sense', name: 'distanceToTarget' }],
            [{ kind: 'const', value: true }, { kind: 'const', value: true }],
            [{ kind: 'const', value: 7 }, { kind: 'const', value: 7 }],
            [{ kind: 'const', value: 'nonsense' }, { kind: 'const', value: 0 }],
        ];
        for (const [source, expected] of cases) {
            const m = parseBehaviorMachine({ parameters: [{ name: 'p', type: 'number', source }] });
            expect(m.parameters[0].source, JSON.stringify(source)).toEqual(expected);
        }
    });

    it('drops a parameter with no name, and defaults an unreadable type to number', () => {
        expect(parseBehaviorMachine({ parameters: [{ type: 'number' }] }).parameters).toEqual([]);
        const m = parseBehaviorMachine({ parameters: [{ name: 'p', type: 'quaternion', default: 4 }] });
        expect(m.parameters[0].type).toBe('number');
        expect(m.parameters[0].default).toBe(4);
    });

    it('reads a boolean parameter default as a boolean, not as truthiness', () => {
        const read = (d: unknown) =>
            parseBehaviorMachine({ parameters: [{ name: 'p', type: 'boolean', default: d }] }).parameters[0].default;
        expect(read(true)).toBe(true);
        expect(read(1)).toBe(false);
        expect(read(undefined)).toBe(false);
    });

    it('drops a transition and a state that are not objects at all', () => {
        const m = parseBehaviorMachine({
            states: ['A', null, { name: 'A', goal: 'idle' }],
            transitions: [42, { from: 'A', to: 'A' }],
        });
        expect(m.states).toHaveLength(1);
        expect(m.transitions).toHaveLength(1);
    });

    it('carries authoring coordinates through but ignores junk ones', () => {
        const m = parseBehaviorMachine({ states: [{ name: 'A', goal: 'idle', x: 12, y: NaN }] });
        expect(m.states[0].x).toBe(12);
        expect('y' in m.states[0]).toBe(false);
    });

    it('clamps a state throttle into 0..1', () => {
        const m = parseBehaviorMachine({ states: [{ name: 'A', goal: 'idle', speedScale: 5 }] });
        expect(m.states[0].speedScale).toBe(1);
        const low = parseBehaviorMachine({ states: [{ name: 'B', goal: 'idle', speedScale: -2 }] });
        expect(low.states[0].speedScale).toBe(0);
    });

    it('is idempotent — parsing its own output changes nothing', () => {
        const once = machine();
        expect(parseBehaviorMachine(once)).toEqual(once);
    });
});

describe('isDefaultBehaviorMachine', () => {
    it('is true for anything empty, so an unauthored controller serializes nothing', () => {
        expect(isDefaultBehaviorMachine(undefined)).toBe(true);
        expect(isDefaultBehaviorMachine({ parameters: [], states: [], transitions: [] })).toBe(true);
        expect(isDefaultBehaviorMachine(machine())).toBe(false);
    });
});

describe('lookups', () => {
    it('finds a state by name and reports a miss as null', () => {
        const m = machine();
        expect(stateNamed(m, 'Chase')?.goal).toBe('seek');
        expect(stateNamed(m, 'Nowhere')).toBeNull();
    });
});
