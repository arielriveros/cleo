import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Scene } from '../src/core/scene/scene';
import { Node } from '../src/core/scene/nodes/node';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { parseBehaviorMachine, stepBehavior, createBehaviorRuntime, isDefaultBehaviorMachine } from '../src/core/control/behavior';

// A brain's layers, outputs and the values it reads off the pawn's body: a Health layer going Fine → Hurt on a knock
// and back after a while, a Weapon layer picking the gun, outputs writing the pawn's fields (the topmost layer's
// winning, a field put back once nothing sets it), a counter raising a trigger once per rise, a strafe stepping off a
// moving target's path, and a target sat in a moving vehicle read by the vehicle's motion.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const H = 1 / 60;
const and = (...children: object[]) => ({ op: 'and', children });

/** A guard and its quarry, a brain possessing the guard, and stand-in reactions it reads its knocks from. */
function world(targetAt: [number, number, number] = [0, 0, 10]) {
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
    const reactions = { knockCount: 0, hitCount: 0, ragdolled: false, staggering: false, hasControl: true, pain: 0 };
    Object.defineProperty(guard, 'reactions', { get: () => reactions, configurable: true });
    (guard as any).weapon = 2;
    (guard as any).hurt = false;
    scene.start();
    const run = (seconds: number) => { for (let t = 0; t < seconds - 1e-9; t += H) scene.update(H, 0, false); };
    return { scene, guard, quarry, brain, reactions, run };
}

/** Health (Fine → Hurt on a knock, back after `hurtFor` s in Hurt) and Weapon (Rifle, Shotgun near, Pistol hurt). */
const fighter = (hurtFor = 12) => parseBehaviorMachine({
    parameters: [
        { name: 'Knocked', type: 'trigger', default: false, source: { kind: 'reaction', name: 'knockCount' } },
        { name: 'Hurt For', type: 'number', default: 0, source: { kind: 'layerTime', layer: 'Health' } },
        { name: 'Is Hurt', type: 'boolean', default: false, source: { kind: 'layerState', layer: 'Health', state: 'Hurt' } },
        { name: 'Distance', type: 'number', default: 99, source: { kind: 'sense', name: 'planarDistanceToTarget' } },
    ],
    states: [{ name: 'Engage', goal: 'idle', isEntry: true }],
    transitions: [],
    layers: [
        {
            name: 'Health',
            states: [{ name: 'Fine', goal: 'idle', isEntry: true }, { name: 'Hurt', goal: 'idle', outputs: [{ field: 'hurt', value: true }] }],
            transitions: [
                { from: '*', to: 'Hurt', restart: true, condition: and({ param: 'Knocked', op: 'trigger' }) },
                { from: 'Hurt', to: 'Fine', condition: and({ param: 'Hurt For', op: 'gt', value: hurtFor }) },
            ],
        },
        {
            name: 'Weapon',
            states: [
                { name: 'Rifle', goal: 'idle', isEntry: true, outputs: [{ field: 'weapon', value: 2 }] },
                { name: 'Shotgun', goal: 'idle', outputs: [{ field: 'weapon', value: 3 }] },
                { name: 'Pistol', goal: 'idle', outputs: [{ field: 'weapon', value: 1 }] },
            ],
            transitions: [
                { from: '*', to: 'Pistol', condition: and({ param: 'Is Hurt', op: 'true' }) },
                { from: 'Pistol', to: 'Rifle', condition: and({ param: 'Is Hurt', op: 'false' }) },
                { from: 'Rifle', to: 'Shotgun', condition: and({ param: 'Distance', op: 'lt', value: 3 }) },
                { from: 'Shotgun', to: 'Rifle', condition: and({ param: 'Distance', op: 'gt', value: 4 }) },
            ],
        },
    ],
});

describe('a brain with layers', () => {
    it('runs its layers beside the top level: hurt on a knock, the pistol while hurt, back after its time', () => {
        const w = world();
        w.brain.behavior = fighter(12);
        w.run(0.5);
        expect([w.brain.behaviorState, w.brain.behaviorLayerState('Health'), w.brain.behaviorLayerState('Weapon')]).toEqual(['Engage', 'Fine', 'Rifle']);
        expect((w.guard as any).weapon).toBe(2);
        // Knocked down: hurt, and the pistol.
        w.reactions.knockCount++;
        w.run(0.2);
        expect([w.brain.behaviorLayerState('Health'), w.brain.behaviorLayerState('Weapon')]).toEqual(['Hurt', 'Pistol']);
        expect([(w.guard as any).hurt, (w.guard as any).weapon]).toEqual([true, 1]);
        // Still hurt after ten seconds; fine again past twelve, the rifle back and the hurt field as it was.
        w.run(10);
        expect((w.guard as any).hurt).toBe(true);
        w.run(2.5);
        expect([w.brain.behaviorLayerState('Health'), w.brain.behaviorLayerState('Weapon')]).toEqual(['Fine', 'Rifle']);
        expect([(w.guard as any).hurt, (w.guard as any).weapon]).toEqual([false, 2]);
    });

    it('another knock while hurt starts its time over', () => {
        const w = world();
        w.brain.behavior = fighter(12);
        w.run(0.2);
        w.reactions.knockCount++;
        w.run(8);
        w.reactions.knockCount++;
        w.run(8);
        expect(w.brain.behaviorLayerState('Health')).toBe('Hurt');
    });

    it('picks the shotgun within 3 m and the rifle again past 4', () => {
        const w = world([0, 0, 2]);
        w.brain.behavior = fighter();
        w.run(0.3);
        expect((w.guard as any).weapon).toBe(3);
        w.quarry.setPosition([0, 0, 5]);
        w.run(0.3);
        expect((w.guard as any).weapon).toBe(2);
    });

    it('a counter raises its trigger once per rise, not on its first read, and a raise nothing takes comes down', () => {
        const m = parseBehaviorMachine({
            parameters: [{ name: 'Knocked', type: 'trigger', default: false, source: { kind: 'reaction', name: 'knockCount' } }],
            states: [{ name: 'A', goal: 'idle', isEntry: true }, { name: 'B', goal: 'idle' }],
            transitions: [{ from: 'A', to: 'B', minDwell: 0.5, condition: and({ param: 'Knocked', op: 'trigger' }) }],
        });
        const w = world();
        w.reactions.knockCount = 3;
        w.brain.behavior = m;
        w.run(1);
        // Three knocks already when it started: no trigger for them.
        expect(w.brain.behaviorState).toBe('A');
        const fresh = world();
        fresh.brain.behavior = m;
        fresh.run(0.1);
        // A knock inside the dwell: raised, not taken, and down again by the time the dwell is over.
        fresh.reactions.knockCount++;
        fresh.run(1);
        expect(fresh.brain.behaviorState).toBe('A');
        fresh.reactions.knockCount++;
        fresh.run(0.1);
        expect(fresh.brain.behaviorState).toBe('B');
    });

    it('the topmost layer wins a field two set; a not-held output is written once as its state is entered', () => {
        const w = world();
        w.brain.behavior = parseBehaviorMachine({
            parameters: [{ name: 'Go', type: 'boolean', default: false, source: { kind: 'blackboard', key: 'go' } }],
            states: [{ name: 'Base', goal: 'idle', isEntry: true, outputs: [{ field: 'weapon', value: 5 }] }],
            transitions: [],
            layers: [
                { name: 'Low', states: [{ name: 'L', goal: 'idle', isEntry: true, outputs: [{ field: 'weapon', value: 6 }] }], transitions: [] },
                {
                    name: 'High',
                    states: [{ name: 'Off', goal: 'idle', isEntry: true }, { name: 'On', goal: 'idle', outputs: [{ field: 'weapon', value: 7 }, { field: 'hurt', value: true, hold: false }] }],
                    transitions: [{ from: 'Off', to: 'On', condition: and({ param: 'Go', op: 'true' }) }, { from: 'On', to: 'Off', condition: and({ param: 'Go', op: 'false' }) }],
                },
            ],
        });
        w.run(0.1);
        expect((w.guard as any).weapon).toBe(6);
        w.brain.setBlackboard('go', true);
        w.run(0.1);
        expect([(w.guard as any).weapon, (w.guard as any).hurt]).toEqual([7, true]);
        (w.guard as any).hurt = false;
        w.run(0.2);
        // Once: not written again while On is held.
        expect((w.guard as any).hurt).toBe(false);
        w.brain.setBlackboard('go', false);
        w.run(0.1);
        expect((w.guard as any).weapon).toBe(6);
    });
});

describe('strafing and moving targets', () => {
    const strafer = (side?: string, keep?: number) => parseBehaviorMachine({
        parameters: [],
        states: [{ name: 'Strafe', goal: 'strafe', targetKey: 'target', isEntry: true, ...(side ? { strafeSide: side } : {}), ...(keep ? { strafeDistance: keep } : {}) }],
        transitions: [],
    });

    it('steps square to the target, facing it, to the side it is told', () => {
        const w = world([0, 0, 10]);
        w.brain.behavior = strafer('left');
        w.run(0.2);
        const d = (w.brain as any)._desired, aim = (w.brain as any)._intent.aimYaw;
        // Facing +Z, its left is +X: it steps along X, looking down +Z.
        expect(Math.abs(d[2])).toBeLessThan(1e-6);
        expect(d[0]).toBeGreaterThan(0);
        expect(aim).toBeCloseTo(0, 3);
    });

    it('on auto steps off the path of a target crossing in front of it', () => {
        const w = world([0, 0, 10]);
        // Crossing to the guard's left (+X) at 6 m/s.
        Object.defineProperty(w.quarry, 'velocity', { get: () => new Float32Array([6, 0, 0]), configurable: true });
        w.brain.behavior = strafer();
        w.run(1.5);
        expect((w.brain as any)._desired[0]).toBeLessThan(0);
        Object.defineProperty(w.quarry, 'velocity', { get: () => new Float32Array([-6, 0, 0]), configurable: true });
        w.run(2);
        expect((w.brain as any)._desired[0]).toBeGreaterThan(0);
    });

    it('keeps its distance as it steps: closing in from far, backing off from near', () => {
        const far = world([0, 0, 20]);
        far.brain.behavior = strafer('left', 8);
        far.run(0.1);
        expect((far.brain as any)._desired[2]).toBeGreaterThan(0);
        const near = world([0, 0, 3]);
        near.brain.behavior = strafer('left', 8);
        near.run(0.1);
        expect((near.brain as any)._desired[2]).toBeLessThan(0);
    });

    it('reads a target sat in a moving vehicle by the vehicle: its speed, its way across, and that it is in one', () => {
        const w = world([0, 0, 10]);
        // The quarry's Collider out of the world, under a car's seat: the car carries it.
        const car = new Node('car');
        Object.defineProperty(car, 'body', { get: () => ({ velocity: { x: 8, y: 0, z: 0 } }), configurable: true });
        const seat = new Node('seat');
        const collider = new ColliderNode('quarry collider');
        w.scene.addNode(car);
        car.addChild(seat);
        seat.addChild(collider);
        w.quarry.parent?.removeChild?.(w.quarry);
        collider.addChild(w.quarry);
        collider._bodySuspended = true;
        car.setPosition([0, 0, 10]);
        w.brain.behavior = parseBehaviorMachine({
            parameters: [
                { name: 'In Car', type: 'boolean', default: false, source: { kind: 'sense', name: 'targetInVehicle' } },
                { name: 'Speed', type: 'number', default: 0, source: { kind: 'sense', name: 'targetSpeed' } },
                { name: 'Across', type: 'number', default: 0, source: { kind: 'sense', name: 'targetLateralSpeed' } },
            ],
            states: [{ name: 'A', goal: 'idle', isEntry: true }], transitions: [],
        });
        w.run(0.1);
        const v = (w.brain as any)._behaviorRuntime.ctx.values;
        expect([v.get('In Car'), v.get('Speed')]).toEqual([true, 8]);
        // Facing it down +Z, +X is its left: the car crosses to the left.
        expect(v.get('Across')).toBeCloseTo(8, 3);
    });
});

describe('reading a machine with layers', () => {
    it('keeps its layers, their states and their transitions, drops a transition naming a state of another table, and reads the same twice', () => {
        const raw = {
            parameters: [], states: [{ name: 'A', goal: 'idle' }], transitions: [],
            layers: [{ name: 'L', enabled: false, states: [{ name: 'X', goal: 'idle', outputs: [{ field: 'f', value: 1, hold: false }, { field: 'f', value: 2 }] }, { name: 'Y', goal: 'strafe', strafeSide: 'right', strafeDistance: 6 }],
                transitions: [{ from: 'X', to: 'Y' }, { from: 'X', to: 'A' }] }],
        };
        const m = parseBehaviorMachine(raw);
        expect(m.layers).toEqual([{ name: 'L', enabled: false, states: [{ name: 'X', goal: 'idle', outputs: [{ field: 'f', value: 1, hold: false }] }, { name: 'Y', goal: 'strafe', strafeSide: 'right', strafeDistance: 6 }], transitions: [{ from: 'X', to: 'Y' }] }]);
        expect(parseBehaviorMachine(JSON.parse(JSON.stringify(m)))).toEqual(m);
        expect(isDefaultBehaviorMachine({ parameters: [], states: [], transitions: [], layers: [{ name: 'L', states: [], transitions: [] }] })).toBe(false);
        // A machine without layers steps as it always did.
        const plain = parseBehaviorMachine({ parameters: [], states: [{ name: 'A', goal: 'idle' }], transitions: [] });
        expect('layers' in plain).toBe(false);
        const s = stepBehavior(plain, createBehaviorRuntime(), H);
        expect([s.state?.name, s.entered]).toEqual(['A', true]);
    });
});
