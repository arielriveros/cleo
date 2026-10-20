import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { parseBehaviorMachine } from '../src/core/control/behavior';

// A player on a ledge straight over an enemy is 3 m away in a straight line and 0 m away on the ground,
// which is where steering and melee reach both live. A machine banding Approach on the straight line
// never left it: the seek overshot the point under the target and flipped direction every frame.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

function world(targetAt: [number, number, number]) {
    const scene = new Scene();
    const guard = new CharacterNode('guard');
    const quarry = new CharacterNode('quarry');
    const brain = new ControllerNode('brain');
    scene.addNode(guard);
    scene.addNode(quarry);
    scene.addNode(brain);
    quarry.setPosition(targetAt);
    brain.possess(guard);
    brain.controlSource = 'ai';
    brain.autoAcquire = false;
    brain.setBlackboard('target', quarry.id);
    scene.start();
    return { scene, guard, quarry, brain };
}

/** Approach until `sense` says closer than 1.8, then hold. */
function approachOn(sense: string) {
    return parseBehaviorMachine({
        parameters: [
            { name: 'Distance', type: 'number', default: 99, source: { kind: 'sense', name: sense } },
            { name: 'Height', type: 'number', default: 0, source: { kind: 'sense', name: 'heightToTarget' } },
        ],
        states: [
            { name: 'Approach', goal: 'seek', targetKey: 'target', isEntry: true },
            { name: 'Hold', goal: 'idle' },
            { name: 'Below', goal: 'idle' },
        ],
        transitions: [
            { from: 'Approach', to: 'Hold', condition: { op: 'and', children: [{ param: 'Distance', op: 'lt', value: 1.8 }] } },
            { from: 'Hold', to: 'Below', condition: { op: 'and', children: [{ param: 'Height', op: 'gt', value: 2 }] } },
        ],
    });
}

describe('planar senses', () => {
    it('reads a target overhead as close on the ground, and says how far up it is', () => {
        const w = world([0.5, 3, 0]);
        w.brain.behavior = approachOn('planarDistanceToTarget');
        for (let i = 0; i < 3; i++) w.scene.update(1 / 60, 0, false);
        // Hold, then Below: the planar distance released Approach and the height sense saw 3 m.
        expect(w.brain.behaviorState).toBe('Below');
    });

    it('is the straight-line sense that keeps approaching forever', () => {
        const w = world([0.5, 3, 0]);
        w.brain.behavior = approachOn('distanceToTarget');
        for (let i = 0; i < 3; i++) w.scene.update(1 / 60, 0, false);
        expect(w.brain.behaviorState).toBe('Approach');
    });

    it('agrees with the straight line on level ground', () => {
        const w = world([1, 0, 0]);
        w.brain.behavior = approachOn('planarDistanceToTarget');
        for (let i = 0; i < 3; i++) w.scene.update(1 / 60, 0, false);
        expect(w.brain.behaviorState).toBe('Hold');
    });
});
