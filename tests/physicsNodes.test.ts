import { describe, it, expect } from 'vitest';
import { Node } from '../src/core/scene/nodes/node';
import { parseNodeJson } from '../src/core/scene/nodes/parseNodeJson';
import { ColliderNode } from '../src/core/scene/nodes/colliderNode';
import { TriggerNode } from '../src/core/scene/nodes/triggerNode';
import { CharacterNode } from '../src/core/scene/nodes/characterNode';
import { migrateLegacyPhysicsJson, migrateLegacyPhysicsTree, legacyColliderId, legacyTriggerId } from '../src/core/scene/nodes/physicsLegacy';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Scene } from '../src/core/scene/scene';
import { TEST_PHYSICS } from './helpers/testPhysics';

// Physics as nodes: a Collider IS the rigid body and carries what is under it; a Trigger is the sensor.
// Older saves carried them as a node's `body` / `trigger` properties (and Area 2D nodes), converted on load.

const IDENT = { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] };
const box = (w: number, h: number, d: number) => ({ type: 'box', width: w, height: h, depth: d, offset: [0, 0, 0], rotation: [0, 0, 0] });
const sphere = (r: number) => ({ type: 'sphere', radius: r, offset: [0, 0, 0], rotation: [0, 0, 0] });

describe('converting physics saved as node properties', () => {
    it('wraps a node with a body in a Collider that takes its place', () => {
        const out = migrateLegacyPhysicsJson({
            type: 'model', name: 'Crate', id: 'c1', position: [1, 2, 3], rotation: [0, 45, 0], scale: [2, 2, 2],
            spawnOnStart: false, variables: { hp: 3 }, children: [{ type: 'node', name: 'Lid', id: 'lid', ...IDENT, children: [] }],
            body: { mass: 5, friction: 0.6, shapes: [box(1, 1, 1)] },
        });
        expect(out.type).toBe('collider');
        expect(out.name).toBe('Crate Collider');
        expect(out.id).toBe(legacyColliderId('c1'));
        expect([out.position, out.rotation, out.scale]).toEqual([[1, 2, 3], [0, 45, 0], [2, 2, 2]]);
        // A pooled node's body sleeps with it.
        expect(out.spawnOnStart).toBe(false);
        expect(out.collider).toMatchObject({ mass: 5, friction: 0.6, shapes: [box(1, 1, 1)] });
        const [inner] = out.children;
        expect(inner).toMatchObject({ type: 'model', name: 'Crate', id: 'c1', variables: { hp: 3 }, ...IDENT });
        expect(inner.body).toBeUndefined();
        expect(inner.spawnOnStart).toBeUndefined();
        expect(inner.children.map((c: any) => c.name)).toEqual(['Lid']);
    });

    it('gives a node with a trigger a Trigger child, and both when it has both', () => {
        const out = migrateLegacyPhysicsJson({
            type: 'model', name: 'Gate', id: 'g', ...IDENT, children: [],
            body: { mass: 0, shapes: [box(4, 3, 0.5)] },
            trigger: { shapes: [sphere(2)], group: 4, mask: 8, detectTriggers: true, enabled: false },
        });
        expect(out.type).toBe('collider');
        const gate = out.children[0];
        expect(gate.trigger).toBeUndefined();
        const t = gate.children[0];
        expect(t).toMatchObject({ type: 'trigger', name: 'Gate Trigger', id: legacyTriggerId('g'), ...IDENT });
        expect(t.sensor).toEqual({ shapes: [sphere(2)], layer: 4, mask: 8, detectTriggers: true, continuous: false, enabled: false });
    });

    it('turns a plain node into the Collider or the Trigger itself, so its script hears its own events', () => {
        const script = { __scriptId: { type: 'string', value: 'lever' } };
        const gate = migrateLegacyPhysicsJson({
            type: 'node', name: 'Gate', id: 'g', position: [1, 0, 0], rotation: [0, 90, 0], scale: [1, 1, 1],
            variables: script, children: [{ type: 'model', name: 'Mesh', id: 'm', ...IDENT, children: [] }],
            body: { mass: 0, shapes: [box(4, 3, 0.5)] }, trigger: { shapes: [sphere(2)] },
        });
        expect(gate).toMatchObject({ type: 'collider', name: 'Gate', id: 'g', position: [1, 0, 0], rotation: [0, 90, 0], variables: script });
        expect(gate.collider.shapes).toEqual([box(4, 3, 0.5)]);
        expect(gate.children.map((c: any) => `${c.name} [${c.type}]`)).toEqual(['Mesh [model]', 'Gate Trigger [trigger]']);

        const zone = migrateLegacyPhysicsJson({ type: 'node', name: 'Zone', id: 'z', ...IDENT, variables: script, children: [], trigger: { shapes: [sphere(2)] } });
        expect(zone).toMatchObject({ type: 'trigger', name: 'Zone', id: 'z', variables: script });
        expect(zone.trigger).toBeUndefined();

        // A placed model's root is rebuilt from its asset, so its collider stands outside it.
        const placed = migrateLegacyPhysicsJson({
            type: 'node', name: 'House', id: 'h', ...IDENT, variables: { __modelId: { type: 'string', value: 'house' } }, children: [],
            body: { mass: 0, shapes: [box(4, 3, 4)] },
        });
        expect(placed).toMatchObject({ type: 'collider', name: 'House Collider', id: legacyColliderId('h') });
        expect(placed.children[0]).toMatchObject({ type: 'node', name: 'House', id: 'h' });
    });

    it('turns an Area 2D into a Trigger, and leaves an animation transition\'s trigger alone', () => {
        const area = migrateLegacyPhysicsJson({
            type: 'area2D', name: 'Pickup', id: 'p', ...IDENT, children: [],
            area2D: { size: [2, 1], offset: [0.5, 0], layer: 2, detectAreas: true },
        });
        expect(area.type).toBe('trigger');
        expect(area.area2D).toBeUndefined();
        expect(area.sensor).toMatchObject({ size: [2, 1], offset: [0.5, 0], layer: 2, mask: 1, detectTriggers: true, enabled: true });
        const plain = { type: 'node', name: 'n', id: 'n', ...IDENT, children: [], trigger: 'jump' };
        expect(migrateLegacyPhysicsJson(plain)).toBe(plain);
    });

    it('converts a whole tree, and a converted tree again to the same thing', () => {
        const tree = {
            type: 'node', name: 'Room', id: 'r', ...IDENT,
            children: [{ type: 'node', name: 'Wall', id: 'w', ...IDENT, children: [], body: { mass: 0, shapes: [box(1, 1, 1)] } }],
        };
        const once = migrateLegacyPhysicsTree(tree);
        expect(once.children[0].type).toBe('collider');
        expect(migrateLegacyPhysicsTree(once)).toEqual(once);
    });
});

/** Started nodes in a physics world, as a running scene holds them, and the system that steps them. */
function world(root: Node): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: TEST_PHYSICS });
    p.initialize();
    const nodes: Node[] = [];
    const walk = (n: Node) => { nodes.push(n); n.children.forEach(walk); };
    root.children.forEach(walk);
    const scene: any = { nodes, landscapes: [], tilemaps: [], activeCamera: null, physics: p };
    (p as any)._scene = scene;
    for (const n of nodes) { (n as any)._hasStarted = true; (n as any)._scene = scene; }
    return p;
}

/** Step `seconds`, then bring world transforms up to date (a scene does that each frame). */
const run = (p: PhysicsSystem, seconds: number, root?: Node) => {
    for (let t = 0; t < seconds; t += 1 / 60) p.update(1 / 60);
    root?.updateTransforms();
};

/** A static floor collider, its top at y = 0. */
const floor = (layer = 1, mask = -1) => ({
    type: 'collider', name: 'Floor', id: 'floor', position: [0, -0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
    collider: { mass: 0, layer, mask, shapes: [box(20, 1, 20)] },
});

/** A 1 m box collider of `mass` at height `y`, with a child node `Crate` under it. */
const crate = (y: number, extra: any = {}) => ({
    type: 'collider', name: 'Crate Collider', id: 'crate', position: [0, y, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    collider: { mass: 1, shapes: [box(1, 1, 1)], ...extra },
    children: [{ type: 'node', name: 'Crate', id: 'crate-mesh', position: [0, 0.25, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [] }],
});

describe('a Collider node', () => {
    it('falls with mass, and carries what is under it', () => {
        const root = new Node('root');
        parseNodeJson(root, floor());
        parseNodeJson(root, crate(3));
        const p = world(root);
        run(p, 2, root);
        const collider = root.getChildByName('Crate Collider')[0] as ColliderNode;
        expect(collider).toBeInstanceOf(ColliderNode);
        expect(collider.worldPosition[1]).toBeCloseTo(0.5, 1);
        const mesh = collider.getChildByName('Crate')[0];
        expect(mesh.worldPosition[1]).toBeCloseTo(0.75, 1);
        expect(mesh.ownBody).toBeNull();
    });

    it('passes through what its mask leaves out', () => {
        const root = new Node('root');
        parseNodeJson(root, floor(1, -1));
        // On layer 2, colliding only with layer 2: the floor (layer 1) is not in its mask.
        parseNodeJson(root, crate(3, { layer: 2, mask: 2 }));
        const p = world(root);
        run(p, 2, root);
        expect(root.getChildByName('Crate Collider')[0].worldPosition[1]).toBeLessThan(-2);
    });

    it('builds no body in a scene that authors, and one in a scene that runs', () => {
        const editing = new Scene();
        editing.spawnRulesEnabled = false;
        parseNodeJson(editing.root, crate(1));
        expect((editing.root.getChildByName('Crate Collider')[0] as ColliderNode).ownBody).toBeNull();
        const running = new Scene();
        parseNodeJson(running.root, crate(1));
        const body = (running.root.getChildByName('Crate Collider')[0] as ColliderNode).ownBody!;
        expect(body.mass).toBe(1);
        expect([body.collisionFilterGroup, body.collisionFilterMask]).toEqual([1, -1]);
    });

    it('builds no body when the scene that authors steps its physics, even for one made in code', () => {
        // The editor steps its scene's physics while you edit (previews); a Collider in it must stay bodiless.
        const root = new Node('root');
        const made = new ColliderNode('Made');
        made.mass = 1;
        made.shapes = [box(1, 1, 1)];
        root.addChild(made);
        const p = world(root);
        (p as any)._scene.spawnRulesEnabled = false;
        run(p, 0.2);
        expect(made.ownBody).toBeNull();
        (p as any)._scene.spawnRulesEnabled = true;
        run(p, 0.1);
        expect(made.ownBody).not.toBeNull();
    });

    it('round-trips its settings', async () => {
        const root = new Node('root');
        parseNodeJson(root, crate(1, { friction: 0.7, layer: 4, mask: 6, canSleep: true }));
        const json = await root.getChildByName('Crate Collider')[0].serialize() as any;
        expect(json.collider).toMatchObject({ mass: 1, friction: 0.7, layer: 4, mask: 6, canSleep: true, shapes: [box(1, 1, 1)] });
    });
});

class Probe extends Node {
    public log: string[] = [];
    onTriggerEnter(other: Node) { this.log.push(`enter ${other.name}`); }
}

describe('a Trigger node', () => {
    it('reports on itself and on the collider that came in, never on the collider\'s children', () => {
        const root = new Node('root');
        parseNodeJson(root, { type: 'trigger', name: 'Zone', id: 'zone', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
            sensor: { shapes: [sphere(1)] } });
        parseNodeJson(root, crate(3));
        const zone = root.getChildByName('Zone')[0] as TriggerNode;
        const collider = root.getChildByName('Crate Collider')[0];
        const mesh = collider.getChildByName('Crate')[0];
        const heard: string[] = [];
        zone.onTriggerEnter = (n: Node) => { heard.push(`zone: ${n.name}`); };
        collider.onTriggerEnter = (n: Node) => { heard.push(`collider: ${n.name}`); };
        mesh.onTriggerEnter = (n: Node) => { heard.push(`mesh: ${n.name}`); };
        const p = world(root);
        run(p, 1.5);
        expect(zone.trigger).not.toBeNull();
        expect(heard).toEqual(['zone: Crate Collider', 'collider: Zone']);
    });

    it('is a 2D area in a 2D scene, and builds no 3D sensor there', () => {
        const scene = new Scene();
        scene.dimension = '2D';
        parseNodeJson(scene.root, { type: 'trigger', name: 'Zone', id: 'z', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
            sensor: { size: [2, 1] } });
        const zone = scene.root.getChildByName('Zone')[0] as TriggerNode;
        expect(zone.trigger).toBeNull();
        expect(scene.areas2D.has(zone)).toBe(true);
        expect(zone.bounds()).toEqual([-1, -0.5, 1, 0.5]);
    });
});

describe('a Character in a Collider', () => {
    it('moves and senses through its collider\'s body', () => {
        const root = new Node('root');
        parseNodeJson(root, floor());
        parseNodeJson(root, {
            type: 'collider', name: 'Player Collider', id: 'pc', position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            collider: { mass: 70, angularConstraints: [0, 0, 0], friction: 0, shapes: [{ type: 'capsule', radius: 0.3, height: 1.8, numSegments: 12, offset: [0, 0.9, 0], rotation: [0, 0, 0] }] },
            children: [{ type: 'character', name: 'Player', id: 'player', ...IDENT, children: [] }],
        });
        const collider = root.getChildByName('Player Collider')[0] as ColliderNode;
        const player = collider.getChildByName('Player')[0] as CharacterNode;
        expect(player).toBeInstanceOf(CharacterNode);
        // Built at the first physics step here (the tree was parsed outside a scene).
        const p = world(root);
        run(p, 1.5, root);
        expect(player.body).toBe(collider.ownBody);
        expect(player.body).not.toBeNull();
        expect(player.ownBody).toBeNull();
        expect(player.collider).toBe(collider);
        // Its collider's body knows it is a character's.
        expect(collider.ownBody!.isCharacter).toBe(true);
        expect(player.isGrounded).toBe(true);
        player.velocity = [2, player.velocity[1], 0] as any;
        expect(collider.ownBody!.velocity.x).toBeCloseTo(2, 5);
    });

    // A placed copy's turn is its root's, the Collider's, so a Character's local rotation is relative to it.
    // A world heading written as a local yaw (setRotation([0, yaw, 0])) faced the Dungeon's player, whose
    // Collider is turned 180, exactly backwards on every roll and attack.
    it('faces a world heading whichever way its Collider is turned', () => {
        const root = new Node('root');
        parseNodeJson(root, {
            type: 'collider', name: 'Player Collider', id: 'pc', position: [0, 1, 0], rotation: [0, 180, 0], scale: [1, 1, 1],
            collider: { mass: 70, angularConstraints: [0, 0, 0], shapes: [] },
            children: [{ type: 'character', name: 'Player', id: 'player', ...IDENT, children: [] }],
        });
        const collider = root.getChildByName('Player Collider')[0] as ColliderNode;
        const player = collider.getChildByName('Player')[0] as CharacterNode;
        const heading = () => { root.updateTransforms(); const f = player.worldForward; return [f[0], f[1], f[2]].map(v => Math.round(v * 1e4) / 1e4 + 0); };
        expect(heading()).toEqual([0, 0, -1]);

        player.setWorldYaw(90);
        expect(heading()).toEqual([1, 0, 0]);
        player.setWorldYaw(0);
        expect(heading()).toEqual([0, 0, 1]);

        // teleport's yaw is a world heading too, and it moves the Collider, not the Character inside it.
        player.teleport([5, 2, -3], -90);
        expect(heading()).toEqual([-1, 0, 0]);
        expect(Array.from(collider.worldPosition)).toEqual([5, 2, -3]);
        expect(Array.from(player.position)).toEqual([0, 0, 0]);
    });
});
