import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { CleoEngine } from '../src/core/engine';
import { parseGoalGraph } from '../src/ai/goals';
import { moveWorldDirection } from '../src/core/control/intent';

// The goal brain reaching the steering layer, end to end. The two things worth pinning are that the
// selector defaults to the state machine (so no existing scene changes behaviour by upgrading), and
// that a goal's desirability reads the SAME parameter vocabulary the machine does -- there is one
// reader, so `sense` and `blackboard` cannot come to mean subtly different things in the two brains.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

function world() {
    const scene = new Scene();
    const guard = new CharacterNode('guard');
    const quarry = new CharacterNode('quarry');
    const brain = new ControllerNode('brain');
    scene.addNode(guard);
    scene.addNode(quarry);
    scene.addNode(brain);
    brain.possess(guard);
    brain.controlSource = 'ai';
    brain.autoAcquire = false;
    brain.setBlackboard('target', quarry.id);
    scene.start();
    return { scene, guard, quarry, brain };
}

/** Chase when the target is near, otherwise hold still. */
const CHASE_OR_IDLE = parseGoalGraph({
    arbitrationInterval: 0,
    goals: [
        { name: 'Chase', goal: 'seek', targetKey: 'target' },
        { name: 'Rest', goal: 'idle' },
    ],
    evaluators: [
        // Nearer is better: 20 units away scores 0, on top of it scores 1.
        { goalName: 'Chase', source: { kind: 'sense', name: 'distanceToTarget' }, from: 20, to: 0, bias: 1 },
        { goalName: 'Rest', source: { kind: 'const', value: 1 }, from: 0, to: 4, bias: 1 },
    ],
});

function direction(guard: CharacterNode): vec3 {
    return moveWorldDirection(vec3.create(), guard.intent);
}

describe('the brain selector', () => {
    it('defaults to the state machine, so upgrading changes nothing', () => {
        expect(new ControllerNode('b').brain).toBe('machine');
    });

    it('ignores a goal graph while the machine is selected', () => {
        const w = world();
        w.brain.goals = CHASE_OR_IDLE;
        w.quarry.setPosition([0, 0, 1]);
        w.scene.update(1 / 60, 0, false);

        expect(w.brain.goalState).toBe('');
        // Falls through to the node's own goal field, which is 'idle' by default.
        expect(vec3.length(direction(w.guard))).toBe(0);
    });

    it('runs the graph once the goal brain is selected', () => {
        const w = world();
        w.brain.brain = 'goal';
        w.brain.goals = CHASE_OR_IDLE;
        w.quarry.setPosition([0, 0, 1]);
        w.scene.update(1 / 60, 0, false);

        expect(w.brain.goalState).toBe('Chase');
        expect(direction(w.guard)[2]).toBeGreaterThan(0);
    });

    it('leaves the goal field alone under `none`', () => {
        const w = world();
        w.brain.brain = 'none';
        w.brain.goals = CHASE_OR_IDLE;
        w.brain.goal = 'seek';
        w.quarry.setPosition([0, 0, 5]);
        w.scene.update(1 / 60, 0, false);

        expect(w.brain.goalState).toBe('');
        // The node's own goal still runs.
        expect(direction(w.guard)[2]).toBeGreaterThan(0);
    });

    it('falls back to the node goal when the graph is empty', () => {
        const w = world();
        w.brain.brain = 'goal';
        w.brain.goal = 'seek';
        w.quarry.setPosition([0, 0, 5]);
        w.scene.update(1 / 60, 0, false);
        expect(direction(w.guard)[2]).toBeGreaterThan(0);
    });
});

describe('desirability reads the shared vocabulary', () => {
    it('switches goal as a sense crosses over', () => {
        const w = world();
        w.brain.brain = 'goal';
        w.brain.goals = CHASE_OR_IDLE;

        // Far: Rest scores 0.25, Chase scores near 0.
        w.quarry.setPosition([0, 0, 19]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalState).toBe('Rest');

        // Close: Chase overtakes.
        w.quarry.setPosition([0, 0, 2]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalState).toBe('Chase');
    });

    it('reads a blackboard entry', () => {
        const w = world();
        w.brain.brain = 'goal';
        w.brain.goals = parseGoalGraph({
            arbitrationInterval: 0,
            goals: [{ name: 'Go', goal: 'seek', targetKey: 'target' }, { name: 'Stop', goal: 'idle' }],
            evaluators: [
                { goalName: 'Go', source: { kind: 'blackboard', key: 'alert' }, from: 0, to: 1, bias: 1 },
                { goalName: 'Stop', source: { kind: 'const', value: 1 }, from: 0, to: 4, bias: 1 },
            ],
        });
        w.quarry.setPosition([0, 0, 5]);

        w.brain.setBlackboard('alert', 0);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalState).toBe('Stop');

        w.brain.setBlackboard('alert', 1);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalState).toBe('Go');
    });
});

describe('composite plans', () => {
    it('runs subgoals in order and reports the plan', () => {
        const w = world();
        w.brain.brain = 'goal';
        w.brain.goals = parseGoalGraph({
            arbitrationInterval: 0,
            goals: [
                { name: 'Hunt', goal: 'idle', subgoals: ['Close', 'Wait'] },
                // Completes once within 3 units of the target.
                { name: 'Close', goal: 'seek', targetKey: 'target', until: {
                    op: 'and', children: [{ param: 'range', op: 'lt', value: 3 }],
                } },
                { name: 'Wait', goal: 'idle' },
            ],
            evaluators: [{ goalName: 'Hunt', source: { kind: 'const', value: 1 }, from: 0, to: 1, bias: 1 }],
        });
        // The condition reads a machine parameter, which is how a goal's `until` gets its values.
        w.brain.behavior = {
            parameters: [{
                name: 'range', type: 'number', default: 99,
                source: { kind: 'sense', name: 'distanceToTarget' },
            }],
            states: [],
            transitions: [],
        } as never;

        w.quarry.setPosition([0, 0, 20]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalPlan).toEqual(['Hunt', 'Close']);
        expect(direction(w.guard)[2]).toBeGreaterThan(0);

        // Now within reach: Close completes and the plan advances to Wait.
        w.quarry.setPosition([0, 0, 1]);
        w.scene.update(1 / 60, 0, false);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.goalPlan).toEqual(['Hunt', 'Wait']);
    });
});

describe('persistence', () => {
    it('round-trips the brain selector and the graph', async () => {
        const brain = new ControllerNode('brain');
        brain.brain = 'goal';
        brain.goals = CHASE_OR_IDLE;

        const json = await brain.serialize() as any;
        expect(json.brain).toBe('goal');
        expect(json.goals.goals).toHaveLength(2);
        expect(json.goals.evaluators).toHaveLength(2);
    });

    it('writes no graph for a controller that never authored one', async () => {
        const json = await new ControllerNode('brain').serialize() as any;
        expect(json.goals).toBeUndefined();
        expect(json.brain).toBe('machine');
    });
});
