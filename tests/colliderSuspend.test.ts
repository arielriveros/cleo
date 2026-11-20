import { describe, it, expect, beforeAll } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import type { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { LoopbackPort } from '../src/physics/worker/ports';

// A Collider's body turned off at runtime (ColliderNode.physicsEnabled), as the Sandbox's driver rides in a car
// seat: out of the world and kept out, its node free to move with a parent, back where the node is, at rest and
// still standing. On every backend (PHYSICS_SUITES), inline and in the physics worker.

const IDENT = { rotation: [0, 0, 0], scale: [1, 1, 1] };
const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });

function build(worker: boolean) {
    const root = new Node('root');
    parseNodeJson(root, { type: 'collider', name: 'Floor', id: 'floor', position: [0, -0.5, 0], ...IDENT, children: [], collider: { mass: 0, friction: 1, shapes: [box(100, 1, 100)] } });
    parseNodeJson(root, {
        type: 'collider', name: 'Crate', id: 'crate', position: [0, 0.5, 0], ...IDENT, children: [],
        collider: { mass: 20, groundProbeDistance: 0.1, simulationMode: 'always', shapes: [box(1, 1, 1)] },
    });
    parseNodeJson(root, { type: 'node', name: 'Carrier', id: 'carrier', position: [5, 2, 0], ...IDENT, children: [] });
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
    p.initialize();
    if (worker) p.setWorkerMode('on', () => new LoopbackPort());
    const nodes: Node[] = [];
    const walk = (n: Node) => { nodes.push(n); n.children.forEach(walk); };
    const scene: any = { nodes, landscapes: [], tilemaps: [], activeCamera: null, physics: p };
    const refresh = () => { nodes.length = 0; root.children.forEach(walk); for (const n of nodes) { (n as any)._hasStarted = true; (n as any)._scene = scene; } };
    refresh();
    (p as any)._scene = scene;
    const frame = (seconds: number) => {
        for (let t = 0; t < seconds - 1e-9; t += 1 / 60) {
            p.update(1 / 60);
            root.updateTransforms();
            p.endFrame(1 / 60);
        }
    };
    const crate = root.getChildByName('Crate')[0] as ColliderNode;
    const carrier = root.getChildByName('Carrier')[0];
    return { root, p, frame, crate, carrier, refresh };
}

for (const worker of [false, true]) describe(`a Collider with its body turned off (${TEST_PHYSICS}${worker ? ', worker' : ''})`, () => {
    beforeAll(async () => { await new PhysicsSystem({ backend: TEST_PHYSICS }).load(); });

    it('leaves the world and stays out, its node moved freely by a parent', () => {
        const { p, frame, crate, carrier, refresh } = build(worker);
        frame(1);
        const body = crate.ownBody!;
        expect(p.hasBody(body)).toBe(true);
        expect(p.isGrounded(body)).toBe(true);
        crate.physicsEnabled = false;
        expect(crate.physicsEnabled).toBe(false);
        expect(p.isSuspended(body)).toBe(true);
        expect(p.hasBody(body)).toBe(false);
        // Under a node that moves: carried, not falling, and the world never takes the body back.
        crate.reparent(carrier);
        refresh();
        const local = [...crate.position];
        for (let k = 0; k < 60; k++) { carrier.setPosition([5 + k * 0.05, 2, 0]); frame(1 / 60); }
        expect(p.hasBody(body)).toBe(false);
        expect([...crate.position].map(v => +v.toFixed(4))).toEqual(local.map(v => +v.toFixed(4)));
        expect(crate.worldPosition[0]).toBeCloseTo(local[0] + 5 + 59 * 0.05, 3);
        // Still standing, as it was when it left: no fall, no landing.
        expect(p.isGrounded(body)).toBe(true);
        expect(crate.currentSpeed ?? 0).toBeLessThan(1e-6);
    });

    it('comes back where its node is, at rest', () => {
        const { root, p, frame, crate, refresh } = build(worker);
        frame(1);
        const body = crate.ownBody!;
        crate.physicsEnabled = false;
        // Moved somewhere else while out (onto the floor three metres along), then back in the world.
        crate.reparent(root);
        refresh();
        crate.setPosition([3, 0.5, 2]);
        frame(0.2);
        crate.physicsEnabled = true;
        expect(p.isSuspended(body)).toBe(false);
        expect(p.hasBody(body)).toBe(true);
        frame(0.5);
        const at = crate.worldPosition;
        expect(Math.hypot(at[0] - 3, at[2] - 2)).toBeLessThan(0.02);
        expect(Math.abs(at[1] - 0.5)).toBeLessThan(0.05);
        const v = body.velocity;
        expect(Math.hypot(v.x, v.y, v.z)).toBeLessThan(0.1);
    });
});

describe('Node.reparent', () => {
    it('keeps where the node is in the world under a turned, moved parent', () => {
        const root = new Node('root');
        const a = new Node('a'), b = new Node('b'), n = new Node('n');
        root.addChild(a); root.addChild(b); a.addChild(n);
        a.setPosition([1, 2, 3]); a.setRotation([0, 30, 0]);
        b.setPosition([-4, 0, 1]); b.setRotation([10, -70, 5]); b.setScale([2, 2, 2]);
        n.setPosition([0.5, 0, -1]); n.setRotation([0, 45, 0]);
        root.updateTransforms();
        const world = [...n.worldTransform];
        n.reparent(b);
        expect(n.parent).toBe(b);
        n.worldTransform.forEach((v, i) => expect(v).toBeCloseTo(world[i], 4));
        expect(() => b.reparent(n)).toThrow();
    });
});
