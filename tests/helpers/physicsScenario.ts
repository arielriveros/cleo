import { Body, Box, ConeTwistConstraint, Cylinder, HingeConstraint, LockConstraint, PointToPointConstraint, Sphere, Vec3, Quaternion } from 'cannon-es';
import { PhysicsSystem } from '../../src/physics/physicsSystem';
import { RigidBody, Trigger } from '../../src/physics/body';
import { Shape } from '../../src/physics/shape';
import { Node } from '../../src/core/scene/nodes/node';
import { WaterVolumeNode } from '../../src/core/scene/nodes/waterVolumeNode';

// One mixed physics scene, driven frame by frame the way the engine drives a game: physics.update, then
// the "scripts" (velocity writes, impulses, forces, a teleport, a camera move), then physics.endFrame.
// It covers what a game leans on: a box pile settling, a sphere rolling over a heightfield, a character
// steered by velocity with a ground probe walking through a trigger zone, a crate floating in water, a
// jointed chain (every constraint type a ragdoll uses), a body frozen by the simulation range and thawed
// again, collide events. The golden trace pins the inline step bit for bit; the worker parity tests run
// the same scene through the worker backend and must match it.

class Probe extends Node {
    constructor(name: string, private readonly log: string[]) { super(name); }
    onTriggerEnter(other: Node) { this.log.push(`${this.name} enter ${other.name}`); }
    onTriggerExit(other: Node) { this.log.push(`${this.name} exit ${other.name}`); }
}

export interface ScenarioTrace {
    /** Every 10th frame: each tracked body's position, quaternion, velocity, angular velocity. */
    states: number[][];
    triggers: string[];
    collides: string[];
    grounded: boolean[];
    frozen: boolean[];
}

/** A physics system as the engine sets one up for a scene with water and a camera. */
export function scenarioPhysics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0] });
    p.initialize();
    p.simulationRange = 30;
    return p;
}

/**
 * Drive the scene for `frames` frames. `lag` is how many frames the physics result trails the scripts:
 * 0 inline; 1 with the worker, whose step is posted at a frame's end and lands at the next one's start.
 * The scripts run against the same simulated state either way, so the traces must match.
 */
export function runScenario(p: PhysicsSystem, frames = 300, dt = 1 / 60, lag = 0): ScenarioTrace {
    const log: string[] = [];
    const collides: string[] = [];
    const camera = { worldPosition: [0, 2, 0] as number[] };
    const water = new WaterVolumeNode('Pond', { size: [6, 3, 6], waveAmplitude: 0.05, waveFrequency: 0.5 } as any);
    water.setPosition([20, -3, 0]);                   // surface at y = 0
    water.updateTransforms?.();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: camera, waterVolumes: new Set([water]) };

    // Ground.
    const ground = new RigidBody({ mass: 0, position: [0, -0.5, 0] }, new Node('Ground'));
    ground.attachShape(Shape.Box(200, 1, 200));
    p.addBody(ground);

    // A heightfield to the south, with a sphere rolling over it.
    const rows = 20, cols = 20;
    const heights: number[][] = [];
    for (let i = 0; i < rows; i++) { heights.push([]); for (let j = 0; j < cols; j++) heights[i].push(0.3 * Math.sin(i * 0.7) * Math.cos(j * 0.5)); }
    const field = new Body({ mass: 0 });
    field.addShape(Shape.Heightfield(heights, 1).cShape);
    field.position.set(-10, 0.05, 30);
    field.quaternion.setFromEuler(-Math.PI / 2, 0, 0);
    p.addBody(field);
    const roller = new RigidBody({ mass: 3, position: [-5, 2, 25] }, new Node('Roller'));
    roller.attachShape(Shape.Sphere(0.4));
    roller.velocity.set(1.5, 0, 0);
    p.addBody(roller);

    // A box pile.
    const boxes: RigidBody[] = [];
    for (let i = 0; i < 10; i++) {
        const b = new RigidBody({ mass: 2, position: [3 + (i % 3) * 0.55, 0.5 + Math.floor(i / 3) * 1.05, -2 + (i % 2) * 0.1], friction: 0.4 + (i % 2) * 0.2, restitution: i % 4 === 0 ? 0.3 : 0 }, new Node(`Box${i}`));
        b.attachShape(Shape.Box(1, 1, 1));
        b.recenterMass();
        p.addBody(b);
        boxes.push(b);
    }
    boxes[0].addEventListener('collide', (e: any) => collides.push(`Box0 hit ${e.body?.owner?.name ?? '?'}`));

    // The character: a capsule steered by velocity every frame, with a ground probe.
    const hero = new Node('Hero', 'character');
    const body = new RigidBody({ mass: 70, position: [-4, 0.95, 4], angularConstraints: [0, 0, 0], friction: 0, groundProbeDistance: 0.12, simulationMode: 'always' }, hero);
    for (const part of Shape.Capsule(0.3, 1.8, 12)) body.attachShape(part.shape, part.offset);
    body.recenterMass();
    p.addBody(body);

    // A trigger zone on the character's path.
    const zone = new Probe('Zone', log);
    const zoneTrigger = new Trigger({ position: [0, 1, 4] }, zone);
    zoneTrigger.attachShape(Shape.Box(2, 2, 2));
    p.addBody(zoneTrigger);
    const walker = new Probe('Walker', log);
    void walker;

    // A crate in the water, and one of a different surface beside it.
    const crate = new RigidBody({ mass: 120, position: [20, 1, 0] }, new Node('Crate'));
    crate.attachShape(Shape.Box(1, 1, 1));
    p.addBody(crate);

    // A jointed chain: every constraint a ragdoll uses.
    const links: Body[] = [];
    for (let i = 0; i < 4; i++) {
        const link = new Body({ mass: 1, position: new Vec3(-8, 4 - i * 0.6, -6) });
        link.addShape(i % 2 ? new Sphere(0.15) : new Cylinder(0.1, 0.1, 0.5, 8));
        p.addBody(link);
        links.push(link);
    }
    const anchor = new Body({ mass: 0, position: new Vec3(-8, 4.6, -6) });
    anchor.addShape(new Sphere(0.05));
    p.addBody(anchor);
    p.addConstraint(new PointToPointConstraint(anchor, new Vec3(0, -0.3, 0), links[0], new Vec3(0, 0.3, 0)));
    p.addConstraint(new ConeTwistConstraint(links[0], links[1], { pivotA: new Vec3(0, -0.3, 0), pivotB: new Vec3(0, 0.3, 0), axisA: Vec3.UNIT_Y, axisB: Vec3.UNIT_Y, angle: 0.6, twistAngle: 0.3 }));
    p.addConstraint(new HingeConstraint(links[1], links[2], { pivotA: new Vec3(0, -0.3, 0), pivotB: new Vec3(0, 0.3, 0), axisA: Vec3.UNIT_X, axisB: Vec3.UNIT_X }));
    p.addConstraint(new LockConstraint(links[2], links[3]));
    links[3].applyImpulse(new Vec3(2, 0, 0.5));

    // A body far out of the simulation range: frozen until the camera comes to it.
    const far = new RigidBody({ mass: 5, position: [45, 3, 0] }, new Node('Far'));
    far.attachShape(Shape.Sphere(0.5));
    p.addBody(far);

    const tracked: Body[] = [roller, ...boxes, body, crate, ...links, far];
    const trace: ScenarioTrace = { states: [], triggers: log, collides, grounded: [], frozen: [] };

    for (let frame = 0; frame < frames + lag; frame++) {
        p.update(dt);
        const f = frame - lag;
        if (f < 0) { (p as any).endFrame?.(dt); continue; }
        if (f % 10 === 0) {
            const row: number[] = [];
            for (const b of tracked) {
                row.push(b.position.x, b.position.y, b.position.z, b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
                    b.velocity.x, b.velocity.y, b.velocity.z, b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z);
            }
            trace.states.push(row);
        }
        trace.grounded.push(p.isGrounded(body));
        trace.frozen.push(p.isFrozen(far));

        // ---- the "scripts" ----
        // Walk east through the zone, then stop.
        body.velocity.x = f < 180 ? 2 : 0;
        body.wakeForMotion();
        // A shove, a steady push, a teleport.
        if (f === 50) boxes[9].applyImpulse(new Vec3(-6, 2, 0));
        if (f >= 60 && f < 90) boxes[8].applyForce(new Vec3(0, 0, 30));
        if (f === 120) { boxes[5].position.set(3, 6, 2); boxes[5].quaternion.copy(new Quaternion().setFromEuler(0.3, 0.2, 0.1)); boxes[5].aabbNeedsUpdate = true; boxes[5].wakeUp(); }
        // The camera walks out to the far body, which thaws, then comes back.
        if (f === 150) camera.worldPosition = [40, 2, 0];
        if (f === 240) camera.worldPosition = [0, 2, 0];

        (p as any).endFrame?.(dt);
    }
    return trace;
}
