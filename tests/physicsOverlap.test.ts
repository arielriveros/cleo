import { describe, it, expect } from 'vitest';
import { Body, Box, Cylinder, Sphere, Vec3, Quaternion } from 'cannon-es';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Node } from '../src/core/scene/nodes/node';
import { closestSegmentSegment, closestSegmentBox, sweepPoses } from '../src/physics/overlap';

// Volumetric queries (overlap + sweep) and trigger enter/exit. Combat in Hollow Keep is decided by these:
// a blade capsule swept from last frame's grip to this frame's against the characters' capsules, and
// interactables found by the trigger zones the player walks into rather than a per-frame distance scan.

type V3 = [number, number, number];

function physics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, 0, 0] });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    return p;
}

/** A character-like capsule (the engine's compound: a cylinder and two end spheres), standing at `at`. */
function capsuleBody(p: PhysicsSystem, at: V3, owner: Node | null, radius = 0.4, height = 1.8): Body {
    const body = new Body({ mass: 1, position: new Vec3(at[0], at[1] + height / 2, at[2]) });
    const cyl = height - 2 * radius;
    body.addShape(new Cylinder(radius, radius, cyl, 12));
    body.addShape(new Sphere(radius), new Vec3(0, cyl / 2, 0));
    body.addShape(new Sphere(radius), new Vec3(0, -cyl / 2, 0));
    (body as any).owner = owner;
    p.addBody(body);
    return body;
}

function boxBody(p: PhysicsSystem, at: V3, half: V3, owner: Node | null, yawDeg = 0): Body {
    const q = new Quaternion(); q.setFromEuler(0, yawDeg * Math.PI / 180, 0);
    const body = new Body({ mass: 0, position: new Vec3(...at), quaternion: q });
    body.addShape(new Box(new Vec3(...half)));
    (body as any).owner = owner;
    p.addBody(body);
    return body;
}

describe('overlap geometry', () => {
    it('finds the closest points between two segments', () => {
        const r = closestSegmentSegment([0, 0, 0], [2, 0, 0], [1, 1, -1], [1, 1, 1]);
        expect(Math.sqrt(r.dist2)).toBeCloseTo(1, 6);
        expect(r.c1).toEqual([1, 0, 0]);
        // Parallel segments, and a degenerate one (a point).
        expect(Math.sqrt(closestSegmentSegment([0, 0, 0], [1, 0, 0], [0, 2, 0], [1, 2, 0]).dist2)).toBeCloseTo(2, 6);
        expect(Math.sqrt(closestSegmentSegment([3, 0, 0], [3, 0, 0], [0, 0, 0], [1, 0, 0]).dist2)).toBeCloseTo(2, 6);
    });

    it('measures a segment against a box, including one that passes a corner', () => {
        expect(closestSegmentBox([-5, 2, 0], [5, 2, 0], [1, 1, 1]).dist2).toBeCloseTo(1, 5);
        expect(closestSegmentBox([-5, 0, 0], [5, 0, 0], [1, 1, 1]).dist2).toBe(0);          // through it
        const corner = closestSegmentBox([2, 2, -5], [2, 2, 5], [1, 1, 1]);
        expect(Math.sqrt(corner.dist2)).toBeCloseTo(Math.SQRT2, 4);
        expect(corner.onBox.slice(0, 2)).toEqual([1, 1]);                  // anywhere along that edge
    });

    it('samples a sweep finely enough that no step is longer than the radius, keeping the blade length', () => {
        const poses = sweepPoses([0, 0, 0], [0, 1, 0], [1, 0, 0], [1, 1, 0], 0.1);
        expect(poses.length).toBe(11);
        // A blade that rotates 90 degrees about its hilt keeps its length mid-sweep.
        const turn = sweepPoses([0, 0, 0], [0, 1, 0], [0, 0, 0], [1, 0, 0], 0.05);
        for (const pose of turn) {
            if (pose.kind !== 'capsule') continue;
            const len = Math.hypot(pose.b[0] - pose.a[0], pose.b[1] - pose.a[1], pose.b[2] - pose.a[2]);
            expect(len).toBeCloseTo(1, 5);
        }
    });
});

describe('physics overlap queries', () => {
    it('hits a character capsule once, however many cannon parts it has', () => {
        const p = physics();
        const enemy = new Node('enemy');
        capsuleBody(p, [0, 0, 0], enemy);
        const hits = p.overlapCapsule([-1, 1, 0.3], [1, 1, 0.3], 0.1);
        expect(hits.map(h => h.node)).toEqual([enemy]);
        expect(hits[0].point[2]).toBeCloseTo(0.4, 4);                     // on the capsule's surface
        expect(p.overlapCapsule([-1, 1, 0.6], [1, 1, 0.6], 0.1)).toEqual([]);
        // The rounded top counts: a sphere just over the head touches, one further up does not.
        expect(p.overlapSphere([0, 1.85, 0], 0.1).length).toBe(1);
        expect(p.overlapSphere([0, 2.0, 0], 0.1).length).toBe(0);
    });

    it('tests oriented boxes, both as targets and as the query', () => {
        const p = physics();
        const wall = new Node('wall');
        boxBody(p, [0, 1, 0], [2, 1, 0.1], wall, 90);                    // a thin wall turned to run along Z
        expect(p.overlapSphere([0.15, 1, 1.5], 0.1).length).toBe(1);
        expect(p.overlapSphere([0.25, 1, 1.5], 0.1).length).toBe(0);
        expect(p.overlapSphere([1.5, 1, 0], 0.1).length).toBe(0);         // where it would be unturned
        const enemy = new Node('enemy');
        capsuleBody(p, [3, 0, 0], enemy);
        expect(p.overlapBox([3, 1, 0], [0.5, 0.5, 0.5]).map(h => h.node)).toEqual([enemy]);
        expect(p.overlapBox([0, 1, 0], [0.5, 0.05, 0.05]).map(h => h.node)).toEqual([wall]);   // box vs box
    });

    it('skips the caster, triggers, ghosts and ragdoll bones unless told otherwise; filter has the last word', () => {
        const p = physics();
        const me = new Node('me'), zone = new Node('zone'), ghost = new Node('ghost'), bone = new Node('bone');
        capsuleBody(p, [0, 0, 0], me);
        const trig = new Body({ mass: 0, isTrigger: true, position: new Vec3(0, 1, 0) });
        trig.addShape(new Sphere(1)); (trig as any).owner = zone; p.addBody(trig);
        const g = capsuleBody(p, [0, 0, 0.2], ghost); g.collisionResponse = false;
        const r = capsuleBody(p, [0, 0, -0.2], bone); r.collisionFilterGroup = 2;

        const at = (opts?: any) => p.overlapSphere([0, 1, 0], 0.2, opts).map(h => h.node!.name).sort();
        expect(at()).toEqual(['me']);
        expect(at({ ignore: me })).toEqual([]);
        expect(at({ includeTriggers: true, includeGhosts: true, includeRagdolls: true })).toEqual(['bone', 'ghost', 'me', 'zone']);
        expect(at({ filter: (n: Node | null) => n !== me })).toEqual([]);
    });

    it('a sweep catches a target that one fast step would jump straight over', () => {
        const p = physics();
        const enemy = new Node('enemy');
        capsuleBody(p, [0, 0, 0], enemy, 0.3);
        // A blade swinging from left of the target to right of it in one frame: neither end pose touches.
        expect(p.overlapCapsule([-3, 1, 0.5], [-2, 1, 0.5], 0.05)).toEqual([]);
        expect(p.overlapCapsule([2, 1, 0.5], [3, 1, 0.5], 0.05)).toEqual([]);
        const hits = p.sweepCapsule([-3, 1, 0], [-2, 1, 0], [2, 1, 0], [3, 1, 0], 0.05);
        expect(hits.map(h => h.node)).toEqual([enemy]);
        expect(hits[0].fraction).toBeGreaterThan(0.2);
        expect(hits[0].fraction).toBeLessThan(0.6);
    });

    it('orders hits by when the sweep reached them', () => {
        const p = physics();
        const near = new Node('near'), far = new Node('far');
        capsuleBody(p, [3, 0, 0], far);
        capsuleBody(p, [1, 0, 0], near);
        const hits = p.sweepSphere([-1, 1, 0], [5, 1, 0], 0.1);
        expect(hits.map(h => h.node!.name)).toEqual(['near', 'far']);
        expect(hits[0].fraction).toBeLessThan(hits[1].fraction);
    });
});

describe('trigger enter / exit', () => {
    /** A node subclass recording its hooks, so dispatch goes through the real Node methods. */
    class Probe extends Node {
        public log: string[] = [];
        onTriggerEnter(other: Node) { this.log.push(`enter ${other.name}`); }
        onTriggerExit(other: Node) { this.log.push(`exit ${other.name}`); }
    }

    function zoneAndWalker() {
        const p = physics();
        const zone = new Probe('zone'), walker = new Probe('walker');
        const trig = new Body({ mass: 0, isTrigger: true, position: new Vec3(0, 1, 0) });
        trig.addShape(new Sphere(1)); (trig as any).owner = zone; p.addBody(trig);
        const body = capsuleBody(p, [5, 0, 0], walker);
        return { p, zone, walker, body, trig };
    }

    it('fires enter once and exit once, on both nodes, however many frames the overlap lasts', () => {
        const { p, zone, walker, body } = zoneAndWalker();
        p.update(1 / 60);
        expect(zone.log).toEqual([]);
        body.position.set(0.5, 0.9, 0);
        for (let i = 0; i < 30; i++) p.update(1 / 60);
        expect(zone.log).toEqual(['enter walker']);
        expect(walker.log).toEqual(['enter zone']);
        expect(p.triggerOverlapCount).toBe(1);
        body.position.set(6, 0.9, 0);
        for (let i = 0; i < 5; i++) p.update(1 / 60);
        expect(zone.log).toEqual(['enter walker', 'exit walker']);
        expect(walker.log).toEqual(['enter zone', 'exit zone']);
        expect(p.triggerOverlapCount).toBe(0);
    });

    it('reports one enter even when a frame takes several substeps', () => {
        const { p, zone, body } = zoneAndWalker();
        body.position.set(0.5, 0.9, 0);
        p.update(0.1);                                   // 6 substeps
        p.update(0.1);
        expect(zone.log).toEqual(['enter walker']);
    });

    it('fires the exit when either side is removed from the world', () => {
        const a = zoneAndWalker();
        a.body.position.set(0.5, 0.9, 0);
        a.p.update(1 / 60);
        a.p.removeBody(a.body);                          // the walker despawns
        a.p.update(1 / 60);
        expect(a.zone.log).toEqual(['enter walker', 'exit walker']);

        const b = zoneAndWalker();
        b.body.position.set(0.5, 0.9, 0);
        b.p.update(1 / 60);
        b.p.removeBody(b.trig);                          // the zone despawns
        b.p.update(1 / 60);
        expect(b.walker.log).toEqual(['enter zone', 'exit zone']);
        // ...and comes back: the overlap is new again.
        b.p.addBody(b.trig);
        b.p.update(1 / 60); b.p.update(1 / 60);
        expect(b.walker.log).toEqual(['enter zone', 'exit zone', 'enter zone']);
    });

    it('puts a node with both a body and a trigger into the world with both', () => {
        const p = physics();
        const gate = new Node('gate');
        gate.setBody(0);
        gate.setTrigger();
        (gate as any)._hasStarted = true;
        (p as any)._scene.nodes = [gate];
        p.update(1 / 60);
        const bodies = (p as any)._world.bodies;
        expect(bodies).toContain(gate.body);
        expect(bodies).toContain(gate.trigger);
    });
});
