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
import SoulsWeaponNode from '../examples/scripts/SoulsWeapon';
import SoulsStraightSwordNode from '../examples/scripts/SoulsStraightSword';
import SoulsGreatswordNode from '../examples/scripts/SoulsGreatsword';
import SoulsHollowNode from '../examples/scripts/SoulsHollow';
import SoulsHollowWardenNode from '../examples/scripts/SoulsHollowWarden';
import SoulsBossBarNode from '../examples/scripts/SoulsBossBar';
import SoulsHudNode from '../examples/scripts/SoulsHud';
import { Scene } from '../src/core/scene/scene';
import { Capsule, newSwing, openSwing, stepSwing, isHurtbox, wieldedBy } from '../examples/scripts/SoulsHitbox';
import { AnimatedModel } from '../src/animation/animatedModel';
import { ModelNode } from '../src/core/scene/nodes/modelNode';
import { mat4 } from 'gl-matrix';

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

    it('decides the side by TEAM, so an enemy blade never cuts another enemy down', () => {
        const a = new SoulsHollowNode('A'), b = new SoulsHollowNode('B');
        expect(isHurtbox(b, a, 'player')).toBe(false);
        expect(isHurtbox(b, attacker(), 'enemy')).toBe(true);
        const turncoat = new SoulsHollowNode('C'); turncoat.team = 'player';
        expect(isHurtbox(turncoat, a, 'player')).toBe(true);
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
    /** A Straight Sword wired to a manager stub that records its sparks. */
    function sword() {
        const m = new SoulsGameManagerNode('GameManager') as any;
        const sparks: any[] = [];
        m.fx = (t: string, at: any) => { sparks.push([t, at]); return null; };
        m.sfx = () => {};
        const w = new SoulsStraightSwordNode('Straight Sword') as any;
        w._gm = m;
        return { w, sparks };
    }

    it('the weapon applies its attack rating times the move, and sparks where the blade met the body', () => {
        const { w, sparks } = sword();
        const got: number[] = [];
        const target = { receiveHit: (d: number, poise: number) => { got.push(d, poise); return true; } } as any;
        expect(w.strike({ strength: 10, dexterity: 10 }, { damageMul: 1.5, poiseMul: 2 }, target, [1, 2, 3])).toBe(true);
        expect(got).toEqual([150, 30]);
        expect(sparks).toEqual([['Hit Spark', [1, 2, 3]]]);
    });

    it('the target applies its OWN defence: the Elite Knight turns 15% aside', () => {
        const { w } = sword();
        const knight = new SoulsHollowNode('Knight') as any;
        Object.assign(knight, { defense: 0.15, maxHp: 650, hp: 650, maxPoise: 999, poise: 999 });
        knight._gm = { sfx() {}, bleed() {}, shake() {} };
        w.strike({ strength: 10, dexterity: 10 }, { damageMul: 1 }, knight, null);
        expect(knight.hp).toBe(650 - 85);
    });

    it('no spark and no damage when the target does not take it (dead, rolling)', () => {
        const { w, sparks } = sword();
        const target = { receiveHit: () => false } as any;
        expect(w.strike({}, { damageMul: 1 }, target, [0, 0, 0])).toBe(false);
        expect(sparks).toEqual([]);
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
        'Straight Sword': () => new SoulsStraightSwordNode('Straight Sword'),
        'Greatsword': () => new SoulsGreatswordNode('Greatsword'),
        'Torch': () => new Node('Torch'),
    };

    it('spawns each named template into the Weapons group, on the hand socket, holding the first', () => {
        const { p, group, made } = wielder('Straight Sword, Greatsword', catalog);
        p._spawnWeapons();
        expect(made).toEqual(['Straight Sword', 'Greatsword']);
        expect(p.weapons().map((w: Node) => w.parent)).toEqual([group, group]);
        expect(p.weapons().map((w: any) => w.socketAttachment)).toEqual([
            { target: 'parent', socket: 'RightHand' }, { target: 'parent', socket: 'RightHand' }]);
        expect(p.currentWeapon().name).toBe('Straight Sword');
        expect(p.weapons().map((w: Node) => w.visible)).toEqual([true, false]);
        expect(p.weaponName).toBe('Straight Sword');
    });

    it('equipping swaps what is shown and the weapon the stats read', () => {
        const { p } = wielder('Straight Sword, Greatsword', catalog);
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

describe('a dead enemy drops its weapon', () => {
    /** A Hollow in a real scene, holding a Club whose Mesh carries the blade. */
    function armed() {
        const scene = new Scene();
        const e = new SoulsHollowNode('Hollow') as any;
        const group = new Node('Weapons');
        e.addChild(group);
        scene.addNode(e);
        e.setPosition([3, 0, 4]);
        const club = new SoulsStraightSwordNode('Club') as any;
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
            expect(club.body.shapes.length).toBe(3);
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
        const trig = new Body({ mass: 0, isTrigger: true, position: new Vec3(at[0], at[1] + 1, at[2]) });
        trig.addShape(new Cylinder(radius, radius, 3, 16));
        (trig as any).owner = n;
        p.addBody(trig);
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

describe('the imported combat clips in the scripts', () => {
    const oneSecond = { samplers: [{ input: [0, 1] }] };
    const intent = () => ({ move: [0, 0], basisYaw: 0, speedScale: 1, sprint: false, look: [0, 0] });

    it('swaps weapons by sheathing, changing, then drawing', () => {
        const player: any = new SoulsPlayerNode('Player');
        const played: string[] = [];
        let equipped = -1;
        player._findClip = () => oneSecond;
        player._play = (clip: string) => { played.push(clip); player._clip = clip; player._clipLength = 1; };
        player._weapons = [{}, {}];
        player._weaponIndex = 0;
        player.equipWeapon = (i: number) => { equipped = i; };
        player.recomputeStats = () => {};
        player._startSwap();
        expect(player.actionState).toBe('swap');
        expect(played).toEqual([player.sheathClip]);
        player._stateTime = 0.4;  player._swap(intent());          // still sheathing (1 s at 2x = 0.5 s)
        expect(equipped).toBe(-1);
        player._stateTime = 0.55; player._swap(intent());          // sheathed: change, then draw
        expect(equipped).toBe(1);
        expect(played).toEqual([player.sheathClip, player.drawClip]);
        player._stateTime = 1.1;  player._swap(intent());          // drawn
        expect(player.actionState).toBe('free');
    });

    it('never lets a regular enemy taunt', () => {
        const hollow: any = new SoulsEnemyNode('Hollow');
        const played: string[] = [];
        hollow._findClip = () => oneSecond;
        hollow._play = (clip: string) => { played.push(clip); hollow._clipLength = 1; };
        hollow._player = { isDead: false, worldPosition: [0, 0, 5] };
        hollow._brain = { behaviorState: 'Chase' };
        hollow._ai(intent(), 1 / 60);
        expect(played).toEqual([]);
        expect(hollow.fightState).not.toBe('taunt');
    });

    it('lets a boss shout a battle cry once, the first time it spots the player', () => {
        const hollow: any = new SoulsEnemyNode('Warden');
        hollow.isBoss = true;
        const played: string[] = [];
        hollow._findClip = () => oneSecond;
        hollow._play = (clip: string) => { played.push(clip); hollow._clip = clip; hollow._clipLength = 1; };
        hollow._player = { isDead: false, worldPosition: [0, 0, 5] };
        hollow._brain = { behaviorState: 'Idle' };
        hollow._ai(intent(), 1 / 60);
        expect(played).toEqual([]);                       // not seen yet
        hollow._brain.behaviorState = 'Chase';
        hollow._ai(intent(), 1 / 60);
        expect(hollow.fightState).toBe('taunt');
        expect(played).toEqual([hollow.tauntClip]);
        hollow.fightState = 'ai';
        hollow._ai(intent(), 1 / 60);
        expect(played).toEqual([hollow.tauntClip]);       // once per life
    });
});
