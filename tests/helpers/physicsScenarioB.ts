import type { Body } from 'cannon-es';
import { quat } from 'gl-matrix';
import { PhysicsSystem } from '../../src/physics/physicsSystem';
import { RigidBody, Trigger } from '../../src/physics/body';
import { Shape } from '../../src/physics/shape';
import { Node } from '../../src/core/scene/nodes/node';
import type { ModelNode } from '../../src/core/scene/nodes/modelNode';
import { WaterVolumeNode } from '../../src/core/scene/nodes/waterVolumeNode';
import { FoliageColliderField } from '../../src/terrain/foliageColliders';

// The second pinned physics scene: what physicsScenario.ts leaves out. A dynamic body whose collider is
// offset from its node (so its centre of mass is too), a cube created already rotated, a continuous
// blade trigger crossing a hurtbox trigger (with the contact point and sweep fraction its listener gets),
// a trigger zone crossed by a rolling ball, a profile ragdoll for 60 frames, pooled foliage colliders
// evicted and re-added under a body resting on them, a cylinder floating in water, and the answers of
// every kind of query: rays (plain, ground-only, camera), overlaps and sweeps. Recorded before physics
// moved behind its backend interface, so that move cannot quietly change any of it.

export interface ScenarioBTrace {
    /** Every 10th frame: each tracked body's node-origin position, quaternion, velocity, angular velocity. */
    states: number[][];
    /** Every 10th frame: the queries' answers. */
    queries: unknown[][];
    /** Trigger listener and collide events, in the order they were heard. */
    events: string[];
    /** The foliage pool's live body count, every frame. */
    foliage: number[];
}

/** A physics system as the engine sets one up for a scene with water, gravity at the engine default. */
export function scenarioBPhysics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.82, 0] });
    p.initialize();
    return p;
}

/** A fake foliage layer: a grid of trunks, found the way FoliageLayer.forEachInstanceNear finds them. */
function trunkLayer() {
    const instances: [number, number, number, number, number][] = [];
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) instances.push([-18 + i * 1.5, 0, -18 + j * 1.5, i * 0.4 + j * 0.1, 1 + 0.1 * ((i + j) % 3)]);
    return {
        key: 'trunks', version: 1, count: instances.length, cameraDither: false,
        collision: { shape: 'cylinder', radius: 0.3, height: 3 },
        forEachInstanceNear(cx: number, cz: number, r: number, cb: (index: number, x: number, y: number, z: number, yaw: number, scale: number) => void) {
            instances.forEach(([x, y, z, yaw, s], index) => { if ((x - cx) ** 2 + (z - cz) ** 2 <= r * r) cb(index, x, y, z, yaw, s); });
        },
    };
}

/** Where `b`'s NODE sits: a RigidBody/Trigger knows its centre-of-mass offset, a plain body has none. */
function origin(b: Body): [number, number, number] {
    const o = (b as any).originPosition;
    if (typeof o === 'function') { const out: [number, number, number] = [0, 0, 0]; o.call(b, out); return out; }
    return [b.position.x, b.position.y, b.position.z];
}

const names = (hits: { node: Node | null }[]) => hits.map(h => h.node?.name ?? '-');

/**
 * Drive scene B for `frames` frames. `dts` is cycled for the frame deltas (one value = a steady rate).
 * `lag` as in physicsScenario.ts: 1 with the worker. `mannequin` makes the ragdoll's model (the real
 * skinned rig, see ragdollProfile.test.ts); null leaves the ragdoll out.
 */
export function runScenarioB(p: PhysicsSystem, mannequin: (() => ModelNode) | null, frames = 200, dts: number[] = [1 / 60], lag = 0, every = 10): ScenarioBTrace {
    const events: string[] = [];
    const camera = { worldPosition: [0, 2, 0] as number[] };
    const water = new WaterVolumeNode('Pond', { size: [6, 3, 6], waveAmplitude: 0.05, waveFrequency: 0.5 } as any);
    water.setPosition([20, -3, 0]);
    water.updateTransforms?.();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: camera, waterVolumes: new Set([water]) };

    const ground = new RigidBody({ mass: 0, position: [0, -0.5, 0], friction: 0.5 }, new Node('Ground'));
    ground.attachShape(Shape.Box(200, 1, 200));
    p.addBody(ground);

    // A box hung off its node: the collider is offset, so the centre of mass sits off the node origin.
    const offset = new RigidBody({ mass: 10, position: [0, 3, -5], quaternion: quat.fromEuler(quat.create(), 0, 0, 20) as any, friction: 0.4 }, new Node('Offset'));
    offset.attachShape(Shape.Box(1, 0.5, 1), [0.4, 0.2, 0]);
    offset.recenterMass();
    p.addBody(offset);
    offset.addEventListener('collide', (e: any) => events.push(`Offset hit ${e.body?.owner?.name ?? '?'}`));

    // A cube created already rotated (its inertia is measured with that rotation taken out).
    const cube = new RigidBody({ mass: 3, position: [2, 4, -5], quaternion: quat.fromEuler(quat.create(), 30, 45, 10) as any, restitution: 0.2 }, new Node('Cube'));
    cube.attachShape(Shape.Box(1, 1, 1));
    cube.recenterMass();
    p.addBody(cube);

    // A thin continuous blade sweeping past a hurtbox, too fast to be caught frame by frame.
    const HURT = 1 << 8, HIT = 1 << 10;
    const hurt = new Trigger({ position: [6, 0, 4], group: HURT, mask: HIT }, new Node('Hurt'));
    hurt.setCapsule([0, 0.3, 0], [0, 1.5, 0], 0.3);
    p.addBody(hurt);
    const blade = new Trigger({ position: [2, 1, 4], group: HIT, mask: HURT, detectTriggers: true, continuous: true }, new Node('Blade'));
    blade.setCapsule([0, 0, -0.5], [0, 0, 0.5], 0.05);
    p.addBody(blade);
    const log = (c: any) => events.push(`${c.self.owner?.name} ${c.phase} ${c.node?.name ?? '-'} ${c.point ? c.point.join(',') : 'null'} ${c.fraction}`);
    hurt.onContact(log);
    blade.onContact(log);

    // A zone a ball rolls through.
    const zone = new Trigger({ position: [10, 0.5, -10] }, new Node('Zone'));
    zone.attachShape(Shape.Box(2, 2, 2));
    p.addBody(zone);
    zone.onContact(log);
    const ball = new RigidBody({ mass: 1, position: [7, 0.3, -10] }, new Node('Ball'));
    ball.attachShape(Shape.Sphere(0.3));
    p.addBody(ball);
    ball.velocity.set(5, 0, 0);

    // A cylinder floating on its side.
    const floater = new RigidBody({ mass: 40, position: [20, 1, 1], quaternion: quat.fromEuler(quat.create(), 90, 0, 0) as any }, new Node('Floater'));
    floater.attachShape(Shape.Cylinder(0.4, 0.4, 1.2, 12));
    floater.recenterMass();
    p.addBody(floater);

    // A ball resting on a trunk of the pooled foliage, which is evicted under it and comes back.
    const field = new FoliageColliderField();
    const layers = [trunkLayer()] as any;
    const settings = { enabled: true, radius: 6, maxBodies: 10 };
    const nest = new RigidBody({ mass: 2, position: [-18, 3.6, -18], friction: 0.6 }, new Node('Nest'));
    nest.attachShape(Shape.Sphere(0.25));
    p.addBody(nest);

    const ragdollNode = mannequin ? mannequin() : null;
    let ragdollBodies: any[] = [];

    const tracked: Body[] = [offset, cube, ball, floater, nest];
    const trace: ScenarioBTrace = { states: [], queries: [], events, foliage: [] };

    for (let frame = 0; frame < frames + lag; frame++) {
        const dt = dts[frame % dts.length];
        p.update(dt);
        const f = frame - lag;
        if (f < 0) { p.endFrame(dt); continue; }

        if (f % every === 0) {
            const row: number[] = [];
            for (const b of [...tracked, ...ragdollBodies]) {
                row.push(...origin(b), b.quaternion.x, b.quaternion.y, b.quaternion.z, b.quaternion.w,
                    b.velocity.x, b.velocity.y, b.velocity.z, b.angularVelocity.x, b.angularVelocity.y, b.angularVelocity.z);
            }
            trace.states.push(row);

            const hit = p.raycast([0, 5, -5], [0, -1, -5]);
            const ground1 = p.raycast([-18, 6, -18], [-18, -1, -18], { groundOnly: true });
            const ground2 = p.raycast([-18, 6, -18], [-18, -1, -18], { groundOnly: true, ignore: nest });
            const cam = p.raycastCamera([0, 1.2, 4] as any, [9, 1.2, 4] as any);
            const camGhost = p.raycastCamera([0, 1.2, 4] as any, [9, 1.2, 4] as any, owner => owner?.name === 'Hurt');
            trace.queries.push([
                hit ? [hit.node?.name ?? '-', hit.distance, ...hit.normal, ...hit.point] : null,
                ground1 ? [ground1.node?.name ?? '-', ground1.distance] : null,
                ground2 ? [ground2.node?.name ?? '-', ground2.distance] : null,
                cam, camGhost,
                names(p.overlapSphere([1, 0.5, -5], 1.6)),
                p.overlapCapsule([-1, 0.2, -5], [3, 0.2, -5], 0.6).map(h => [h.node?.name ?? '-', ...h.point]),
                names(p.overlapBox([6, 1, 4], [1, 1, 1], [0, 0.3826834, 0, 0.9238795], { includeTriggers: true })),
                p.sweepSphere([3, 0.3, -10], [12, 0.3, -10], 0.2).map(h => [h.node?.name ?? '-', h.fraction]),
            ]);
        }

        // ---- the "scripts" ----
        // The blade crosses the hurtbox in 0.6 m strides (wider than the hurtbox), and comes back.
        const bx = f < 40 ? 2 + f * 0.6 : f < 80 ? 26 - (f - 40) * 0.6 : 2;
        blade.position.set(bx, 1, 4);
        blade.aabbNeedsUpdate = true;

        // The foliage: around the nest, then the camera leaves (every trunk evicted), then returns.
        const camAt = f < 60 || f >= 120 ? [-17, 2, -17] : [100, 2, 100];
        camera.worldPosition = camAt;
        field.update(p, layers, camAt as any, [0, 0, 0], settings);
        trace.foliage.push(field.activeCount);

        // A shove, and a teleport of the rotated cube.
        if (f === 30) offset.impulse([0, 2, -3], [0.2, 0, 0]);
        if (f === 90) { cube.setPosition([2, 3, -5]); cube.setQuaternion(quat.fromEuler(quat.create(), 0, 90, 45)); cube.wakeUp(); }

        // The ragdoll: 60 frames of it.
        if (ragdollNode && f === 10) {
            const r = p.startRagdoll(ragdollNode);
            ragdollBodies = [...r.bodies.values()];
        }
        if (ragdollNode && f === 70) { p.stopRagdoll(ragdollNode); ragdollBodies = []; }

        p.endFrame(dt);
    }
    field.dispose(p);
    return trace;
}
