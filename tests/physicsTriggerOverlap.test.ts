import { describe, it, expect } from 'vitest';
import { makeBody, cylinder } from './helpers/physicsBodies';
import { Body, Cylinder, Sphere, Vec3 } from 'cannon-es';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Node } from '../src/core/scene/nodes/node';
import { Trigger, type TriggerOptions, type TriggerContact } from '../src/physics/body';
import { physicsStats } from '../src/physics/physicsStats';
import { localPrims } from '../src/physics/triggerOverlaps';
import { TEST_PHYSICS } from './helpers/testPhysics';

// Trigger volumes against OTHER trigger volumes. cannon drops every static-static pair in its broadphase
// and every engine trigger is static, so these come from the engine's own pass (triggerOverlaps.ts), run
// once per frame after the write-back and reported through the same enter/exit diff as cannon's pairs.
// Souls-style combat is built on it: a weapon's hitbox trigger entering a character's hurtbox trigger.

type V3 = [number, number, number];
const HURTBOX = 1 << 8, HITBOX = 1 << 10;

function physics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, 0, 0], backend: TEST_PHYSICS });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    return p;
}

/** A node subclass recording its hooks, so dispatch goes through the real Node methods. */
class Probe extends Node {
    public log: string[] = [];
    onTriggerEnter(other: Node) { this.log.push(`enter ${other.name}`); }
    onTriggerExit(other: Node) { this.log.push(`exit ${other.name}`); }
}

/** A trigger owned by `owner` at `at`: a sphere of radius `r`, or a capsule from `a` to `b` (body space). */
function trigger(p: PhysicsSystem, owner: Node, at: V3, opts: TriggerOptions, r = 0.5, a: V3 = [0, 0, 0], b: V3 = [0, 0, 0]): Trigger {
    const t = new Trigger({ ...opts, position: at as any }, owner);
    t.setCapsule(a, b, r);
    p.addBody(t);
    return t;
}

function moveTo(t: Trigger, at: V3) { t.position.set(at[0], at[1], at[2]); }

/** The engine's capsule as Node.parse attaches it: a cylinder and its two end caps. */
function engineCapsule(t: Trigger): void {
    t.addCollider({ shape: { kind: 'cylinder', radiusTop: 0.3, radiusBottom: 0.3, height: 1.2, segments: 12 }, offset: [0, 0.9, 0] });
    t.addCollider({ shape: { kind: 'sphere', radius: 0.3 }, offset: [0, 1.5, 0] });
    t.addCollider({ shape: { kind: 'sphere', radius: 0.3 }, offset: [0, 0.3, 0] });
}

/** A vertical capsule standing at `at` (the hurtbox shape: a cylinder plus end spheres). */
function hurtbox(p: PhysicsSystem, owner: Node, at: V3, opts: TriggerOptions = { group: HURTBOX, mask: HITBOX }, radius = 0.3, height = 1.8): Trigger {
    return trigger(p, owner, at, opts, radius, [0, radius, 0], [0, height - radius, 0]);
}

describe('trigger ↔ trigger overlaps', () => {
    it('reports enter and exit on both nodes when one side asks to detect triggers', () => {
        const p = physics();
        const zone = new Probe('zone'), blade = new Probe('blade');
        trigger(p, zone, [0, 0, 0], {});
        const t = trigger(p, blade, [5, 0, 0], { detectTriggers: true });
        p.update(1 / 60);
        expect(zone.log).toEqual([]);
        moveTo(t, [0.6, 0, 0]);
        for (let i = 0; i < 10; i++) p.update(1 / 60);
        expect(zone.log).toEqual(['enter blade']);
        expect(blade.log).toEqual(['enter zone']);
        moveTo(t, [5, 0, 0]);
        p.update(1 / 60);
        expect(zone.log).toEqual(['enter blade', 'exit blade']);
        expect(blade.log).toEqual(['enter zone', 'exit zone']);
    });

    it('never pairs two triggers when neither asks (plain zones keep their old behaviour)', () => {
        const p = physics();
        const a = new Probe('a'), b = new Probe('b');
        trigger(p, a, [0, 0, 0], {});
        trigger(p, b, [0.2, 0, 0], {});
        for (let i = 0; i < 5; i++) p.update(1 / 60);
        expect(a.log).toEqual([]);
        expect(b.log).toEqual([]);
        expect(physicsStats.triggerCandidates).toBe(0);
    });

    it('checks the layers both ways, as cannon does for bodies', () => {
        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox'), other = new Probe('other');
        trigger(p, box, [0, 0, 0], { group: HURTBOX, mask: HITBOX });
        trigger(p, hit, [0.3, 0, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true });
        // Its mask has the hurtbox's group, but the hurtbox's mask lacks its group: no overlap.
        trigger(p, other, [-0.3, 0, 0], { group: 1, mask: HURTBOX, detectTriggers: true });
        p.update(1 / 60);
        expect(box.log).toEqual(['enter hitbox']);
        expect(other.log).toEqual([]);
    });

    it('skips two triggers on the same node', () => {
        const p = physics();
        const n = new Probe('n');
        trigger(p, n, [0, 0, 0], { detectTriggers: true });
        trigger(p, n, [0.1, 0, 0], { detectTriggers: true });
        p.update(1 / 60);
        expect(p.triggerOverlapCount).toBe(0);
    });

    it('ends an overlap when a trigger is disabled, and starts a new one when it comes back', () => {
        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox');
        hurtbox(p, box, [0, 0, 0]);
        const blade = trigger(p, hit, [0.3, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.05, [0, 0, 0], [0.8, 0, 0]);
        p.update(1 / 60);
        expect(box.log).toEqual(['enter hitbox']);
        blade.enabled = false;                               // hitEnd
        p.update(1 / 60);
        expect(box.log).toEqual(['enter hitbox', 'exit hitbox']);
        expect(p.isTriggerOverlapping(blade)).toBe(false);
        blade.enabled = true;                                // the next hit
        p.update(1 / 60);
        expect(box.log).toEqual(['enter hitbox', 'exit hitbox', 'enter hitbox']);
        expect(p.isTriggerOverlapping(blade)).toBe(true);
    });

    it('reports exit then enter when a trigger is switched off and on within one frame (a combo)', () => {
        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox');
        hurtbox(p, box, [0, 0, 0]);
        const blade = trigger(p, hit, [0.3, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.05, [0, 0, 0], [0.8, 0, 0]);
        p.update(1 / 60);
        blade.enabled = false;
        blade.enabled = true;
        p.update(1 / 60);
        expect(box.log).toEqual(['enter hitbox', 'exit hitbox', 'enter hitbox']);
    });

    it('a disabled trigger is not seen by the pass, by overlap queries, or by cannon', () => {
        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox');
        const hb = hurtbox(p, box, [0, 0, 0], { group: HURTBOX, mask: HITBOX, enabled: false });
        trigger(p, hit, [0.3, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.2);
        p.update(1 / 60);
        expect(box.log).toEqual([]);
        expect(p.overlapSphere([0, 1, 0], 0.5, { includeTriggers: true, layerMask: HURTBOX })).toEqual([]);
        expect(hb.collisionFilterMask).toBe(0);
        hb.enabled = true;
        expect(hb.collisionFilterMask).toBe(HITBOX);
        expect(p.overlapSphere([0, 1, 0], 0.5, { includeTriggers: true, layerMask: HURTBOX }).map(h => h.node)).toEqual([box]);
        // The layer mask keeps everything else out before any geometry.
        expect(p.overlapSphere([0, 1, 0], 0.5, { includeTriggers: true, layerMask: 1 << 12 })).toEqual([]);
    });

    it('a continuous trigger catches a target it jumped clean past between two frames', () => {
        for (const continuous of [false, true]) {
            const p = physics();
            const box = new Probe('hurtbox'), hit = new Probe('hitbox');
            hurtbox(p, box, [0, 0, 0]);
            const contacts: TriggerContact[] = [];
            const blade = trigger(p, hit, [-2, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true, continuous }, 0.05, [0, 0, -0.5], [0, 0, 0.5]);
            blade.onContact(c => contacts.push(c));
            p.update(1 / 60);
            moveTo(blade, [2, 1, 0]);                         // 4 m in one frame, through the hurtbox
            p.update(1 / 60);
            if (!continuous) { expect(box.log).toEqual([]); continue; }
            expect(box.log).toEqual(['enter hitbox']);
            expect(contacts).toHaveLength(1);
            expect(contacts[0].phase).toBe('enter');
            expect(contacts[0].node).toBe(box);
            expect(contacts[0].fraction).toBeGreaterThan(0.3);
            expect(contacts[0].fraction).toBeLessThan(0.7);
            // The point is on the hurtbox's surface.
            const [x, , z] = contacts[0].point!;
            expect(Math.hypot(x, z)).toBeCloseTo(0.3, 2);
        }
    });

    it('a continuous trigger tests its first frame discretely (no sweep from nowhere)', () => {
        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox');
        hurtbox(p, box, [1, 0, 0]);
        // Created on the far side: a sweep from the world origin would cross the hurtbox.
        trigger(p, hit, [3, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true, continuous: true }, 0.05);
        p.update(1 / 60);
        expect(box.log).toEqual([]);
    });

    it('merges the engine capsule (cylinder + caps) into one capsule, matching overlapCapsule', () => {
        const owner = new Node('o');
        const t = new Trigger({}, owner);
        // The engine's capsule, as Node.parse builds it.
        engineCapsule(t);
        const alone = physics();
        alone.addBody(t);
        const prims = localPrims(alone.colliderParts(t));
        expect(prims).toHaveLength(1);
        expect(Array.from(prims[0].la)).toEqual([0, 0.3, 0].map(v => expect.closeTo(v, 6)));

        const p = physics();
        const box = new Probe('hurtbox'), hit = new Probe('hitbox');
        const hb = new Trigger({ group: HURTBOX, mask: HITBOX }, box);
        engineCapsule(hb);
        p.addBody(hb);
        const contacts: TriggerContact[] = [];
        const blade = trigger(p, hit, [0, 1.1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.1, [-1, 0, 0.35], [1, 0, 0.35]);
        blade.onContact(c => contacts.push(c));
        p.update(1 / 60);
        const query = p.overlapCapsule([-1, 1.1, 0.35], [1, 1.1, 0.35], 0.1, { includeTriggers: true, layerMask: HURTBOX });
        expect(query.map(h => h.node)).toEqual([box]);
        expect(contacts[0].point!.map(v => +v.toFixed(3))).toEqual(query[0].point.map(v => +v.toFixed(3)));
    });

    it('a hurtbox masked to hitboxes makes no contacts with its own character\'s body', () => {
        const p = physics();
        const character = new Node('character'), hurt = new Node('hurtbox');
        const body = makeBody(cylinder(0.3, 1.2), { mass: 60, position: [0, 0.9, 0], owner: character });
        p.addBody(body);
        const hb = hurtbox(p, hurt, [0, 0, 0]);
        p.update(1 / 60);
        const touches = () => { let n = 0; (p as any)._world.forEachContact((a: number, b: number) => { if (a === hb.id || b === hb.id) n++; }); return n > 0; };
        expect(touches()).toBe(false);
        // Without the mask, cannon builds full contact equations for the pair every substep. (Rapier's
        // sensors never make contacts, mask or not.)
        if (TEST_PHYSICS !== 'cannon') return;
        hb.mask = -1;
        p.update(1 / 60);
        expect(touches()).toBe(true);
    });

    it('counts its work in the physics stats', () => {
        const p = physics();
        hurtbox(p, new Node('a'), [0, 0, 0]);
        hurtbox(p, new Node('b'), [10, 0, 0]);
        trigger(p, new Node('blade'), [0.3, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.1);
        p.update(1 / 60);
        expect(physicsStats.triggerCandidates).toBe(3);
        expect(physicsStats.triggerPairsTested).toBe(1);   // the far hurtbox never reaches the exact test
        expect(physicsStats.triggerOverlaps).toBe(1);
    });

    it('unsubscribes a contact listener', () => {
        const p = physics();
        hurtbox(p, new Node('a'), [0, 0, 0]);
        const blade = trigger(p, new Node('blade'), [5, 1, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.1);
        const seen: string[] = [];
        const off = blade.onContact(c => seen.push(c.phase));
        moveTo(blade, [0.3, 1, 0]); p.update(1 / 60);
        off();
        moveTo(blade, [5, 1, 0]); p.update(1 / 60);
        expect(seen).toEqual(['enter']);
    });
});

describe('node trigger lifecycle', () => {
    function started(p: PhysicsSystem, node: Node) {
        (node as any)._hasStarted = true;
        (node as any)._scene = (p as any)._scene;
        (p as any)._scene.physics = p;
        (p as any)._scene.nodes.push(node);
    }

    it('setTrigger twice leaves one trigger in the world', () => {
        const p = physics();
        const n = new Node('zone');
        started(p, n);
        n.setTrigger().setCapsule([0, 0, 0], [0, 0, 0], 1);
        p.update(1 / 60);
        n.setTrigger().setCapsule([0, 0, 0], [0, 0, 0], 2);
        p.update(1 / 60);
        const triggers = p.bodies.filter(b => b.isTrigger);
        expect(triggers).toEqual([n.trigger]);
        expect([...p.triggers]).toEqual([n.trigger]);
    });

    it('removeTrigger takes it out of the world and reports the exit', () => {
        const p = physics();
        const zone = new Probe('zone'), blade = new Probe('blade');
        started(p, zone);
        zone.setTrigger({ group: HURTBOX, mask: HITBOX }).setCapsule([0, 0, 0], [0, 0, 0], 1);
        trigger(p, blade, [0.5, 0, 0], { group: HITBOX, mask: HURTBOX, detectTriggers: true }, 0.2);
        p.update(1 / 60);
        expect(blade.log).toEqual(['enter zone']);
        const before = p.triggerVersion;
        zone.removeTrigger();
        expect(zone.trigger).toBeNull();
        expect(p.triggerVersion).not.toBe(before);
        p.update(1 / 60);
        expect(blade.log).toEqual(['enter zone', 'exit zone']);
        expect(p.bodies.filter(b => b.isTrigger)).toHaveLength(1);
    });

    it('reads the trigger options from scene JSON', () => {
        const root = new Node('root');
        Node.parse(root, {
            name: 'hurtbox', nodeType: 'node', id: 'hb', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            trigger: {
                shapes: [{ type: 'capsule', radius: 0.3, height: 1.8, numSegments: 12, offset: [0, 0.9, 0], rotation: [0, 0, 0] }],
                group: HURTBOX, mask: HITBOX, detectTriggers: true, continuous: true, enabled: false,
            },
        } as any);
        const t = root.getChildByName('hurtbox')[0].trigger!;
        expect(t.group).toBe(HURTBOX);
        expect(t.mask).toBe(HITBOX);
        expect(t.detectTriggers).toBe(true);
        expect(t.continuous).toBe(true);
        expect(t.enabled).toBe(false);
        expect(t.collisionFilterMask).toBe(0);
        // A plain trigger is unchanged.
        Node.parse(root, {
            name: 'zone', nodeType: 'node', id: 'z', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            trigger: { shapes: [{ type: 'sphere', radius: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }] },
        } as any);
        const z = root.getChildByName('zone')[0].trigger!;
        expect([z.enabled, z.group, z.mask, z.detectTriggers, z.continuous]).toEqual([true, 1, -1, false, false]);
    });
});
