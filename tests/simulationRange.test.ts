import { describe, it, expect } from 'vitest';
import { Box, Heightfield, Body, Sphere, Vec3 } from 'cannon-es';
import {
    SIMULATION_RANGE_HYSTERESIS, effectiveSimulationRange, parseSimulationMode, shouldFreeze,
} from '../src/physics/simulationRange';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { RigidBody } from '../src/physics/body';

// Simulation range: dynamic bodies far from the camera are frozen in place (still solid, not simulated) and
// woken when the camera comes back. The rules are pure (simulationRange.ts); the behaviour that matters to
// a game — nothing moves while frozen, it resumes where it left off, a frozen character never reads as
// falling — lives in PhysicsSystem and is exercised through update().

describe('simulation range rules', () => {
    it('resolves the range a body uses', () => {
        expect(effectiveSimulationRange('always', 10, 50)).toBe(Infinity);
        expect(effectiveSimulationRange('project', 10, 50)).toBe(50);
        expect(effectiveSimulationRange('custom', 10, 50)).toBe(10);
        // 0 means unlimited at either level.
        expect(effectiveSimulationRange('project', 10, 0)).toBe(Infinity);
        expect(effectiveSimulationRange('custom', 0, 50)).toBe(Infinity);
    });

    it('parses unknown modes as the project default', () => {
        expect(parseSimulationMode(undefined)).toBe('project');
        expect(parseSimulationMode('nonsense')).toBe('project');
        expect(parseSimulationMode('always')).toBe('always');
        expect(parseSimulationMode('custom')).toBe('custom');
    });

    it('freezes past the hysteresis band and wakes inside the range', () => {
        const r = 10, far = r * SIMULATION_RANGE_HYSTERESIS;
        expect(shouldFreeze(false, (r + 0.5) ** 2, r)).toBe(false);   // inside the band: stays awake
        expect(shouldFreeze(false, (far + 0.1) ** 2, r)).toBe(true);
        expect(shouldFreeze(true, (r + 0.5) ** 2, r)).toBe(true);     // inside the band: stays frozen
        expect(shouldFreeze(true, (r - 0.1) ** 2, r)).toBe(false);
        expect(shouldFreeze(false, 1e12, Infinity)).toBe(false);
    });
});

/** A physics system over a stand-in scene whose camera sits at `cam`. */
function physics(cam: [number, number, number]) {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0] });
    p.initialize();
    const camera = { worldPosition: cam };
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: camera };
    return { p, camera };
}

function ball(p: PhysicsSystem, at: [number, number, number], config: ConstructorParameters<typeof RigidBody>[0] = {}): RigidBody {
    const body = new RigidBody({ mass: 1, position: at, linearDamping: 0, ...config });
    body.addShape(new Sphere(0.25));
    p.addBody(body);
    return body;
}

const FRAME = 1 / 60;

describe('PhysicsSystem simulation range', () => {
    it('freezes a falling body out of range and resumes its fall when the camera returns', () => {
        const { p, camera } = physics([0, 0, 0]);
        p.simulationRange = 20;
        const body = ball(p, [40, 10, 0]);
        body.velocity.set(0, -3, 0);
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(true);
        const y = body.position.y;
        for (let i = 0; i < 30; i++) p.update(FRAME);
        expect(body.position.y).toBe(y);
        expect(p.stats.frozenBodies).toBe(1);

        camera.worldPosition = [35, 10, 0];
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(false);
        // Its velocity came back with it: still falling, a little faster after one frame of gravity.
        expect(body.velocity.y).toBeLessThan(-3);
        expect(body.position.y).toBeLessThan(y);
    });

    it('never freezes a body set to always, nor anything when the project range is unlimited', () => {
        const { p } = physics([0, 0, 0]);
        p.simulationRange = 20;
        const always = ball(p, [100, 10, 0], { simulationMode: 'always' });
        p.update(FRAME);
        expect(p.isFrozen(always)).toBe(false);

        const { p: q } = physics([0, 0, 0]);
        const far = ball(q, [1000, 10, 0]);
        q.update(FRAME);
        expect(q.isFrozen(far)).toBe(false);
    });

    it('uses a custom range over the project one', () => {
        const { p } = physics([0, 0, 0]);
        p.simulationRange = 100;
        const near = ball(p, [30, 5, 0], { simulationMode: 'custom', simulationRange: 10 });
        p.update(FRAME);
        expect(p.isFrozen(near)).toBe(true);
    });

    it('does not let script steering thaw a frozen body, but a hit does', () => {
        const { p } = physics([0, 0, 0]);
        p.simulationRange = 20;
        const body = ball(p, [40, 10, 0]);
        p.update(FRAME);
        body.velocity.set(2, 0, 0);
        body.wakeForMotion();            // what Node.velocity does
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(true);

        body.applyImpulse(new Vec3(0, 5, 0));
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(false);
        // And it is left awake for a grace period, rather than refrozen on the spot.
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(false);
    });

    it('holds a frozen grounded body grounded', () => {
        const { p } = physics([0, 0, 0]);
        p.simulationRange = 20;
        const body = ball(p, [40, 1, 0]);
        // Stand it on something by hand: the stamp is what isGrounded reads.
        (p as any)._record(body, 1, [0, 1, 0]);
        expect(p.isGrounded(body)).toBe(true);
        for (let i = 0; i < 60; i++) p.update(FRAME);
        expect(p.isFrozen(body)).toBe(true);
        expect(p.isGrounded(body)).toBe(true);
    });

    it('puts a resting canSleep body to sleep and wakes it when a script moves it', () => {
        const { p } = physics([0, 0, 0]);
        const floor = new Body({ mass: 0, shape: new Box(new Vec3(10, 0.5, 10)) });
        floor.position.set(0, -0.5, 0);
        p.addBody(floor);
        const body = ball(p, [0, 0.3, 0], { canSleep: true, linearDamping: 0.5 });
        for (let i = 0; i < 180; i++) p.update(FRAME);
        expect(p.isFrozen(body)).toBe(true);
        expect(p.stats.restingBodies).toBe(1);

        body.velocity.set(1, 0, 0);
        body.wakeForMotion();
        p.update(FRAME);
        expect(p.isFrozen(body)).toBe(false);
        expect(body.position.x).toBeGreaterThan(0);
    });

    it('does not report a trigger exit for a body that falls asleep inside it', () => {
        const { p } = physics([0, 0, 0]);
        const pairs = (p as any)._reportedPairs as Map<number, unknown>;
        const trigger = new Body({ mass: 0, isTrigger: true, shape: new Box(new Vec3(2, 2, 2)) });
        p.addBody(trigger);
        const floor = new Body({ mass: 0, shape: new Box(new Vec3(10, 0.5, 10)) });
        floor.position.set(0, -0.5, 0);
        p.addBody(floor);
        ball(p, [0, 0.3, 0], { canSleep: true, linearDamping: 0.5 });
        for (let i = 0; i < 30; i++) p.update(FRAME);
        expect(pairs.size).toBe(1);
        for (let i = 0; i < 150; i++) p.update(FRAME);
        expect(pairs.size).toBe(1);
    });

    it('collides with terrain through the replacement resolvers', () => {
        const { p } = physics([0, 0, 0]);
        const data = Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => 0));
        const terrain = new Body({ mass: 0 });
        terrain.addShape(new Heightfield(data, { elementSize: 1 }));
        terrain.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
        terrain.position.set(-10, 0, 10);
        p.addBody(terrain);
        const body = ball(p, [0.3, 2, 0.6]);
        for (let i = 0; i < 180; i++) p.update(FRAME);
        expect(Math.abs(body.position.y - 0.25)).toBeLessThan(0.02);
    });
});
