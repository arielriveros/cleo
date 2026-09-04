import { describe, it, expect } from 'vitest';
import {
    EMPTY_GOAL_GRAPH, GoalBrain, isDefaultGoalGraph, parseGoalGraph,
} from '../src/ai/goals';
import type { GoalContext, GoalGraph } from '../src/ai/goals';
import type { AiGoal } from '../src/core/control/behavior';

// Three of these assertions pin Yuka semantics that were MEASURED rather than read, and each one is a
// silent wrong-behaviour if it flips: authored subgoal order is execution order (addSubgoal fronts a
// stack popped from the back); arbitrate compares with >= so a tie goes to the LAST evaluator; and
// the initial best is -1, so an evaluator scoring 0 still wins and therefore cannot abstain.

/** A context that records what was driven and answers reads from a table. */
function context(values: Record<string, number | boolean> = {}) {
    const driven: { goal: AiGoal; targetKey?: string; speedScale: number }[] = [];
    const met = new Set<string>();
    const ctx: GoalContext = {
        read: (source) => {
            if (source.kind === 'const') return source.value;
            if (source.kind === 'blackboard') return values[source.key] ?? 0;
            if (source.kind === 'sense') return values[source.name] ?? 0;
            if (source.kind === 'fuzzy') return values[source.name] ?? 0;
            if (source.kind === 'builtin') return values[source.name] ?? 0;
            return 0;
        },
        // Conditions are opaque here; the tests tag them with a marker the fake recognises.
        met: (condition) => !!condition && met.has((condition as unknown as { tag: string }).tag),
        drive: (goal, targetKey, speedScale) => { driven.push({ goal, targetKey, speedScale }); },
    };
    return { ctx, driven, met, values };
}

const tagged = (tag: string) => ({ op: 'and', children: [], tag }) as never;

function graph(over: Partial<GoalGraph> = {}): GoalGraph {
    return parseGoalGraph({ arbitrationInterval: 0, ...over });
}

describe('arbitration', () => {
    it('runs the goal with the highest desirability', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'Patrol', goal: 'wander' }, { name: 'Chase', goal: 'seek' }],
            evaluators: [
                { goalName: 'Patrol', source: { kind: 'const', value: 1 }, from: 0, to: 10, bias: 1 },
                { goalName: 'Chase', source: { kind: 'sense', name: 'threat' }, from: 0, to: 1, bias: 1 },
            ],
        }));

        const calm = context({ threat: 0 });
        brain.step(calm.ctx, 0.1);
        expect(brain.current).toBe('Patrol');

        const alarmed = context({ threat: 1 });
        brain.step(alarmed.ctx, 0.1);
        expect(brain.current).toBe('Chase');
        expect(alarmed.driven.at(-1)!.goal).toBe('seek');
    });

    it('scales desirability by the bias', () => {
        // Identical sources; only the bias separates them.
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'Timid', goal: 'flee' }, { name: 'Bold', goal: 'seek' }],
            evaluators: [
                { goalName: 'Timid', source: { kind: 'const', value: 1 }, from: 0, to: 2, bias: 1 },
                { goalName: 'Bold', source: { kind: 'const', value: 1 }, from: 0, to: 2, bias: 0.1 },
            ],
        }));
        brain.step(context().ctx, 0.1);
        expect(brain.current).toBe('Timid');
    });

    it('inverts when the range runs backwards, which is how "nearer is better" reads', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'Near', goal: 'seek' }, { name: 'Idle', goal: 'idle' }],
            evaluators: [
                // 0 distance scores 1, 20 scores 0.
                { goalName: 'Near', source: { kind: 'sense', name: 'distanceToTarget' }, from: 20, to: 0, bias: 1 },
                { goalName: 'Idle', source: { kind: 'const', value: 1 }, from: 0, to: 4, bias: 1 },
            ],
        }));

        brain.step(context({ distanceToTarget: 1 }).ctx, 0.1);
        expect(brain.current).toBe('Near');
        brain.step(context({ distanceToTarget: 19 }).ctx, 0.1);
        expect(brain.current).toBe('Idle');
    });

    // Yuka's arbitrate uses >=, so the LAST evaluator added wins a tie. Worth pinning because it
    // decides which of two equally-desirable goals runs, and nothing about the API hints at it.
    it('breaks a tie in favour of the last evaluator', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'First', goal: 'idle' }, { name: 'Second', goal: 'wander' }],
            evaluators: [
                { goalName: 'First', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
                { goalName: 'Second', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
            ],
        }));
        brain.step(context().ctx, 0.1);
        expect(brain.current).toBe('Second');
    });

    // The initial best is -1, so zero still wins. An evaluator cannot abstain, which means an idle
    // fallback has to be authored rather than assumed.
    it('still runs a goal whose desirability is zero, because nothing can abstain', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'Only', goal: 'idle' }],
            evaluators: [{ goalName: 'Only', source: { kind: 'const', value: 0 }, from: 0, to: 1, bias: 1 }],
        }));
        brain.step(context().ctx, 0.1);
        expect(brain.current).toBe('Only');
    });

    it('does nothing at all with no evaluators', () => {
        const brain = GoalBrain.from(graph({ goals: [{ name: 'Lonely', goal: 'idle' }] }));
        const c = context();
        brain.step(c.ctx, 0.1);
        expect(brain.current).toBe('');
        expect(c.driven).toHaveLength(0);
    });
});

describe('the arbitration interval', () => {
    it('holds a plan until the interval elapses, then reconsiders', () => {
        const brain = GoalBrain.from(parseGoalGraph({
            arbitrationInterval: 1,
            goals: [{ name: 'A', goal: 'idle' }, { name: 'B', goal: 'wander' }],
            evaluators: [
                { goalName: 'A', source: { kind: 'sense', name: 'a' }, from: 0, to: 1, bias: 1 },
                { goalName: 'B', source: { kind: 'sense', name: 'b' }, from: 0, to: 1, bias: 1 },
            ],
        }));

        brain.step(context({ a: 1, b: 0 }).ctx, 0);
        expect(brain.current).toBe('A');

        // B is now far more desirable, but the interval has not passed.
        brain.step(context({ a: 0, b: 1 }).ctx, 0.5);
        expect(brain.current).toBe('A');

        brain.step(context({ a: 0, b: 1 }).ctx, 0.6);
        expect(brain.current).toBe('B');
    });

    it('reconsiders every frame at an interval of zero', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'A', goal: 'idle' }, { name: 'B', goal: 'wander' }],
            evaluators: [
                { goalName: 'A', source: { kind: 'sense', name: 'a' }, from: 0, to: 1, bias: 1 },
                { goalName: 'B', source: { kind: 'sense', name: 'b' }, from: 0, to: 1, bias: 1 },
            ],
        }));
        brain.step(context({ a: 1, b: 0 }).ctx, 0.001);
        expect(brain.current).toBe('A');
        brain.step(context({ a: 0, b: 1 }).ctx, 0.001);
        expect(brain.current).toBe('B');
    });
});

describe('composite goals', () => {
    function attack(): GoalGraph {
        return graph({
            goals: [
                { name: 'Attack', goal: 'idle', subgoals: ['Approach', 'Strike'] },
                { name: 'Approach', goal: 'seek', until: tagged('inReach') },
                { name: 'Strike', goal: 'idle', until: tagged('dead') },
            ],
            evaluators: [{ goalName: 'Attack', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 }],
        });
    }

    // Authored order is execution order: addSubgoal fronts a stack that pops from the back.
    it('runs subgoals in authored order', () => {
        const brain = GoalBrain.from(attack());
        const c = context();

        brain.step(c.ctx, 0.1);
        expect(c.driven.at(-1)!.goal).toBe('seek');
        expect(brain.plan).toEqual(['Attack', 'Approach']);

        // Approach completes; the next step must move on to Strike rather than restart.
        c.met.add('inReach');
        brain.step(c.ctx, 0.1);
        brain.step(c.ctx, 0.1);
        expect(brain.plan).toEqual(['Attack', 'Strike']);
    });

    // A plan whose conditions are all instantly true completes WITHIN the step it was formed in, so
    // `current` is empty at the end of it. What matters is that the brain re-forms the plan rather
    // than going dead -- a composite that popped itself and never came back is the failure here.
    it('re-forms a completed plan instead of going idle', () => {
        const brain = GoalBrain.from(attack());
        const c = context();
        c.met.add('inReach');
        c.met.add('dead');

        for (let i = 0; i < 6; i++) brain.step(c.ctx, 0.1);
        expect(brain.current).toBe('');

        // Conditions no longer met: the very next step must plan again and start driving.
        c.met.clear();
        brain.step(c.ctx, 0.1);
        expect(brain.current).toBe('Attack');
        expect(c.driven.at(-1)!.goal).toBe('seek');
    });

    it('fails a goal rather than completing it when both conditions are met', () => {
        // "I am in reach" and "my target died" want the second answer.
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'G', goal: 'seek', until: tagged('done'), failWhen: tagged('lost') }],
            evaluators: [{ goalName: 'G', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 }],
        }));
        const c = context();
        c.met.add('done');
        c.met.add('lost');
        brain.step(c.ctx, 0.1);
        // Nothing was driven: the goal bailed before reaching drive().
        expect(c.driven).toHaveLength(0);
    });

    it('drives the target key and speed scale a goal names', () => {
        const brain = GoalBrain.from(graph({
            goals: [{ name: 'G', goal: 'follow', targetKey: 'ally', speedScale: 0.4 }],
            evaluators: [{ goalName: 'G', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 }],
        }));
        const c = context();
        brain.step(c.ctx, 0.1);
        expect(c.driven.at(-1)).toEqual({ goal: 'follow', targetKey: 'ally', speedScale: 0.4 });
    });

    it('abandons its plan on clear, for a respawned brain', () => {
        const brain = GoalBrain.from(attack());
        brain.step(context().ctx, 0.1);
        expect(brain.current).toBe('Attack');

        brain.clear();
        expect(brain.current).toBe('');
    });
});

describe('the tolerant reader', () => {
    it('reads junk as a graph that decides nothing', () => {
        for (const junk of [null, undefined, 7, 'no', {}, { goals: 1, evaluators: 2 }]) {
            const parsed = parseGoalGraph(junk);
            expect(parsed.goals).toHaveLength(0);
            expect(parsed.evaluators).toHaveLength(0);
            expect(isDefaultGoalGraph(junk)).toBe(true);
        }
        expect(EMPTY_GOAL_GRAPH.goals).toHaveLength(0);
    });

    it('drops a subgoal naming a goal that does not exist', () => {
        const parsed = parseGoalGraph({
            goals: [{ name: 'A', goal: 'idle', subgoals: ['B', 'ghost'] }, { name: 'B', goal: 'idle' }],
        });
        expect(parsed.goals[0].subgoals).toEqual(['B']);
    });

    // A plan that nests forever. Direct self-reference is caught while parsing the goal; a longer
    // cycle needs the whole graph, which is why there are two passes.
    it('breaks self-reference and longer cycles', () => {
        expect(parseGoalGraph({ goals: [{ name: 'A', goal: 'idle', subgoals: ['A'] }] })
            .goals[0].subgoals).toBeUndefined();

        const mutual = parseGoalGraph({
            goals: [
                { name: 'A', goal: 'idle', subgoals: ['B'] },
                { name: 'B', goal: 'idle', subgoals: ['A'] },
            ],
        });
        expect(mutual.goals[0].subgoals).toBeUndefined();
        expect(mutual.goals[1].subgoals).toBeUndefined();
    });

    it('drops an evaluator naming a goal that does not exist', () => {
        const parsed = parseGoalGraph({
            goals: [{ name: 'A', goal: 'idle' }],
            evaluators: [
                { goalName: 'A', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
                { goalName: 'ghost', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 },
            ],
        });
        expect(parsed.evaluators).toHaveLength(1);
    });

    it('drops duplicate goal names', () => {
        expect(parseGoalGraph({ goals: [{ name: 'A', goal: 'idle' }, { name: 'A', goal: 'seek' }] })
            .goals).toHaveLength(1);
    });

    // A zero-width range divides by zero.
    it('never leaves a desirability range zero-width', () => {
        const parsed = parseGoalGraph({
            goals: [{ name: 'A', goal: 'idle' }],
            evaluators: [{ goalName: 'A', source: { kind: 'const', value: 1 }, from: 5, to: 5, bias: 1 }],
        });
        expect(parsed.evaluators[0].to).not.toBe(parsed.evaluators[0].from);
    });

    it('clamps a negative bias and a silly speed scale', () => {
        const parsed = parseGoalGraph({
            goals: [{ name: 'A', goal: 'idle', speedScale: 9 }],
            evaluators: [{ goalName: 'A', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: -3 }],
        });
        expect(parsed.goals[0].speedScale).toBe(1);
        expect(parsed.evaluators[0].bias).toBe(0);
    });
});
