import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CleoEngine } from '../src/core/engine';
import { Node } from '../src/core/scene/nodes/node';
import '../src/cleo';   // registers the 'cleo' module the example scripts import from

import SoulsGameManagerNode from '../examples/scripts/SoulsGameManager';
import SoulsPlayerNode from '../examples/scripts/SoulsPlayer';
import SoulsEnemyNode from '../examples/scripts/SoulsEnemy';
import SoulsWeaponNode from '../examples/scripts/SoulsWeapon';
import SoulsStraightSwordNode from '../examples/scripts/SoulsStraightSword';
import SoulsGreatswordNode from '../examples/scripts/SoulsGreatsword';
import SoulsHollowNode from '../examples/scripts/SoulsHollow';
import SoulsHollowSorcererNode from '../examples/scripts/SoulsHollowSorcerer';
import SoulsEliteKnightNode from '../examples/scripts/SoulsEliteKnight';
import SoulsHollowWardenNode from '../examples/scripts/SoulsHollowWarden';
import SoulsLockOnNode from '../examples/scripts/SoulsLockOn';
import { statBonus } from '../examples/scripts/SoulsMath';
import SoulsMoveNode from '../examples/scripts/SoulsMove';
import SoulsFogGateNode from '../examples/scripts/SoulsFogGate';
import SoulsBonfireMenuNode from '../examples/scripts/SoulsBonfireMenu';
import SoulsBloodSplatNode from '../examples/scripts/SoulsBloodSplat';
import { DecalNode } from '../src/core/scene/nodes/decalNode';

// The Hollow Keep souls-like example. Its balance lives with the things it describes — the player's stat
// curves on the player, attack rating on each weapon, defence on each fighter — and its feel
// in a handful of state machines whose bugs are invisible until someone plays a long session: a roll
// that is not actually invulnerable, a bloodstain that keeps the souls of the death before, a boss that
// never turns. These pin the rules and the transitions without a renderer.

let authoring = false;
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; });

const gm = () => new SoulsGameManagerNode('GameManager');

/** A player on its own: its curves are its own methods, no manager needed. */
const pl = () => new SoulsPlayerNode('Player');

describe('stat curves (the player owns them)', () => {
    it('gives 400 HP and 90 stamina at the starting stats', () => {
        const p = pl();
        expect(p.hpForVigor(10)).toBe(400);
        expect(p.staminaForEndurance(10)).toBe(90);
    });

    it('grows HP steeply to Vigor 30, then soft-caps', () => {
        const p = pl();
        const early = p.hpForVigor(20) - p.hpForVigor(19);
        const late = p.hpForVigor(45) - p.hpForVigor(44);
        expect(early).toBe(30);
        expect(late).toBeLessThan(early);
        for (let v = 10; v < 60; v++) expect(p.hpForVigor(v + 1)).toBeGreaterThan(p.hpForVigor(v));
    });

    it('never treats a stat below 10 as lower than 10', () => {
        expect(pl().hpForVigor(3)).toBe(400);
    });

    it('prices each level higher than the last', () => {
        const p = pl();
        expect(p.levelCost(1)).toBe(400);
        for (let l = 1; l < 40; l++) expect(p.levelCost(l + 1)).toBeGreaterThan(p.levelCost(l));
    });

    it('counts the level from the points spent', () => {
        expect(pl().levelFor(10, 10, 10, 10)).toBe(1);
        expect(pl().levelFor(12, 11, 10, 13)).toBe(7);
    });
});

describe('attack rating (each weapon owns its own)', () => {
    const sword = () => new SoulsStraightSwordNode('Straight Sword');
    const greatsword = () => new SoulsGreatswordNode('Greatsword');

    it('is the base damage at stat 10', () => {
        expect(sword().attackRating(10, 10)).toBe(100);
    });

    it('scales with the stat the weapon favours', () => {
        expect(sword().attackRating(10, 30)).toBeGreaterThan(sword().attackRating(30, 10));
        expect(greatsword().attackRating(30, 10)).toBeGreaterThan(greatsword().attackRating(10, 30));
    });

    it('is penalised while a requirement is unmet', () => {
        expect(greatsword().attackRating(10, 10)).toBe(Math.round(165 * 0.6));
        expect(greatsword().attackRating(16, 10)).toBeGreaterThan(165);
    });

    it('hits the soft cap at 30 and 50', () => {
        expect(statBonus(10)).toBe(0);
        expect(statBonus(30)).toBeCloseTo(0.6);
        expect(statBonus(50)).toBeCloseTo(0.9);
    });

    it('turns a move into damage from the WIELDER\'s stats', () => {
        const w = sword();
        expect(w.hitFor({ strength: 10, dexterity: 10 } as any, { damageMul: 1.5, poiseMul: 2 })).toEqual({ damage: 150, poise: 30 });
        expect(w.hitFor({ strength: 10, dexterity: 30 } as any, { damageMul: 1 }).damage).toBe(w.attackRating(10, 30));
    });

    it('the subclass is only defaults: every behaviour is the base weapon\'s', () => {
        const w = sword();
        expect(w).toBeInstanceOf(SoulsWeaponNode);
        expect([w.displayName, w.baseDamage, w.isWeapon]).toEqual(['Straight Sword', 100, true]);
        expect(new SoulsWeaponNode('Weapon').displayName).toBe('Weapon');
    });
});

describe('defence (each fighter owns its own)', () => {
    it('never lets defence reduce a hit to nothing', () => {
        const e = new SoulsEnemyNode('e');
        e.defense = 0.9;
        expect(e.applyDefense(1)).toBe(1);
        e.defense = 0.2;
        expect(e.applyDefense(100)).toBe(80);
    });
});

describe('enemy types own their stats', () => {
    it('carries the per-type numbers as class defaults', () => {
        const hollow = new SoulsHollowNode('Hollow');
        expect([hollow.displayName, hollow.maxHp, hollow.defense, hollow.weaponTemplates, hollow.team]).toEqual(['Hollow', 160, 0, ['Club'], 'enemy']);
        const sorcerer = new SoulsHollowSorcererNode('Hollow Sorcerer');
        expect([sorcerer.maxHp, sorcerer.strafeSpeedScale, sorcerer.weaponTemplates]).toEqual([110, 0.5, ['Sorcerer Staff']]);
        const knight = new SoulsEliteKnightNode('Elite Knight');
        expect([knight.maxHp, knight.defense, knight.weaponTemplates]).toEqual([650, 0.15, ['Maul']]);
        const warden = new SoulsHollowWardenNode('Hollow Warden');
        expect([warden.maxHp, warden.defense, warden.isBoss, warden.flinchOnHit, warden.weaponTemplates]).toEqual([2600, 0.2, true, false, ['Halberd']]);
    });

    it('the player is on the other team', () => {
        expect([pl().team, pl().weaponTemplates]).toEqual(['player', ['Straight Sword', 'Greatsword']]);
    });
});

describe('enemy attack selection', () => {
    const attacks = [
        { name: 'Swing', minRange: 0, maxRange: 2.5, weight: 1 },
        { name: 'Thrust', minRange: 4, maxRange: 9, weight: 1 },
        { name: 'Leap', minRange: 6, maxRange: 16, weight: 1, phase: 2 },
        { name: 'Combo Only', minRange: 0, maxRange: 99, weight: 1, phase: 9 },
    ];
    const pick = (...args: Parameters<SoulsEnemyNode['pickAttack']>) => new SoulsEnemyNode('e').pickAttack(...args);

    it('only picks attacks whose range fits', () => {
        expect(pick(attacks, 1, 1, '', {}, 0.5).name).toBe('Swing');
        expect(pick(attacks, 5, 1, '', {}, 0.5).name).toBe('Thrust');
        expect(pick(attacks, 3.5, 1, '', {}, 0.5)).toBeNull();
    });

    it('holds phase-two attacks back until phase two', () => {
        expect(pick(attacks, 8, 1, '', {}, 0.99).name).toBe('Thrust');
        const picks = new Set([0.1, 0.9].map(r => pick(attacks, 7, 2, '', {}, r).name));
        expect(picks.has('Leap')).toBe(true);
    });

    it('never picks a combo-only attack on its own', () => {
        for (let r = 0; r < 1; r += 0.05) expect(pick(attacks, 1, 2, '', {}, r).name).not.toBe('Combo Only');
    });

    it('skips attacks still on cooldown', () => {
        expect(pick(attacks, 1, 1, '', { Swing: 2 }, 0.5)).toBeNull();
    });

    it('avoids repeating the last attack when another fits', () => {
        const both = [{ name: 'A', maxRange: 3 }, { name: 'B', maxRange: 3 }];
        for (let r = 0; r < 1; r += 0.1) expect(pick(both, 1, 1, 'A', {}, r).name).toBe('B');
    });
});

describe('lock-on ranking', () => {
    it('prefers the enemy nearest the camera forward, then the nearer one', () => {
        const ranked = new SoulsLockOnNode('rig').rankLockTargets([0, 0, 0], 0, [
            { id: 'side', position: [10, 0, 1] },
            { id: 'far-ahead', position: [0, 0, 15] },
            { id: 'near-ahead', position: [0.3, 0, 5] },
            { id: 'out-of-range', position: [0, 0, 40] },
        ], 20);
        expect(ranked.map(c => c.id)).toEqual(['near-ahead', 'far-ahead', 'side']);
    });
});

describe('the player', () => {
    function player() {
        const m = gm();
        const p = new SoulsPlayerNode('Player');
        (p as any)._gm = m;
        p.recomputeStats();
        p.hp = p.maxHp;
        return { m, p };
    }

    it('ignores damage during the roll i-frames and takes it outside them', () => {
        const { p } = player();
        p.invulnerable = true;
        expect(p.receiveHit(100, 10, null)).toBe(false);
        expect(p.hp).toBe(400);
        p.invulnerable = false;
        expect(p.receiveHit(100, 10, null)).toBe(true);
        expect(p.hp).toBe(300);
        expect(p.actionState).toBe('hit');
    });

    it('is invulnerable only inside the roll window', () => {
        const { p } = player();
        const at = (t: number) => { (p as any).actionState = 'roll'; (p as any)._stateTime = t; return (p as any)._computeInvulnerable(); };
        expect(at(0.02)).toBe(false);
        expect(at(0.2)).toBe(true);
        expect(at(0.5)).toBe(false);
    });

    it('staggers harder from a heavy hit', () => {
        const { p } = player();
        p.receiveHit(40, 10, null);
        expect((p as any)._actionSeconds).toBe(p.hitLightSeconds);
        p.receiveHit(200, 10, null);
        expect((p as any)._actionSeconds).toBe(p.hitHeavySeconds);
    });

    it('spends souls on a level and refuses one it cannot afford', () => {
        const { p } = player();
        p.souls = 500;
        expect(p.applyLevelUp(11, 10, 10, 10, p.levelCost(1))).toBe(true);
        expect(p.souls).toBe(100);
        expect(p.vigor).toBe(11);
        expect(p.maxHp).toBe(430);
        expect(p.hp).toBe(430);
        expect(p.applyLevelUp(12, 10, 10, 10, p.levelCost(2))).toBe(false);
    });

    it('refills flasks, health and stamina when restored', () => {
        const { p } = player();
        p.hp = 10; p.stamina = 0; p.estus = 0;
        p.restoreAll();
        expect([p.hp, p.stamina, p.estus]).toEqual([p.maxHp, p.maxStamina, p.estusMax]);
    });
});

describe('weapons', () => {
    it('finds its moves by node name', () => {
        const weapon = new SoulsWeaponNode('Weapon_StraightSword');
        const light = new SoulsMoveNode('Light1');
        weapon.addChild(light);
        weapon.addChild(new Node('Mesh'));
        expect(weapon.findMove('Light1')).toBe(light);
        expect(weapon.findMove('Mesh')).toBeNull();
        expect(weapon.moves()).toEqual([light]);
    });
});

describe('enemies', () => {
    function enemy(fields: Partial<SoulsHollowWardenNode> = {}, Type: typeof SoulsEnemyNode = SoulsEnemyNode) {
        const m = gm();
        const e = new Type('Hollow') as SoulsHollowWardenNode;
        Object.assign(e, { maxHp: 160, hp: 160, maxPoise: 25, poise: 25, defense: 0, ...fields });
        (e as any)._gm = Object.assign(m, { sfx() {}, shake() {}, onEnemyKilled() { killed++; } });
        let killed = 0;
        return { e, killed: () => killed };
    }

    it('flinches on an ordinary hit and staggers when poise breaks', () => {
        const { e } = enemy();
        e.receiveHit(20, 10, null);
        expect(e.fightState).toBe('flinch');
        e.receiveHit(20, 20, null);
        expect(e.fightState).toBe('stagger');
        expect(e.poise).toBe(e.maxPoise);
    });

    it('does not flinch through hyper armour', () => {
        const { e } = enemy();
        (e as any).fightState = 'attack';
        (e as any)._attack = { hyperArmor: true };
        e.receiveHit(20, 5, null);
        expect(e.fightState).toBe('attack');
    });

    it('dies once, at zero', () => {
        const { e } = enemy();
        e.receiveHit(500, 0, null);
        expect(e.isDead).toBe(true);
        expect(e.receiveHit(500, 0, null)).toBe(false);
    });

    it('turns to phase two at half health, and is untouchable while it roars', () => {
        // The Warden's own script owns its phase two; a plain enemy has none.
        const { e } = enemy({ maxHp: 1000, hp: 1000, maxPoise: 999, poise: 999, phase2At: 0.5 }, SoulsHollowWardenNode);
        e.receiveHit(400, 0, null);
        expect(e.phase).toBe(1);
        e.receiveHit(200, 0, null);
        expect(e.phase).toBe(2);
        expect(e.fightState).toBe('phase');
        expect(e.receiveHit(100, 0, null)).toBe(false);
        expect(e.hp).toBe(400);
    });

    it('a plain enemy never turns, however low it gets', () => {
        const { e } = enemy({ maxHp: 1000, hp: 1000, maxPoise: 999, poise: 999 });
        e.receiveHit(900, 0, null);
        expect([e.phase, e.isDead]).toEqual([1, false]);
    });

    it('never flinches when it is a boss', () => {
        const { e } = enemy({ isBoss: true, maxPoise: 999, poise: 999 });
        (e as any).fightState = 'ai';
        e.receiveHit(10, 1, null);
        expect(e.fightState).toBe('ai');
    });
});

describe('bloodstains', () => {
    function withInstantiate() {
        const m = gm();
        const made: any[] = [];
        Object.defineProperty(m, 'scene', {
            value: { instantiate: (_: string, o: any) => { const n: any = new Node('Bloodstain'); n.at = o.position; n.removed = false; n.remove = () => { n.removed = true; }; made.push(n); return n; } },
        });
        return { m, made };
    }

    it('drops the souls where the player fell', () => {
        const { m, made } = withInstantiate();
        m.dropBloodstain([1, 0, 2], 500);
        expect(made).toHaveLength(1);
        expect(made[0].souls).toBe(500);
        expect(made[0].at).toEqual([1, 0, 2]);
    });

    it('loses the old stain when the player dies again', () => {
        const { m, made } = withInstantiate();
        m.dropBloodstain([0, 0, 0], 500);
        m.dropBloodstain([5, 0, 5], 50);
        expect(made[0].removed).toBe(true);
        expect(m.bloodstain).toBe(made[1]);
    });

    it('drops nothing when there was nothing to lose', () => {
        const { m, made } = withInstantiate();
        m.dropBloodstain([0, 0, 0], 500);
        m.dropBloodstain([0, 0, 0], 0);
        expect(made).toHaveLength(1);
        expect(made[0].removed).toBe(true);
        expect(m.bloodstain).toBeNull();
    });
});

describe('blood', () => {
    /** A manager whose scene records instantiations instead of making them. */
    function bleeding() {
        const m = gm();
        const made: any[] = [];
        Object.defineProperty(m, 'scene', {
            value: {
                instantiate: (template: string, o: any) => {
                    const n: any = new Node(template);
                    n.at = o.position;
                    n.alive = true;
                    Object.defineProperty(n, 'scene', { get: () => (n.alive ? {} : null) });
                    n.remove = () => { n.alive = false; };
                    made.push(n);
                    return n;
                },
            },
        });
        const at = (x: number, z: number) => { const n = new Node('n'); n.setPosition([x, 0, z]); n.updateTransforms(); return n; };
        return { m, made, at };
    }

    it('throws droplets, pools blood under the target and spatters it along the blow', () => {
        const { m, made, at } = bleeding();
        m.bleed(at(0, 2), at(0, 0), 120);
        expect(made.map(n => n.name)).toEqual(['Blood Spray', 'Blood Splat', 'Blood Drops']);
        const [, splat, drops] = made;
        expect(splat.at).toEqual([0, 0.5, 2]);
        expect(drops.yaw).toBeCloseTo(0);            // +Z: from the attacker through the target
        expect(drops.at[2]).toBeGreaterThan(2);
        expect(splat.sizeScale).toBe(1);
        m.bleed(at(0, 2), at(2, 2), 10_000);
        expect(made[5].yaw).toBeCloseTo(-90);         // blow toward -X
        expect(made[5].sizeScale).toBe(1.6);
    });

    it('bleeds nothing when blood is off or nothing was dealt', () => {
        const { m, made, at } = bleeding();
        m.bleed(at(0, 0), null, 0);
        m.bloodEnabled = false;
        m.bleed(at(0, 0), null, 100);
        expect(made).toHaveLength(0);
    });

    it('keeps at most maxBloodDecals on the ground, retiring the oldest', () => {
        const { m, made, at } = bleeding();
        m.maxBloodDecals = 4;
        for (let i = 0; i < 5; i++) m.bleed(at(i, 0), null, 100);
        const decals = made.filter(n => n.name !== 'Blood Spray');
        expect(m.bloodDecals).toHaveLength(4);
        expect(decals.filter(n => n.alive)).toHaveLength(4);
        expect(decals[0].alive).toBe(false);
    });

    it('bleeds the player only when a hit lands', () => {
        const m = gm();
        let bled = 0;
        Object.assign(m, { bleed: () => { bled++; }, sfx() {}, shake() {} });
        const p = new SoulsPlayerNode('Player');
        (p as any)._gm = m;
        p.recomputeStats();
        p.hp = p.maxHp;
        p.invulnerable = true;
        p.receiveHit(100, 10, null);
        expect(bled).toBe(0);
        p.invulnerable = false;
        p.receiveHit(100, 10, null);
        expect(bled).toBe(1);
    });

    it('bleeds an enemy on every landed hit, the killing blow included', () => {
        const m = gm();
        const dealt: number[] = [];
        Object.assign(m, { bleed: (_t: any, _f: any, amount: number) => { dealt.push(amount); }, sfx() {}, shake() {}, onEnemyKilled() {} });
        const e = new SoulsEnemyNode('Hollow');
        Object.assign(e, { maxHp: 100, hp: 100, maxPoise: 50, poise: 50, defense: 0 });
        (e as any)._gm = m;
        e.receiveHit(40, 0, null);
        e.receiveHit(200, 0, null);
        e.receiveHit(50, 0, null);                    // dead: does not land
        expect(dealt).toHaveLength(2);
    });
});

describe('a blood splat', () => {
    function splat(hit: any) {
        const s = new SoulsBloodSplatNode('Blood Splat');
        const decal = new DecalNode('Decal', { size: [1, 0.4, 2] });
        s.addChild(decal);
        s.setPosition([3, 1.5, 4]);
        let removed = false;
        (s as any).remove = () => { removed = true; };
        const casts: any[] = [];
        Object.defineProperty(s, 'scene', { value: { physics: { raycast: (a: any, b: any) => { casts.push([a, b]); return hit; } } } });
        s.onStart();
        return { s, decal, removed: () => removed, casts };
    }

    it('stays invisible until it has found the floor, then lies on it at its size', () => {
        const { s, decal, casts } = splat({ point: [3, 0, 4], normal: [0, 1, 0] });
        expect(decal.opacity).toBe(0);
        s.sizeScale = 1; s.minSize = 1; s.maxSize = 1; s.yaw = 30;
        s.onUpdate(0.016);
        expect(casts[0]).toEqual([[3, 2, 4], [3, 1.5 - s.snapDown, 4]]);
        expect(Array.from(s.position)).toEqual([3, 0, 4]);
        expect(Array.from(s.rotation)).toEqual([0, 30, 0]);
        expect(decal.opacity).toBe(1);
        expect(Array.from(decal.size)).toEqual([1, 0.4, 2]);
    });

    it('tilts onto a slope so it projects into the surface', () => {
        const n = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0];   // 30 degrees, rising toward -X
        const { s } = splat({ point: [3, 0, 4], normal: n });
        s.onUpdate(0.016);
        expect(s.rotation[0]).toBeCloseTo(30);
        expect(s.rotation[1]).toBeCloseTo(90);
        // Its local +Y really is the normal.
        s.updateTransforms();
        const m = s.worldTransform;
        for (let i = 0; i < 3; i++) expect(m[4 + i]).toBeCloseTo(n[i]);   // the matrix's Y column
    });

    it('removes itself with no floor in reach', () => {
        const { s, removed } = splat(null);
        s.onUpdate(0.016);
        expect(removed()).toBe(true);
    });

    it('fades out over its last seconds, then goes', () => {
        const { s, decal, removed } = splat({ point: [3, 0, 4], normal: [0, 1, 0] });
        s.lifetime = 10; s.fadeSeconds = 2;
        s.onUpdate(0.016);
        s.onUpdate(8.984);                               // 9 s in: halfway through the fade
        expect(decal.opacity).toBeCloseTo(0.5, 1);
        expect(removed()).toBe(false);
        s.onUpdate(1.1);
        expect(decal.opacity).toBe(0);
        expect(removed()).toBe(true);
    });
});

describe('the fog gate', () => {
    function gate() {
        const g = new SoulsFogGateNode('Fog Gate');
        g.arenaCenter = [0, 0, 10];
        g.arenaRadius = 8;
        g.updateTransforms();
        return g;
    }

    it('offers the way in only from outside, and only while closed', () => {
        const g = gate();
        // Detached nodes: their cached world transforms are only refreshed on request.
        g.updateTransforms();
        const outside = new Node('p'); outside.setPosition([0, 0, -1]); outside.updateTransforms();
        const inside = new Node('p'); inside.setPosition([0, 0, 2]); inside.updateTransforms();
        expect(g.canInteract(outside)).toBe(true);
        expect(g.canInteract(inside)).toBe(false);
        g.gateState = 'fight';
        expect(g.canInteract(outside)).toBe(false);
    });

    it('resets for another attempt, but stays gone once the boss is dead', () => {
        const g = gate();
        g.gateState = 'fight';
        g.resetGate();
        expect(g.gateState).toBe('closed');
        g.dissolve();
        g.resetGate();
        expect(g.gateState).toBe('gone');
    });

    it('starts the boss fight when the player walks into the arena zone, and only that zone', () => {
        const m = gm() as any;
        const started: any[] = [];
        m.startBossFight = (g: any) => started.push(g);
        m._player = { isDead: false };
        const arena = new Node('Boss Arena');
        arena.setVariable('isBossArena', true, 'boolean', 'public');
        m.onPlayerEnteredZone(new Node('Some Message'));
        expect(started.length).toBe(0);
        m.onPlayerEnteredZone(arena);
        expect(started.length).toBe(1);
        m.bossDefeated = true;
        m.onPlayerEnteredZone(arena);
        expect(started.length).toBe(1);
    });
});

describe('the level-up menu', () => {
    it('prices several points as the sum of consecutive levels', () => {
        const m = gm();
        const p = new SoulsPlayerNode('Player');
        (p as any)._gm = m;
        p.recomputeStats();
        const menu = new SoulsBonfireMenuNode('BonfireMenu');
        (menu as any)._gm = m;
        (menu as any)._player = p;
        (menu as any)._pending = [12, 10, 11, 10];
        expect(menu.pendingCost()).toBe(p.levelCost(1) + p.levelCost(2) + p.levelCost(3));
    });
});
