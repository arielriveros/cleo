import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mat4, vec3 } from 'gl-matrix';
import { EXAMPLE, dataReady, readThisExample } from '@tools/exampleKit/testKit';
import { AnimatedModel, ModelNode, PhysicsSystem } from 'cleo';
import type { ReactionController } from 'cleo';
import { loadSkin } from '@editor/utils/animationAssets';
import { TEST_PHYSICS } from '@engine-tests/helpers/testPhysics';
import { acquirePhysicsBackend } from '@engine/physics/pal/createWorld';
import { makeBody, box } from '@engine-tests/helpers/physicsBodies';
import { resetScriptChannels } from '@engine/core/events/hub';

// The Sandbox's mannequin reacts with its whole body (physics/reactive/): shot, it flinches and holds the wound;
// tripped, it catches itself on its arms, lies down and gets up; thrown from the car at speed, it tumbles and gets
// up. Played on the example's own skeleton (a Mixamo rig, the automatic humanoid ragdoll) and its own idle, with
// the built-in reaction set its skeleton reacts with; and the scripts that send it there.

const present = dataReady();
const sandbox = present ? await readThisExample() : null;
const library = (name: string): any[] => sandbox!.read('libraries', `${name}.json`) ?? [];
const H = 1 / 60;
const ASSETS = join(EXAMPLE, 'Assets');
const source = (...p: string[]) => readFileSync(join(ASSETS, ...p), 'utf-8').replace(/\r\n/g, '\n');

describe.skipIf(!present)('the Sandbox mannequin reacts', { timeout: 300_000 }, () => {
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });

    /** The mannequin on its idle, on open ground (and whatever `extra` adds), its reactions. */
    async function setup(position: [number, number, number] = [0, 0, 0], extra?: (p: PhysicsSystem) => void) {
        await acquirePhysicsBackend(TEST_PHYSICS);
        const physics = new PhysicsSystem({ gravity: [0, -9.82, 0], backend: TEST_PHYSICS } as any);
        physics.initialize();
        (physics as any)._scene = { nodes: [], landscapes: [], tilemaps: [], activeCamera: null };
        physics.addBody(makeBody(box(50, 0.5, 50), { position: [0, -0.5, 0] }));
        extra?.(physics);
        made.push(physics);
        const skin = loadSkin(library('rigs').find(r => r.name === 'Mannequin')!.skin, (a: number[]) => mat4.clone(a as any));
        const idle = library('animations').find(a => a.name === 'Idle')!.clips[0];
        // A skinned model with no GPU buffers: the skeleton and the clip are all a reaction reads.
        const model = Object.create(AnimatedModel.prototype) as AnimatedModel;
        Object.assign(model, { _skin: skin, _animations: [idle], _materials: [], _submeshes: [], skinnedCloth: null });
        const node = new ModelNode('Mannequin', model);
        node.setPosition(position);
        node.updateTransforms(null);
        node.scene = {} as any;
        node.animator!.playAnimationByName(idle.name, true, false);
        node.animator!.update(0);
        const r = physics.reactionsOf(node)!;
        return { physics, node, r };
    }
    const run = (s: { physics: PhysicsSystem; node: ModelNode }, frames: number, each?: (f: number) => void) => {
        for (let f = 0; f < frames; f++) {
            each?.(f);
            s.physics.update(H);
            s.node.animator!.update(H);
        }
    };
    const finite = (r: ReactionController) => !r.ragdoll || r.ragdoll.parts.every(p => Number.isFinite(p.body.position.x + p.body.position.y + p.body.position.z));
    const at = (b: { position: { x: number; y: number; z: number } }) => vec3.fromValues(b.position.x, b.position.y, b.position.z);

    it('has reactions on its skeleton: the automatic humanoid, sixteen parts', async () => {
        const s = await setup();
        expect(s.r).not.toBeNull();
        s.r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 5 });
        expect(s.r.ragdoll?.powered).toBe(true);
        expect(s.r.ragdoll!.parts.length).toBe(16);
        // The parts stand where the idle has the bones: the head over the hips, about a mannequin high.
        const head = at(s.r.ragdoll!.parts[s.r.ragdoll!.findPart('Head')].body);
        expect(head[1]).toBeGreaterThan(1.4);
        expect(head[1]).toBeLessThan(1.9);
    });

    it('shot in the forearm, holds the wound with the other hand and stays up', async () => {
        const s = await setup();
        let closest = Infinity, start = NaN, fell = false;
        run(s, 150, f => {
            if (f === 5) s.r.hit({ part: 'Forearm L', direction: [0, 0, -1], impulse: 12 });
            if (s.r.state === 'falling') fell = true;
            const body = s.r.body, w = s.r.wounds[0];
            if (!body || !w || !w.hand) return;
            const d = vec3.distance(at(body.parts[body.arms[w.hand]!.end].body), body.simPoint(w.part, w.local) as vec3);
            if (Number.isNaN(start)) start = d;
            closest = Math.min(closest, d);
        });
        expect(fell).toBe(false);
        expect(s.r.wounds[0]?.hand).toBe('R');
        // cannon's arms are slower to land it, its contacts the stiffest (docs/editor/reactions.md#physics-backends).
        expect(closest).toBeLessThan(Math.min(TEST_PHYSICS === 'cannon' ? 0.32 : 0.25, start - 0.15));
        expect(finite(s.r)).toBe(true);
    });

    it('tripped, catches itself on its arms, lies down and gets up', async () => {
        const s = await setup();
        let first: string | null = null, states = '';
        run(s, 900, f => {
            if (f === 3) s.r.trip();
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            const rg = s.r.ragdoll;
            if (rg && !first) {
                const upper = rg.parts.filter(p => !['legs', 'feet', 'pelvis'].includes(p.region) && s.r.sensors.touching.has(p.index));
                if (upper.length) first = upper.some(p => p.region === 'arms' || p.region === 'hands') ? 'arms' : upper.map(p => p.name).join('+');
            }
        });
        // Never the head first. On Rapier, whose muscles are the softest, the chest can touch down before the hands.
        expect(first).not.toMatch(/Head/);
        if (TEST_PHYSICS !== 'rapier') expect(first).toBe('arms');
        expect(states).toMatch(/>falling.*>down.*>getUp.*>animated/);
        expect(s.r.state).toBe('animated');
    });

    it('thrown from the car at 10 m/s, tumbles, comes to rest and gets up', async () => {
        const s = await setup([0, 0.4, 0]);
        let states = '', nan = false;
        run(s, 900, f => {
            if (f === 2) s.r.bail({ velocity: [0, 0, 10], exitDirection: [1, 0, 0] });
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            if (!finite(s.r)) nan = true;
        });
        expect(nan).toBe(false);
        expect(states).toMatch(/>falling.*>down.*>getUp/);
        expect(s.r.state).toBe('animated');
    });

    it('knocked backwards down a flight, tumbles with its arms round its head', async () => {
        // Ten 0.2 m steps down along -Z from a 2 m landing, like the Sandbox's flights.
        const s = await setup([0, 2, 0.4], p => {
            for (let i = 0; i < 10; i++) p.addBody(makeBody(box(1.5, (2 - i * 0.2) / 2, 0.15), { position: [0, (2 - i * 0.2) / 2, -0.15 - i * 0.3] }));
            p.addBody(makeBody(box(1.5, 1, 1), { position: [0, 1, 1] }));
        });
        let sum = 0, n = 0, states = '';
        run(s, 300, f => {
            if (f === 5) s.r.push([0, 0.4, -2.6]);
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            const g = s.r.ragdoll;
            if (g && (s.r.state === 'tumble' || s.r.state === 'falling') && f > 20) {
                const head = at(g.parts[g.findPart('neck')].body);
                sum += Math.min(vec3.distance(head, at(g.parts[g.findPart('hand.L')].body)), vec3.distance(head, at(g.parts[g.findPart('hand.R')].body)));
                n++;
            }
        });
        expect(states).toMatch(/>falling.*>tumble/);
        expect(finite(s.r)).toBe(true);
        expect(sum / Math.max(1, n)).toBeLessThan(TEST_PHYSICS === 'rapier' ? 0.6 : 0.4);
    });
});

describe('the Sandbox scripts use the reactions', () => {
    it('a shot that strikes a character goes to its reactions, on the part it struck', () => {
        const gun = source('Weapons', 'Scripts', 'SandboxGun.ts');
        expect(gun).toContain('physics?.reactionsFor?.(hit.body) && physics.applyHit(hit, way, impulse)')
    });

    it('every Sandbox character sits out its reactions, and the player trips and is shoved on its keys', () => {
        // The body (SandboxCharacter, the player's and every NPC's): no input while a reaction has it.
        const body = source('Characters', 'Base', 'Scripts', 'SandboxCharacter.ts');
        expect(body).toMatch(/onUpdate\(delta: number\) \{\n\s+if \(this\._carPhase !== 'none'\) \{ this\._ride\(delta\); return \}\n\s+if \(this\._reacting\(delta\)\) return/);
        const player = source('Characters', 'Player', 'Scripts', 'SandboxPlayer.ts');
        expect(player).toMatch(/export default class SandboxPlayerNode extends SandboxCharacterNode/);
        expect(player).toContain("Input.started('Trip')");
        // The Trip key is the animator's Trip trigger (its Ragdoll state), fired by name.
        expect(player).toMatch(/@animTrigger\('Trip'\)\n\s+private _trip\(\) \{\}/);
        expect(player).toContain("Input.started('Shove')");
        const input = JSON.parse(readFileSync(join(EXAMPLE, 'ProjectSettings', 'input.json'), 'utf-8'));
        const actions = input.maps.flatMap((m: any) => m.actions.map((a: any) => a.name));
        for (const a of ['Trip', 'Shove']) expect(actions).toContain(a);
    });

    it('the car throws its driver out when asked to stop at speed', () => {
        const car = source('Vehicles', 'Car', 'Scripts', 'SandboxCar.ts');
        expect(car).toContain('Math.abs(vehicle.speed) > this.bailSpeed && this._driver?.bailOut?.(');
        const body = source('Characters', 'Base', 'Scripts', 'SandboxCharacter.ts');
        expect(body).toContain('reactions.bail({ velocity, exitDirection, vehicle })');
    });

    it('the car knocks down whoever it hits fast enough, warns whoever is ahead of it, and lets only the player drive', () => {
        const car = source('Vehicles', 'Car', 'Scripts', 'SandboxCar.ts');
        expect(car).toContain('character.struckByVehicle(this, [v[0], v[1], v[2]], closing)');
        expect(car).toContain('character.dodgeVehicle(this, [v[0], v[1], v[2]])');
        expect(car).toContain('character.canDrive === true');
        const body = source('Characters', 'Base', 'Scripts', 'SandboxCharacter.ts');
        expect(body).toMatch(/public struckByVehicle\(vehicle: Node, velocity: ArrayLike<number>, speed: number\): boolean/);
        expect(body).toMatch(/public get canDrive\(\): boolean \{ return false \}/);
        expect(source('Characters', 'Player', 'Scripts', 'SandboxPlayer.ts')).toMatch(/public get canDrive\(\): boolean \{ return true \}/);
    });

    it('an NPC never dies: its health kept full, a body down too long got up, its hits adding up to a fall', () => {
        const npc = source('Characters', 'NPCs', 'Scripts', 'SandboxNpc.ts');
        expect(npc).toContain('reactions.health = 1');
        expect(npc).toContain('if (!reactions.alive) { reactions.reset(); return }');
        expect(npc).toContain('if (this._downFor > this.downSeconds) { this._downFor = 0; reactions.getUp() }');
        expect(npc).toMatch(/@eventListener\('reaction:Hit'\)/);
        expect(npc).toMatch(/if \(this\._shock >= this\.knockdownShock \|\| legs\)/);
    });
});
