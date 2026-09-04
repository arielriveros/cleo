import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { CleoEngine } from '../src/core/engine';
import { parseFuzzyModel } from '../src/ai/fuzzy';
import { parseBehaviorMachine } from '../src/core/control/behavior';

// Fuzzy output reaching a behaviour machine, end to end. The wiring worth pinning is the INPUT
// CONVENTION: a fuzzy variable is fed by NAME from the vocabulary that already exists -- a sense
// first, then a motion builtin on the pawn, then a numeric blackboard entry. There is no mapping
// table to author, which means there is no mapping table to get out of step with the variable names.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

/** distanceToTarget 0..40 in two bands, driving `commitment` 0..100. */
const MODEL = parseFuzzyModel({
    variables: [
        { name: 'distanceToTarget', sets: [
            { name: 'near', shape: 'leftShoulder', left: 0, mid: 5, right: 40 },
            { name: 'far', shape: 'rightShoulder', left: 0, mid: 30, right: 40 },
        ] },
        { name: 'commitment', sets: [
            { name: 'low', shape: 'leftShoulder', left: 0, mid: 10, right: 50 },
            { name: 'high', shape: 'rightShoulder', left: 50, mid: 90, right: 100 },
        ] },
    ],
    rules: [
        { antecedent: { op: 'is', variable: 'distanceToTarget', set: 'near' }, variable: 'commitment', set: 'high' },
        { antecedent: { op: 'is', variable: 'distanceToTarget', set: 'far' }, variable: 'commitment', set: 'low' },
    ],
});

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
    brain.fuzzy = MODEL;
    brain.setBlackboard('target', quarry.id);
    scene.start();
    return { scene, guard, quarry, brain };
}

/** A machine whose only transition is gated on the fuzzy output crossing a threshold. */
function commitMachine() {
    return parseBehaviorMachine({
        parameters: [
            { name: 'commitment', type: 'number', default: 0, source: { kind: 'fuzzy', name: 'commitment' } },
        ],
        states: [
            { name: 'Wait', goal: 'idle', isEntry: true },
            { name: 'Chase', goal: 'seek', targetKey: 'target' },
        ],
        transitions: [
            { from: 'Wait', to: 'Chase', condition: { op: 'and', children: [
                { param: 'commitment', op: 'gt', value: 50 },
            ] } },
        ],
    });
}

describe('a fuzzy model on a controller', () => {
    it('feeds an input variable from the sense of the same name', () => {
        const w = world();
        w.quarry.setPosition([0, 0, 2]);
        w.scene.update(1 / 60, 0, false);
        const near = w.brain.fuzzyValue('commitment');

        w.quarry.setPosition([0, 0, 38]);
        w.scene.update(1 / 60, 0, false);
        const far = w.brain.fuzzyValue('commitment');

        // Close means committed; far means not. If the input were never fed, both would be identical.
        expect(near).toBeGreaterThan(far);
    });

    it('answers 0 for an output nothing writes, and for no model at all', () => {
        const w = world();
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.fuzzyValue('nonsense')).toBe(0);

        const bare = new ControllerNode('bare');
        expect(bare.fuzzyValue('commitment')).toBe(0);
    });

    it('drives a behaviour transition through a fuzzy parameter', () => {
        const w = world();
        w.brain.behavior = commitMachine();

        // Far away: commitment stays under the threshold and the machine holds.
        w.quarry.setPosition([0, 0, 38]);
        w.scene.update(1 / 60, 0, false);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.behaviorState).toBe('Wait');

        // Close: commitment crosses and the machine commits.
        w.quarry.setPosition([0, 0, 1]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.behaviorState).toBe('Chase');
    });

    it('rebuilds when the authored model is replaced', () => {
        const w = world();
        w.quarry.setPosition([0, 0, 2]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.fuzzyValue('commitment')).toBeGreaterThan(0);

        // A model with no rules decides nothing -- and must not leave the previous answer standing.
        w.brain.fuzzy = parseFuzzyModel(null);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.fuzzyValue('commitment')).toBe(0);
    });
});

describe('persistence', () => {
    it('writes nothing for a controller that never authored a model', async () => {
        const brain = new ControllerNode('brain');
        const json = await brain.serialize() as any;
        expect(json.fuzzy).toBeUndefined();
    });

    it('round-trips an authored model', async () => {
        const brain = new ControllerNode('brain');
        brain.fuzzy = MODEL;
        const json = await brain.serialize() as any;
        expect(json.fuzzy.variables).toHaveLength(2);
        expect(json.fuzzy.rules).toHaveLength(2);

        const reparsed = parseFuzzyModel(JSON.parse(JSON.stringify(json.fuzzy)));
        expect(reparsed.variables).toHaveLength(2);
        expect(reparsed.rules).toHaveLength(2);
    });
});
