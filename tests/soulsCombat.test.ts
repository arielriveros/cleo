import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Body, Box, Cylinder, Sphere, Vec3 } from 'cannon-es';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import { PhysicsSystem } from '../src/physics/physicsSystem';
import '../src/cleo';   // registers the 'cleo' module the example scripts import from

import SoulsGameManagerNode from '../examples/scripts/SoulsGameManager';
import SoulsPlayerNode from '../examples/scripts/SoulsPlayer';
import SoulsEnemyNode from '../examples/scripts/SoulsEnemy';
import SoulsProjectileNode from '../examples/scripts/SoulsProjectile';
import { Capsule, newSwing, openSwing, stepSwing, isHurtbox } from '../examples/scripts/SoulsHitbox';

// Hollow Keep's combat is decided by shapes, not distances: a blade capsule swept from last frame's
// grip to this frame's against the characters' physics capsules (their hurtboxes). I-frames are the
// hurtbox switched off, and a wall the blade reaches first bounces the swing. Interactables are offered
// through the trigger zones the player stands in. These drive the real scripts against a real cannon
// world, with no renderer.

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

/** A character capsule standing at `at`, owned by `owner` — the hurtbox. */
function capsule(p: PhysicsSystem, owner: Node, at: V3, radius = 0.3, height = 1.78): Body {
    const body = new Body({ mass: 70, position: new Vec3(at[0], at[1] + height / 2, at[2]) });
    const cyl = height - 2 * radius;
    body.addShape(new Cylinder(radius, radius, cyl, 12));
    body.addShape(new Sphere(radius), new Vec3(0, cyl / 2, 0));
    body.addShape(new Sphere(radius), new Vec3(0, -cyl / 2, 0));
    (body as any).owner = owner;
    p.addBody(body);
    return body;
}

function wall(p: PhysicsSystem, at: V3, half: V3, blocks: boolean, name = 'Wall'): Node {
    const n = new Node(name);
    if (blocks) n.setVariable('blocksSwings', true, 'boolean', 'public');
    const body = new Body({ mass: 0, position: new Vec3(...at) });
    body.addShape(new Box(new Vec3(...half)));
    (body as any).owner = n;
    p.addBody(body);
    return n;
}

const enemy = (name: string) => new SoulsEnemyNode(name);
const attacker = () => new SoulsPlayerNode('Player');
/** A horizontal blade at chest height, along X, from `x0` to `x1`, at depth `z`. */
const blade = (x0: number, x1: number, z: number, r = 0.12): Capsule => ({ a: [x0, 1.2, z], b: [x1, 1.2, z], radius: r });

describe('a swing', () => {
    it('hits an enemy its blade overlaps, and misses one it does not', () => {
        const p = physics();
        const near = enemy('Near'), far = enemy('Far');
        capsule(p, near, [0, 0, 1]);
        capsule(p, far, [0, 0, 3]);
        const swing = newSwing(); openSwing(swing);
        const hit = stepSwing(p, swing, blade(-0.5, 0.5, 0.8), attacker(), 'enemy', true);
        expect(hit.targets.map(t => t.node)).toEqual([near]);
        expect(hit.targets[0].point[2]).toBeCloseTo(0.7, 4);          // on the near side of its capsule
        expect(hit.blockedAt).toBeNull();
    });

    it('hits each target once per swing, however many frames the blade stays in it', () => {
        const p = physics();
        const e = enemy('E');
        capsule(p, e, [0, 0, 1]);
        const swing = newSwing(); openSwing(swing);
        const me = attacker();
        let total = 0;
        for (let f = 0; f < 5; f++) total += stepSwing(p, swing, blade(-0.5, 0.5, 1), me, 'enemy', true).targets.length;
        expect(total).toBe(1);
        openSwing(swing);                                            // the next swing may hit it again
        expect(stepSwing(p, swing, blade(-0.5, 0.5, 1), me, 'enemy', true).targets.length).toBe(1);
    });

    it('sweeps between frames: a blade that jumps past two enemies in one frame hits both, in order', () => {
        const p = physics();
        const left = enemy('Left'), right = enemy('Right');
        capsule(p, left, [-1, 0, 1.2]);
        capsule(p, right, [1, 0, 1.2]);
        const swing = newSwing(); openSwing(swing);
        const me = attacker();
        // A blade pointing forward from the hilt at the origin, swung right-to-left across the front.
        const pose = (x: number): Capsule => ({ a: [0, 1.2, 0.2], b: [x, 1.2, 2], radius: 0.1 });
        expect(stepSwing(p, swing, pose(-6), me, 'enemy', true).targets).toEqual([]);   // first frame: wide left
        const hit = stepSwing(p, swing, pose(6), me, 'enemy', true);                      // one big frame to the right
        expect(hit.targets.map(t => t.node.name)).toEqual(['Left', 'Right']);
    });

    it('never hits the attacker, the dead, or a target whose hurtbox is off', () => {
        const p = physics();
        const me = attacker();
        capsule(p, me, [0, 0, 0]);
        const dead = enemy('Dead'); (dead as any).isDead = true;
        const ghost = enemy('Rolling'); (ghost as any).hurtboxActive = false;
        capsule(p, dead, [0, 0, 1]);
        capsule(p, ghost, [0.2, 0, 1.4]);
        const swing = newSwing(); openSwing(swing);
        expect(stepSwing(p, swing, blade(-1, 1, 0.8, 0.4), me, 'enemy', true).targets).toEqual([]);
        // The hurtbox comes back while the window is still open: the tail of the swing lands.
        (ghost as any).hurtboxActive = true;
        expect(stepSwing(p, swing, blade(-1, 1, 0.8, 0.4), me, 'enemy', true).targets.map(t => t.node)).toEqual([ghost]);
    });

    it('an enemy swing only sees the player; a player swing only sees enemies', () => {
        const player = attacker(), foe = enemy('Foe');
        expect(isHurtbox(player, foe, 'player')).toBe(true);
        expect(isHurtbox(foe, foe, 'player')).toBe(false);
        expect(isHurtbox(enemy('Other'), foe, 'player')).toBe(false);
        expect(isHurtbox(foe, player, 'enemy')).toBe(true);
        expect(isHurtbox(player, player, 'enemy')).toBe(false);
    });
});

describe('i-frames', () => {
    it('are the player hurtbox switched off by a roll, so an enemy blade passes through', () => {
        const p = physics();
        const player = attacker() as any;
        capsule(p, player, [0, 0, 1]);
        const foe = enemy('Foe');
        player.actionState = 'roll';
        player._stateTime = 0.2;
        player.hurtboxActive = !player._computeInvulnerable();
        const swing = newSwing(); openSwing(swing);
        expect(stepSwing(p, swing, blade(-0.5, 0.5, 1), foe, 'player', false).targets).toEqual([]);
        // A roll started too early: the i-frames run out while the blade is still live.
        player._stateTime = 0.5;
        player.hurtboxActive = !player._computeInvulnerable();
        expect(stepSwing(p, swing, blade(-0.5, 0.5, 1), foe, 'player', false).targets.map((t: any) => t.node)).toEqual([player]);
    });

    it('let a bolt fly through a rolling player, and hit one standing still', () => {
        const p = physics();
        const player = attacker() as any;
        capsule(p, player, [0, 0, 2]);
        let damage = 0;
        player.receiveDamage = (amount: number) => { damage += amount; return true; };
        const bolt = new SoulsProjectileNode('Bolt') as any;
        Object.defineProperty(bolt, 'scene', { value: { physics: p }, configurable: true });
        bolt.remove = () => { bolt.removed = true; };
        const fire = () => {
            bolt.setPosition([0, 1.1, 0]);
            bolt.launch([0, 0, 1], 12, 90, 'caster');
            bolt.updateTransforms();
            for (let i = 0; i < 30 && bolt._live; i++) { bolt.onUpdate(1 / 30); bolt.updateTransforms(); }
        };
        player.hurtboxActive = false;
        fire();
        expect(damage).toBe(0);
        expect(bolt.worldPosition[2]).toBeGreaterThan(4);           // flew on past the player
        player.hurtboxActive = true;
        fire();
        expect(damage).toBe(90);
        expect(bolt.removed).toBe(true);
    });
});

describe('a swing meeting a wall', () => {
    it('bounces when the blade reaches a swing blocker before the enemy', () => {
        const p = physics();
        const e = enemy('Behind the wall');
        capsule(p, e, [2, 0, 1]);
        wall(p, [0.8, 1.5, 1], [0.1, 1.5, 1.5], true);
        const swing = newSwing(); openSwing(swing);
        const me = attacker();
        // A forward blade swung from the left across to the right: the wall comes first.
        const pose = (x: number): Capsule => ({ a: [0, 1.2, 0.2], b: [x, 1.2, 1.6], radius: 0.1 });
        stepSwing(p, swing, pose(-1), me, 'enemy', true);
        const hit = stepSwing(p, swing, pose(3), me, 'enemy', true);
        expect(hit.blockedAt).not.toBeNull();
        expect(hit.targets).toEqual([]);
    });

    it('ploughs through when the move does not bounce (a heavy), and never bounces off a floor', () => {
        const p = physics();
        const e = enemy('E');
        capsule(p, e, [2, 0, 1]);
        wall(p, [0.8, 1.5, 1], [0.1, 1.5, 1.5], true);
        wall(p, [0, -0.25, 0], [10, 0.25, 10], false, 'Floor');
        const me = attacker();
        const pose = (x: number): Capsule => ({ a: [0, 1.2, 0.2], b: [x, 1.2, 1.6], radius: 0.1 });
        const heavy = newSwing(); openSwing(heavy);
        stepSwing(p, heavy, pose(-1), me, 'enemy', false);
        expect(stepSwing(p, heavy, pose(3), me, 'enemy', false).targets.map(t => t.node)).toEqual([e]);

        // An overhead driven into the floor: the floor is solid but not a swing blocker.
        const overhead = newSwing(); openSwing(overhead);
        stepSwing(p, overhead, { a: [0, 1.6, 0.3], b: [0, 2.5, 0.8], radius: 0.1 }, me, 'enemy', true);
        expect(stepSwing(p, overhead, { a: [0, 0.6, 0.3], b: [0, -0.1, 1.2], radius: 0.1 }, me, 'enemy', true).blockedAt).toBeNull();
    });
});

describe('damage from a blade', () => {
    it('applies the attack rating times the move, and sparks where the blade met the body', () => {
        const m = new SoulsGameManagerNode('GameManager') as any;
        const sparks: any[] = [];
        m.fx = (_t: string, at: any) => { sparks.push(at); return null; };
        m.sfx = () => {};
        const got: number[] = [];
        const target = { receiveHit: (d: number, poise: number) => { got.push(d, poise); return true; } };
        const player = { strength: 10, dexterity: 10 };
        const weapon = { baseDamage: 100, strScaling: 0.2, dexScaling: 0.8, poiseDamage: 15 };
        expect(m.applyPlayerHit(player, { damageMul: 1.5, poiseMul: 2 }, weapon, target, [1, 2, 3])).toBe(true);
        expect(got).toEqual([150, 30]);
        expect(sparks).toEqual([[1, 2, 3]]);
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
        const trig = new Body({ mass: 0, isTrigger: true, position: new Vec3(at[0], at[1] + 1, at[2]) });
        trig.addShape(new Cylinder(reach - 0.3, reach - 0.3, 3, 12));
        (trig as any).owner = n;
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
