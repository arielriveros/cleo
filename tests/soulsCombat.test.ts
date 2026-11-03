import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Logger } from '../src/core/logger';
import { makeBody, box, sphere, cylinder, heightfield, plane, engineCapsule } from './helpers/physicsBodies';
import { PhysicsBody } from '../src/physics/physicsBody';
import { Body, Box, Cylinder, Sphere, Vec3 } from 'cannon-es';
import { quat } from 'gl-matrix';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import { Shape } from '../src/physics/shape';
import type { Trigger } from '../src/physics/body';
import '../src/cleo';   // registers the 'cleo' module the example scripts import from

import SoulsGameManagerNode from '../examples/scripts/SoulsGameManager';
import SoulsPlayerNode from '../examples/scripts/SoulsPlayer';
import SoulsEnemyNode from '../examples/scripts/SoulsEnemy';
import SoulsProjectileNode from '../examples/scripts/SoulsProjectile';
import SoulsWeaponNode from '../examples/scripts/SoulsWeapon';
import SoulsLongswordNode from '../examples/scripts/SoulsLongsword';
import SoulsGreatswordNode from '../examples/scripts/SoulsGreatsword';
import SoulsHollowNode from '../examples/scripts/SoulsHollow';
import SoulsHollowWardenNode from '../examples/scripts/SoulsHollowWarden';
import SoulsBossBarNode from '../examples/scripts/SoulsBossBar';
import SoulsHudNode from '../examples/scripts/SoulsHud';
import { Scene } from '../src/core/scene/scene';
import {
    Capsule, LAYER, SwingContact, Swing, closeSwing, hurtboxLayer, isHurtbox, newSwing, openSwing, stepSwing, wieldedBy,
} from '../examples/scripts/SoulsHitbox';
import { AnimatedModel } from '../src/animation/animatedModel';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { mat4 } from 'gl-matrix';

// Hollow Keep's combat is decided by trigger volumes, not distances: a weapon's HITBOX (a capsule trigger
// along its blade, switched on by the attack's `hit` event and off by `hitEnd`) entering a character's
// HURTBOX (a capsule trigger beside its walking body). The hitbox is continuous — tested along its path
// from last frame to this one — so a fast swing cannot skip a target. I-frames are the hurtbox switched
// off, and a wall the blade reaches first bounces the swing. Interactables are offered through the
// trigger zones the player stands in. These drive the real scripts against a real cannon world, with no
// renderer.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

type V3 = [number, number, number];

function physics(): PhysicsSystem {
    const p = new PhysicsSystem({ gravity: [0, 0, 0] });
    p.initialize();
    (p as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
    return p;
}

/** A character capsule standing at `at`, owned by `owner` — the body it walks with. */
function capsule(p: PhysicsSystem, owner: Node, at: V3, radius = 0.3, height = 1.78): PhysicsBody {
    const body = makeBody(engineCapsule(radius, height), { mass: 70, position: [at[0], at[1] + height / 2, at[2]], owner });
    p.addBody(body);
    return body;
}

/** A character's hurtbox, as the generator authors it: a `Hurtbox` child with a capsule trigger at `at`. */
function hurtbox(p: PhysicsSystem, character: Node, at: V3, radius = 0.3, height = 1.78): Trigger {
    const hb = new Node('Hurtbox');
    character.addChild(hb);
    const t = hb.setTrigger({ group: hurtboxLayer((character as any).team), mask: LAYER.HITBOX, detectTriggers: true });
    t.setCapsule([0, radius, 0], [0, height - radius, 0], radius);
    t.position.set(at[0], at[1], at[2]);
    p.addBody(t);
    return t;
}

function wall(p: PhysicsSystem, at: V3, half: V3, blocks: boolean, name = 'Wall'): Node {
    const n = new Node(name);
    if (blocks) n.setVariable('blocksSwings', true, 'boolean', 'public');
    p.addBody(makeBody(box(half[0], half[1], half[2]), { position: at, owner: n }));
    return n;
}

const enemy = (name: string) => new SoulsEnemyNode(name);
const attacker = () => new SoulsPlayerNode('Player');

/** A weapon whose blade runs `length` m up its Mesh's Y from the grip, `radius` thick. */
function sword(length = 1, radius = 0.1): any {
    const w = new SoulsWeaponNode('Sword') as any;
    Object.assign(w, { bladeStart: [0, 0, 0], bladeEnd: [0, length, 0], bladeRadius: radius });
    w.addChild(new Node('Mesh'));
    return w;
}
const hitboxOf = (w: any): Trigger | null => w.getChildByName('Mesh')[0].getChildByName('Hitbox')[0]?.trigger ?? null;

/**
 * A rigid blade pose: the grip at `hilt`, the blade `length` long, turned `yaw` degrees about Y and pitched
 * `pitch` degrees from straight up toward +Z (90 = level, pointing along +Z at yaw 0). The trigger is posed
 * as yaw · pitch, so the pass interpolates it exactly as a swinging arm turns it.
 */
function blade(hilt: V3, yaw: number, pitch: number, length: number, radius = 0.1) {
    const q = quat.multiply(quat.create(), quat.setAxisAngle(quat.create(), [0, 1, 0], yaw * Math.PI / 180),
        quat.setAxisAngle(quat.create(), [1, 0, 0], pitch * Math.PI / 180));
    const up = [2 * (q[0] * q[1] - q[3] * q[2]), 1 - 2 * (q[0] * q[0] + q[2] * q[2]), 2 * (q[1] * q[2] + q[3] * q[0])];
    const capsule: Capsule = { a: [...hilt], b: [hilt[0] + up[0] * length, hilt[1] + up[1] * length, hilt[2] + up[2] * length], radius };
    return { capsule, hilt, q };
}

/**
 * Swing `w` (already armed by openSwing) through `poses`, one frame each, in the game's order: the hitbox
 * is placed where the blade is (the physics write-back), physics runs (the trigger pass reports what it
 * entered), then the attacker's frame steps the swing. Returns every frame's contact.
 */
function swingThrough(p: PhysicsSystem, swing: Swing, w: any, poses: ReturnType<typeof blade>[], me: Node,
    kind: 'player' | 'enemy', bounces: boolean): SwingContact[] {
    const out: SwingContact[] = [];
    for (const pose of poses) {
        const t = hitboxOf(w);
        if (t) {
            p.addBody(t);
            t.position.set(...pose.hilt);
            t.quaternion.set(pose.q[0], pose.q[1], pose.q[2], pose.q[3]);
            t.aabbNeedsUpdate = true;
        }
        p.update(1 / 60);
        out.push(stepSwing(p, swing, pose.capsule, me, kind, bounces));
    }
    return out;
}
const hitNames = (contacts: SwingContact[]) => contacts.flatMap(c => c.targets.map(t => t.node.name));

describe('a swing', () => {
    it('builds its hitbox from the blade, in the Mesh\'s space, armed against the other team only', () => {
        const w = sword(0.9, 0.11);
        const swing = newSwing();
        openSwing(swing, w, 'enemy');
        const t = hitboxOf(w)!;
        expect(t).toBeTruthy();
        expect([t.enabled, t.group, t.mask, t.detectTriggers, t.continuous]).toEqual([true, LAYER.HITBOX, LAYER.ENEMY_HURTBOX, true, true]);
        closeSwing(swing);
        expect(t.enabled).toBe(false);
        openSwing(swing, w, 'player');                                // an enemy's blade: the player's layer
        expect(hitboxOf(w)).toBe(t);                                  // built once
        expect(t.mask).toBe(LAYER.PLAYER_HURTBOX);
    });

    it('hits an enemy its blade overlaps, at its surface, and misses one it does not', () => {
        const p = physics();
        const near = enemy('Near'), far = enemy('Far');
        hurtbox(p, near, [0, 0, 1]);
        hurtbox(p, far, [0, 0, 3]);
        const w = sword(1, 0.12), swing = newSwing();
        openSwing(swing, w, 'enemy');
        // Level, across the front at z 0.8, through the near enemy's capsule (its near side is at z 0.7).
        const [hit] = swingThrough(p, swing, w, [blade([-0.5, 1.2, 0.8], 90, 90, 1, 0.12)], attacker(), 'enemy', true);
        expect(hit.targets.map(t => t.node)).toEqual([near]);
        expect(hit.targets[0].point[2]).toBeCloseTo(0.7, 3);
        expect(hit.blockedAt).toBeNull();
    });

    it('hits each target once per swing, however many frames the blade stays in it', () => {
        const p = physics();
        const e = enemy('E');
        hurtbox(p, e, [0, 0, 1]);
        const w = sword(), swing = newSwing(), me = attacker();
        const pose = blade([-0.5, 1.2, 1], 90, 90, 1);
        openSwing(swing, w, 'enemy');
        expect(hitNames(swingThrough(p, swing, w, [pose, pose, pose, pose, pose], me, 'enemy', true))).toEqual(['E']);
        openSwing(swing, w, 'enemy');                                 // the next swing may hit it again
        expect(hitNames(swingThrough(p, swing, w, [pose], me, 'enemy', true))).toEqual(['E']);
    });

    it('is continuous: a blade that sweeps past two enemies in one frame hits both, in order', () => {
        const p = physics();
        const left = enemy('Left'), right = enemy('Right');
        hurtbox(p, left, [-1, 0, 1.2]);
        hurtbox(p, right, [1, 0, 1.2]);
        const w = sword(2.2), swing = newSwing(), me = attacker();
        openSwing(swing, w, 'enemy');
        // Level from the grip at the origin: wide left, then one big frame round to wide right.
        const contacts = swingThrough(p, swing, w, [blade([0, 1.2, 0], -85, 90, 2.2), blade([0, 1.2, 0], 85, 90, 2.2)], me, 'enemy', true);
        expect(contacts[0].targets).toEqual([]);
        expect(contacts[1].targets.map(t => t.node.name)).toEqual(['Left', 'Right']);
    });

    it('a disarmed hitbox hits nothing', () => {
        const p = physics();
        const e = enemy('E');
        hurtbox(p, e, [0, 0, 1]);
        const w = sword(), swing = newSwing(), me = attacker();
        openSwing(swing, w, 'enemy');
        closeSwing(swing);                                            // hitEnd before the blade got there
        const contacts = swingThrough(p, swing, w, [blade([-0.5, 1.2, 1], 90, 90, 1)], me, 'enemy', true);
        expect(contacts[0].targets).toEqual([]);
        expect(hitboxOf(w)!.enabled).toBe(false);
    });

    it('never hits the attacker, the dead, or a target whose hurtbox is off', () => {
        const p = physics();
        const me = attacker();
        hurtbox(p, me, [0, 0, 0.6]);
        const dead = enemy('Dead'); (dead as any).isDead = true;
        const ghost = enemy('Rolling') as any;
        hurtbox(p, dead, [0, 0, 1]);
        hurtbox(p, ghost, [0.2, 0, 1.4]);
        ghost.hurtboxActive = false; ghost._syncHurtbox();
        const w = sword(2, 0.4), swing = newSwing();
        openSwing(swing, w, 'enemy');
        const pose = blade([-1, 1.2, 0.9], 90, 90, 2, 0.4);
        expect(swingThrough(p, swing, w, [pose], me, 'enemy', true)[0].targets).toEqual([]);
        // The hurtbox comes back while the window is still open: the tail of the swing lands.
        ghost.hurtboxActive = true; ghost._syncHurtbox();
        expect(hitNames(swingThrough(p, swing, w, [pose], me, 'enemy', true))).toEqual(['Rolling']);
    });

    it('an enemy swing only sees the player; a player swing only sees enemies', () => {
        const player = attacker(), foe = enemy('Foe');
        expect(isHurtbox(player, foe, 'player')).toBe(true);
        expect(isHurtbox(foe, foe, 'player')).toBe(false);
        expect(isHurtbox(enemy('Other'), foe, 'player')).toBe(false);
        expect(isHurtbox(foe, player, 'enemy')).toBe(true);
        expect(isHurtbox(player, player, 'enemy')).toBe(false);
    });

    it('decides the side by TEAM, so an enemy blade never cuts another enemy down', () => {
        const a = new SoulsHollowNode('A'), b = new SoulsHollowNode('B');
        expect(isHurtbox(b, a, 'player')).toBe(false);
        expect(isHurtbox(b, attacker(), 'enemy')).toBe(true);
        const turncoat = new SoulsHollowNode('C'); turncoat.team = 'player';
        expect(isHurtbox(turncoat, a, 'player')).toBe(true);
    });

    it('an enemy\'s blade passes straight through other enemies\' hurtboxes (layers, not a filter)', () => {
        const p = physics();
        const other = enemy('Other'), player = attacker();
        hurtbox(p, other, [0, 0, 1]);
        hurtbox(p, player, [0, 0, 3]);
        const w = sword(3), swing = newSwing();
        openSwing(swing, w, 'player');
        const contacts = swingThrough(p, swing, w, [blade([0, 1.2, 0], 0, 90, 3)], enemy('Attacker'), 'player', true);
        expect(hitNames(contacts)).toEqual(['Player']);
    });
});

describe('i-frames', () => {
    it('are the player hurtbox switched off by a roll, so an enemy blade passes through', () => {
        const p = physics();
        const player = attacker() as any;
        hurtbox(p, player, [0, 0, 1]);
        const foe = enemy('Foe');
        player.actionState = 'roll';
        player._stateTime = 0.2;
        player.hurtboxActive = !player._computeInvulnerable();
        player._syncHurtbox();
        const w = sword(), swing = newSwing();
        openSwing(swing, w, 'player');
        const pose = blade([-0.5, 1.2, 1], 90, 90, 1);
        expect(swingThrough(p, swing, w, [pose], foe, 'player', false)[0].targets).toEqual([]);
        // A roll started too early: the i-frames run out while the blade is still live.
        player._stateTime = 0.5;
        player.hurtboxActive = !player._computeInvulnerable();
        player._syncHurtbox();
        expect(swingThrough(p, swing, w, [pose], foe, 'player', false)[0].targets.map((t: any) => t.node)).toEqual([player]);
    });

    it('let a bolt fly through a rolling player, and hit one standing still', () => {
        const p = physics();
        const player = attacker() as any;
        hurtbox(p, player, [0, 0, 2]);
        let damage = 0;
        player.receiveHit = (amount: number) => { damage += amount; return true; };
        const bolt = new SoulsProjectileNode('Bolt') as any;
        Object.defineProperty(bolt, 'scene', { value: { physics: p }, configurable: true });
        bolt.remove = () => { bolt.removed = true; };
        const fire = () => {
            bolt.setPosition([0, 1.1, 0]);
            bolt.launch([0, 0, 1], 12, 90, 'caster');
            bolt.updateTransforms();
            for (let i = 0; i < 30 && bolt._live; i++) { bolt.onUpdate(1 / 30); bolt.updateTransforms(); }
        };
        player.hurtboxActive = false; player._syncHurtbox();
        fire();
        expect(damage).toBe(0);
        expect(bolt.worldPosition[2]).toBeGreaterThan(4);           // flew on past the player
        player.hurtboxActive = true; player._syncHurtbox();
        fire();
        expect(damage).toBe(90);
        expect(bolt.removed).toBe(true);
    });

    it('builds a hurtbox from the body for a character whose template has none', () => {
        const p = physics();
        const scene = new Scene();
        try {
            const e = enemy('Bare') as any;
            scene.addNode(e);
            e.setBody(70).attachShape(Shape.Cylinder(0.35, 0.35, 1.7, 12), [0, 0.85, 0]);
            e._syncHurtbox();
            const hb = e.getChildByName('Hurtbox')[0];
            expect(hb?.trigger).toBeTruthy();
            expect([hb.trigger.group, hb.trigger.mask, hb.trigger.detectTriggers]).toEqual([LAYER.ENEMY_HURTBOX, LAYER.HITBOX, true]);
            // A capsule as tall as the body: its two end caps 1.7 - 2 x 0.35 apart.
            const capsule = hb.trigger.colliders.find((c: any) => c.shape.kind === 'capsule');
            expect(capsule.shape.height).toBeCloseTo(1.0, 3);
            e.isDead = true; e._syncHurtbox();
            expect(hb.trigger.enabled).toBe(false);
        } finally { scene.dispose?.(); void p; }
    });
});

describe('a swing meeting a wall', () => {
    it('bounces when the blade reaches a swing blocker before the enemy', () => {
        const p = physics();
        const e = enemy('Behind the wall');
        hurtbox(p, e, [2, 0, 1]);
        wall(p, [0.8, 1.5, 1], [0.1, 1.5, 1.5], true);
        const w = sword(2.2), swing = newSwing(), me = attacker();
        openSwing(swing, w, 'enemy');
        // A level blade swung from the left round to the right: the wall comes first.
        const [first, second] = swingThrough(p, swing, w, [blade([0, 1.2, 0.2], -45, 90, 2.2), blade([0, 1.2, 0.2], 80, 90, 2.2)], me, 'enemy', true);
        expect(first.blockedAt).toBeNull();
        expect(second.blockedAt).not.toBeNull();
        expect(second.targets).toEqual([]);
    });

    it('ploughs through when the move does not bounce (a heavy), and never bounces off a floor', () => {
        const p = physics();
        const e = enemy('E');
        hurtbox(p, e, [2, 0, 1]);
        wall(p, [0.8, 1.5, 1], [0.1, 1.5, 1.5], true);
        wall(p, [0, -0.25, 0], [10, 0.25, 10], false, 'Floor');
        const me = attacker();
        const w = sword(2.2), heavy = newSwing();
        openSwing(heavy, w, 'enemy');
        const contacts = swingThrough(p, heavy, w, [blade([0, 1.2, 0.2], -45, 90, 2.2), blade([0, 1.2, 0.2], 80, 90, 2.2)], me, 'enemy', false);
        expect(hitNames(contacts)).toEqual(['E']);

        // An overhead driven into the floor: the floor is solid but not a swing blocker.
        const overhead = newSwing(), club = sword(1.6);
        openSwing(overhead, club, 'enemy');
        const down = swingThrough(p, overhead, club, [blade([0, 1.2, 0.3], 0, 30, 1.6), blade([0, 1.2, 0.3], 0, 150, 1.6)], me, 'enemy', true);
        expect(down[1].blockedAt).toBeNull();
    });
});

describe('damage from a blade', () => {
    /** A Longsword wired to a manager stub that records its sparks. */
    function longsword() {
        const m = new SoulsGameManagerNode('GameManager') as any;
        const sparks: any[] = [];
        m.fx = (t: string, at: any) => { sparks.push([t, at]); return null; };
        m.sfx = () => {};
        const w = new SoulsLongswordNode('Longsword') as any;
        w._gm = m;
        return { w, sparks };
    }

    it('the weapon applies its attack rating times the move, and sparks where the blade met the body', () => {
        const { w, sparks } = longsword();
        const got: number[] = [];
        const target = { receiveHit: (d: number, poise: number) => { got.push(d, poise); return true; } } as any;
        expect(w.strike({ strength: 10, dexterity: 10 }, { damageMul: 1.5, poiseMul: 2 }, target, [1, 2, 3])).toBe(true);
        expect(got).toEqual([168, 40]);
        expect(sparks).toEqual([['Hit Spark', [1, 2, 3]]]);
    });

    it('the target applies its OWN defence: the Elite Knight turns 15% aside', () => {
        const { w } = longsword();
        const knight = new SoulsHollowNode('Knight') as any;
        Object.assign(knight, { defense: 0.15, maxHp: 650, hp: 650, maxPoise: 999, poise: 999 });
        knight._gm = { sfx() {}, bleed() {}, shake() {} };
        w.strike({ strength: 10, dexterity: 10 }, { damageMul: 1 }, knight, null);
        expect(knight.hp).toBe(650 - 95);
    });

    it('no spark and no damage when the target does not take it (dead, rolling)', () => {
        const { w, sparks } = longsword();
        const target = { receiveHit: () => false } as any;
        expect(w.strike({}, { damageMul: 1 }, target, [0, 0, 0])).toBe(false);
        expect(sparks).toEqual([]);
    });

    it('a landed hit asks for a hit-stop: longer for the heavy move, longest for a killing blow', () => {
        const { w } = longsword();
        const stops: [number, boolean][] = [];
        w._gm.hitStop = (s: number, kill: boolean) => stops.push([s, kill]);
        const alive = { receiveHit: () => true, isDead: false } as any;
        w.strike({}, { name: 'Light1', damageMul: 1 }, alive, null);
        w.strike({}, { name: w.heavyMove, damageMul: 1 }, alive, null);
        const dying = { receiveHit() { this.isDead = true; return true; }, isDead: false } as any;
        w.strike({}, { name: 'Light1', damageMul: 1 }, dying, null);
        w.strike({}, { damageMul: 1 }, { receiveHit: () => false } as any, null);
        expect(stops).toEqual([[w.hitStop, false], [w.heavyHitStop, false], [w.hitStop, true]]);
        expect(w.heavyHitStop).toBeGreaterThan(w.hitStop);
    });

    it("the player's landed hits kick the camera, harder for the heavy move; an enemy's do not", () => {
        const { w } = longsword();
        const shakes: number[] = [];
        const player = {};
        w._gm.hitStop = () => {};
        w._gm.shake = (a: number) => shakes.push(a);
        Object.defineProperty(w._gm, 'player', { value: player });
        const target = { receiveHit: () => true } as any;
        w.strike(player, { name: 'Light1', damageMul: 1 }, target, null);
        w.strike(player, { name: w.heavyMove, damageMul: 1 }, target, null);
        w.strike({}, { name: 'Light1', damageMul: 1 }, target, null);
        expect(shakes).toEqual([w.hitShake, w.heavyHitShake]);
    });

    it('the game manager slows game time to a fifth for the hit-stop, longer for a kill, never while paused', async () => {
        const { Game } = await import('../src/core/game');
        const m = new SoulsGameManagerNode('GameManager') as any;
        const calls: [number, number][] = [];
        const hitStop = Game.hitStop, paused = Object.getOwnPropertyDescriptor(Game, 'isPaused')!;
        let isPaused = false;
        (Game as any).hitStop = (s: number, scale: number) => calls.push([s, scale]);
        Object.defineProperty(Game, 'isPaused', { get: () => isPaused, configurable: true });
        try {
            m.hitStop(0.07);
            m.hitStop(0.07, true);
            isPaused = true;
            m.hitStop(0.07);
            isPaused = false;
            m.hitStopEnabled = false;
            m.hitStop(0.07);
        } finally {
            (Game as any).hitStop = hitStop;
            Object.defineProperty(Game, 'isPaused', paused);
        }
        expect(calls).toEqual([[0.07, 0.2], [m.killHitStop, 0.2]]);
    });
});

describe('weapons spawned from templates', () => {
    /** A character whose scene "instantiates" by building the named weapon class under the parent. */
    function wielder(names: string, catalog: Record<string, () => Node>) {
        const p = new SoulsPlayerNode('Player') as any;
        const group = new Node('Weapons');
        p.addChild(group);
        p.weaponTemplates = names;
        const made: string[] = [];
        Object.defineProperty(p, 'scene', {
            configurable: true,
            value: {
                instantiate: (name: string, o: any) => {
                    const make = catalog[name];
                    if (!make) return null;
                    const n = make(); o.parent.addChild(n); made.push(name);
                    return n;
                },
            },
        });
        return { p, group, made };
    }
    const catalog = {
        'Longsword': () => new SoulsLongswordNode('Longsword'),
        'Greatsword': () => new SoulsGreatswordNode('Greatsword'),
        'Torch': () => new Node('Torch'),
    };

    it('spawns each named template into the Weapons group, on the hand socket, holding the first', () => {
        const { p, group, made } = wielder('Longsword, Greatsword', catalog);
        p._spawnWeapons();
        expect(made).toEqual(['Longsword', 'Greatsword']);
        expect(p.weapons().map((w: Node) => w.parent)).toEqual([group, group]);
        expect(p.weapons().map((w: any) => w.socketAttachment)).toEqual([
            { target: 'parent', socket: 'RightHand' }, { target: 'parent', socket: 'RightHand' }]);
        expect(p.currentWeapon().name).toBe('Longsword');
        expect(p.weapons().map((w: Node) => w.visible)).toEqual([true, false]);
        expect(p.weaponName).toBe('Longsword');
    });

    it('equipping swaps what is shown and the weapon the stats read', () => {
        const { p } = wielder('Longsword, Greatsword', catalog);
        p._spawnWeapons();
        p.equipWeapon(1);
        expect(p.weapons().map((w: Node) => w.visible)).toEqual([false, true]);
        p.recomputeStats();
        expect(p.attackRatingNow).toBe(Math.round(165 * 0.6));        // STR 10 < the greatsword's 16
    });

    it('skips a missing template and refuses one that is not a weapon', () => {
        const { p, group } = wielder('Torch, Nothing, Greatsword', catalog);
        p._spawnWeapons();
        expect(p.weapons().map((w: Node) => w.name)).toEqual(['Greatsword']);
        // The torch was removed again (removal is deferred to the scene's next sweep: it is despawned now).
        expect(group.children.find(c => c.name === 'Torch')?.spawned).toBe(false);
        expect(p.currentWeapon()).toBeInstanceOf(SoulsWeaponNode);
    });
});

describe('interactables through trigger zones', () => {
    /** An interactable node with a trigger cylinder of planar `reach`, like build.mjs's zone(). */
    function interactable(p: PhysicsSystem, name: string, at: V3, reach: number, opts: any = {}): any {
        const n: any = new Node(name);
        n.interact = () => {};
        n.canInteract = opts.canInteract ?? (() => true);
        n.promptText = () => name;
        n.setPosition(at);
        n.updateTransforms();
        const trig = makeBody(cylinder(reach - 0.3, 3), { sensor: true, position: [at[0], at[1] + 1, at[2]], owner: n });
        p.addBody(trig);
        n._trig = trig;
        return n;
    }

    function setup() {
        const p = physics();
        const player: any = new SoulsPlayerNode('Player');
        player._gm = { onPlayerEnteredZone() {}, onPlayerLeftZone() {} };
        player.actionState = 'free';
        const body = capsule(p, player, [10, 0, 0]);
        const move = (x: number, z: number) => {
            body.position.set(x, 0.89, z);
            player.setPosition([x, 0, z]);
            player.updateTransforms();
            p.update(1 / 60); p.update(1 / 60);
            player._findInteractable();
        };
        return { p, player, body, move };
    }

    it('offers an interactable while the player stands in its zone, and not outside it', () => {
        const { p, player, move } = setup();
        interactable(p, 'Lever', [0, 0, 0], 1.5);
        move(5, 0);
        expect(player.interactPrompt).toBe('');
        move(1.2, 0);
        expect(player.interactPrompt).toBe('Lever');
        move(1.7, 0);
        expect(player.interactPrompt).toBe('');
        expect(player.nearbyInteractables()).toEqual([]);
    });

    it('picks the nearest of two overlapping zones, skipping one that says no', () => {
        const { p, player, move } = setup();
        interactable(p, 'Door', [0, 0, 0], 2.4);
        const lever = interactable(p, 'Lever', [1.5, 0, 0], 1.5);
        move(1.2, 0);
        expect(player.nearbyInteractables().length).toBe(2);
        expect(player.interactPrompt).toBe('Lever');
        lever.canInteract = () => false;                              // pulled already
        player._findInteractable();
        expect(player.interactPrompt).toBe('Door');
    });

    it('drops an interactable that despawns while the player stands in its zone', () => {
        const { p, player, move } = setup();
        const pickup = interactable(p, 'Pickup', [0, 0, 0], 1.4);
        move(0.8, 0);
        expect(player.interactPrompt).toBe('Pickup');
        p.removeBody(pickup._trig);                                   // taken: the node despawns
        p.update(1 / 60);
        player._findInteractable();
        expect(player.interactPrompt).toBe('');
        expect(player.nearbyInteractables()).toEqual([]);
    });
});

describe('a dead enemy drops its weapon', () => {
    /** A Hollow in a real scene, holding a Club whose Mesh carries the blade. */
    function armed() {
        const scene = new Scene();
        const e = new SoulsHollowNode('Hollow') as any;
        const group = new Node('Weapons');
        e.addChild(group);
        scene.addNode(e);
        e.setPosition([3, 0, 4]);
        const club = new SoulsLongswordNode('Club') as any;
        club.addChild(new Node('Mesh'));
        group.addChild(club);
        club.attachToSocket('parent', 'RightHand');
        club.setPosition([0.2, 1.1, 0.1]);
        scene.root.updateTransforms?.();
        e._weapons = [club];
        e.equipWeapon(0);
        return { scene, e, club };
    }

    it('lets go of it: it leaves the hand for the world root, where it stood, as a body of blade spheres', () => {
        const { scene, e, club } = armed();
        try {
            const at = Array.from(club.worldPosition);
            expect(e.dropWeapon()).toBe(club);
            expect(club.parent).toBe(scene.root);
            expect(club.socketAttachment).toBeNull();
            const now = Array.from(club.worldPosition) as number[];
            now.forEach((v, i) => expect(v).toBeCloseTo(at[i] as number, 4));
            expect(club.body).toBeTruthy();
            expect(club.body.cameraCollision).toBe(false);
            expect(club.body.colliders.length).toBe(3);
            expect(e.currentWeapon()).toBeNull();
            expect(e.droppedWeapons()).toEqual([club]);
        } finally { scene.dispose?.(); }
    });

    it('drops it on death, and takes it away when the corpse goes', () => {
        const { scene, e, club } = armed();
        try {
            e._gm = { sfx() {}, bleed() {}, shake() {}, onEnemyKilled() {} };
            e.maxHp = 10; e.hp = 10;
            e.receiveHit(50, 0, null);
            expect(e.isDead).toBe(true);
            expect(club.parent).toBe(scene.root);
            e.onDespawn();
            expect(club.spawned).toBe(false);
            expect(e.droppedWeapons()).toEqual([]);
        } finally { scene.dispose?.(); }
    });
});

describe('UI belongs to its owner', () => {
    it('the boss bar shows its OWN boss while that boss is awake and alive', () => {
        const boss = new SoulsHollowWardenNode('Hollow Warden') as any;
        const ui = new SoulsBossBarNode('BossBar') as any;
        const bar = new Node('Bar');
        const name: any = new Node('BossName'); name.text = '';
        const health: any = new Node('BossHealth'); health.max = 1; health.value = 0;
        bar.addChild(name); bar.addChild(health);
        ui.addChild(bar);
        boss.addChild(ui);
        ui.onStart();
        expect(ui.owner).toBe(boss);
        boss.fightState = 'dormant'; boss.isAwake = false;
        ui.onUpdate(0.016);
        expect(bar.visible).toBe(false);
        boss.fightState = 'ai'; boss.isAwake = true; boss.hp = 1300;
        ui.onUpdate(0.016);
        expect(bar.visible).toBe(true);
        expect(name.text).toBe('Hollow Warden');
        expect([health.value, health.max]).toEqual([1300, 2600]);
        boss.isDead = true;
        ui.onUpdate(0.016);
        expect(bar.visible).toBe(false);
    });

    it('the HUD reads the character it is a child of', () => {
        const player = new SoulsPlayerNode('Player') as any;
        const hud = new SoulsHudNode('HUD') as any;
        player.addChild(hud);
        hud.onStart();
        expect(hud.owner).toBe(player);
    });
});

describe('a weapon only hits from its own wielder’s hand', () => {
    const body = (names: string[]) => {
        const model = Object.create(AnimatedModel.prototype);
        model._skin = {
            joints: names.map((_, i) => ({ nodeIndex: i, inverseBindMatrix: mat4.create(), parentIndex: i ? 0 : undefined })),
            nodeParents: new Map(names.slice(1).map((_, i) => [i + 1, 0])),
            nodeTransforms: new Map(names.map((_, i) => [i, mat4.create()])),
            nodeNames: new Map(names.map((n, i) => [i, n])),
            sockets: [],
        };
        model._animations = [];
        return new ModelNode('Body', model);
    };
    const fighter = (scene: Scene, name: string, bones: string[]) => {
        const c = new Node(name, 'character');
        c.addChild(body(bones));
        const weapons = new Node('Weapons');
        c.addChild(weapons);
        scene.addNode(c);
        const sword = new Node('Sword');
        weapons.addChild(sword);
        sword.attachToSocket('parent', 'RightHand');
        return { c, sword };
    };

    it('is wielded when the character’s own model has the hand — any humanoid rig, unauthored', () => {
        const scene = new Scene();
        const { c, sword } = fighter(scene, 'Player', ['pelvis', 'hand_r'])
        expect(wieldedBy(sword, c)).toBe(true);
    });

    it('is NOT wielded when the hand is missing, even with another character’s hand in the scene', () => {
        const scene = new Scene();
        fighter(scene, 'Knight', ['mixamorig1:Hips', 'mixamorig1:RightHand']);
        const { c, sword } = fighter(scene, 'Player', ['Root', 'Bone1']);
        expect(wieldedBy(sword, c)).toBe(false);
    });
});


describe('wading through a water zone', () => {
    /** A water zone like the Valley's Pond Zone: a trigger cylinder on a node with `isWater`. */
    function waterZone(p: PhysicsSystem, at: V3, radius: number, speedScale = 0.5): Node {
        const n = new Node('Pond Zone');
        n.setVariable('isWater', true, 'boolean', 'public');
        n.setVariable('waterSpeedScale', speedScale, 'number', 'public');
        p.addBody(makeBody(cylinder(radius, 3, 16), { sensor: true, position: [at[0], at[1] + 1, at[2]], owner: n }));
        return n;
    }

    function setup(character: any) {
        const p = physics();
        const notices: string[] = [];
        character._gm = { onPlayerEnteredZone() {}, onPlayerLeftZone() {}, notice: (t: string) => notices.push(t) };
        character.actionState = 'free';
        const body = capsule(p, character, [20, 0, 0]);
        const move = (x: number, z: number) => {
            body.position.set(x, 0.89, z);
            character.setPosition([x, 0, z]);
            character.updateTransforms();
            p.update(1 / 60); p.update(1 / 60);
        };
        return { p, body, move, notices };
    }

    const forward = () => ({ move: [0, 1], basisYaw: 0, speedScale: 1, sprint: false });

    it('slows the player and stops rolling while wading, and says so once', () => {
        const player: any = new SoulsPlayerNode('Player');
        const { p, move, notices } = setup(player);
        waterZone(p, [0, 0, 0], 5, 0.5);
        move(10, 0);
        expect(player.inWater).toBe(false);
        move(1, 0);
        expect(player.inWater).toBe(true);
        expect(notices).toEqual([player.waterNotice]);

        const intent = forward();
        player.applyWater(intent);
        expect(intent.speedScale).toBeCloseTo(0.5, 6);

        player.stamina = 100;
        player._bufferAction = 'roll';
        player._startRoll(forward());
        expect(player.actionState).toBe('free');          // no roll in water
        expect(player._bufferAction).toBe('');            // and the press is spent, not queued for the bank

        move(10, 0);
        expect(player.inWater).toBe(false);
        const dry = forward();
        player.applyWater(dry);
        expect(dry.speedScale).toBe(1);
    });

    it("counts as wading only with the feet under the zone's water level", () => {
        const player: any = new SoulsPlayerNode('Player');
        const { p, notices } = setup(player);
        const zone = waterZone(p, [0, 0, 0], 5, 0.5);
        zone.setVariable('waterLevel', 0.5, 'number', 'public');
        const at = (y: number) => {
            player.setPosition([1, y, 0]); player.updateTransforms();
            (p as any)._inWorld.forEach((b: any) => { if (b.owner === player) b.position.set(1, y + 0.89, 0); });
            p.update(1 / 60); p.update(1 / 60);
            player.applyWater(forward());
        };
        at(1.0);                                  // inside the zone, standing on the bank above the water
        expect(player.inWater).toBe(false);
        expect(notices).toEqual([]);
        at(0.0);                                  // walked down into it
        expect(player.inWater).toBe(true);
        expect(notices).toEqual([player.waterNotice]);
    });

    it('slows enemies too', () => {
        const hollow: any = new SoulsEnemyNode('Hollow');
        const { p, move } = setup(hollow);
        waterZone(p, [0, 0, 0], 5, 0.6);
        move(0, 0);
        expect(hollow.inWater).toBe(true);
        const intent = forward();
        hollow.applyWater(intent);
        expect(intent.speedScale).toBeCloseTo(0.6, 6);
    });
});

type ActionStateSpec = {
    name: string; clip: string; length?: number; speed?: number; trigger?: string | null
    speedScaleParam?: string; seconds?: number; fromAnywhere?: boolean
};

/**
 * An animator stub answering what the scripts ask by trigger NAME: `triggerInfo` (what a trigger plays: a
 * state of the `Actions` layer, entered by its name unless `trigger` says otherwise) and `activeTrigger`. It
 * records the triggers fired, and lets a test play the animator's part — `enter` on a trigger, move the clip
 * time, `rest` — while the scripts read it back as they would. `Died`, `Stop` and `Cut` take it to rest.
 */
function actionsAnimator(states: ActionStateSpec[]) {
    const raised = new Set<string>();
    const pinned = new Map<string, number | boolean>();
    const floats = new Map<string, number>();
    const byTrigger = new Map<string, ActionStateSpec>();
    for (const s of states) if (s.trigger !== null) byTrigger.set(s.trigger ?? s.name, s);
    const rest = { layer: 'Actions', state: 'Off', clip: '', clipLength: 0, speed: 1, startTime: 0, seconds: 0, extractsRootMotion: false, fromAnywhere: true };
    const a = {
        fired: [] as string[], raised, pinned, floats,
        state: 'Off', time: 0, active: null as string | null, currentTime: 0,
        triggerInfo(trigger: string) {
            if (trigger === 'Died' || trigger === 'Stop' || trigger === 'Cut') return rest;
            const s = byTrigger.get(trigger);
            if (!s) return null;
            const length = s.length ?? 1;
            const scale = s.speedScaleParam ? floats.get(s.speedScaleParam) ?? 1 : 1;
            const speed = (s.speed ?? 1) * scale;
            return {
                layer: 'Actions', state: s.name, clip: s.clip, clipLength: length, speed, startTime: 0,
                seconds: s.seconds ?? length / speed, extractsRootMotion: false, fromAnywhere: s.fromAnywhere ?? true,
            };
        },
        activeTrigger: () => a.active,
        setTrigger: (n: string) => { raised.add(n); a.fired.push(n); },
        resetTrigger: (n: string) => { raised.delete(n); },
        getParam: (n: string) => (floats.has(n) ? floats.get(n) : raised.has(n)),
        setFloat: (n: string, v: number) => { floats.set(n, v); },
        layerStateTime: () => a.time,
        setParamOverride: (name: string, value: number | boolean | null) => { if (value === null) pinned.delete(name); else pinned.set(name, value); },
        consumeRootMotion: () => null,
        /** The animator's pass taking `trigger`: its state starts at clip time 0, and the trigger is lowered. */
        enter(trigger: string) { a.state = byTrigger.get(trigger)?.name ?? 'Off'; a.time = 0; a.active = trigger; raised.delete(trigger); },
        /** Back in the layer's empty rest state. */
        toRest() { a.state = 'Off'; a.time = 0; a.active = null; },
    };
    return a;
}

describe('one-shots are played by trigger name', () => {
    const intent = () => ({ move: [0, 0], basisYaw: 0, speedScale: 1, sprint: false, look: [0, 0] });

    /** A player whose Swap trigger plays a 1 s sheathe-and-draw; `withEvent`: the sheathe's clip has `swap`. */
    function swapper(withEvent: boolean) {
        const player: any = new SoulsPlayerNode('Player');
        const a = actionsAnimator([{ name: 'Sheath', clip: 'Souls_Sheath', trigger: 'Swap', seconds: 1 }]);
        const equipped: number[] = [];
        player._model = { animator: a };
        player._findClip = (n: string) => (withEvent && n === 'Souls_Sheath' ? { events: [{ name: 'swap', time: 1 }] } : null);
        player._weapons = [{}, {}];
        player._weaponIndex = 0;
        player.equipWeapon = (i: number) => { equipped.push(i); };
        player.recomputeStats = () => {};
        return { player, a, equipped };
    }

    it('swaps weapons on the sheathe\'s swap event, and lasts the sheathe and the draw', () => {
        const { player, a, equipped } = swapper(true);
        player._startSwap();
        expect(player.actionState).toBe('swap');
        expect(a.fired).toEqual(['Swap']);
        expect(player._actionSeconds).toBeCloseTo(1, 6);           // what the trigger plays, both halves
        a.enter('Swap'); player._trackAction(1 / 60);
        player._stateTime = 0.6; player._swap(intent());
        expect(equipped).toEqual([]);                              // waits for the event, past halfway too
        player._onAnimEvent('swap', 'Souls_Sheath');
        expect(equipped).toEqual([1]);
        player._stateTime = 0.8; player._swap(intent());
        expect(equipped).toEqual([1]);                             // once
        player._stateTime = 1.05; player._swap(intent());
        expect(player.actionState).toBe('free');
    });

    it('swaps halfway when the sheathe carries no event', () => {
        const { player, a, equipped } = swapper(false);
        player._startSwap();
        a.enter('Swap'); player._trackAction(1 / 60);
        player._stateTime = 0.45; player._swap(intent());
        expect(equipped).toEqual([]);
        player._stateTime = 0.52; player._swap(intent());
        expect(equipped).toEqual([1]);
    });

    it('never lets a regular enemy taunt', () => {
        const hollow: any = new SoulsEnemyNode('Hollow');
        const a = actionsAnimator([{ name: 'Taunt', clip: 'Souls_Battlecry' }]);
        hollow._model = { animator: a };
        hollow._player = { isDead: false, worldPosition: [0, 0, 5] };
        hollow._brain = { behaviorState: 'Chase' };
        hollow._ai(intent(), 1 / 60);
        expect(a.fired).toEqual([]);
        expect(hollow.fightState).not.toBe('taunt');
    });

    it('lets a boss shout a battle cry once, the first time it spots the player', () => {
        const hollow: any = new SoulsEnemyNode('Warden');
        hollow.isBoss = true;
        const a = actionsAnimator([{ name: 'Taunt', clip: 'Souls_Battlecry', length: 2.8 }]);
        hollow._model = { animator: a };
        hollow._player = { isDead: false, worldPosition: [0, 0, 5] };
        hollow._brain = { behaviorState: 'Idle' };
        hollow._ai(intent(), 1 / 60);
        expect(a.fired).toEqual([]);                       // not seen yet
        hollow._brain.behaviorState = 'Chase';
        hollow._ai(intent(), 1 / 60);
        expect(hollow.fightState).toBe('taunt');
        expect(a.fired).toEqual(['Taunt']);
        expect(hollow._reactSeconds).toBeCloseTo(2.8, 6);   // as long as its state lasts
        hollow.fightState = 'ai';
        hollow._ai(intent(), 1 / 60);
        expect(a.fired).toEqual(['Taunt']);                // once per life
    });

    it('plays a boss\'s attacks faster in its second phase through the AttackSpeed parameter', () => {
        const hollow: any = new SoulsEnemyNode('Warden');
        const a = actionsAnimator([{ name: 'Sweep', clip: 'Souls_Giant_Sweep', length: 1.8, speed: 0.9, speedScaleParam: 'AttackSpeed' }]);
        hollow._model = { animator: a };
        hollow._setSpeedMul(1.5);
        expect(a.floats.get('AttackSpeed')).toBe(1.5);
        hollow._startAttack({ name: 'Sweep', animTrigger: 'Sweep', hitTime: 0.7 });
        expect(a.fired).toEqual(['Sweep']);
        expect(hollow._playSpeed).toBeCloseTo(0.9 * 1.5, 6);
        expect(hollow._actionSeconds).toBeCloseTo(1.8 / (0.9 * 1.5), 6);
    });

    it('lowers a queued trigger that never fired before raising the next one', () => {
        const player: any = new SoulsPlayerNode('Player');
        const a = actionsAnimator([{ name: 'HitLight', clip: 'Souls_HitLight' }]);
        player._model = { animator: a };
        player._raise('Longsword Light2');                 // a combo swing waiting for its segment's end
        player._onDamaged(10, 5, null);                   // ... cut short by a hit
        expect(a.raised.has('Longsword Light2')).toBe(false);
        expect(a.raised.has('HitLight')).toBe(true);
    });

    it('queues a combo\'s next segment, entered only at the segment\'s end, and takes it up when it starts', () => {
        const player: any = new SoulsPlayerNode('Player');
        const a = actionsAnimator([
            { name: 'Longsword Light1', clip: 'Souls_LS_Combo', seconds: 0.8 },
            { name: 'Longsword Light2', clip: 'Souls_LS_Combo', seconds: 0.7, fromAnywhere: false },
        ]);
        const light1 = { name: 'Light1', animTrigger: 'Longsword Light1', next: 'Light2', staminaCost: 10, trackSeconds: 0 };
        const light2 = { name: 'Light2', animTrigger: 'Longsword Light2', next: '', staminaCost: 10, trackSeconds: 0 };
        player.currentWeapon = () => ({ lightMove: 'Light1', findMove: (n: string) => (n === 'Light1' ? light1 : n === 'Light2' ? light2 : null) });
        player._model = { animator: a };
        player._startAttack('light', null);
        a.enter('Longsword Light1');
        player._comboOpen = true; player._windowOpened = true; player._usesEvents = true;
        player._bufferAction = 'light'; player._bufferAge = 0;
        player._stateTime = 0.5; player._attack(intent(), 1 / 60);
        // Fired, not started: the graph hands over at the segment's end.
        expect(a.fired).toEqual(['Longsword Light1', 'Longsword Light2']);
        expect(player._move).toBe(light1);
        player._stateTime = 0.8; player._attack(intent(), 1 / 60);
        expect(player._move).toBe(light2);
        expect(player._actionSeconds).toBeCloseTo(0.7, 6);
        expect(a.fired).toHaveLength(2);                     // nothing fired again for the hand-over
    });

    it('warns once, and still plays the gameplay, when the animator has no state for a trigger', () => {
        const player: any = new SoulsPlayerNode('Player');
        player._model = { animator: actionsAnimator([]) };
        const warn = vi.spyOn(Logger, 'warn').mockImplementation(() => {});
        try {
            player.playGesture('Pickup', 0.8);
            player.playGesture('Pickup', 0.8);
            expect(player.actionState).toBe('gesture');
            expect(warn.mock.calls.filter(c => String(c[0]).includes('"Pickup"'))).toHaveLength(1);
        } finally { warn.mockRestore(); }
    });
});

describe('the running 180° turn', () => {
    /** A player running at `speed` along -Z, with an animator stub whose Actions layer has both turns. */
    function runner(speed: number, grounded = true) {
        const p = new SoulsPlayerNode('Player') as any;
        const a = actionsAnimator([
            { name: 'RunTurnRight', clip: 'Souls_RunTurn180', length: 0.6, speed: 1.2 },
            { name: 'RunTurnLeft', clip: 'Souls_RunTurn180L', length: 0.6, speed: 1.2 },
        ]);
        let v: V3 = [0, 0, -speed];
        let measured = 0;
        Object.defineProperty(p, 'velocity', { get: () => v, set: (x: V3) => { v = x; }, configurable: true });
        Object.defineProperty(p, 'isGrounded', { get: () => grounded, configurable: true });
        Object.defineProperty(p, 'planarSpeed', { get: () => measured, configurable: true });
        p._model = { animator: a };
        p.setRotation([0, 180, 0]);
        /** The animator parameters pinned now (setParamOverride), by name. */
        return { p, a, pinned: a.pinned, measure: (s: number) => { measured = s; } };
    }
    /** Step the turn to its end, as the player's frame does (the animator never plays it). */
    function runTurnToEnd(p: any, intent: any): void {
        for (let t = 0; t < p._runTurnLength + 0.05; t += 1 / 60) { p._stateTime += 1 / 60; p._runTurn(intent); if (p.actionState !== 'runTurn') break; }
    }
    /** The controller's intent with the stick pointing along world (x, z). */
    const stick = (x: number, z: number) => ({ move: [x === 0 ? 0 : -x, z], basisYaw: 0, sprint: false, speedScale: 1 } as any);

    it('fires the turn toward the side the stick went when it reverses at a run, and plays no clip itself', () => {
        const { p, a } = runner(4);
        p._free(stick(0.3, 1), 1 / 60);            // back, and a little to one side
        expect(p.actionState).toBe('runTurn');
        expect(a.fired).toHaveLength(1);
        expect(p._runTurnLength).toBeCloseTo(0.6 / 1.2, 6);   // the state's length, at its speed
        const other = runner(4);
        other.p._free(stick(-0.3, 1), 1 / 60);
        expect(new Set([a.fired[0], other.a.fired[0]])).toEqual(new Set(['RunTurnRight', 'RunTurnLeft']));
        expect((a as any).playAction).toBeUndefined();
    });

    it('does not for a walk, in the air, or for a turn of less than the reversal angle', () => {
        const walk = runner(2); walk.p._free(stick(0, 1), 1 / 60);
        const air = runner(4, false); air.p._free(stick(0, 1), 1 / 60);
        const side = runner(4); side.p._free(stick(1, 0), 1 / 60);
        for (const r of [walk, air, side]) { expect(r.p.actionState).toBe('free'); expect(r.a.fired).toHaveLength(0); }
    });

    it('turns the body round on the frame the turn\'s clip ends, before the layer cuts back to the run', () => {
        const { p, a } = runner(4);
        const dt = 1 / 60;
        p._free(stick(0, 1), dt);
        a.enter(a.fired[0]);                       // the animator's pass, later that frame
        /** The clip time at each turn of the node. */
        const turnedAt: number[] = [];
        const setRotation = p.setRotation.bind(p);
        p.setRotation = (r: number[]) => { turnedAt.push(a.time); setRotation(r); };
        let frames = 0;
        while (p.actionState === 'runTurn' && frames++ < 120) {
            // The player's frame first (breadth-first: it is the model's ancestor), then the animator's.
            p._stateTime += dt; p._trackAction(dt); p._runTurn(stick(0, 1));
            if (p.actionState !== 'runTurn') break;
            a.time = Math.min(0.6, a.time + dt * 1.2);
        }
        expect(p.actionState).toBe('free');
        // Once, and not a frame before the clip's end: the frame the layer's exit cuts back to the run.
        expect(turnedAt).toEqual([0.6]);
        // The layer's own exit cuts it: nothing more is fired.
        expect(a.fired).toEqual(['RunTurnRight']);
    });

    it('cuts the turn at once when it is called off after the body has turned round', () => {
        const { p, a } = runner(4);
        p._free(stick(0, 1), 1 / 60);
        a.enter(a.fired[0]); p._trackAction(1 / 60);
        a.time = 0.4; p._stateTime = 0.35;         // past halfway
        let turned = false;
        const setRotation = p.setRotation.bind(p);
        p.setRotation = (r: number[]) => { turned = true; setRotation(r); };
        p._enter('roll');
        expect(turned).toBe(true);                 // drawn facing the new way already
        expect(a.fired).toContain('Cut');          // so whatever follows must not blend from the turned pose
    });

    it('does not cut a turn called off before it shows', () => {
        const { p, a } = runner(4);
        p._free(stick(0, 1), 1 / 60);
        a.enter(a.fired[0]); p._trackAction(1 / 60);
        a.time = 0.1; p._stateTime = 0.08;
        p._enter('roll');
        expect(a.fired).not.toContain('Cut');
    });

    it('holds the base machine on a straight-ahead run under the clip, at the speed it leaves at', () => {
        const { p, pinned } = runner(4.5);
        p._free(stick(0, 1), 1 / 60);
        // Braking: the run it came in at, straight ahead, never the Idle the measured speed would fall to.
        expect(pinned.get('Speed')).toBe(4.5);
        expect(pinned.get('Direction')).toBe(0);
        const plant = p.runTurnPlant * p._runTurnLength;
        while (p._stateTime < plant + 0.02) { p._stateTime += 1 / 60; p._runTurn(stick(0, 1)); }
        // Pushing off: the jog it leaves at, so the pose the clip is cut to is already that run.
        expect(pinned.get('Speed')).toBe(p.jogSpeed);
        expect(pinned.get('Direction')).toBe(0);
    });

    it('hands the speed back to the body after the turn, once the measured speed has caught up', () => {
        const { p, pinned, measure } = runner(4);
        p._free(stick(0, 1), 1 / 60);
        runTurnToEnd(p, stick(0, 1));
        expect(p.actionState).toBe('free');
        // The measured speed trails the body's: the parameter follows the body meanwhile.
        expect(pinned.get('Speed')).toBe(4);
        p._settleRunPin(0.1);
        expect(pinned.get('Speed')).toBe(4);
        measure(3.9);
        p._settleRunPin(1 / 60);
        expect(pinned.size).toBe(0);
    });

    it('gives the parameters back after a while even if the measured speed never catches up', () => {
        const { p, pinned } = runner(4);
        p._free(stick(0, 1), 1 / 60);
        runTurnToEnd(p, stick(0, 1));
        for (let t = 0; t < p.runTurnReleaseSeconds + 0.05; t += 1 / 60) p._settleRunPin(1 / 60);
        expect(pinned.size).toBe(0);
    });

    it('releases the parameters at once when the turn is cut short before it shows', () => {
        const { p, pinned } = runner(4);
        p._free(stick(0, 1), 1 / 60);
        p._stateTime = 0.05;
        p._enter('roll');
        expect(pinned.size).toBe(0);
    });
});
