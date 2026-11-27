import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Logger } from '../src/core/logger';
import { vec3 } from 'gl-matrix';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsBackendKind } from '../src/physics/pal/types';
import type { PhysicsSystem } from '../src/physics/physicsSystem';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';
import type { ReactionController, ReactionEventInfo } from '../src/physics/reactive/reactionController';
import { stepState } from '../src/physics/reactive/behaviours';
import { defaultReactionSet, parseReactionSets, pickReactionSet, reactionParamKeys, REACTION_PRESETS } from '../src/physics/reactive/reactionSet';
import { getChannel, resetScriptChannels } from '../src/core/events/hub';
import { LoopbackPort } from '../src/physics/worker/ports';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';
import { makeBody, box } from './helpers/physicsBodies';
import { Node } from '../src/core/scene/nodes/node';

// Reactions (physics/reactive/): a character that is hit flinches and clutches the wound, one pushed steps to keep
// its balance, one that trips or drops catches itself, bends its knees and protects its head, lies still, and
// gets up. Measured on a procedural person (tests/helpers/humanoidRig.ts) on every backend; the finest gates on
// Jolt, the default, whose motors meet the muscles exactly (Rapier's are the shared spring, a little softer).

const BACKENDS: PhysicsBackendKind[] = ['jolt', 'cannon', 'rapier'];
const H = 1 / 60;
const at = (b: { position: { x: number; y: number; z: number } }) => vec3.fromValues(b.position.x, b.position.y, b.position.z);

describe('reaction sets', () => {
    it('read tolerantly: numbers clamped, missing ones defaulted, unknown ones dropped', () => {
        const sets = parseReactionSets({ sets: [{ name: 'Mine', strength: 99, muscles: { arms: { frequency: -4 } }, thresholds: { fallImpulse: 'x', bogus: 3 }, behaviours: { hitReact: { enabled: false, params: { weakness: 0.6 } } } }] })!;
        const s = sets.sets[0];
        expect(s.name).toBe('Mine');
        expect(s.strength).toBe(5);
        expect(s.muscles.arms.frequency).toBe(0);
        expect(s.muscles.legs.frequency).toBe(defaultReactionSet().muscles.legs.frequency);
        expect(s.thresholds.fallImpulse).toBe(defaultReactionSet().thresholds.fallImpulse);
        expect('bogus' in s.thresholds).toBe(false);
        expect(s.behaviours.hitReact.enabled).toBe(false);
        expect(s.behaviours.hitReact.params.weakness).toBe(0.6);
        expect(parseReactionSets({ sets: 'no' })).toBeUndefined();
    });

    it('picks by id or name, else the default, else the first, else the built-in', () => {
        const sets = parseReactionSets({ defaultSet: 'b', sets: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }] });
        expect(pickReactionSet(sets, 'A').id).toBe('a');
        expect(pickReactionSet(sets, null).id).toBe('b');
        expect(pickReactionSet(undefined).name).toBe('Default');
    });

    it('round-trips its presets, and names every number for the docs', () => {
        for (const p of REACTION_PRESETS) {
            const s = p.make();
            expect(parseReactionSets({ sets: [JSON.parse(JSON.stringify(s))] })!.sets[0]).toEqual(s);
        }
        expect(reactionParamKeys()).toContain('behaviours.stepBalance.maxSteps');
        expect(new Set(reactionParamKeys()).size).toBe(reactionParamKeys().length);
    });
});

describe.each(BACKENDS)('reactions on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });

    function setup(position: [number, number, number] = [0, 0, 0], extra?: (p: PhysicsSystem) => void) {
        const physics = groundWorld(backend);
        made.push(physics);
        extra?.(physics);
        const node = humanoidModel(undefined, position);
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

    it('are there for a skinned model and absent for anything else', () => {
        const s = setup();
        expect(s.r).not.toBeNull();
        expect(s.r.state).toBe('animated');
        expect(s.physics.reactionsOf(null)).toBeNull();
    });

    it("are a character's body's, not a skinned model it carries deeper down (a viewmodel under its camera)", () => {
        const s = setup();
        const character = new Node('Character');
        const camera = new Node('Camera Rig');
        camera.addChild(humanoidModel());
        character.addChild(camera);
        character.addChild(s.node);
        expect(s.physics.reactionsFor(character)).toBe(s.r);
    });

    it('finds the part a ray strikes, before it has a body and after', () => {
        const s = setup();
        // Straight through the chest from the front (the person faces +Z).
        expect(s.r.partByRay([0, 1.4, 2], [0, 1.4, -2])?.part).toBe('Chest');
        expect(s.r.partByRay([0.6, 0.7, 2], [0.6, 0.7, -2])).toBeNull();
        s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 5 });
        expect(s.r.ragdoll).not.toBeNull();
        expect(s.r.partByRay([0.09, 0.7, 2], [0.09, 0.7, -2])?.part).toBe('Thigh L');
    });

    it("takes a ray's hit on the limb along the shot, and pushes anything else", () => {
        const s = setup();
        // As a gun's ray reports a character's capsule: its owner, and a point on its surface in front of the chest.
        const ground = s.physics.raycast([5, 5, 5], [5, -5, 5])!;
        const took = s.physics.applyHit({ ...ground, point: [0, 1.4, 0.35], node: s.node } as any, [0, 0, -1], 12);
        expect(took).toBe(true);
        expect(s.r.ragdoll!.parts[s.r.wounds[0].part].name).toBe('Chest');
        // Once it has a body, a ray that strikes a limb names it.
        const arm = s.r.ragdoll!.parts[s.r.ragdoll!.findPart('foreArm.L')];
        expect(s.physics.applyHit({ point: [arm.body.position.x, arm.body.position.y, arm.body.position.z], normal: [0, 0, 1], distance: 1, body: arm.body, node: null, ragdoll: s.r.ragdoll!, part: arm.index } as any, [0, 0, -1], 5)).toBe(true);
        expect(s.r.wounds[1].part).toBe(arm.index);
        // A crate is pushed, as before.
        const crate = makeBody(box(0.3, 0.3, 0.3), { mass: 10, position: [4, 0.3, 0] });
        s.physics.addBody(crate);
        expect(s.physics.applyHit({ point: [4, 0.3, 0.3], normal: [0, 0, 1], distance: 1, body: crate, node: null } as any, [0, 0, -1], 10)).toBe(false);
        expect(crate.velocity.z).toBeLessThan(-0.5);
    });

    it('takes a small hit standing: flinches, then is back on its animation', () => {
        const s = setup();
        const events: string[] = [];
        const ch = getChannel('reaction');
        for (const name of ['Hit', 'Started', 'Recovered', 'Fell']) ch.on(name, (info: ReactionEventInfo) => events.push(`${name}:${info.state}`));
        run(s, 200, f => { if (f === 5) s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 }); });
        ch.flush?.();
        expect(s.r.state).toBe('animated');
        expect(s.r.ragdoll).toBeNull();
        expect(events.map(e => e.split(':')[0])).toEqual(['Hit', 'Started', 'Recovered']);
        expect(s.node.animator!.physicsMapped).toBe(false);
    });

    it('trips: catches itself on its arms before its head hits, lies down, and gets up', () => {
        const s = setup();
        let first: string | null = null, states = '';
        run(s, 720, f => {
            if (f === 3) s.r.trip();
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            const rg = s.r.ragdoll;
            if (rg && !first) {
                const upper = rg.parts.filter(p => !['legs', 'feet', 'pelvis'].includes(p.region) && s.r.sensors.touching.has(p.index));
                if (upper.length) first = upper.some(p => p.region === 'arms' || p.region === 'hands') ? 'arms' : upper.map(p => p.name).join('+');
            }
        });
        expect(first).toBe('arms');
        expect(states).toMatch(/>falling.*>down.*>getUp.*>animated/);
        expect(s.r.state).toBe('animated');
    });

    it('drops off a ledge feet first: bends its knees before it lands', () => {
        const s = setup([0, 3, 0]);
        let knee = NaN;
        run(s, 150, f => {
            if (f === 2) s.r.fall();
            const g = s.r.ragdoll;
            if (!g || !Number.isNaN(knee)) return;
            if (s.r.sensors.touching.has(g.findPart('foot.L')) || s.r.sensors.touching.has(g.findPart('foot.R'))) {
                const dir = (i: number) => { const q = g.parts[i].body.quaternion; return vec3.transformQuat(vec3.create(), [0, 1, 0], [q.x, q.y, q.z, q.w]); };
                knee = Math.acos(Math.min(1, vec3.dot(dir(g.findPart('upLeg.L')), dir(g.findPart('leg.L'))))) * 180 / Math.PI;
            }
        });
        expect(knee).toBeGreaterThan(backend === 'rapier' ? 30 : 40);
        expect(finite(s.r)).toBe(true);
    });

    it('steps to keep its balance when pushed, more the harder, and falls past it', () => {
        const pushes = [40, 80, 200].map(J => {
            const s = setup();
            let fell = false, steps = 0;
            run(s, 240, f => {
                if (f === 5) s.r.push([0, 0, -J / 70]);
                if (s.r.state === 'falling') fell = true;
                if (s.r.body) steps = Math.max(steps, stepState(s.r.body).steps);
            });
            return { J, fell, steps, state: s.r.state };
        });
        expect(pushes[0].fell).toBe(false);
        expect(pushes[0].steps).toBeGreaterThan(0);
        expect(pushes[2].fell).toBe(true);
        for (const p of pushes) expect(p.steps).toBeLessThanOrEqual(defaultReactionSet().behaviours.stepBalance.params.maxSteps);
        if (backend === 'jolt') expect(pushes[1].steps).toBeGreaterThanOrEqual(pushes[0].steps);
    });

    it('bails from a vehicle at 10 m/s: tumbles, comes to rest, gets up', () => {
        const s = setup([0, 0.4, 0]);
        let states = '', nan = false;
        run(s, 720, f => {
            if (f === 2) s.r.bail({ velocity: [0, 0, 10], exitDirection: [1, 0, 0] });
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            if (!finite(s.r)) nan = true;
        });
        expect(nan).toBe(false);
        expect(states).toMatch(/>falling.*>down.*>getUp/);
        expect(s.r.state).toBe('animated');
    });

    it('rolls down stairs with its arms round its head', () => {
        const s = setup([0, 2, 0.4], p => {
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
        expect(sum / Math.max(1, n)).toBeLessThan(backend === 'rapier' ? 0.6 : 0.4);
    });

    it('dies limp and never gets up', () => {
        const s = setup();
        const died: string[] = [];
        getChannel('reaction').on('Died', () => died.push('x'));
        run(s, 400, f => { if (f === 3) s.r.hit({ part: 'Head', direction: [0, 0, -1], impulse: 30, damage: 1 }); });
        expect(s.r.alive).toBe(false);
        expect(s.r.state).toBe('dead');
        expect(died.length).toBe(1);
    });
});

// The arm's muscles aim the hand, a string lands it (hitReact's Reach pull), and the forearm and hand pass through
// the chest they cross (cannon's stiff contacts held them off it).
describe.each(BACKENDS)('a hand to the wound on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });

    it('shot in the left forearm, brings it in and holds it with the right hand', () => {
        const physics = groundWorld(backend), node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        let best = Infinity;
        for (let f = 0; f < 100; f++) {
            if (f === 5) r.hit({ part: 'Forearm L', direction: [0, 0, -1], impulse: 12 });
            physics.update(H); node.animator!.update(H);
            const body = r.body;
            if (body && r.wounds.length) {
                const w = r.wounds[0];
                best = Math.min(best, vec3.distance(at(body.parts[body.arms[w.hand!]!.end].body), body.simPoint(w.part, w.local) as vec3));
            }
        }
        expect(r.wounds.length === 0 || r.wounds[0].hand === 'R').toBe(true);
        expect(best).toBeLessThan(backend === 'jolt' ? 0.12 : backend === 'rapier' ? 0.2 : 0.3);
        physics.dispose();
    });
});

describe('reactions with the physics worker', () => {
    for (const backend of ['cannon', 'jolt'] as const) {
        it(`trip, lie and get up as inline on ${backend}`, async () => {
            await acquirePhysicsBackend(backend);
            const physics = groundWorld(backend);
            physics.setWorkerMode('on', () => new LoopbackPort());
            const node = humanoidModel();
            const r = physics.reactionsOf(node)!;
            let states = '';
            for (let f = 0; f < 900; f++) {
                if (f === 3) r.trip();
                physics.update(H);
                node.animator!.update(H);
                physics.endFrame(H);
                if (!states.endsWith(r.state)) states += `>${r.state}`;
            }
            expect(physics.executor).toBe('worker');
            expect(states).toMatch(/>falling.*>down.*>getUp.*>animated/);
            physics.dispose();
        }, 60000);
    }

    // An editor action (the bench's End or Run) ends a reaction between frames: its bodies are gone before the step
    // the worker is running for them comes back. The step lands without them.
    for (const backend of ['jolt', 'rapier', 'cannon'] as const) {
        it(`ends a reaction between frames on ${backend} without losing the step in flight`, async () => {
            await acquirePhysicsBackend(backend);
            const physics = groundWorld(backend);
            physics.setWorkerMode('on', () => new LoopbackPort());
            const node = humanoidModel();
            const r = physics.reactionsOf(node)!;
            const errors = vi.spyOn(Logger, 'error');
            for (let f = 0; f < 120; f++) {
                if (f === 3) r.trip();
                physics.update(H);
                node.animator!.update(H);
                physics.endFrame(H);
                if (f === 60) { expect(r.ragdoll).not.toBeNull(); r.reset(); }
            }
            expect(errors).not.toHaveBeenCalled();
            expect(r.state).toBe('animated');
            errors.mockRestore();
            physics.dispose();
        }, 60000);
    }
});
