import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vec3 } from 'gl-matrix';
import { Scene } from '../src/core/scene/scene';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';
import { CleoEngine } from '../src/core/engine';
import { moveWorldDirection } from '../src/core/control/intent';

// The flock goal reaching the steering layer. The gather is the part with judgement in it: there is
// no spatial index, on purpose -- it would be a third structure after cannon's broadphase and every
// Geometry's BVH, with this as its only consumer, over agent counts in the tens.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

interface World {
    scene: Scene;
    self: CharacterNode;
    brain: ControllerNode;
    mates: CharacterNode[];
}

/** One flocking agent plus `count` mates the caller positions. */
function world(count: number): World {
    const scene = new Scene();
    const self = new CharacterNode('self');
    const brain = new ControllerNode('brain');
    scene.addNode(self);
    scene.addNode(brain);
    brain.possess(self);
    brain.controlSource = 'ai';
    brain.autoAcquire = false;
    brain.goal = 'flock';

    const mates: CharacterNode[] = [];
    for (let i = 0; i < count; i++) {
        const mate = new CharacterNode('mate' + i);
        scene.addNode(mate);
        mates.push(mate);
    }
    scene.start();
    return { scene, self, brain, mates };
}

function direction(w: World): vec3 {
    return moveWorldDirection(vec3.create(), w.self.intent);
}

describe('the flock goal', () => {
    it('holds still when there is nobody to flock with', () => {
        // A flock of one has no group to move with. Wandering instead would make "flock" quietly mean
        // two different things depending on how many friends happened to be nearby.
        const w = world(0);
        w.scene.update(1 / 60, 0, false);
        expect(vec3.length(direction(w))).toBe(0);
        expect(w.brain.neighborCount).toBe(0);
    });

    it('steers toward a group that is entirely on one side', () => {
        const w = world(2);
        // Both mates well beyond the separation push, so cohesion dominates.
        w.mates[0].setPosition([0, 0, 5]);
        w.mates[1].setPosition([0, 0, 6]);
        // Cohesion only, so the direction is unambiguous.
        w.brain.separationWeight = 0;
        w.brain.alignmentWeight = 0;
        w.brain.cohesionWeight = 1;

        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(2);
        expect(direction(w)[2]).toBeGreaterThan(0);
    });

    it('pushes away from someone standing on top of it', () => {
        const w = world(1);
        w.mates[0].setPosition([0, 0, 1]);
        w.brain.separationWeight = 1;
        w.brain.alignmentWeight = 0;
        w.brain.cohesionWeight = 0;

        w.scene.update(1 / 60, 0, false);
        expect(direction(w)[2]).toBeLessThan(0);
    });

    it('counts only the mates inside the radius', () => {
        const w = world(2);
        w.mates[0].setPosition([0, 0, 2]);
        w.mates[1].setPosition([0, 0, 500]);
        w.brain.flockRadius = 6;

        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(1);
    });

    it('never counts its own pawn', () => {
        const w = world(0);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(0);
    });

    it('flocks with nobody at a zero radius, which is how it is switched off', () => {
        const w = world(2);
        w.mates[0].setPosition([0, 0, 1]);
        w.mates[1].setPosition([0, 0, 2]);
        w.brain.flockRadius = 0;

        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(0);
        expect(vec3.length(direction(w))).toBe(0);
    });

    // The arrays are reused between frames, so a shrinking flock must not leave stale entries that
    // the steers would still read.
    it('shrinks its neighbour list when mates leave', () => {
        const w = world(3);
        for (let i = 0; i < 3; i++) w.mates[i].setPosition([0, 0, 1 + i]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(3);

        w.mates[1].setPosition([0, 0, 500]);
        w.mates[2].setPosition([0, 0, 500]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(1);
    });

    it('stops counting a despawned mate', () => {
        const w = world(1);
        w.mates[0].setPosition([0, 0, 2]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(1);

        w.scene.removeNode(w.mates[0]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(0);
    });
});

describe('the neighborCount sense', () => {
    it('answers even when no flock goal is running', () => {
        // A machine may ask "am I alone" while doing something else entirely.
        const w = world(1);
        w.brain.goal = 'idle';
        w.mates[0].setPosition([0, 0, 2]);
        w.scene.update(1 / 60, 0, false);
        expect(w.brain.neighborCount).toBe(1);
    });
});

describe('persistence', () => {
    it('round-trips the flock tuning', async () => {
        const brain = new ControllerNode('brain');
        brain.flockRadius = 12;
        brain.separationWeight = 3;
        brain.alignmentWeight = 0.25;
        brain.cohesionWeight = 0;

        const json = await brain.serialize() as any;
        expect(json.flockRadius).toBe(12);
        expect(json.separationWeight).toBe(3);
        expect(json.alignmentWeight).toBe(0.25);
        expect(json.cohesionWeight).toBe(0);
    });

    it('gives a controller written before flocking existed sensible defaults', () => {
        const brain = new ControllerNode('brain');
        expect(brain.flockRadius).toBeGreaterThan(0);
        expect(brain.separationWeight).toBeGreaterThan(brain.cohesionWeight);
    });
});
