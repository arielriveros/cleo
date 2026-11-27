import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Logger } from '../src/core/logger';
import { mat4, vec3 } from 'gl-matrix';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsBackendKind } from '../src/physics/pal/types';
import type { PhysicsSystem } from '../src/physics/physicsSystem';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';
import type { ReactionController, ReactionEventInfo } from '../src/physics/reactive/reactionController';
import { defaultReactionSet, parseReactionSets, pickReactionSet, reactionParamKeys, REACTION_PRESETS } from '../src/physics/reactive/reactionSet';
import { getChannel, resetScriptChannels } from '../src/core/events/hub';
import { LoopbackPort } from '../src/physics/worker/ports';
import { groundWorld, humanoidModel, IDLE, ARM_SWING, boneIndex } from './helpers/humanoidRig';
import type { Animation } from '../src/animation/animatedModel';
import { quat } from 'gl-matrix';
import { makeBody, box } from './helpers/physicsBodies';
import { physicsStats } from '../src/physics/physicsStats';
import { Node } from '../src/core/scene/nodes/node';

// Reactions (physics/reactive/): a character that is hit flinches and clutches the wound, one pushed steps to keep
// its balance, one that trips or drops catches itself, bends its knees and protects its head, lies still, and
// gets up. Measured on a procedural person (tests/helpers/humanoidRig.ts) on every backend; the finest gates on
// Jolt, the default, whose motors meet the muscles exactly (Rapier's are the shared spring, a little softer).

// Reactions run on Jolt alone (capabilities.reactions); 'no reactions on %s' below checks the others give none.
const BACKENDS: PhysicsBackendKind[] = ['jolt'];
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
        expect(reactionParamKeys()).toContain('behaviours.stepBalance.giveUpTilt');
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

    it('shoved, is carried back on its feet, farther the harder, keeping its control, and knocked down past the fall threshold', () => {
        const pushes = [40, 80, 200].map(J => {
            const s = setup();
            let fell = false, control = true;
            run(s, 240, f => {
                if (f === 5) s.r.push([0, 0, -J / 70]);
                if (s.r.state === 'falling') fell = true;
                if (f > 5 && !fell && !s.r.hasControl) control = false;
            });
            return { J, fell, control, moved: -s.node.worldPosition[2] };
        });
        expect(pushes[0].fell).toBe(false);
        expect(pushes[1].fell).toBe(false);
        expect(pushes[0].control && pushes[1].control).toBe(true);
        expect(pushes[0].moved).toBeGreaterThan(0.1);
        expect(pushes[1].moved).toBeGreaterThan(pushes[0].moved);
        expect(pushes[2].fell).toBe(true);
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
    for (const backend of ['jolt'] as const) {
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
    for (const backend of ['jolt'] as const) {
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

// What made reactions look wrong: a spine bent and twisted by world axes taken as its parent's, a get-up that turned
// the body round to meet a clip lined up with the idle rather than with itself, a get-up that a hit could not stop,
// foot and hand IK left planting the animation the muscles reach for, and a body that slid where it should roll.
// Elsewhere a model has none: a hit moves only what it strikes, and a ragdoll it is given (a death) still falls.
describe.each(['cannon', 'rapier'] as PhysicsBackendKind[])('no reactions on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); vi.restoreAllMocks(); });
    const world = () => { const p = groundWorld(backend); made.push(p); return p; };

    it('gives a skinned model none, and says why once', () => {
        const info = vi.spyOn(Logger, 'info');
        const p = world();
        expect(p.capabilities?.reactions).toBe(false);
        expect(p.reactionsSupported).toBe(false);
        const node = humanoidModel();
        expect(p.reactionsOf(node)).toBeNull();
        const character = new Node('Character');
        character.addChild(node);
        expect(p.reactionsFor(character)).toBeNull();
        expect(p.reactionsOf(humanoidModel())).toBeNull();
        expect(info.mock.calls.filter(c => /only on the Jolt/.test(String(c[0]))).length).toBe(1);
    });

    it("pushes what a ray's hit strikes, and a model's own ragdoll still falls", () => {
        const p = world();
        const node = humanoidModel();
        const crate = makeBody(box(0.3, 0.3, 0.3), { mass: 10, position: [4, 0.3, 0] });
        p.addBody(crate);
        expect(p.applyHit({ point: [0, 1.4, 0.35], normal: [0, 0, 1], distance: 1, body: null, node } as any, [0, 0, -1], 12)).toBe(false);
        expect(p.applyHit({ point: [4, 0.3, 0.3], normal: [0, 0, 1], distance: 1, body: crate, node: null } as any, [0, 0, -1], 10)).toBe(false);
        expect(crate.velocity.z).toBeLessThan(-0.5);
        const ragdoll = p.startRagdoll(node)!;
        const top = () => Math.max(...[...ragdoll.bodies.values()].map(b => b.position.y));
        const standing = top();
        for (let f = 0; f < 180; f++) p.update(H);
        expect(standing - top()).toBeGreaterThan(0.5);
    });
});

describe('the reactions capability', () => {
    it("is Jolt's: there a skinned model has reactions", async () => {
        await acquirePhysicsBackend('jolt');
        const p = groundWorld('jolt');
        expect(p.capabilities?.reactions).toBe(true);
        expect(p.reactionsSupported).toBe(true);
        expect(p.reactionsOf(humanoidModel())).not.toBeNull();
        p.dispose();
    });
});

describe.each(BACKENDS)('reactions that look right on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });

    /** Getting up from lying face down: the hips from flat on the ground (pitched forward) to standing, in 1.5 s. */
    const getUpClip = (): Animation => {
        const lying = quat.setAxisAngle(quat.create(), [1, 0, 0], Math.PI / 2), up = quat.create();
        return {
            name: 'Get Up',
            samplers: [
                { input: [0, 1.5], output: [...lying, ...up], interpolation: 'LINEAR' },
                { input: [0, 1.5], output: [0, 0.2, 0, 0, 1.0, 0], interpolation: 'LINEAR' },
            ],
            channels: [
                { samplerIndex: 0, targetNodeIndex: boneIndex('Hips'), targetPath: 'rotation' },
                { samplerIndex: 1, targetNodeIndex: boneIndex('Hips'), targetPath: 'translation' },
            ],
        } as Animation;
    };

    /** A person facing `yaw` degrees, with a get-up clip for both faces. */
    function person(yaw = 0) {
        const physics = groundWorld(backend);
        made.push(physics);
        const node = humanoidModel([IDLE(), getUpClip()]);
        const set = defaultReactionSet();
        set.behaviours.getUp.clips = { faceDown: 'Get Up', faceUp: 'Get Up' };
        (node.model as any).skin.reactionSets = { version: 1, sets: [set] };
        node.setRotation([0, yaw, 0]);
        node.updateTransforms(null);
        const r = physics.reactionsOf(node)!;
        return { physics, node, r };
    }
    const step = (s: { physics: PhysicsSystem; node: ModelNode }) => { s.physics.update(H); s.node.animator!.update(H); };
    const heading = (q: { x: number; y: number; z: number; w: number }, axis: [number, number, number]) => {
        const v = vec3.transformQuat(vec3.create(), axis, [q.x, q.y, q.z, q.w]);
        return Math.atan2(v[0], v[2]) * 180 / Math.PI;
    };
    const wrap = (a: number) => ((a + 540) % 360) - 180;

    it('turns a part about a WORLD axis the same whichever way its parent faces', () => {
        for (const yaw of [0, 90, 200]) {
            const s = person(yaw);
            s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 5 });
            const body = s.r.body!;
            body.begin();
            const i = body.chest, parent = body.parts[i].parent;
            const qp = body.simRotation(parent);
            const before = quat.multiply(quat.create(), qp as quat, body.target[i] as unknown as quat);
            const turn = quat.setAxisAngle(quat.create(), [1, 0, 0], 0.4);
            body.turnWorld(i, turn as unknown as number[], 1);
            const after = quat.multiply(quat.create(), qp as quat, body.target[i] as unknown as quat);
            const want = quat.multiply(quat.create(), turn, before);
            expect(Math.abs(quat.dot(after, want)), `facing ${yaw}`).toBeGreaterThan(0.9999);
        }
    });

    it('keeps the chest from twisting round on the hips when hit from the side, facing any way', () => {
        const worst: number[] = [];
        for (const yaw of [0, 120]) {
            const s = person(yaw);
            // From its left, whichever way it faces.
            const a = yaw * Math.PI / 180, from = [-Math.cos(a), 0, Math.sin(a)];
            let most = 0;
            for (let f = 0; f < 150; f++) {
                if (f === 5) s.r.hit({ part: 'Chest', direction: from as [number, number, number], impulse: 30 });
                step(s);
                const rg = s.r.ragdoll, body = s.r.body;
                if (!rg || !body) continue;
                const p = rg.parts[body.pelvis].body.quaternion, c = rg.parts[body.chest].body.quaternion;
                // The chest's twist about the spine against the hips: their side axes' headings, in the hips' frame.
                const rel = quat.multiply(quat.create(), quat.invert(quat.create(), [p.x, p.y, p.z, p.w]), [c.x, c.y, c.z, c.w]);
                const twist = 2 * Math.atan2(Math.abs(rel[1]), Math.abs(rel[3])) * 180 / Math.PI;
                most = Math.max(most, twist);
            }
            worst.push(most);
        }
        // About as far as a spine turns (its two joints' twist), and the same facing any way.
        for (const w of worst) expect(w).toBeLessThan(45);
        expect(Math.abs(worst[0] - worst[1])).toBeLessThan(12);
    });

    it('gets up on a clip lined up with the body: the body does not turn round to meet it', () => {
        const s = person(30);
        let start: number | null = null, turned = 0, states = '';
        for (let f = 0; f < 900; f++) {
            if (f === 3) s.r.trip();
            step(s);
            if (!states.endsWith(s.r.state)) states += `>${s.r.state}`;
            const rg = s.r.ragdoll, body = s.r.body;
            // While the skin blends from the body onto the clip's first frame.
            if (s.r.state !== 'getUp' || !rg || !body || s.r.stateTime > 0.3) continue;
            const h = heading(rg.parts[body.pelvis].body.quaternion, [0, 1, 0]);
            if (start === null) start = h;
            turned = Math.max(turned, Math.abs(wrap(h - start)));
        }
        expect(states).toMatch(/>getUp/);
        expect(turned).toBeLessThan(20);
    });

    it('is knocked back down by a hit while it gets up', () => {
        const s = person();
        let after = '';
        for (let f = 0; f < 900 && !after; f++) {
            if (f === 3) s.r.trip();
            step(s);
            if (s.r.state === 'getUp' && s.r.stateTime > 0.5) {
                s.r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 20 });
                after = s.r.state;
            }
        }
        expect(['falling', 'stagger']).toContain(after);
    });

    it('fades foot and hand IK out while a reaction has the body, and back in after', () => {
        const s = person();
        const a = s.node.animator! as any;
        let off = false;
        for (let f = 0; f < 600; f++) {
            if (f === 3) s.r.trip();
            step(s);
            if (s.r.state === 'down' && a._footIkReaction === 0 && a._handIkReaction === 0) off = true;
        }
        expect(off).toBe(true);
        for (let f = 0; f < 60; f++) step(s);
        if (s.r.state === 'animated') expect([a._footIkReaction, a._handIkReaction]).toEqual([1, 1]);
    });

    it('rolls when pushed lying down, rather than sliding', () => {
        const s = person();
        // On ground with grip (the Sandbox's course has 0.7): a pair takes the smaller friction.
        s.physics.addBody(makeBody(box(50, 0.5, 50), { position: [0, -0.49, 0], friction: 0.8 }));
        for (let f = 0; f < 400 && s.r.state !== 'down'; f++) { if (f === 3) s.r.trip(); step(s); }
        expect(s.r.state).toBe('down');
        const rg = s.r.ragdoll!, body = s.r.body!;
        const pelvis = rg.parts[body.pelvis].body;
        // Sideways to the way it lies.
        const left = vec3.transformQuat(vec3.create(), [1, 0, 0], [pelvis.quaternion.x, pelvis.quaternion.y, pelvis.quaternion.z, pelvis.quaternion.w]);
        left[1] = 0; vec3.normalize(left, left);
        s.r.push([left[0] * 2.5, 0.3, left[2] * 2.5]);
        const from = at(pelvis);
        let turned = 0;
        for (let f = 0; f < 60; f++) {
            step(s);
            const w = pelvis.angularVelocity;
            turned += Math.hypot(w.x, w.y, w.z) * H;
        }
        const moved = vec3.distance(at(pelvis), from);
        // Rolling covers its radius (about 0.13 m) of ground a radian.
        expect(turned * 0.13).toBeGreaterThan(moved * 0.35);
    });

    it('struck by a car: the legs go first, the knees and hips bend and the arms come up round the head', () => {
        const s = person();
        for (let f = 0; f < 5; f++) step(s);
        s.r.impact({ velocity: [0, 0, -8] });
        let bent = 0, guard = Infinity;
        for (let f = 0; f < 30; f++) {
            step(s);
            const rg = s.r.ragdoll, body = s.r.body;
            if (!rg || !body) continue;
            const leg = body.legs.L!, arm = body.arms.L!;
            const q = (i: number) => { const b = rg.parts[i].body.quaternion; return [b.x, b.y, b.z, b.w] as quat; };
            const knee = 2 * Math.acos(Math.min(1, Math.abs(quat.dot(q(leg.root), q(leg.mid))))) * 180 / Math.PI;
            bent = Math.max(bent, knee);
            if (f > 12) guard = Math.min(guard, vec3.distance(at(rg.parts[arm.end].body), at(rg.parts[body.head].body)));
        }
        expect(s.r.state).toBe('falling');
        expect(bent).toBeGreaterThan(25);
        expect(guard).toBeLessThan(0.45);
    });
});

// What reacting costs, kept in check: a budget of reacting bodies (a flinch past it moves nothing, a fall takes the
// farthest flinch's body), a body lying still out of the world, solver iterations for its own island, and senses
// cast only as its state needs them.
// On its feet a reaction is physical animation: the legs and hips kinematic on the animation, the upper body
// following it on firm muscles with its motion, a stagger a shove on the capsule. The character keeps its control.
describe('physical animation on its feet (jolt)', () => {
    beforeAll(async () => { await acquirePhysicsBackend('jolt'); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });
    const person = (clips?: Animation[]) => {
        const physics = groundWorld('jolt');
        made.push(physics);
        const node = humanoidModel(clips);
        return { physics, node, r: physics.reactionsOf(node)! };
    };
    const step = (s: { physics: PhysicsSystem; node: ModelNode }) => { s.physics.update(H); s.node.animator!.update(H); s.physics.endFrame?.(H); };
    const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    /** Part `i`'s rotation against the hips, from a pose list (body.sim or body.anim). */
    const rel = (poses: number[][], pelvis: number, i: number) => quat.multiply(quat.create(),
        quat.conjugate(quat.create(), [poses[pelvis][3], poses[pelvis][4], poses[pelvis][5], poses[pelvis][6]]), [poses[i][3], poses[i][4], poses[i][5], poses[i][6]]);
    /** The skin's joints in the world, as drawn. */
    const drawn = (node: ModelNode) => {
        const skin = (node.model as any).skin, bones = node.animator!.getFinalBoneMatrices(), world = node.worldTransform as any;
        return skin.joints.map((j: any, i: number) => {
            const bind = mat4.invert(mat4.create(), j.inverseBindMatrix)!;
            const at = vec3.transformMat4(vec3.create(), mat4.getTranslation(vec3.create(), bind), bones[i] as any);
            return vec3.transformMat4(at, at, world);
        });
    };

    it('shot standing: the legs and hips stay on the animation, the upper body sways and comes back, and it never leaves its feet', () => {
        const s = person();
        const states: string[] = [];
        let legs = 0, sway = 0, control = true, anchored = false;
        for (let f = 0; f < 200; f++) {
            if (f === 5) s.r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 12 });
            step(s);
            if (states[states.length - 1] !== s.r.state) states.push(s.r.state);
            if (!s.r.hasControl) control = false;
            const b = s.r.body;
            if (!b || s.r.state !== 'hitReact') continue;
            anchored ||= s.r.ragdoll!.anchorPart === b.pelvis;
            for (const p of b.parts) if (b.kinematic[p.index]) legs = Math.max(legs, Math.hypot(b.sim[p.index][0] - b.anim[p.index][0], b.sim[p.index][1] - b.anim[p.index][1], b.sim[p.index][2] - b.anim[p.index][2]));
            sway = Math.max(sway, angle(rel(b.sim, b.pelvis, b.chest), rel(b.anim, b.pelvis, b.chest)));
        }
        expect(states).toEqual(['animated', 'hitReact', 'recover', 'animated']);
        expect(control).toBe(true);
        expect(anchored).toBe(true);
        expect(legs).toBeLessThan(0.02);
        expect(sway).toBeGreaterThan(0.02);
        expect(sway).toBeLessThan(0.6);
        expect(s.node.animator!.ikSuppressed).toBe(false);
    });

    it('follows a moving animation on its feet: a swinging arm is tracked within degrees, not trailed', () => {
        const s = person([ARM_SWING(25, 1)]);
        // Both hands on something (no reach for the wound: that is a target of its own, not the animation).
        s.r.busyHands = { L: true, R: true };
        const errors: number[] = [];
        for (let f = 0; f < 90; f++) {
            if (f === 10) s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 4 });
            step(s);
            const b = s.r.body;
            if (!b || s.r.state !== 'hitReact' || f < 25) continue;
            // Against its own parent (the chest, which turns too as the head looks to the wound).
            const arm = b.arms.R!.root, parent = b.parts[arm].parent;
            errors.push(angle(rel(b.sim, parent, arm), rel(b.anim, parent, arm)));
        }
        expect(errors.length).toBeGreaterThan(20);
        const rms = Math.sqrt(errors.reduce((a, e) => a + e * e, 0) / errors.length);
        // The arm swings at up to 2.7 rad/s: a second's lag (Euphoria's loose muscles) would be tens of degrees.
        expect(rms * 180 / Math.PI).toBeLessThan(10);
        expect(Math.max(...errors) * 180 / Math.PI).toBeLessThan(20);
    });

    it('a stumble shoves it back on its feet: carried, keeping its control, then back on its animation', () => {
        const s = person();
        const states = new Set<string>();
        for (let f = 0; f < 300; f++) {
            if (f === 5) s.r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 40 });
            step(s);
            states.add(s.r.state);
        }
        expect(states.has('stagger')).toBe(true);
        expect(states.has('falling')).toBe(false);
        expect(-s.node.worldPosition[2]).toBeGreaterThan(0.15);
        expect(s.r.state).toBe('animated');
    });

    it('a burst adds up: a few rounds stagger it, more knock it down', () => {
        const s = person();
        const seen: string[] = [];
        for (let f = 0; f < 120; f++) {
            if (f >= 5 && f % 6 === 5 && f < 5 + 6 * 7) s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 25 });
            step(s);
            if (seen[seen.length - 1] !== s.r.state) seen.push(s.r.state);
        }
        expect(seen.indexOf('stagger')).toBeGreaterThan(0);
        expect(seen.indexOf('falling')).toBeGreaterThan(seen.indexOf('stagger'));
    });

    it('starts and goes back to its animation without a pop: no drawn joint jumps against its own motion', () => {
        const s = person();
        const seen: vec3[][] = [];
        let worst = 0;
        for (let f = 0; f < 200; f++) {
            if (f === 5) s.r.hit({ part: 'Chest', direction: [-1, 0, 0], impulse: 14 });
            step(s);
            seen.push(drawn(s.node));
            if (seen.length < 3) continue;
            // The second difference (x[t] − 2·x[t−1] + x[t−2]): a joint moving at any speed changes it little; one
            // jumping where it is drawn (the skin swapped between the body and the animation) changes it a lot.
            const [a, b, c] = seen.slice(-3);
            for (let i = 0; i < c.length; i++) worst = Math.max(worst, Math.hypot(c[i][0] - 2 * b[i][0] + a[i][0], c[i][1] - 2 * b[i][1] + a[i][1], c[i][2] - 2 * b[i][2] + a[i][2]));
        }
        expect(s.r.state).toBe('animated');
        expect(worst).toBeLessThan(0.025);
    });

    it("lets a hand on a weapon stay there: a busy hand never reaches for a wound", () => {
        const s = person();
        s.r.busyHands = { L: true, R: true };
        for (let f = 0; f < 60; f++) {
            if (f === 5) s.r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 });
            step(s);
        }
        expect(s.r.wounds.every(w => w.hand === null)).toBe(true);
    });
});

describe.each(BACKENDS)('reacting bodies on a budget on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });
    const world = () => { const physics = groundWorld(backend); made.push(physics); return physics; };
    const step = (physics: PhysicsSystem, nodes: ModelNode[], frames = 1, each?: (f: number) => void) => {
        for (let f = 0; f < frames; f++) { each?.(f); physics.update(H); for (const n of nodes) n.animator!.update(H); }
    };

    it('a flinch past the budget moves no body, and its hit still counts', () => {
        const physics = world();
        physics.maxPoweredRagdolls = 1;
        const a = humanoidModel(undefined, [0, 0, 0]), b = humanoidModel(undefined, [3, 0, 0]);
        const ra = physics.reactionsOf(a)!, rb = physics.reactionsOf(b)!;
        const hits: string[] = [];
        getChannel('reaction').on('Hit', (info: ReactionEventInfo & { partName?: string }) => hits.push(info.partName ?? ''));
        step(physics, [a, b], 3);
        ra.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 });
        rb.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 });
        getChannel('reaction').flush?.();
        expect(ra.ragdoll).not.toBeNull();
        expect(rb.ragdoll).toBeNull();
        expect(rb.state).toBe('animated');
        expect(hits).toEqual(['Spine', 'Spine']);
        expect(physics.poweredRagdollCount).toBe(1);
    });

    it('a fall always gets its body, taking it from the character only flinching', () => {
        const physics = world();
        physics.maxPoweredRagdolls = 1;
        const a = humanoidModel(undefined, [0, 0, 0]), b = humanoidModel(undefined, [3, 0, 0]);
        const ra = physics.reactionsOf(a)!, rb = physics.reactionsOf(b)!;
        step(physics, [a, b], 3);
        ra.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 });
        step(physics, [a, b], 2);
        expect(ra.state).toBe('hitReact');
        rb.trip();
        expect(rb.ragdoll).not.toBeNull();
        expect(ra.ragdoll).toBeNull();
        expect(ra.state).toBe('animated');
        expect(physics.poweredRagdollCount).toBe(1);
    });

    it('a body lying still leaves the world, out of the budget, and comes back to get up', () => {
        const physics = world();
        const node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        let frozenDown = false, countFrozen = -1, unfrozenUp = false;
        step(physics, [node], 1200, f => {
            if (f === 3) r.trip();
            if (r.state === 'down' && r.ragdoll?.frozen && !frozenDown) { frozenDown = true; countFrozen = physics.poweredRagdollCount; }
            if (frozenDown && r.state === 'getUp' && r.ragdoll && !r.ragdoll.frozen) unfrozenUp = true;
        });
        expect(frozenDown, 'frozen lying still').toBe(true);
        expect(countFrozen).toBe(0);
        expect(unfrozenUp, 'back in the world to get up').toBe(true);
        expect(r.state).toBe('animated');
    });

    it('asks for its solver iterations for its own island where the backend can, and raises the world\'s where not', () => {
        const physics = world();
        const base = physics.solverIterations;
        const node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        step(physics, [node], 3);
        r.trip();
        step(physics, [node], 5);
        expect(r.ragdoll).not.toBeNull();
        if (physics.capabilities!.islandIterations) expect(physics.solverIterations).toBe(base);
        else expect(physics.solverIterations).toBeGreaterThan(base);
    });

    it('casts its senses as its state needs: the ground under it standing, where it lands falling', () => {
        const physics = world();
        const node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        step(physics, [node], 3);
        r.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 12 });
        let flinching = 0, falling = 0;
        step(physics, [node], 240, f => {
            if (f === 60) r.trip();
            if (r.state === 'hitReact') flinching = Math.max(flinching, physicsStats.sensorRays);
            if (r.state === 'falling') falling = Math.max(falling, physicsStats.sensorRays);
        });
        expect(flinching).toBe(1);
        expect(falling).toBeGreaterThan(4);
    });
});
