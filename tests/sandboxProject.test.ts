import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { readExample } from '../tools/exampleKit/readExample.mjs';
// The whole engine: it registers itself as the scripts' 'cleo' module, so the example's script runs headless.
import { Scene, CleoEngine, PhysicsSystem, Animator, Logger, NODE_BUILTINS, MathUtils } from '../src/cleo';
import type { CharacterNode, CameraRigNode, ControllerNode, Node } from '../src/cleo';
import { loadSkin } from '../applications/editor/src/utils/animationAssets';
import { detectFootLockWindows } from '../src/animation/footLockWindows';
import { fakeInput } from './helpers/fakeInput';
import type { FakeInput } from './helpers/fakeInput';
import { TEST_PHYSICS } from './helpers/testPhysics';
import { PhysicsBody } from '../src/physics/physicsBody';
import { ALL_LAYERS, LAYER, layerByName } from '../src/physics/collisionLayers';
import { MaterialBinder } from '../src/graphics/render/materialBinder';

// The Sandbox example: a mannequin with ALS-style locomotion built from the engine's own tools (tools/sandbox).
// Almost everything that can go wrong with it is silent: a parameter bound to a field that does not exist reads
// its default forever, a turn clip whose root motion tilts the capsule tips the character over, a landing gated
// on the wrong flag fires at take-off. So this suite reads the bundle and PLAYS it, headless: the real Collider,
// Character and Controller on a real physics world, the scene's own script, and an Animator built from the
// bundle's skeleton, clips and machine, hung under the Character exactly where the model would be.

const PROJECT = join(__dirname, '..', 'applications', 'editor', 'public', 'examples', 'sandbox');
const present = existsSync(join(PROJECT, 'manifest.json'));
const sandbox = present ? await readExample(PROJECT) : null;
const read = (...parts: string[]) => sandbox!.read(...parts);
const library = (name: string): any[] => read('libraries', `${name}.json`) ?? [];
const allNodes = (root: any): any[] => { const out: any[] = []; const walk = (n: any) => { out.push(n); (n.children ?? []).forEach(walk); }; walk(root); return out; };
/** A copy with every model node a plain node: a model builds GPU buffers, and there is no device here. */
const withoutModels = (n: any): any => ({
    ...n,
    ...(n.type === 'model' ? { type: 'node', model: undefined, stateMachine: undefined, ragdoll: undefined } : {}),
    children: (n.children ?? []).map(withoutModels),
});

const FRAME = 1 / 60;
/** A spot with open ground 15 m round it. */
const OPEN: [number, number, number] = [32, 0.02, -30];
const DEG = 180 / Math.PI;
const wrap = (a: number) => ((a + 180) % 360 + 360) % 360 - 180;

let authoring = false;
let input: FakeInput;
/** Every world a test played: disposed after it, since a WASM backend's heap is fixed (Jolt's 128 MB holds a few). */
const played: PhysicsSystem[] = [];
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; input = fakeInput(); });
afterEach(() => {
    CleoEngine.authoringMode = authoring; input.restore();
    for (const p of played.splice(0)) p.dispose();
});

describe.skipIf(!present)('the Sandbox example project', { timeout: 300_000 }, () => {
    const sceneFile = () => read('scenes', `${read('manifest.json').mainSceneId}.json`);
    const nodes = () => allNodes(sceneFile().scene);
    const named = (name: string) => nodes().find(n => n.name === name);
    const rig = () => library('rigs')[0];
    const machine = () => named('Mannequin').stateMachine;

    // ----- the bundle -------------------------------------------------------------------------------

    it('is one 3D scene with its player, its camera rig and a merged static course', () => {
        const metas = read('manifest.json').sceneMetas;
        expect(metas).toHaveLength(1);
        expect(metas[0].dimension).toBe('3D');
        const collider = named('Player Collider');
        expect(collider.type).toBe('collider');
        expect(collider.collider.friction).toBe(0);
        expect(collider.collider.angularConstraints).toEqual([0, 0, 0]);
        const player = collider.children[0];
        expect(player.type).toBe('character');
        const types = player.children.map((c: any) => c.type);
        expect(types).toEqual(['cameraRig', 'model', 'controller']);
        const [camera] = player.children;
        expect(camera.name).toBe('Camera Rig');
        expect(camera.children[0].active).toBe(true);
        const controller = player.children[2];
        expect(controller.possessedId).toBe(player.id);
        expect(controller.aimSource).toBe('node');
        expect(controller.aimSourceId).toBe(camera.id);
        expect(camera.followId).toBe(player.children[1].id);
        // One course at the top, what is merged apart for its layer (the feet's detail, the stairs' ramps, the
        // see-through pillars) inside it.
        const course = sceneFile().scene.children.filter((n: any) => n.type === 'collider' && /^Static Collision/.test(n.name));
        expect(course.map((n: any) => n.name)).toEqual(['Static Collision']);
        expect(course[0].children.filter((n: any) => n.type === 'collider').map((n: any) => n.name).sort())
            .toEqual(['Static Collision (Foot Detail)', 'Static Collision (See Through)', 'Static Collision (Stair Ramp)']);
    });

    // ----- collision layers -------------------------------------------------------------------------

    /** The project's collision layers by name, as its settings name them. */
    const layer = (name: string) => layerByName(read('libraries', 'projectSettings.json').collisionLayers, name);

    it('names its layers: the feet on the steps and the bumps, the capsule on a ramp over each flight, the camera through the pillars', () => {
        const [character, detail, ramp, vehicle] = ['Character', 'Foot Detail', 'Stair Ramp', 'Vehicle'].map(layer);
        expect([character, detail, ramp, vehicle]).toEqual([16, 32, 64, 128]);
        const collider = named('Player Collider').collider;
        expect(collider.layer).toBe(character);
        // The capsule never meets the steps or the bumps: the ramp stands in for the steps, the ground for the bumps.
        expect(collider.mask & detail).toBe(0);
        expect(collider.mask & ramp).not.toBe(0);
        const rampBody = named('Static Collision (Stair Ramp)').collider, detailBody = named('Static Collision (Foot Detail)').collider;
        expect([rampBody.layer, rampBody.mask]).toEqual([ramp, character]);
        expect([detailBody.layer, detailBody.mask]).toEqual([detail, ALL_LAYERS]);
        expect(detailBody.shapes).toHaveLength(18 + 24);   // a box per step (10 + 8), and the 24 bumps
        const pillars = named('Static Collision (See Through)');
        expect(pillars.collider.layer).toBe(LAYER.SEE_THROUGH);
        expect(allNodes(pillars).filter((n: any) => n.type === 'model').map((n: any) => n.name).sort()).toEqual(['Pillar 1', 'Pillar 2', 'Pillar 3']);
        // The feet land on the steps and the bumps, never on the ramp; the camera stops at the steps and the wall,
        // never at the ramp, and sees through the pillars.
        const traceLayers = rig().skin.ikRig.traceLayers;
        expect([traceLayers & detail, traceLayers & ramp]).toEqual([detail, 0]);
        const camera = named('Camera Rig');
        expect([camera.collisionLayers & detail, camera.collisionLayers & ramp, camera.collisionLayers & LAYER.NO_CAMERA]).toEqual([detail, 0, 0]);
        expect(camera.seeThroughLayers).toBe(LAYER.SEE_THROUGH);
        // Small props are out of the camera's way, big ones block it.
        const props = library('templates').filter((t: any) => t.nodeJson?.type === 'collider' && t.nodeJson.collider.mass > 0);
        const layerOf = (name: string) => props.find((t: any) => t.name === name)?.nodeJson.collider.layer ?? LAYER.DEFAULT;
        expect(layerOf('Ball')).toBe(LAYER.NO_CAMERA);
        expect(layerOf('Large Crate')).toBe(LAYER.DEFAULT);
    });

    /** The flights of stairs (tools/sandbox/level.ts): where to set off from, the riser, the step count. */
    const FLIGHTS = [
        // Left of the barrel lying at the foot of the 15 cm flight.
        { name: '15 cm', x: -5.95, rise: 0.15, steps: 10 },
        { name: '20 cm', x: -1, rise: 0.2, steps: 8 },
    ];
    const STAIRS_Z = 6, TREAD = 0.3;
    /**
     * The most a stance foot creeps over its tread on the stairs, m/s. The clips' stride is 0.24 m to a 0.30 m tread,
     * which foot locking takes up: measured 0.02-0.13.
     */
    const STAIR_SLIDE = 0.25;
    /** The top of what is under `z` on flight `f`: the ground before it, a step's tread, the landing past it. */
    const treadTop = (f: typeof FLIGHTS[number], z: number) => z < STAIRS_Z ? 0 : Math.min(f.steps, Math.floor((z - STAIRS_Z) / TREAD) + 1) * f.rise;

    /**
     * Up a flight from 3 m short of it, or down it from its landing, at a gait, and stop past it, with the rig's foot
     * IK tuned by `ikRig`: every foot ray over the flight and what it landed on, and how the capsule, the animator
     * and the feet went while on it.
     */
    function flight(f: typeof FLIGHTS[number], o: { down?: boolean; gait?: 'walk' | 'jog' | 'sprint'; back?: number; ikRig?: Record<string, unknown>; character?: Record<string, unknown> } = {}) {
        const steps = layer('Foot Detail');
        const end = STAIRS_Z + f.steps * TREAD;
        const p = play(o.down ? [f.x, f.rise * f.steps + 0.02, end + 2.2] : [f.x, 0.02, STAIRS_Z - (o.back ?? 3)], o.ikRig ?? {}, o.character ?? {}, o.down ? 180 : 0);
        const hits: { layer: number; y: number; z: number }[] = [];
        const raycast = p.physics.raycast.bind(p.physics);
        // The foot rays are the ground-only ones the rig's trace layers filter.
        (p.physics as any).raycast = (from: any, to: any, options?: any) => {
            const hit = raycast(from, to, options);
            if (options?.groundOnly && options.layerMask !== undefined && hit) hits.push({ layer: hit.body.collisionFilterGroup, y: hit.point[1], z: hit.point[2] });
            return hit;
        };
        p.run(0.5);
        if (o.gait === 'walk') input.press('Walk');
        if (o.gait === 'sprint') input.press('Sprint');
        input.setMove(0, 1);
        const speeds: number[] = [], states = new Set<string>(), clips = new Set<string>();
        let onFlight = 0, facing = 0, atFirstRiser = -1;
        // Going up: the fastest it got before the flight, and how far short of the first riser it began to slow.
        let topSpeed = 0, brakeAt = -1;
        // The feet in stance on the flight: a toe at most 3.5 cm over its foot's tread (the one under the ankle: going
        // down, the toe hangs over the nose) and nearly still. Its drift over each stance (foot slide), and how far over
        // its tread each stance stood (a floating upper foot).
        const toes = ['LeftToeBase', 'RightToeBase'];
        const last: Record<string, vec3> = {};
        const stance: Record<string, { from: vec3; at: vec3; frames: number; over: number } | null> = { LeftToeBase: null, RightToeBase: null };
        let drift = 0, stanceTime = 0, stillFrames = 0, stillOver = 0;
        // How far apart the knees are side to side on the flight (model space, +X the left), m.
        let kneeSum = 0, kneeFrames = 0;
        const overs: number[] = [];
        const close = (toe: string) => {
            const s = stance[toe];
            if (s && s.frames >= 4) { drift += Math.hypot(s.at[0] - s.from[0], s.at[2] - s.from[2]); stanceTime += s.frames * FRAME; overs.push(s.over); }
            stance[toe] = null;
        };
        // A walk up a flight takes its time: 3 m at a walk, 3 more at half a metre a second.
        p.run(o.gait === 'walk' ? 10 : o.down ? 6 : 5, () => {
            const at = p.collider.worldPosition;
            // Past the flight: let go there.
            if (o.down ? at[2] < STAIRS_Z - 1 : at[2] > end + 0.6) input.setMove(0, 0);
            if (!o.down && atFirstRiser < 0 && at[2] >= STAIRS_Z) atFirstRiser = p.player.groundSpeed;
            if (!o.down && at[2] < STAIRS_Z) {
                topSpeed = Math.max(topSpeed, p.player.groundSpeed);
                if (brakeAt < 0 && topSpeed > 1 && p.player.groundSpeed < topSpeed - 0.15) brakeAt = STAIRS_Z - at[2];
            }
            const onIt = at[2] > STAIRS_Z + 0.5 && at[2] < end - 0.5;
            for (const toe of toes) {
                const w = p.jointWorld(toe), ankle = p.jointWorld(toe === 'LeftToeBase' ? 'LeftFoot' : 'RightFoot');
                const prev = last[toe];
                last[toe] = vec3.clone(w);
                if (!onIt || !prev) { close(toe); continue; }
                const over = w[1] - treadTop(f, ankle[2]);
                const still = Math.hypot(w[0] - prev[0], w[1] - prev[1], w[2] - prev[2]) / FRAME < 0.3;
                if (still) { stillFrames++; if (over < 0.035) stillOver++; }
                if (over > 0.035 || !still) { close(toe); continue; }
                const s = stance[toe];
                if (!s) stance[toe] = { from: vec3.clone(w), at: vec3.clone(w), frames: 0, over };
                else { vec3.copy(s.at, w); s.frames++; s.over = Math.min(s.over, over); }
            }
            if (!onIt) return;
            onFlight++;
            kneeSum += p.jointModel('LeftLeg')[0] - p.jointModel('RightLeg')[0];
            kneeFrames++;
            speeds.push(p.player.groundSpeed);
            states.add(p.animator.currentStateName ?? '');
            clips.add(heaviest(p));
            const v = p.player.velocity, fw = p.player.worldForward;
            if (Math.hypot(v[0], v[2]) > 0.3) facing = Math.max(facing, Math.abs(wrap(Math.atan2(v[0], v[2]) * DEG - Math.atan2(fw[0], fw[2]) * DEG)));
        });
        for (const toe of toes) close(toe);
        input.setMove(0, 0);
        input.release('Walk'); input.release('Sprint');
        const over = hits.filter(h => h.z > STAIRS_Z && h.z < end);
        // On a tread: on the steps, at one of their heights.
        const offTread = over.filter(h => h.layer !== steps || Math.abs(h.y - Math.round(h.y / f.rise) * f.rise) > 0.01).length;
        const mean = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : 0;
        return {
            p, hits, over, offTread, onFlight, states: [...states], clips: [...clips], mean, slowest: Math.min(...speeds), fastest: Math.max(...speeds), facing, atFirstRiser, topSpeed, brakeAt, knees: kneeFrames ? kneeSum / kneeFrames : 0,
            slide: stanceTime > 0 ? drift / stanceTime : 0, landed: stillFrames ? stillOver / stillFrames : 0, overs, stillFrames, top: f.rise * f.steps,
        };
    }

    /** The stair paces the build fitted (SandboxPlayer's public attributes): horizontal m/s. */
    const pace = (name: 'stairUpWalkSpeed' | 'stairUpRunSpeed' | 'stairDownWalkSpeed' | 'stairDownRunSpeed') => named('Player').scriptVars[name] as number;
    /** Whether the Stairs blend space has clips for going down (clips.ts stairCheck passed them). */
    const downInBlend = () => (machine().states.find((s: any) => s.name === 'Stairs')?.field?.samples ?? []).some((s: any) => s.x < 0);
    /** The blend space's heaviest clip this frame. */
    const heaviest = (p: ReturnType<typeof play>) => [...(p.animator.activeFieldWeights ?? [])].sort((a: any, b: any) => b.weight - a.weight)[0]?.clipName ?? '';

    it("plays up and down a flight from one blend space, in the walk's sync group, the descent rebuilt from the pack's clips", () => {
        const sm = machine();
        const stairs = sm.states.find((s: any) => s.name === 'Stairs');
        const loco = sm.states.find((s: any) => s.name === 'Locomotion');
        expect(stairs.field.mode).toBe('2d');
        expect([stairs.fieldInputs.x, stairs.fieldInputs.y]).toEqual(['Stairs', 'GroundSpeed']);
        expect([stairs.syncGroup, stairs.plantInWindows, stairs.speedScaleParam]).toEqual([loco.syncGroup, true, 'StairRate']);
        // Up at +1, down at -1, each a creep, a walk and a run, at the paces the script keeps.
        const at = (x: number) => stairs.field.samples.filter((s: any) => s.x === x).map((s: any) => s.clipName).sort();
        expect(at(1)).toEqual(['StairsUpCreep', 'StairsUpRun', 'StairsUpWalk']);
        expect(at(-1)).toEqual(['StairsDownCreep', 'StairsDownRun', 'StairsDownWalk']);
        const speedOf = (name: string) => stairs.field.samples.find((s: any) => s.clipName === name).y;
        expect([speedOf('StairsUpWalk'), speedOf('StairsUpRun'), speedOf('StairsDownWalk'), speedOf('StairsDownRun')])
            .toEqual([pace('stairUpWalkSpeed'), pace('stairUpRunSpeed'), pace('stairDownWalkSpeed'), pace('stairDownRunSpeed')]);
        // The rebuilt descents step down and loop (the build's check), with a window per foot to plant by.
        const clips = new Map(library('animations').map(a => [a.clips[0].name, a.clips[0]]));
        for (const name of ['StairsDownWalk', 'StairsDownRun', 'StairsUpWalk', 'StairsUpRun']) {
            const c = clips.get(name);
            expect(c.footLocks['foot.L'].length, name).toBeGreaterThan(0);
            expect(c.footLocks['foot.R'].length, name).toBeGreaterThan(0);
        }
    });

    for (const gait of ['walk', 'jog'] as const) {
        it(`${gait}s up each flight in the stair climb, at its pace, facing its travel, the feet on the treads and never on the ramp`, () => {
            const ramp = layer('Stair Ramp');
            const expected = pace(gait === 'walk' ? 'stairUpWalkSpeed' : 'stairUpRunSpeed');
            for (const f of FLIGHTS) {
                const c = flight(f, { gait });
                console.log(`stairs ${f.name} ${gait} up: ${c.onFlight} frames, ${c.mean.toFixed(2)} m/s (${c.slowest.toFixed(2)}-${c.fastest.toFixed(2)}; the pace ${expected}), states ${c.states.join(' ')}, facing off ${c.facing.toFixed(0)} deg, `
                    + `${c.over.length} foot rays, ${c.offTread} off a tread, ${(c.landed * 100).toFixed(0)}% of still toes on their tread, stance slide ${c.slide.toFixed(2)} m/s`);
                expect(c.onFlight, f.name).toBeGreaterThan(40);
                expect(c.states, `${f.name}: the states on the flight`).toEqual(['Stairs']);
                // The climb's clips, never the descent's.
                expect(c.clips.every(n => n.startsWith('StairsUp')), `${f.name}: clips ${c.clips.join(' ')}`).toBe(true);
                // At the pace: one tread a step.
                expect(Math.abs(c.mean - expected) / expected, `${f.name}: ${c.mean.toFixed(2)} m/s on the flight, not ${expected}`).toBeLessThan(0.1);
                expect(c.facing, `${f.name}: facing off its travel`).toBeLessThan(15);
                expect(c.hits.some(h => h.layer === ramp), `${f.name}: a foot ray on the ramp`).toBe(false);
                expect(c.over.length, f.name).toBeGreaterThan(20);
                expect(c.offTread, `${f.name}: foot rays that missed a tread`).toBe(0);
                expect(c.slide, `${f.name}: stance slide`).toBeLessThan(STAIR_SLIDE);
                expect(c.p.collider.worldPosition[1], `${f.name}: up on the landing`).toBeCloseTo(c.top, 1);
                // A still foot stands on its tread, the upper one too (planted by its clip's windows at any height).
                // Not from every run-up: the climb steps one tread a step from wherever its stride met the flight,
                // so now and then each foot comes down on a riser's edge, the toe on the tread above (a known
                // limit: the stride is not matched to the treads). From three run-ups, most stand on their tread.
                const landings = [c.landed, ...[2.7, 3.3].map(back => flight(f, { gait, back }).landed)];
                console.log(`stairs ${f.name} ${gait} up: still toes on their tread from run-ups of 3, 2.7 and 3.3 m: ${landings.map(l => (l * 100).toFixed(0)).join(', ')}%`);
                expect(landings.filter(l => l > 0.85).length, `${f.name}: run-ups with the still toes on their tread`).toBeGreaterThanOrEqual(2);
                expect(c.p.trace).not.toContain('Fall');
            }
        });

        it(`${gait}s down each flight at its pace, facing its travel, the feet on the treads`, () => {
            const ramp = layer('Stair Ramp');
            const expected = pace(gait === 'walk' ? 'stairDownWalkSpeed' : 'stairDownRunSpeed');
            // The descent's clips (rebuilt from the pack's, descent.ts) when they passed the build's check; else a
            // flight down plays the walk blend at the stairs' pace.
            const down = downInBlend();
            const state = down ? 'Stairs' : 'Locomotion';
            for (const f of FLIGHTS) {
                const c = flight(f, { gait, down: true });
                console.log(`stairs ${f.name} ${gait} down: ${c.onFlight} frames, ${c.mean.toFixed(2)} m/s (${c.slowest.toFixed(2)}-${c.fastest.toFixed(2)}; the pace ${expected}), states ${c.states.join(' ')}, facing off ${c.facing.toFixed(0)} deg, `
                    + `${c.offTread} foot rays off a tread, ${(c.landed * 100).toFixed(0)}% of still toes on their tread, stance slide ${c.slide.toFixed(2)} m/s`);
                expect(c.onFlight, f.name).toBeGreaterThan(20);
                expect(c.states, `${f.name}: the states on the flight`).toEqual([state]);
                if (down) {
                    expect(c.clips.every(n => n.startsWith('StairsDown')), `${f.name}: clips ${c.clips.join(' ')}`).toBe(true);
                    expect(c.landed, `${f.name}: still toes on their tread`).toBeGreaterThan(0.85);
                    expect(c.slide, `${f.name}: stance slide`).toBeLessThan(STAIR_SLIDE);
                }
                expect(Math.abs(c.mean - expected) / expected, `${f.name}: ${c.mean.toFixed(2)} m/s on the flight, not ${expected}`).toBeLessThan(0.12);
                expect(c.facing, `${f.name}: facing off its travel`).toBeLessThan(15);
                expect(c.hits.some(h => h.layer === ramp), `${f.name}: a foot ray on the ramp`).toBe(false);
                expect(c.offTread, `${f.name}: foot rays that missed a tread`).toBe(0);
                expect(c.p.collider.worldPosition[1], `${f.name}: down on the ground`).toBeLessThan(0.1);
                expect(c.p.trace).not.toContain('Fall');
            }
        });
    }

    it('keeps its knees in walking up a flight, as close together as on the flat', () => {
        // The pack's walking climb splays its knees (23 cm apart over hips 16 cm apart); the build turns them in
        // (legs.ts alignKnees), and the foot IK bends them along the clip's own bend.
        const flat = play(OPEN);
        flat.run(0.5);
        input.press('Walk');
        input.setMove(0, 1);
        flat.run(1);
        let sum = 0, frames = 0;
        flat.run(1.5, () => { sum += flat.jointModel('LeftLeg')[0] - flat.jointModel('RightLeg')[0]; frames++; });
        input.setMove(0, 0);
        input.release('Walk');
        const onFlat = sum / frames;
        for (const f of FLIGHTS) {
            const c = flight(f, { gait: 'walk' });
            console.log(`stairs ${f.name} walk up: knees ${(c.knees * 100).toFixed(1)} cm apart, ${(onFlat * 100).toFixed(1)} walking on the flat`);
            expect(Math.abs(c.knees - onFlat), f.name).toBeLessThan(0.02);
        }
    });

    it('slows to the stairs\' pace by the first riser, starting late: from a jog and from a full sprint', () => {
        // Braking 1.5 times harder than its Acceleration, to the jog's own stair pace: from a jog it starts about
        // 0.6 m short of the first riser, from a sprint about 1.4 (it used to be 1.25 and 2.35).
        for (const [gait, back, latest] of [['jog', 3, 0.8], ['sprint', 7, 1.6]] as const) for (const f of FLIGHTS) {
            const c = flight(f, { gait, back });
            console.log(`stairs ${f.name} ${gait} up: ${c.topSpeed.toFixed(2)} m/s at most, slowing from ${c.brakeAt.toFixed(2)} m short of the first riser, ${c.atFirstRiser.toFixed(2)} m/s at it, ${c.mean.toFixed(2)} on the flight`);
            expect(c.topSpeed, `${f.name} ${gait}: up to speed`).toBeGreaterThan((gait === 'sprint' ? named('Player').runSpeed : named('Player').walkSpeed) * 0.95);
            expect(c.brakeAt, `${f.name} ${gait}: slows from`).toBeGreaterThan(0);
            expect(c.brakeAt, `${f.name} ${gait}: slows from`).toBeLessThan(latest);
            expect(c.atFirstRiser, f.name).toBeLessThan(pace('stairUpRunSpeed') * 1.15);
            expect(c.states, f.name).toEqual(['Stairs']);
        }
    });

    it('hands the walk blend over to the stair climb in step, the stride carried across', () => {
        // The same approach with and without the sync group. Through the cross-fade both sides pose the feet, and
        // their foot-lock windows say which foot each has planted: in step they agree, out of step one side swings
        // the foot the other stands on and the blend drags it. Measured as the share of the blend in which they
        // disagree, per foot (0 agree, 1 one side planted and the other not). Even in step they disagree for some of
        // it: the stair climb holds each foot down for 56-61% of its cycle, the walk for 44-47%, so about an eighth
        // of the cycle one side has a foot down that the other has just lifted.
        const handOver = (synced: boolean, back: number) => {
            const f = FLIGHTS[0];
            const p = play([f.x, 0.02, STAIRS_Z - back], {}, {}, undefined, synced ? undefined : (sm: any) => { for (const s of sm.states) delete s.syncGroup; });
            const feet = ['LeftFoot', 'RightFoot'].map(b => [...(rig().skin.nodeNames as [number, string][])].find(([, n]) => n.endsWith(':' + b))![0]);
            p.run(0.5);
            input.setMove(0, 1);
            let entered: { phase: number; previous: number | null; synced: boolean } | null = null;
            let disagree = 0, frames = 0;
            p.run(3, () => {
                const d = p.animator.fieldDebug;
                if (!entered && p.animator.currentStateName === 'Stairs') entered = { phase: d.phase, previous: d.previousPhase, synced: d.synced };
                if (!entered || !p.animator.isBlending) return;
                frames++;
                for (const foot of feet) {
                    const s = (p.animator as any)._footLockShares(foot) as { inside: number; total: number };
                    const share = s.total > 0 ? s.inside / s.total : 0;
                    disagree += 2 * Math.min(share, 1 - share) / feet.length;
                }
            });
            input.setMove(0, 0);
            return { entered, disagree: frames ? disagree / frames : 0, frames };
        };
        // From eight run-ups 15-20 cm apart, so the walk reaches the flight all round its stride (about 1.4 m).
        const backs = [3, 3.15, 3.35, 3.5, 3.7, 3.85, 4.05, 4.2];
        const runs = backs.map(back => ({ synced: handOver(true, back), unsynced: handOver(false, back) }));
        const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
        const syncedShare = mean(runs.map(r => r.synced.disagree)), unsyncedShare = mean(runs.map(r => r.unsynced.disagree));
        console.log(`stairs hand-over: the two sides disagree on a planted foot ${(syncedShare * 100).toFixed(0)}% of the blend in step `
            + `(${runs.map(r => (r.synced.disagree * 100).toFixed(0)).join(', ')}%), ${(unsyncedShare * 100).toFixed(0)}% without the sync group `
            + `(${runs.map(r => (r.unsynced.disagree * 100).toFixed(0)).join(', ')}%)`);
        for (const { synced, unsynced } of runs) {
            expect(synced.entered).not.toBeNull();
            expect(synced.entered!.synced).toBe(true);
            expect(synced.entered!.previous).toBeCloseTo(synced.entered!.phase, 6);
            expect(unsynced.entered!.synced).toBe(false);
            expect(synced.disagree).toBeLessThan(0.3);
        }
        // In step it is never as far out as the worst run-ups without it (35-40%: a foot one side swings, the
        // other stands on). On average the two come out alike, about 15-18%, since most run-ups happen to meet
        // the stair clip near in step anyway and the windows' lengths differ either way.
        expect(Math.max(...runs.map(r => r.synced.disagree))).toBeLessThan(Math.max(...runs.map(r => r.unsynced.disagree)) - 0.08);
        expect(syncedShare).toBeLessThan(unsyncedShare + 0.03);
    });

    it('turns round on a flight: the climb blends into the way down', () => {
        const f = FLIGHTS[0];
        const p = play([f.x, 0.02, STAIRS_Z - 3]);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(2.6);
        expect(p.animator.currentStateName).toBe('Stairs');
        expect(heaviest(p)).toMatch(/^StairsUp/);
        input.setMove(0, -1);
        p.run(1.2);
        // Down, facing the way it goes: the descent's clips in the same blend space when it has them, else the walk.
        expect(p.animator.currentStateName).toBe(downInBlend() ? 'Stairs' : 'Locomotion');
        if (downInBlend()) expect(heaviest(p)).toMatch(/^StairsDown/);
        expect(p.player.stairs).toBe(-1);
        const v = p.player.velocity, fw = p.player.worldForward;
        expect(Math.abs(wrap(Math.atan2(v[0], v[2]) * DEG - Math.atan2(fw[0], fw[2]) * DEG))).toBeLessThan(20);
        input.setMove(0, 0);
    });

    it('stands on a flight without sliding down its ramp, and stops on it as on the flat', () => {
        const f = FLIGHTS[1];
        // Half way up, let go: it brakes at its acceleration and stands, into Idle.
        const p = play([f.x, 0.02, STAIRS_Z - 3]);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.6);
        expect(p.player.onStairs).toBe(true);
        const v0 = p.player.velocity, speed = Math.hypot(v0[0], v0[1], v0[2]);
        const from = vec3.clone(p.collider.worldPosition as vec3);
        input.setMove(0, 0);
        p.run(0.8);
        const braked = vec3.distance(p.collider.worldPosition as vec3, from);
        expect(p.animator.currentStateName).toBe('Idle');
        // Braking at the Character's acceleration, along the ramp: v^2 / 2a (a frame or two of travel on top).
        expect(braked, `braked in ${braked.toFixed(3)} m from ${speed.toFixed(2)} m/s`).toBeLessThan(speed * speed / (2 * p.player.acceleration) + speed * 3 * FRAME);
        const still = vec3.clone(p.collider.worldPosition as vec3);
        p.run(3);
        const drift = vec3.distance(p.collider.worldPosition as vec3, still);
        // The hold off (slopeLimit 0): frictionless, it creeps down the ramp.
        const q = play([f.x, 0.02, STAIRS_Z - 3], {}, { slopeLimit: 0 });
        q.run(0.5);
        input.setMove(0, 1);
        q.run(1.6);
        input.setMove(0, 0);
        q.run(0.8);
        const qFrom = vec3.clone(q.collider.worldPosition as vec3);
        q.run(3);
        const creep = vec3.distance(q.collider.worldPosition as vec3, qFrom);
        console.log(`stairs stand: braked in ${braked.toFixed(3)} m from ${speed.toFixed(2)} m/s, then drifted ${(drift * 100).toFixed(2)} cm in 3 s (${(creep * 100).toFixed(1)} cm with slopeLimit 0)`);
        expect(drift).toBeLessThan(0.01);
        expect(creep).toBeGreaterThan(0.05);
    });

    it('lands the feet on the ramp instead when the rig traces every layer: the trace layers are what keep them off it', () => {
        const ramp = layer('Stair Ramp');
        const c = flight(FLIGHTS[1], { ikRig: { traceLayers: ALL_LAYERS } });
        console.log(`stairs ${FLIGHTS[1].name}, every layer traced: ${c.over.length} foot rays over it, ${c.offTread} off a tread`);
        expect(c.over.filter(h => h.layer === ramp).length).toBeGreaterThan(5);
        expect(c.offTread).toBeGreaterThan(5);
    });

    it('walks through the bumps on the ground, its feet climbing onto them', () => {
        const detail = layer('Foot Detail');
        // Up the middle column of the strip (level.ts: x 3, 4.1, 5.2; z 6 to 13.7, 0.9 m slabs).
        const p = play([4.1, 0.02, 4]);
        const hits: { layer: number; y: number; z: number }[] = [];
        const raycast = p.physics.raycast.bind(p.physics);
        (p.physics as any).raycast = (from: any, to: any, options?: any) => {
            const hit = raycast(from, to, options);
            if (options?.groundOnly && options.layerMask !== undefined && hit) hits.push({ layer: hit.body.collisionFilterGroup, y: hit.point[1], z: hit.point[2] });
            return hit;
        };
        p.run(0.5);
        input.setMove(0, 1);
        let highest = 0, slowest = Infinity;
        p.run(2.5, () => {
            const at = p.collider.worldPosition;
            if (at[2] > 15) input.setMove(0, 0);
            if (at[2] < 6 || at[2] > 13.5) return;
            highest = Math.max(highest, at[1]);
            slowest = Math.min(slowest, p.player.planarSpeed);
        });
        const over = hits.filter(h => h.z > 5.6 && h.z < 14.1);
        const onBumps = over.filter(h => h.layer === detail);
        console.log(`bumps: capsule at most ${highest.toFixed(3)} m up, slowest ${slowest.toFixed(2)} m/s, ${onBumps.length} of ${over.length} foot rays on a bump, highest ${Math.max(...onBumps.map(h => h.y)).toFixed(2)} m`);
        // The capsule stays on the ground at full pace: the bumps are not in its way.
        expect(highest).toBeLessThan(0.03);
        expect(slowest).toBeGreaterThan(named('Player').walkSpeed * 0.9);
        // The feet are: a good share of their rays over the strip land on a bump, above the ground.
        expect(onBumps.length).toBeGreaterThan(over.length * 0.3);
        expect(onBumps.every(h => h.y > 0)).toBe(true);
        expect(p.trace).not.toContain('Fall');
    });

    it('sees through the pillars and pulls the camera in for the wall', () => {
        const p = play(OPEN);
        p.run(0.1);
        const rig = p.rigs[0];
        const layers = { blockedBy: rig.collisionLayers, seeThrough: rig.seeThroughLayers };
        // Through Pillar 1 (level.ts: at x 8, z -5, 0.4 m round), and through the Wall (x -10, z -6, 0.4 m thick).
        const pillar = p.physics.raycastCamera([8, 1.5, -3] as any, [8, 1.5, -7] as any, undefined, layers);
        const wall = p.physics.raycastCamera([-10, 1.5, -4] as any, [-10, 1.5, -8] as any, undefined, layers);
        expect(pillar).toBeNull();
        expect(wall).toBeCloseTo(1.8, 1);
        // A rig that saw through nothing would stop at the pillar.
        expect(p.physics.raycastCamera([8, 1.5, -3] as any, [8, 1.5, -7] as any, undefined, { blockedBy: ALL_LAYERS, seeThrough: 0 })).toBeCloseTo(1.6, 1);
        // And the hole cuts the pillars' meshes, not the wall's.
        const optIn = (name: string) => MaterialBinder.prototype.holeOptIn.call({ _camHoleLayers: rig.seeThroughLayers } as any, p.scene.findNode(name) as any);
        expect([optIn('Pillar 1'), optIn('Pillar 2'), optIn('Pillar 3'), optIn('Wall')]).toEqual([true, true, true, false]);
    });

    it('lands a dropped ball on a tread, not on the ramp over it', () => {
        const p = play(OPEN);
        const f = FLIGHTS[1];
        // Over the back of the fourth tread, where the ramp runs above it.
        const k = 3, z = STAIRS_Z + (k + 0.75) * TREAD, r = 0.05;
        const ball = new PhysicsBody({ name: 'ball', type: 'dynamic', mass: 1, position: [f.x, 2.5, z] });
        ball.addCollider({ shape: { kind: 'sphere', radius: r } });
        p.physics.addBody(ball);
        p.run(1.5);
        // On the tread (give or take a backend's contact slop: Jolt lets a small ball settle 2 cm in), where the
        // ramp would have it 5 cm higher and rolling down.
        expect(Math.abs(ball.position.y - ((k + 1) * f.rise + r)), `rests at ${ball.position.y.toFixed(3)}`).toBeLessThan(0.03);
        expect(Math.abs(ball.position.z - z)).toBeLessThan(0.02);
    });

    it('names only clips its skeleton owns, and links every parameter to something that exists', () => {
        const clipNames = new Set(library('animations').map(a => a.clips[0].name));
        expect(new Set(rig().animationIds)).toEqual(new Set(library('animations').map(a => a.id)));
        const sm = machine();
        for (const s of sm.states) {
            if (s.field) for (const sample of s.field.samples) expect(clipNames.has(sample.clipName), sample.clipName).toBe(true);
            else expect(clipNames.has(s.clipName), `${s.name}: ${s.clipName}`).toBe(true);
        }
        // The layers' blend spaces (the Look layer's) play clips the skeleton owns too.
        for (const l of sm.layers) for (const s of l.states) {
            if (s.field) for (const sample of s.field.samples) expect(clipNames.has(sample.clipName), `${l.name}: ${sample.clipName}`).toBe(true);
            else expect(clipNames.has(s.clipName), `${l.name}: ${s.clipName}`).toBe(true);
        }
        const field = sm.states.find((s: any) => s.name === 'Locomotion').field;
        // The embedded copy is the blend space asset's.
        expect(field.samples).toEqual(library('animationFields')[0].samples);
        for (const s of field.samples) {
            expect(s.x).toBeGreaterThanOrEqual(field.xAxis.min);
            expect(s.x).toBeLessThanOrEqual(field.xAxis.max);
            expect(s.y).toBeGreaterThanOrEqual(field.yAxis.min);
            expect(s.y).toBeLessThanOrEqual(field.yAxis.max);
        }
        const script = library('scripts').find(s => s.name === 'SandboxPlayer');
        const scriptFields = new Set(script.variables.map((v: any) => v.name));
        // The car's two triggers (fired by name: SandboxPlayer's enterTrigger and exitTrigger) are the only parameters
        // nothing links: everything else the machine reads by itself.
        expect(sm.parameters.filter((p: any) => p.type === 'trigger').map((p: any) => p.name)).toEqual(['EnterCar', 'ExitCar']);
        for (const p of sm.parameters) {
            if (p.type === 'trigger') continue;
            expect(p.variable.nodeRef).toBe('parent');
            if (p.variable.source === 'builtin') expect(NODE_BUILTINS[p.variable.varName], p.variable.varName).toBeDefined();
            else expect(['moveDir', 'isJumping', 'turnRequest'].includes(p.variable.varName) || scriptFields.has(p.variable.varName), p.variable.varName).toBe(true);
        }
        const params = new Set(sm.parameters.map((p: any) => p.name));
        const conds = (c: any): any[] => !c ? [] : c.children ? c.children.flatMap(conds) : [c];
        for (const t of sm.transitions) for (const c of conds(t.condition)) expect(params.has(c.param), c.param).toBe(true);
        // Only the turns, the stop (which plants sideways), the hard landing (which crouches where it came down) and
        // getting in and out of the car (from the door to the seat and back) drive the character with their root motion.
        const rootMotion = library('animations').filter(a => a.clips[0].rootMotion).map(a => a.name).sort();
        expect(rootMotion).toEqual(['CarEnter', 'CarExit', 'LandHard', 'RunTurnL', 'RunTurnR', 'Stop', 'StopMirror', 'Turn180L', 'Turn180R', 'Turn90L', 'Turn90R']);
    });

    it('ships the current scripts and the actions they read', () => {
        for (const [name, node] of [['SandboxPlayer', 'Player'], ['SandboxCamera', 'Camera Rig'], ['SandboxCar', 'Car'], ['SandboxCarCamera', 'Car Camera Rig'], ['SandboxGameManager', 'Game Manager']]) {
            const script = library('scripts').find(s => s.name === name);
            expect(script.source).toBe(readFileSync(join(__dirname, '..', 'examples', 'scripts', `${name}.ts`), 'utf8'));
            expect(named(node).script, node).toBe(script.source);
        }
        const actions = read('libraries', 'inputMap.json').maps.find((m: any) => m.name === 'Gameplay').actions.map((a: any) => a.name);
        for (const a of ['Move', 'Look', 'Jump', 'Sprint', 'Walk', 'Interact', 'Day', 'Sunset', 'Night']) expect(actions).toContain(a);
        // The camera's framing follows the sprint: no action switches it.
        expect(actions).not.toContain('Camera');
    });

    // ----- playing it -------------------------------------------------------------------------------

    /**
     * The scene as the player starts it, on a real physics world, with an Animator in the model's place: the
     * Animator the editor would build from the model's skin, the skeleton's clips and the embedded machine.
     */
    function play(at?: [number, number, number], ikRig: Record<string, unknown> = {}, character: Record<string, unknown> = {}, yaw?: number, editMachine?: (sm: any) => void) {
        const file = sceneFile();
        const scene = new Scene();
        const tree = withoutModels(file.scene);
        if (at) tree.children.find((c: any) => c.name === 'Player Collider').position = at;
        // Facing `yaw` (degrees), the body and the camera behind it.
        if (yaw !== undefined) {
            tree.children.find((c: any) => c.name === 'Player Collider').rotation = [0, yaw, 0];
            for (const n of allNodes(tree)) if (n.type === 'cameraRig') n.yaw = yaw;
        }
        Object.assign(allNodes(tree).find((n: any) => n.name === 'Player'), character);
        scene.parse({ ...file, scene: tree }, true);
        const physics = new PhysicsSystem({ gravity: [0, -9.82, 0], backend: TEST_PHYSICS } as any);
        physics.initialize();
        // The project's layer names, as the game config hands them to the world (scripts look layers up by name).
        physics.layerNames = read('libraries', 'projectSettings.json').collisionLayers;
        physics.scene = scene;
        // A test that plays many times (each direction of a gait) keeps the last two worlds; the rest are freed.
        played.push(physics);
        while (played.length > 2) played.shift()!.dispose();
        const stored = rig().skin;
        const skin = loadSkin(stored, (a: number[]) => mat4.clone(a as any));
        skin.ikRig = { ...stored.ikRig, ...ikRig };
        const animations = library('animations').map(a => a.clips[0]);
        const animator = new Animator({ skin, animations, hasSkin: true } as any);
        const model = scene.findNode('Mannequin') as Node;
        animator.setNode(model);
        const sm = JSON.parse(JSON.stringify(machine()));
        editMachine?.(sm);
        animator.setStateMachine(sm);
        // A ModelNode's frame: its script, then the machine, then the pose.
        const base = model.update.bind(model);
        (model as any).update = (dt: number, t: number) => { base(dt, t); animator.checkTriggers(); animator.update(dt); };
        // Where a ModelNode keeps it, for the scripts that fire its triggers (SandboxPlayer getting into the car).
        (model as any).animator = animator;
        scene.start();
        const player = scene.findNode('Player') as CharacterNode & Record<string, any>;
        const collider = scene.findNode('Player Collider') as Node;
        const rigs = player.children.filter((c: any) => c.nodeType === 'cameraRig') as CameraRigNode[];
        const trace: string[] = [];
        /** Every state the machine was in, in order, with how long it stayed. */
        const visits: { state: string, seconds: number }[] = [];
        let t = 0;
        const run = (seconds: number, each?: (time: number) => void) => {
            for (let k = 0; k < Math.round(seconds / FRAME); k++) {
                each?.(t);
                physics.update(FRAME);
                scene.update(FRAME, t * 1000, false);
                physics.endFrame(FRAME);
                input.endFrame();
                t += FRAME;
                const s = animator.currentStateName ?? '';
                if (trace[trace.length - 1] !== s) { trace.push(s); visits.push({ state: s, seconds: 0 }); }
                visits[visits.length - 1].seconds += FRAME;
            }
        };
        const names = new Map<number, string>(skin.nodeNames);
        const jointOf = (base: string) => skin.joints.findIndex((j: any) => (names.get(j.nodeIndex) ?? '').endsWith(':' + base));
        const bind = skin.joints.map((j: any) => mat4.invert(mat4.create(), j.inverseBindMatrix));
        /** A joint's world position as posed this frame. */
        const jointWorld = (base: string) => {
            const j = jointOf(base);
            const m = mat4.multiply(mat4.create(), animator.getFinalBoneMatrices()[j] as mat4, bind[j]);
            return vec3.transformMat4(vec3.create(), mat4.getTranslation(vec3.create(), m), model.worldTransform as mat4);
        };
        const yawOf = (n: Node) => { const f = n.worldForward; return Math.atan2(f[0], f[2]) * DEG; };
        /** A joint's position in the MODEL's own space: the pose alone, whatever the capsule does. */
        const jointModel = (base: string) => {
            const j = jointOf(base);
            return mat4.getTranslation(vec3.create(), mat4.multiply(mat4.create(), animator.getFinalBoneMatrices()[j] as mat4, bind[j]));
        };
        return { scene, physics, animator, player, collider, rigs, trace, visits, run, jointWorld, jointModel, yawOf, controller: () => player.controller as ControllerNode };
    }

    /**
     * How fast a planted foot creeps over the ground while moving, m/s: what foot slide is. A stance is a run of
     * frames in which the same toe is the lower one and touches the ground (3 cm); its slide is the toe's net
     * ground travel over the stance, averaged over every stance by time.
     */
    function footSlide(p: ReturnType<typeof play>, seconds: number, only?: () => boolean, each?: () => void): number {
        let drift = 0, time = 0
        let stance: { side: string, from: vec3, at: vec3, frames: number } | null = null
        const close = () => {
            if (stance && stance.frames >= 4) { drift += Math.hypot(stance.at[0] - stance.from[0], stance.at[2] - stance.from[2]); time += stance.frames * FRAME }
            stance = null
        }
        p.run(seconds, () => {
            each?.()
            const l = p.jointWorld('LeftToeBase'), r = p.jointWorld('RightToeBase')
            const [side, at] = l[1] < r[1] ? ['L', l] : ['R', r]
            const off = only !== undefined && !only()
            if (off || at[1] > 0.03 || (stance && stance.side !== side)) close()
            if (off || at[1] > 0.03) return
            if (!stance) stance = { side, from: vec3.clone(at), at: vec3.clone(at), frames: 0 }
            else { vec3.copy(stance.at, at); stance.frames++ }
        })
        close()
        return time > 0 ? drift / time : 0
    }

    it('stands still in Idle, and its parameters read the Character', () => {
        const p = play();
        p.run(1);
        expect(p.player.isGrounded).toBe(true);
        expect(p.animator.currentStateName).toBe('Idle');
        expect(p.collider.worldPosition[1]).toBeLessThan(0.1);
    });

    const DIRECTIONS: [string, number, number, number][] = [
        // name, move x (right), move y (forward), expected moveDir
        ['forward', 0, 1, 0], ['forward-left', -0.7071, 0.7071, 45], ['left', -1, 0, 90], ['back-left', -0.7071, -0.7071, 135],
        ['back', 0, -1, 180], ['back-right', 0.7071, -0.7071, -135], ['right', 1, 0, -90], ['forward-right', 0.7071, 0.7071, -45],
    ];
    const slides: string[] = [];

    for (const gait of ['walk', 'jog', 'sprint'] as const) {
        it(`${gait}s in eight directions in the locomotion blend, facing the camera`, () => {
            const jog = named('Player').walkSpeed, sprint = named('Player').runSpeed;
            const walk = jog * named('Player').scriptVars.walkScale;
            for (const [name, x, y, dir] of DIRECTIONS) {
                // In the open, clear of the course.
                const p = play(OPEN);
                p.run(0.5);
                if (gait === 'walk') input.press('Walk');
                if (gait === 'sprint') input.press('Sprint');
                input.setMove(x, y);
                p.run(1.5);
                const slide = footSlide(p, 1.5);
                const speed = p.player.planarSpeed;
                expect(p.animator.currentStateName, `${gait} ${name}`).toBe('Locomotion');
                // A sprint goes freely, facing where it goes: its blend direction stays ahead in every direction.
                const sprinting = gait === 'sprint';
                if (!sprinting) expect(Math.abs(wrap(p.player.moveDir - dir)), `${gait} ${name} moveDir ${p.player.moveDir}`).toBeLessThan(12);
                else {
                    expect(Math.abs(p.player.moveDir), `sprint ${name} moveDir`).toBeLessThan(12);
                    const v = p.player.velocity, f = p.player.worldForward;
                    expect(Math.abs(wrap(Math.atan2(v[0], v[2]) * DEG - Math.atan2(f[0], f[2]) * DEG)), `sprint ${name} faces its travel`).toBeLessThan(15);
                    const sprintShare = (p.animator.activeFieldWeights ?? []).filter((w: any) => w.clipName === 'SprintF').reduce((a: number, w: any) => a + w.weight, 0);
                    expect(sprintShare, `sprint ${name} plays the sprint`).toBeGreaterThan(0.85);
                }
                const nominal = sprinting ? sprint : gait === 'walk' ? walk : jog;
                expect(speed, `${gait} ${name}`).toBeLessThanOrEqual(nominal * 1.03);
                expect(speed, `${gait} ${name}`).toBeGreaterThan(nominal * 0.4);
                slides.push(`${gait} ${name}: ${speed.toFixed(2)} m/s, foot slide ${slide.toFixed(2)} m/s`);
                // The feet keep their footing: within 8% of the travel speed on the four cardinal directions,
                // 15% on the diagonals (blends of two clips, with no stride warping to straighten them).
                const limit = name.includes('-') && !sprinting ? Math.max(0.35, speed * 0.15) : Math.max(0.15, speed * 0.08);
                expect(slide, `${gait} ${name}: foot slide at ${speed.toFixed(2)} m/s`).toBeLessThan(limit);
                input.setMove(0, 0);
                input.release('Walk'); input.release('Sprint');
                p.run(1.5);
                expect(p.animator.currentStateName, `${gait} ${name} at rest`).toBe('Idle');
                expect(p.trace).not.toContain('Fall');
            }
            if (gait === 'sprint') console.log(slides.join('\n'));
        });
    }

    it('blends no back-diagonal into a strafe while speeding up to a jog', () => {
        for (const x of [1, -1]) {
            const p = play(OPEN);
            p.run(0.5);
            input.setMove(x, 0);
            let worst = 0;
            p.run(1.5, () => {
                for (const w of p.animator.activeFieldWeights ?? []) if (/B[LR]$/.test(w.clipName) && w.weight > worst) { worst = w.weight; (globalThis as any).__worst = [w.clipName, p.player.planarSpeed.toFixed(2), p.player.moveDir.toFixed(0)]; }
            });
            expect(worst, `strafing ${x > 0 ? 'right' : 'left'}: ${(globalThis as any).__worst}`).toBeLessThan(0.1);
        }
    });

    it('stops from a jog with the stop clip off the swinging foot, and from a sprint once braked to a jog', () => {
        const seen = new Set<string>();
        for (const [sprint, run] of [[false, 1.5], [false, 1.6], [false, 1.7], [false, 1.8], [true, 1.5]] as const) {
            const p = play(OPEN);
            p.run(0.5);
            if (sprint) input.press('Sprint');
            input.setMove(0, 1);
            p.run(run);
            input.setMove(0, 0);
            input.release('Sprint');
            p.run(2);
            const stop = p.trace.find(s => /^Stop/.test(s));
            expect(stop, p.trace.join(' ')).toBeDefined();
            seen.add(stop!);
            expect(p.trace.slice(-2)).toEqual([stop, 'Idle']);
            expect(p.trace).toContain(sprint ? 'Start' : 'Locomotion');
        }
        // Released at different points of the stride, both feet start a stop.
        expect([...seen].sort()).toEqual(['Stop', 'StopMirror']);
    });

    it('turns in place after a stop when the camera is round, without a pop', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.5);
        input.setMove(0, 0);
        p.rigs[0].setOrbit(p.yawOf(p.player) + 150, 12);
        let worst = 0, prev: vec3 | null = null;
        p.run(3, () => {
            const head = p.jointModel('Head');
            if (prev) worst = Math.max(worst, vec3.distance(head, prev));
            prev = head;
        });
        const i = p.trace.findIndex(s => /^Stop/.test(s));
        expect(i, p.trace.join(' ')).toBeGreaterThan(0);
        // Straight out of the stop when the turn is asked for by the time it settles; with the head looking round
        // first (turnDelay), the stop's own turn has usually brought the camera under 135 degrees by then, so it
        // settles into Idle and turns from there.
        expect(p.trace.slice(i + 1).some(s => /^Turn/.test(s)), p.trace.join(' ')).toBe(true);
        // The head never jumps: 60 frames a second, and nothing moves it 6 cm in one.
        expect(worst, `the head moved ${(worst * 100).toFixed(1)} cm in one frame`).toBeLessThan(0.06);
    });

    for (const [aim, state, turned] of [[110, 'Turn90L', 90], [-110, 'Turn90R', -90], [175, 'Turn180L', 180], [-170, 'Turn180R', -180]] as const) {
        it(`turns in place with ${state} when the camera swings ${aim} degrees, and the capsule only turns`, () => {
            const p = play();
            p.run(0.5);
            const start = p.yawOf(p.player);
            const y0 = p.collider.worldPosition[1];
            p.rigs[0].setOrbit(start + aim, 12);
            let maxTilt = 0;
            p.run(3, () => {
                const q = p.collider.worldQuaternion;
                const up = vec3.transformQuat(vec3.create(), [0, 1, 0], q as quat);
                maxTilt = Math.max(maxTilt, Math.acos(Math.min(1, up[1])) * DEG);
            });
            expect(p.trace).toContain(state);
            expect(p.trace[p.trace.length - 1]).toBe('Idle');
            const off = wrap(p.yawOf(p.player) - (start + aim));
            expect(Math.abs(off), `ends ${off.toFixed(1)} degrees off the camera`).toBeLessThan(45);
            expect(Math.abs(wrap(p.yawOf(p.player) - start - turned)), 'turns by its clip').toBeLessThan(aim > 150 || aim < -150 ? 30 : 30);
            expect(maxTilt).toBeLessThan(0.5);
            expect(Math.abs(p.collider.worldPosition[1] - y0)).toBeLessThan(0.02);
            expect(p.player.turnRequest).toBe(0);
        });
    }

    it('jumps from standing into the jump clip, at the physics arc, and lands', () => {
        const p = play();
        p.run(0.5);
        let apex = 0;
        input.tap('Jump');
        p.run(2.5, () => { apex = Math.max(apex, p.collider.worldPosition[1]); });
        const jumpSpeed = named('Player').jumpSpeed;
        expect(apex).toBeGreaterThan(jumpSpeed * jumpSpeed / (2 * 9.82) * 0.9);
        expect(apex).toBeLessThan(jumpSpeed * jumpSpeed / (2 * 9.82) * 1.1);
        expect(p.trace).toEqual(['Idle', 'JumpStand', 'JumpLand', 'Idle']);
    });

    it('jumps from a jog into the running jump and lands back into locomotion', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.2);
        input.tap('Jump');
        p.run(1.5);
        expect(p.trace.slice(0, 4)).toEqual(['Idle', 'Locomotion', 'JumpRun', 'LandRun']);
        expect(p.trace[p.trace.length - 1]).toBe('Locomotion');
        // The landing plays through its impact before the run takes over.
        // (The running landing is the running jump's own last 0.3 s, left a little before its end.)
        const landing = p.visits.find(v => v.state === 'LandRun')!;
        expect(landing.seconds).toBeGreaterThan(0.18);
    });

    for (const [height, landing] of [[0.3, 'LandSoft'], [1, 'LandSoft'], [2, 'LandSoft'], [3.5, 'LandHard']] as const) {
        it(`drops ${height} m into ${landing}, whatever the height`, () => {
            const p = play([35, height, 30]);
            p.run(3);
            expect(p.trace).toContain(landing);
            expect(p.trace).not.toContain(landing === 'LandHard' ? 'LandSoft' : 'LandHard');
            expect(p.trace[p.trace.length - 1]).toBe('Idle');
            expect(p.trace).toContain('Fall');
        });
    }

    it('lands with a landing clip when it falls moving too, and plays it through its impact', () => {
        const p = play([35, 1, 30]);
        input.setMove(0, 1);
        p.run(3);
        const landing = p.visits.find(v => /^Land/.test(v.state));
        expect(landing, p.trace.join(' ')).toBeDefined();
        expect(landing!.seconds, `${landing!.state} for ${landing!.seconds.toFixed(2)} s`).toBeGreaterThan(0.25);
        expect(p.trace[p.trace.length - 1]).toBe('Locomotion');
        input.setMove(0, 0);
    });

    it('sets off into a sprint with the start clip, and into a walk, a jog or a sprint backwards without it', () => {
        for (const [gait, x, y, expected] of [['sprint', 0, 1, ['Idle', 'Start', 'Locomotion']], ['walk', 0, 1, ['Idle', 'Locomotion']], ['jog', 0, 1, ['Idle', 'Locomotion']], ['sprint', 0, -1, ['Idle', 'Locomotion']]] as const) {
            const p = play(OPEN);
            p.run(0.5);
            const walk = gait === 'walk';
            if (walk) input.press('Walk');
            if (gait === 'sprint') input.press('Sprint');
            input.setMove(x, y);
            // The start itself: from the frame it is entered to the frame it hands over.
            const slide = footSlide(p, 0.6, () => p.animator.currentStateName === 'Start' && !p.animator.isBlending);
            p.run(1);
            expect(p.trace, `${gait} ${y > 0 ? 'forward' : 'back'}`).toEqual(expected);
            if (expected.includes('Start')) expect(slide, 'the start keeps its footing').toBeLessThan(0.35);
            input.release('Walk');
            input.release('Sprint');
            input.setMove(0, 0);
        }
    });

    it('takes off into a sprint at the start clip’s own pace, and eases from it into the run', () => {
        const p = play(OPEN);
        p.run(0.5);
        const base = p.player.acceleration;
        const takeoff = named('Player').scriptVars.sprintTakeoff;
        expect(takeoff).toBeLessThan(base * 0.7);
        input.press('Sprint');
        input.setMove(0, 1);
        let inStart = 0, accelInStart = 0, handOver = -1;
        p.run(2, () => {
            if (p.animator.currentStateName === 'Start') { inStart += FRAME; accelInStart = p.player.acceleration; }
            else if (handOver < 0 && p.animator.currentStateName === 'Locomotion') handOver = (p.animator as any)._activeBlendTime;
        });
        input.release('Sprint');
        input.setMove(0, 0);
        // The 0.8 s clip at its own speed (it was over in 0.4 s at 1.5x), into the run over 0.3 s.
        expect(p.trace.slice(0, 3)).toEqual(['Idle', 'Start', 'Locomotion']);
        expect(inStart, 'the start is seen').toBeGreaterThan(0.55);
        expect(accelInStart).toBeCloseTo(takeoff, 3);
        expect(handOver, 'eased into the run').toBeGreaterThanOrEqual(0.25);
        // A jog sets off at the Character's own quick acceleration.
        const jog = play(OPEN);
        jog.run(0.5);
        input.setMove(0, 1);
        jog.run(0.3);
        expect(jog.player.acceleration).toBeCloseTo(base, 3);
        input.setMove(0, 0);
    });

    it('turns round with the running turn when a sprint reverses, the capsule turning flat', () => {
        for (const x of [0.3, -0.3]) {
            const p = play(OPEN);
            p.run(0.5);
            input.press('Sprint');
            input.setMove(0, 1);
            p.run(1.5);
            // Back the other way, a little off to one side so the turn has a side.
            input.setMove(x, -1);
            let tilt = 0;
            p.run(1.6, () => {
                const up = vec3.transformQuat(vec3.create(), [0, 1, 0], p.collider.worldQuaternion as quat);
                tilt = Math.max(tilt, Math.acos(Math.min(1, up[1])) * DEG);
            });
            const turn = x > 0 ? 'RunTurnR' : 'RunTurnL';
            expect(p.trace, `reversing toward ${x > 0 ? 'the right' : 'the left'}`).toContain(turn);
            expect(p.trace[p.trace.length - 1]).toBe('Locomotion');
            const f = p.player.worldForward;
            const want = Math.atan2(-x, -1) * DEG;   // the input, relative to the camera at yaw 0
            expect(Math.abs(wrap(Math.atan2(f[0], f[2]) * DEG - want)), 'faces the new way').toBeLessThan(30);
            expect(tilt).toBeLessThan(0.5);
            input.release('Sprint');
        }
    });

    it('leans into a change of direction at a run, not on a straight line or at a walk', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.press('Sprint');
        input.setMove(0, 1);
        p.run(1.5);
        expect(Math.max(p.player.leanLeft, p.player.leanRight), 'straight').toBeLessThan(0.05);
        // Curve left: the input swings from ahead to the left over a second.
        let left = 0, right = 0;
        for (let k = 0; k < 60; k++) {
            const angle = (k / 60) * Math.PI / 2;
            input.setMove(-Math.sin(angle), Math.cos(angle));
            p.run(1 / 60);
            left = Math.max(left, p.player.leanLeft); right = Math.max(right, p.player.leanRight);
        }
        expect(left, 'leans left into a left curve').toBeGreaterThan(0.25);
        expect(right).toBeLessThan(0.05);
        input.release('Sprint');
        // A walk does not lean.
        const w = play(OPEN);
        w.run(0.5);
        input.press('Walk');
        input.setMove(0, 1);
        w.run(1);
        let walkLean = 0;
        for (let k = 0; k < 60; k++) {
            input.setMove(Math.sin(k / 60 * Math.PI / 2), Math.cos(k / 60 * Math.PI / 2));
            w.run(1 / 60);
            walkLean = Math.max(walkLean, w.player.leanLeft, w.player.leanRight);
        }
        expect(walkLean).toBeLessThan(0.05);
        input.release('Walk');
    });

    it('leans through three additive layers masked to the bones a whole-body lean moves', () => {
        expect(machine().layers.map((l: any) => [l.name, l.blend, l.weightParam])).toEqual([
            ['Lean Left', 'additive', 'LeanLeft'], ['Lean Right', 'additive', 'LeanRight'], ['Lean Forward', 'additive', 'LeanForward'],
            ['Look', 'additive', 'LookWeight']]);
        const layers = machine().layers.filter((l: any) => /^Lean/.test(l.name));
        const mask = library('boneMasks').find((m: any) => m.name === 'Lean');
        expect(Object.keys(mask.weights).map(n => n.replace(/^.*:/, '')).sort()).toEqual(
            ['Head', 'Hips', 'LeftFoot', 'LeftLeg', 'LeftUpLeg', 'Neck', 'RightFoot', 'RightLeg', 'RightUpLeg', 'Spine', 'Spine1', 'Spine2']);
        for (const l of layers) expect(l.mask).toEqual(mask.weights);
        // The lean clips move only those bones.
        const names = new Map<number, string>(rig().skin.nodeNames);
        for (const clip of library('animations').filter(a => /^Lean/.test(a.name)).map(a => a.clips[0]))
            for (const c of clip.channels) expect(mask.weights[names.get(c.targetNodeIndex)!], names.get(c.targetNodeIndex)).toBe(1);
    });

    it('leans the whole body about the ground, the feet staying where they are and flat', () => {
        const stored = rig().skin;
        const skin = loadSkin(stored, (a: number[]) => mat4.clone(a as any));
        const animations = library('animations').map(a => a.clips[0]);
        const names = new Map<number, string>(skin.nodeNames);
        const bind = skin.joints.map((j: any) => mat4.invert(mat4.create(), j.inverseBindMatrix));
        /** The Idle pose with the right lean at `weight`: each joint's model matrix. */
        const pose = (weight: number) => {
            const a = new Animator({ skin, animations, hasSkin: true } as any);
            const sm = JSON.parse(JSON.stringify(machine()));
            sm.parameters = sm.parameters.map((q: any) => q.name === 'LeanRight' ? { name: 'LeanRight', type: 'float', default: weight } : q);
            a.setStateMachine(sm);
            for (let k = 0; k < 20; k++) { a.checkTriggers(); a.update(FRAME); }
            return (base: string) => {
                const j = skin.joints.findIndex((x: any) => (names.get(x.nodeIndex) ?? '').endsWith(':' + base));
                return mat4.multiply(mat4.create(), a.getFinalBoneMatrices()[j] as mat4, bind[j]);
            };
        };
        const upright = pose(0), leant = pose(1);
        const at = (m: mat4) => mat4.getTranslation(vec3.create(), m);
        // Right is -X for a body facing +Z.
        const head = at(leant('Head'))[0] - at(upright('Head'))[0];
        expect(head, 'the head goes over to the right').toBeLessThan(-0.2);
        expect(head).toBeGreaterThan(-0.5);
        for (const foot of ['LeftFoot', 'RightFoot']) {
            // Along the ground the feet stay; tilting a stance about its middle raises one foot a little and lowers
            // the other, which foot placement takes up.
            const d = vec3.sub(vec3.create(), at(leant(foot)), at(upright(foot)));
            expect(Math.hypot(d[0], d[2]), `${foot} stays put`).toBeLessThan(0.02);
            expect(Math.abs(d[1]), `${foot} height`).toBeLessThan(0.04);
            const q0 = mat4.getRotation(quat.create(), upright(foot)), q1 = mat4.getRotation(quat.create(), leant(foot));
            const up0 = vec3.transformQuat(vec3.create(), [0, 1, 0], q0), up1 = vec3.transformQuat(vec3.create(), [0, 1, 0], q1);
            // Rolled back about the body's forward as the rest pose has it: a few degrees off on an ankle the clip flexes.
            expect(Math.acos(Math.min(1, vec3.dot(up0, up1))) * DEG, `${foot} stays flat`).toBeLessThan(5);
        }
        // From the hips up AND below: the legs tilt with the body.
        const tilt = (p: (b: string) => mat4, a: string, b: string) => { const d = vec3.sub(vec3.create(), at(p(b)), at(p(a))); return Math.atan2(-d[0], d[1]) * DEG; };
        expect(tilt(leant, 'Hips', 'Head') - tilt(upright, 'Hips', 'Head'), 'the trunk').toBeGreaterThan(8);
        expect(tilt(leant, 'RightFoot', 'RightUpLeg') - tilt(upright, 'RightFoot', 'RightUpLeg'), 'the legs').toBeGreaterThan(6);
    });

    it('keeps its planted feet while the camera turns it as it walks and jogs (foot locking)', () => {
        const lines: string[] = [];
        for (const gait of ['walk', 'jog'] as const) {
            const slide: Record<string, number> = {};
            for (const lock of [1, 0]) {
                const p = play(OPEN, { footLock: lock });
                p.run(0.5);
                if (gait === 'walk') input.press('Walk');
                input.setMove(0, 1);
                p.run(1.2);
                // The camera pans 75 degrees a second, and the body follows it round.
                let yaw = p.rigs[0].yaw;
                slide[lock] = footSlide(p, 2, undefined, () => { yaw += 75 * FRAME; p.rigs[0].setOrbit(yaw, 12); });
                input.setMove(0, 0);
                input.release('Walk');
            }
            lines.push(`${gait} turning: foot slide ${slide[1].toFixed(2)} m/s locked, ${slide[0].toFixed(2)} without`);
            // The clips' windows let each foot go at heel-off, and through the push-off it follows the clip round
            // with the turning body: what the lock still holds is the weight-bearing part of the stance.
            expect(slide[1], `${gait}, locked`).toBeLessThan(gait === 'walk' ? 0.12 : 0.25);
            expect(slide[1], `${gait}: the lock holds the feet`).toBeLessThan(slide[0] * 0.85);
        }
        console.log(lines.join('\n'));
    });

    /** The old controller: turning by the acceleration alone, the blend direction from the input. */
    const OLD_CONTROLLER = { turnFriction: 0, moveDirSource: 'input', directionSmoothing: 0.12 };

    it('changes direction at a jog without coasting: the speed kept, the legs playing where the body goes', () => {
        const lines: string[] = [];
        for (const [name, character] of [['new', {}], ['old', OLD_CONTROLLER]] as const) {
            const p = play(OPEN, {}, character);
            p.run(0.5);
            input.setMove(0, 1);
            p.run(1.2);
            const jog = p.player.planarSpeed;
            input.setMove(-1, 0);   // a quarter turn to the left, the body still facing the camera
            let slowest = Infinity, worst = 0, sum = 0, n = 0;
            const slide = footSlide(p, 0.6, undefined, () => {
                const v = p.player.velocity, f = p.player.worldForward;
                const speed = Math.hypot(v[0], v[2]);
                slowest = Math.min(slowest, speed);
                const travel = wrap(Math.atan2(v[0], v[2]) * DEG - Math.atan2(f[0], f[2]) * DEG);
                const off = Math.abs(wrap(p.player.moveDir - travel));
                worst = Math.max(worst, off); sum += off; n++;
            });
            lines.push(`${name} controller, jog forward to left: slowest ${(slowest / jog * 100).toFixed(0)}% of the jog, legs off the travel by ${(sum / n).toFixed(0)} deg (worst ${worst.toFixed(0)}), foot slide ${slide.toFixed(2)} m/s`);
            if (name === 'new') {
                expect(slowest, 'keeps its speed through the turn').toBeGreaterThan(jog * 0.85);
                expect(sum / n, 'the legs play where the body goes').toBeLessThan(12);
                expect(worst).toBeLessThan(40);
                expect(slide, 'the feet hold through the turn').toBeLessThan(0.5);
            }
            input.setMove(0, 0);
        }
        console.log(lines.join(String.fromCharCode(10)));
    });

    it('keeps its feet when the camera whips round as it jogs', () => {
        const lines: string[] = [];
        const slide: Record<string, number> = {};
        for (const [name, character] of [['new', {}], ['old', OLD_CONTROLLER]] as const) {
            const p = play(OPEN, {}, character);
            p.run(0.5);
            input.setMove(0, 1);
            p.run(1.2);
            let yaw = p.rigs[0].yaw;
            slide[name] = footSlide(p, 1.5, undefined, () => { yaw += 200 * FRAME; p.rigs[0].setOrbit(yaw, 12); });
            lines.push(`${name} controller, camera at 200 deg/s: foot slide ${slide[name].toFixed(2)} m/s`);
            input.setMove(0, 0);
        }
        console.log(lines.join(String.fromCharCode(10)));
        // The windows release each foot at heel-off, so the push-off is swept round with the body. The lock's
        // blend-in eases a sliding foot to a stop for either controller (the old one's slide fell from 0.93 to
        // about 0.55 m/s with it), so the new one is still well under what the old one slides, if no longer half.
        expect(slide.new).toBeLessThan(0.4);
        expect(slide.new).toBeLessThan(slide.old * 0.75);
    });

    it('gives every clip that locks a foot-lock window per foot, ending before the heel is up', () => {
        const clips = new Map(library('animations').map(a => [a.name, a.clips[0]]));
        for (const name of ['WalkF', 'JogF', 'SprintF', 'JogBR', 'Start', 'Stop', 'StopMirror', 'RunTurnL', 'LandSoft']) {
            const c = clips.get(name);
            expect(Object.keys(c.footLocks ?? {}).sort(), name).toEqual(['foot.L', 'foot.R']);
        }
        for (const name of ['Idle', 'Turn90L', 'Fall', 'JumpAir']) expect(clips.get(name).footLocks, name).toBeUndefined();
        // A jog stance: the ball lands at about 0.38 of the cycle and the heel is up by 0.6: the window is the part
        // between, not the whole contact.
        const [[a, b]] = clips.get('JogF').footLocks['foot.L'];
        const T = Math.max(...clips.get('JogF').samplers.map((s: any) => s.input[s.input.length - 1]));
        expect(a / T).toBeGreaterThan(0.3);
        expect(b / T).toBeLessThan(0.65);
    });

    it('lets a jogging foot go at heel-off: locked for only part of the time its ball is down', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.2);
        const locks = (p.animator as any)._ikFootLocks as Map<number, any>;
        let down = 0, held = 0;
        p.run(1.5, () => {
            const toe = p.jointWorld('LeftToeBase');
            if (toe[1] > 0.03) return;
            down++;
            const left = [...locks.entries()].find(([node]) => /LeftFoot$/.test((rig().skin.nodeNames as [number, string][]).find(([n]) => n === node)?.[1] ?? ''))?.[1];
            if (left && left.alpha >= 1) held++;
        });
        expect(down).toBeGreaterThan(10);
        expect(held / down, `held ${held} of ${down} frames down`).toBeLessThan(0.9);
        expect(held, 'it does lock').toBeGreaterThan(0);
        input.setMove(0, 0);
    });

    it('locks no foot standing still, nor once a run has stopped', () => {
        const locked = (p: ReturnType<typeof play>) => [...((p.animator as any)._ikFootLocks as Map<number, any>).values()].filter(l => l.alpha > 0).length;
        const p = play(OPEN);
        p.run(1);
        expect(p.animator.currentStateName).toBe('Idle');
        expect(locked(p)).toBe(0);
        input.setMove(0, 1);
        p.run(1.2);
        let duringRun = 0;
        p.run(0.4, () => { duringRun = Math.max(duringRun, locked(p)); });
        expect(duringRun, 'it does lock while running').toBeGreaterThan(0);
        input.setMove(0, 0);
        p.run(2.5);
        expect(p.animator.currentStateName).toBe('Idle');
        expect(locked(p)).toBe(0);
    });

    it('stays as it stopped after a sprint until the camera swings', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.press('Sprint');
        input.setMove(0, -1);   // toward the camera
        p.run(1.5);
        input.setMove(0, 0);
        input.release('Sprint');
        p.run(2);
        expect(p.trace.filter(s => /^Turn/.test(s)), 'no turn by itself').toEqual([]);
        p.rigs[0].setOrbit(40, 12);
        p.run(2.5);
        expect(p.trace.some(s => /^Turn/.test(s)), `turns once the camera swings: ${p.trace.join(' ')}`).toBe(true);
    });

    it('holds every clip in place without tilting it sideways', async () => {
        const prepared = join(__dirname, '..', 'build', 'sandbox_prepared', 'clips');
        if (!existsSync(prepared)) return;   // the source clips are local (build/ is not in git)
        const { bodyRoll, clipSeconds } = await import('../tools/sandbox/measure');
        const { bakeInPlace } = await import('../src/animation/clipEdit');
        const stored = rig().skin;
        const skin = loadSkin(stored, (a: number[]) => mat4.clone(a as any));
        const clips = new Map(library('animations').map(a => [a.name, a.clips[0]]));
        const source = (file: string) => JSON.parse(readFileSync(join(prepared, `${file}.json`), 'utf8')).clip;
        const lean = (clip: any, from: any, offset: number) => {
            const T = clipSeconds(clip), n = Math.round(T * 30);
            const times = Array.from({ length: n + 1 }, (_, k) => T * k / n);
            const a = bodyRoll(skin, clip, times), b = bodyRoll(skin, from, times.map(t => t + offset));
            return Math.max(...times.map((_, k) => Math.abs((a[k] - a[0]) - (b[k] - b[0]))));
        };
        const { measure } = await import('../tools/sandbox/measure');
        // A landing clip is kept from its touchdown on.
        const touchdown = (file: string) => measure(skin, source(file)).air[0].to;
        for (const [name, file, offset] of [['Stop', 'Run To Stop', 0], ['LandHard', 'Hard Landing', touchdown('Hard Landing')], ['LandSoft', 'Falling To Landing', touchdown('Falling To Landing')], ['Start', 'Idle To Sprint', 0]] as const)
            expect(lean(clips.get(name), source(file), offset), name).toBeLessThan(3);
        // The check sees the fault it guards against: the engine's in-place bake tilts the hard landing.
        expect(lean(bakeInPlace(source('Hard Landing'), skin, { strip: 'xz' }), source('Hard Landing'), 0)).toBeGreaterThan(10);
    });

    it('frames over the shoulder at rest, and eases out to third person while sprinting', () => {
        const p = play(OPEN);
        p.run(0.3);
        expect(p.rigs).toHaveLength(1);
        const cam = p.rigs[0] as CameraRigNode & Record<string, any>;
        const vars = named('Camera Rig').scriptVars;
        expect(cam.armLength).toBeCloseTo(vars.shoulderArm, 2);
        expect(cam.socketOffset[0]).toBeCloseTo(-vars.shoulderOffset, 2);
        cam.setOrbit(40, 20);
        input.press('Sprint');
        input.setMove(0, 1);
        // Eased in: barely moved after 0.3 s of the 2 s switch, half way at half time, there at the end.
        p.run(0.3);
        expect(cam.armLength).toBeGreaterThan(vars.shoulderArm);
        expect(cam.armLength).toBeLessThan(vars.shoulderArm + 0.25);
        p.run(0.7);
        const half = (vars.shoulderArm + vars.thirdPersonArm) / 2;
        expect(Math.abs(cam.armLength - half)).toBeLessThan(0.3);
        p.run(1.2);
        expect(Math.abs(cam.armLength - vars.thirdPersonArm)).toBeLessThan(0.01);
        expect(Math.abs(cam.socketOffset[0])).toBeLessThan(0.01);
        expect(cam.camera!.active).toBe(true);
        // Let go: it holds the wide framing a moment (so a sprint dropped for an instant does not swing it), then
        // eases back over the shoulder as slowly.
        input.release('Sprint');
        input.setMove(0, 0);
        p.run(0.3);
        expect(cam.armLength).toBeGreaterThan(vars.thirdPersonArm - 0.05);
        p.run(1.1);
        expect(cam.armLength).toBeGreaterThan(vars.shoulderArm + 0.3);
        p.run(1.2);
        expect(Math.abs(cam.armLength - vars.shoulderArm)).toBeLessThan(0.01);
    });

    it('holds still through a hard landing, the stick pushing, and moves off once it is up', () => {
        /** How far the capsule goes over the ground while in LandHard, at most, and how long it is there. */
        const land = (push: boolean) => {
            const p = play([35, 3.5, 30]);
            if (push) input.setMove(0, 1);
            let from: vec3 | null = null, travel = 0, seconds = 0;
            p.run(3, () => {
                if (p.animator.currentStateName !== 'LandHard') return;
                const at = p.collider.worldPosition as vec3;
                from ??= vec3.clone(at);
                travel = Math.max(travel, Math.hypot(at[0] - from[0], at[2] - from[2]));
                seconds += FRAME;
            });
            input.setMove(0, 0);
            expect(p.trace, p.trace.join(' ')).toContain('LandHard');
            expect(p.player.animationHold).toBe(false);
            return { travel, seconds, last: p.trace[p.trace.length - 1] };
        };
        const still = land(false), pushed = land(true);
        // The clip's own root motion moves it (the crouch carries it forward, the stand brings it back) ...
        expect(still.travel).toBeGreaterThan(0.1);
        expect(still.travel).toBeLessThan(0.5);
        // ... and the stick adds nothing while it is down: it moves as if nobody were pushing.
        expect(Math.abs(pushed.travel - still.travel), `${pushed.travel.toFixed(2)} m pushed, ${still.travel.toFixed(2)} m still`).toBeLessThan(0.03);
        expect(pushed.seconds, 'it plays the landing').toBeGreaterThan(0.5);
        expect(pushed.last).toBe('Locomotion');
        expect(still.last).toBe('Idle');
    });

    it('locks the backward diagonals for half of what it detects', () => {
        const stored = rig().skin;
        const skin = loadSkin(stored, (a: number[]) => mat4.clone(a as any));
        const total = (w: Record<string, [number, number][]>) => Object.values(w).flat().reduce((sum, [a, b]) => sum + b - a, 0);
        for (const a of library('animations').filter(a => /^(Jog|Walk|Creep)B[LR]$/.test(a.name))) {
            const clip = a.clips[0];
            const found = detectFootLockWindows(clip, skin as any, { heelLift: 0.03 });
            expect(total(clip.footLocks), a.name).toBeGreaterThan(0);
            expect(total(clip.footLocks), a.name).toBeLessThan(total(found) * 0.6);
        }
        // The straight-back jog keeps all of its own.
        const back = library('animations').find(a => a.name === 'JogB').clips[0];
        expect(total(back.footLocks)).toBeCloseTo(total(detectFootLockWindows(back, skin as any, { heelLift: 0.03 })), 3);
    });

    it('leans forward into a start, and not on a straight run or a stop', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        let start = 0;
        p.run(0.6, () => { start = Math.max(start, p.player.leanForward); });
        expect(start, 'leans into the start').toBeGreaterThan(0.25);
        p.run(1.5);
        expect(p.player.leanForward, 'straight').toBeLessThan(0.05);
        input.setMove(0, 0);
        let stop = 0;
        p.run(1, () => { stop = Math.max(stop, p.player.leanForward); });
        expect(stop, 'never back').toBeLessThan(0.05);
    });

    it('is a Player template, placed once, with the attributes each character sets public', () => {
        const templates = library('templates');
        expect(templates.slice(0, 4).map((t: any) => t.name)).toEqual(['Player', 'Environment', 'Course', 'Car']);
        const [template] = templates;
        expect(read('manifest.json').sceneMetas[0].refs.templateIds).toEqual(templates.map((t: any) => t.id));
        const instance = named('Player Collider');
        expect(instance.variables.__templateId.value).toBe(template.id);
        const inside = allNodes(template.nodeJson);
        expect(inside.map((n: any) => n.type)).toEqual(['collider', 'character', 'cameraRig', 'camera', 'model', 'controller']);
        // The instance holds just what the template holds, and references inside it point inside it.
        expect(allNodes(instance).map((n: any) => n.type)).toEqual(inside.map((n: any) => n.type));
        const ids = new Set(inside.map((n: any) => n.id));
        const controller = inside.find((n: any) => n.type === 'controller');
        expect(ids.has(controller.possessedId) && ids.has(controller.aimSourceId)).toBe(true);
        const publics = (name: string) => library('scripts').find(s => s.name === name).variables
            .filter((v: any) => v.attribute && !v.hidden && v.access === 'public').map((v: any) => v.name).sort();
        expect(publics('SandboxPlayer')).toEqual(['backDiagonalScale', 'backScale', 'enterTrigger', 'exitTrigger', 'runFootSpeed', 'runFootWeight', 'runTurnSpeed', 'sprintTakeoff',
            'stairDownRunSpeed', 'stairDownWalkSpeed', 'stairUpRunSpeed', 'stairUpWalkSpeed', 'stairsLayer', 'turnDelay', 'walkBackDiagonalScale', 'walkFootSpeed', 'walkScale']);
        expect(publics('SandboxCamera')).toEqual(['pivotHeight', 'shoulderArm', 'shoulderOffset', 'thirdPersonArm']);
        expect(inside.find((n: any) => n.type === 'character').script).toBe(named('Player').script);
        expect(inside.find((n: any) => n.type === 'cameraRig').script).toBe(named('Camera Rig').script);
    });

    it('keeps its sky and its course in templates of their own', () => {
        const templates = new Map(library('templates').map((t: any) => [t.name, t]));
        const env = named('Environment'), course = named('Static Collision');
        expect(env.variables.__templateId.value).toBe(templates.get('Environment').id);
        expect(course.variables.__templateId.value).toBe(templates.get('Course').id);
        expect(env.children.map((c: any) => [c.type, c.name])).toEqual([['light', 'Sun'], ['skyAtmosphere', 'Sky Atmosphere'], ['skyLight', 'Sky Light'], ['volumetricClouds', 'Volumetric Clouds']]);
        expect(course.type).toBe('collider');
        expect(allNodes(course).filter((n: any) => n.type === 'collider').reduce((k: number, n: any) => k + n.collider.shapes.length, 0)).toBeGreaterThan(40);
        // The scene's top level is the placements: the sky, the ocean, the GI over the floor and the light probe over it
        // all, the Game Manager and its HUD, the player, the car, the props and the course.
        expect(sceneFile().scene.children.map((c: any) => c.name)).toEqual(['Environment', 'Ocean', 'GI Volume', 'Light Probe', 'Game Manager', 'HUD', 'Player Collider', 'Car', 'Props', 'Static Collision']);
        // And the running scene still finds its sun, sky and sky light inside the Environment.
        const scene = new Scene();
        scene.parse({ ...sceneFile(), scene: withoutModels(sceneFile().scene) }, true);
        expect(scene.findNode('Sky Atmosphere')).toBeTruthy();
        expect([...(scene as any).lights].some((l: any) => l.name === 'Sun')).toBe(true);
    });

    it('is lit at dusk under sunset clouds, with a GI Volume of one layer over the whole floor and a light probe over it all', () => {
        const env = named('Environment');
        // The clouds: the Sunset preset, more of them and smaller, fading into the sky from 9 km.
        const clouds = env.children.find((c: any) => c.type === 'volumetricClouds').clouds;
        expect([clouds.coverage, clouds.baseScale, clouds.detailScale, clouds.hazeDistance]).toEqual([0.6, 0.0013, 0.007, 9000]);
        expect(clouds.sunsetColor).toEqual([1.0, 0.32, 0.1]);
        // The GI Volume: the floor's 120 m square, one probe up (2 m over the ground, mid-box), 20 by 20 across.
        const gi = named('GI Volume');
        expect([gi.type, gi.position, gi.giVolume.size, gi.giVolume.probeCounts, gi.giVolume.probeInset, gi.giVolume.bakeId])
            .toEqual(['giVolume', [0, 2, 0], [120, 8, 120], [20, 1, 20], 0.5, null]);
        const scene = new Scene();
        scene.parse({ ...sceneFile(), scene: withoutModels(sceneFile().scene) }, true);
        const volume = scene.findNode('GI Volume') as any;
        volume.updateTransforms(null);
        const at = (i: number, k: number) => [...volume.probeWorldPosition(vec3.create(), i, 0, k)].map((v: number) => +v.toFixed(3));
        expect([at(0, 0), at(19, 19)]).toEqual([[-57, 2, -57], [57, 2, 57]]);
        // The floor (at the barrier's foot too) inside the box, past its feather.
        expect(volume.weightAt(vec3.fromValues(0, 0, 0))).toBe(1);
        expect(volume.weightAt(vec3.fromValues(58.9, 0.01, -58.9))).toBe(1);
        // The light probe: the whole scene, captured from the course's middle.
        const probe = named('Light Probe');
        expect([probe.type, probe.size, probe.mode, probe.affectsLighting, probe.affectsReflections, probe.relightDegrees]).toEqual(['lightProbe', [120, 40, 120], 'baked', true, true, 1]);
        // The eye: set once for the day, the dusk and the night (a floor low enough for the night, a curve keeping the
        // dark dark, never ramped by a script), the curve's darkening easing off toward the day.
        const render = sceneFile().config.render;
        expect(render.exposureMinEV).toBe(-3);
        const curve = render.exposureCompensationCurve as number[][];
        for (let i = 1; i < curve.length; i++) expect(curve[i][0] > curve[i - 1][0] && curve[i][1] >= curve[i - 1][1]).toBe(true);
        expect(curve[curve.length - 1][1]).toBe(0);
    });

    it('stands on an open ocean, 2 m under the ground', () => {
        const ocean = named('Ocean');
        expect([ocean.type, ocean.position, ocean.waterVolume.waterType, ocean.waterVolume.followWind]).toEqual(['waterVolume', [0, -2, 0], 'ocean', false]);
        const material = library('materials').find((m: any) => m.id === ocean.waterVolume.waterMaterialId);
        expect(material.name).toBe('Ocean');
    });

    it('switches its three light setups from the Game Manager on 1, 2 and 3, and says which on the HUD', () => {
        const p = play();
        p.run(0.2);
        const sun = p.scene.findNode('Sun') as Node;
        const line = p.scene.findNode('Light Setup') as any;
        const manager = p.scene.findNode('Game Manager') as any;
        const sunAt = () => [...sun.rotation].map(v => +v.toFixed(3));
        // As authored: the dusk.
        expect([manager.setup, sunAt(), line.text]).toEqual([2, [-9, 35, 0], 'Light: Sunset']);
        for (const [action, setup, elevation, name] of [['Day', 1, 52, 'Day'], ['Night', 3, -40, 'Night'], ['Sunset', 2, -9, 'Sunset']] as const) {
            input.tap(action);
            p.run(0.1);
            expect([manager.setup, sunAt(), line.text], action).toEqual([setup, [elevation, 35, 0], `Light: ${name}`]);
        }
        // The HUD lists the keys.
        expect((p.scene.findNode('Light Keys') as any).text).toContain('1 Day');
        expect((p.scene.findNode('HUD') as any).nodeType).toBe('uiRoot');
    });

    it('rolls out of a far fall while it is still running, and runs on at speed', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.5);
        const jog = named('Player').walkSpeed;
        // Off a ledge 3.6 m up, running: lifted with its speed kept.
        const at = p.collider.worldPosition;
        p.collider.setWorldPosition([at[0], at[1] + 3.6, at[2]]);
        let slowest = Infinity, rolling = 0;
        p.run(3, () => {
            if (p.animator.currentStateName !== 'LandRoll') return;
            rolling += FRAME;
            slowest = Math.min(slowest, p.player.groundSpeed);
        });
        input.setMove(0, 0);
        expect(p.trace, p.trace.join(' ')).toContain('LandRoll');
        expect(p.trace).not.toContain('LandHard');
        expect(rolling).toBeGreaterThan(0.3);
        expect(slowest, `slowest ${slowest.toFixed(2)} m/s through the roll`).toBeGreaterThan(0.8 * jog);
        expect(p.trace[p.trace.length - 1]).toBe('Locomotion');
        // A far fall standing still still lands hard (the drop tests above).
    });

    it('looks round at the camera standing still, and turns its body only after turnDelay', () => {
        const p = play(OPEN);
        p.run(1);
        const start = p.yawOf(p.player);
        expect(p.player.lookWeight).toBeGreaterThan(0.9);
        const names = new Map<number, string>(rig().skin.nodeNames);
        const headJoint = rig().skin.joints.findIndex((j: any) => (names.get(j.nodeIndex) ?? '').endsWith(':Head'));
        const headQ = () => quat.normalize(quat.create(), mat4.getRotation(quat.create(), mat4.invert(mat4.create(),
            mat4.invert(mat4.create(), p.animator.getFinalBoneMatrices()[headJoint] as mat4)!) as mat4));
        const before = headQ();
        // Inside the turn threshold (70): the head looks, the body stays.
        p.rigs[0].setOrbit(start + 60, 12);
        p.run(1);
        expect(p.player.lookYaw).toBeGreaterThan(55);
        expect(p.player.lookYaw).toBeLessThan(65);
        const turned = 2 * Math.acos(Math.min(1, Math.abs(quat.dot(before, headQ())))) * DEG;
        expect(turned, `the head turned ${turned.toFixed(1)} degrees`).toBeGreaterThan(35);
        expect(p.trace.some(s => /^Turn/.test(s))).toBe(false);
        // Past it: the body waits turnDelay before it turns.
        const delay = library('scripts').find(x => x.name === 'SandboxPlayer').variables.find((v: any) => v.name === 'turnDelay').default;
        expect(delay).toBeGreaterThanOrEqual(0.8);
        p.rigs[0].setOrbit(start + 110, 12);
        let t = 0, turnAt = -1;
        p.run(3.5, () => { t += FRAME; if (turnAt < 0 && /^Turn/.test(p.animator.currentStateName ?? '')) turnAt = t; });
        expect(turnAt, p.trace.join(' ')).toBeGreaterThan(delay * 0.95);
        expect(turnAt).toBeLessThan(delay + 0.8);
        // Moving off fades the look out.
        input.setMove(0, 1);
        p.run(1);
        expect(p.player.lookWeight).toBeLessThan(0.05);
        input.setMove(0, 0);
    });

    /** The head's rotation in model space, as posed this frame. */
    const headRotation = (p: ReturnType<typeof play>) => {
        const names = new Map<number, string>(rig().skin.nodeNames);
        const j = rig().skin.joints.findIndex((x: any) => (names.get(x.nodeIndex) ?? '').endsWith(':Head'));
        const bind = mat4.invert(mat4.create(), rig().skin.joints[j].inverseBindMatrix as unknown as mat4)!;
        const m = mat4.multiply(mat4.create(), p.animator.getFinalBoneMatrices()[j] as mat4, bind);
        return quat.normalize(quat.create(), mat4.getRotation(quat.create(), m));
    };
    const degreesApart = (a: quat, b: quat) => 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * DEG;

    it('looks up and down with the camera, level at the camera’s resting pitch', () => {
        const p = play(OPEN);
        p.run(1);
        const yaw = p.rigs[0].yaw;
        const rest = named('Camera Rig').pitch ?? 12;
        p.rigs[0].setOrbit(yaw, rest);
        p.run(0.6);
        expect(Math.abs(p.player.lookPitch)).toBeLessThan(1);
        const level = headRotation(p);
        /** Where the head's forward points, off its level look: + up. */
        const lift = () => {
            const delta = quat.multiply(quat.create(), headRotation(p), quat.invert(quat.create(), level));
            return vec3.transformQuat(vec3.create(), [0, 0, 1], delta)[1];
        };
        p.rigs[0].setOrbit(yaw, rest - 30);   // the camera looks up 30 degrees
        p.run(0.6);
        expect(p.player.lookPitch).toBeCloseTo(-30, 0);
        expect(lift(), 'looks up').toBeGreaterThan(0.3);
        p.rigs[0].setOrbit(yaw, rest + 30);
        p.run(0.6);
        expect(p.player.lookPitch).toBeCloseTo(30, 0);
        expect(lift(), 'looks down').toBeLessThan(-0.3);
    });

    it('holds a look round without twitching', () => {
        // The look poses are rest at their first frame: a looping blend space wrapped back to it every 2 s and
        // snapped the head toward centre for three frames.
        const p = play(OPEN);
        p.run(1);
        p.rigs[0].setOrbit(p.yawOf(p.player) + 60, 12);
        p.run(1);
        let prev = headRotation(p), worst = 0;
        p.run(5, () => { const q = headRotation(p); worst = Math.max(worst, degreesApart(q, prev)); prev = q; });
        expect(worst, `the head jumped ${worst.toFixed(2)} degrees in one frame`).toBeLessThan(1);
        expect(p.trace.some(s => /^Turn/.test(s))).toBe(false);
    });

    it('scatters rigid bodies over the course, at rest until touched, for the player to shove', () => {
        const props = named('Props').children;
        expect(props.length).toBeGreaterThan(15);
        for (const pr of props) {
            expect(pr.type, pr.name).toBe('collider');
            expect(pr.collider.mass, pr.name).toBeGreaterThan(0);
            expect(pr.collider.canSleep, pr.name).toBe(true);
            expect(pr.variables?.__templateId, `${pr.name} is a template instance`).toBeDefined();
        }
        const kinds = library('templates').slice(4).map((t: any) => t.name).sort();
        expect(kinds).toEqual(['Ball', 'Barrel', 'Big Ball', 'Crate', 'Large Crate', 'Plank', 'Small Crate']);
        // Placed at rest: two seconds with nobody near them moves nothing more than a barrel lying on its side rolling
        // onto a flat of its many-sided collider (a centimetre or two). The crate pyramid among them sleeps as one: on
        // Rapier its bottom row put to sleep first let the rows above sink through it (PhysicsSystem._updateActivation).
        const idle = play(OPEN);
        const bodies = idle.scene.findNode('Props')!.children as Node[];
        const from = bodies.map(b => vec3.clone(b.worldPosition as vec3));
        idle.run(2);
        const moved = bodies.map((b, i) => [b.name, vec3.distance(b.worldPosition as vec3, from[i])] as const).sort((a, b) => b[1] - a[1]);
        // Rapier's cylinder is round (native), with no flat to stop on, and one lying on its side drifts into a slow roll
        // on its own even on level ground (10 cm in 4 s, measured on a lone box floor): the barrels are let roll.
        const settled = TEST_PHYSICS === 'rapier' ? moved.filter(([name]) => !/^Barrel/.test(name)) : moved;
        expect(settled[0][1], `${settled[0][0]} moved ${(settled[0][1] * 100).toFixed(1)} cm on its own`).toBeLessThan(0.04);
        for (const [name, m] of moved) if (/Crate/.test(name)) expect(m, `${name} moved ${(m * 100).toFixed(1)} cm on its own`).toBeLessThan(0.02);
        // Jogging into the small crate beside the start pushes it along.
        const p = play([4.6, 0.02, -0.3]);
        p.run(0.5);
        const crate = (p.scene.findNode('Props')!.children as Node[]).find(b => Math.hypot(b.worldPosition[0] - 4.6, b.worldPosition[2] - 1.6) < 0.1)!;
        expect(crate, 'the small crate beside the start').toBeDefined();
        const at = vec3.clone(crate.worldPosition as vec3);
        input.setMove(0, 1);
        p.run(1.5);
        input.setMove(0, 0);
        expect(vec3.distance(crate.worldPosition as vec3, at), 'shoved').toBeGreaterThan(0.3);
    });

    it('groups its turns, stops, running turns, air, landings and the car, each state in one group', () => {
        const sm = machine();
        const states = new Set(sm.states.map((s: any) => s.name));
        expect(sm.groups.map((g: any) => g.name)).toEqual(['Turning', 'Stopping', 'Running Turn', 'Air', 'Landing', 'Car']);
        const seen = new Set<string>();
        for (const g of sm.groups) {
            expect(states.has(g.name), `${g.name} is not also a state`).toBe(false);
            for (const m of g.states) { expect(states.has(m), m).toBe(true); expect(seen.has(m), m).toBe(false); seen.add(m); }
        }
        // Left outside: the ones everything comes back to.
        for (const s of ['Idle', 'Locomotion', 'Start', 'Stairs']) expect(seen.has(s), s).toBe(false);
        const fromGroups = sm.transitions.filter((t: any) => sm.groups.some((g: any) => g.name === t.from));
        expect(fromGroups.length).toBeGreaterThan(6);
        expect(sm.states.find((s: any) => s.name === 'LandHard').holdMovement).toBe(true);
    });


    it('never snaps a leg with its foot locks: strafing, walking, setting off', () => {
        // A snap is what the lock does to a leg changing suddenly: the knee or the ankle, with the lock less without
        // it, moving more than 3 cm between two frames. Foot slide cannot see it. Three causes, measured here first:
        // the knee pole switching from the clip's bend to straight ahead as a strafing knee swung out past
        // sideways (20 to 35 cm), a 0.2 s release still holding a swinging foot back and the leg pulled straight
        // after it (5 to 10 cm), and a foot caught sliding as the run blended out of Idle (up to 8 cm).
        const out: string[] = [];
        let worst = 0;
        for (const [label, x, y, walk] of [['jog left', -1, 0, false], ['jog right', 1, 0, false], ['walk left', -1, 0, true],
            ['walk right', 1, 0, true], ['jog forward', 0, 1, false]] as const) {
            const runs: Record<string, vec3>[][] = [];
            for (const lock of [1, 0]) {
                const p = play(OPEN, { footLock: lock });
                p.run(0.5);
                if (walk) input.press('Walk');
                input.setMove(x, y);
                const frames: Record<string, vec3>[] = [];
                p.run(3, () => {
                    const r: Record<string, vec3> = {};
                    for (const b of ['LeftFoot', 'LeftLeg', 'RightFoot', 'RightLeg']) r[b] = p.jointModel(b);
                    frames.push(r);
                });
                input.setMove(0, 0);
                input.release('Walk');
                runs.push(frames);
            }
            const [on, off] = runs;
            let mostThisWay = 0, setOff = 0, steady = 0;
            for (let k = 1; k < on.length; k++) for (const b of ['LeftFoot', 'LeftLeg', 'RightFoot', 'RightLeg']) {
                const now = vec3.sub(vec3.create(), on[k][b], off[k][b]), before = vec3.sub(vec3.create(), on[k - 1][b], off[k - 1][b]);
                const jump = vec3.distance(now, before);
                mostThisWay = Math.max(mostThisWay, jump);
                if (k < 60) setOff = Math.max(setOff, jump); else steady = Math.max(steady, jump);
            }
            out.push(`${label}: the lock moves a leg joint at most ${(mostThisWay * 100).toFixed(1)} cm in a frame (setting off ${(setOff * 100).toFixed(1)}, then ${(steady * 100).toFixed(1)})`);
            worst = Math.max(worst, mostThisWay);
        }
        console.log(out.join(String.fromCharCode(10)));
        // Strafing, the cause: under 3.5 cm (it was 35). Setting off forward, the most left: about 4.
        expect(worst, out.join('; ')).toBeLessThan(0.045);
        expect(Math.max(...out.filter(l => /left|right/.test(l)).map(l => parseFloat(/at most ([\d.]+)/.exec(l)![1]))), out.join('; ')).toBeLessThan(3.5);
    });

    it('never ping-pongs between two states', () => {
        const warn = vi.spyOn(Logger, 'warn');
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1); p.run(1);
        input.setMove(1, 0); p.run(1);
        input.setMove(0, 0); p.run(1);
        p.rigs[0].setOrbit(p.yawOf(p.player) + 120, 12); p.run(2);
        input.tap('Jump'); p.run(2);
        const pingPong = warn.mock.calls.filter(c => String(c[0]).includes('ping-ponging'));
        warn.mockRestore();
        expect(pingPong).toEqual([]);
    });

    it('settles at a wall it runs into instead of ping-ponging between Idle and the run', () => {
        for (const sprint of [false, true]) {
            const warn = vi.spyOn(Logger, 'warn');
            // Behind the wall by the start, running straight at it.
            const p = play([-10, 0.02, -7.6]);
            p.run(0.5);
            if (sprint) input.press('Sprint');
            input.setMove(0, 1);
            p.run(4);
            const pingPong = warn.mock.calls.filter(c => String(c[0]).includes('ping-ponging'));
            warn.mockRestore();
            expect(pingPong, `${sprint ? 'sprinting' : 'jogging'}: ${p.trace.join(' ')}`).toEqual([]);
            expect(p.trace.length, p.trace.join(' ')).toBeLessThanOrEqual(4);
            expect(p.collider.worldPosition[2]).toBeLessThan(-6);
            input.setMove(0, 0);
            input.release('Sprint');
        }
    });

    // ----- the car ----------------------------------------------------------------------------------

    it('is a Car template: its body and windows, its lamps, four wheels each turning its mesh, a seat, a door, its own camera and Controller', () => {
        const template = library('templates').find((t: any) => t.name === 'Car');
        const instance = named('Car');
        expect(instance.variables.__templateId.value).toBe(template.id);
        const inside = allNodes(template.nodeJson);
        expect(inside.map((n: any) => `${n.type} ${n.name}`)).toEqual([
            'collider Car', 'node Car Body', 'model Body', 'model Glass',
            'node Lights', 'light Headlight L', 'light Headlight R', 'light Tail Light L', 'light Tail Light R',
            'light Reverse Light L', 'light Reverse Light R',
            'vehicle Vehicle', 'node Wheels',
            'wheel Wheel FL', 'model Wheel Mesh', 'wheel Wheel FR', 'model Wheel Mesh',
            'wheel Wheel RL', 'model Wheel Mesh', 'wheel Wheel RR', 'model Wheel Mesh',
            'node Seat', 'node Enter Point', 'node Exit Point', 'trigger Door Zone', 'node Camera Target',
            'cameraRig Car Camera Rig', 'camera Car Camera', 'controller Car Controller',
        ]);
        // The body and its windows are the Car Body model (the windows blended: a node of their own), placed under its
        // asset's name, as the editor names a placed model. Each wheel's mesh is right under its Wheel node (which
        // turns it), turned round on the right so its hub faces out.
        const models = new Map(library('models').map((m: any) => [m.name, m]));
        expect([...models.keys()].filter(n => n.startsWith('Car'))).toEqual(['Car Body']);
        expect(inside.find((n: any) => n.name === 'Car Body').variables.__modelId.value).toBe(models.get('Car Body').id);
        for (const w of inside.filter((n: any) => n.type === 'wheel')) {
            expect(w.children.map((c: any) => `${c.type} ${c.name}`)).toEqual(['model Wheel Mesh']);
            expect(w.children[0].model.geometry.positions.length).toBeGreaterThan(300);
            expect(w.children[0].rotation[1]).toBe(w.name.endsWith('R') ? 180 : 0);
        }
        // The lamps: the headlights spots ahead and a little down, casting shadows; the tail and reverse lights at the
        // back, red and white. None baked into probes (they move with the car).
        const lamps = inside.filter((n: any) => n.type === 'light');
        for (const l of lamps) {
            expect(l.bake).toBe(false);
            expect(Math.sign(l.position[0])).toBe(l.name.endsWith('L') ? 1 : -1);
            if (l.name.startsWith('Headlight')) {
                expect([l.lightType, l.castShadows, l.position[2] > 2, l.rotation[0] > 0]).toEqual(['spotlight', true, true, true]);
            } else {
                expect([l.lightType, l.castShadows, l.position[2] < -2]).toEqual(['point', false, true]);
                const [r, g, b] = l.light.color;
                expect(l.name.startsWith('Tail') ? r > 0.9 && g < 0.1 && b < 0.1 : r > 0.9 && g > 0.9 && b > 0.8).toBe(true);
            }
        }
        const glass = inside.find((n: any) => n.name === 'Glass');
        expect(glass.model.material.config.transparent).toBe(true);
        expect(inside.find((n: any) => n.type === 'model' && n.name === 'Body').model.material.config.transparent).toBe(false);
        // The Car preset, on this car's wheels: the front ones steer, the rear ones drive and hold the hand brake.
        const vehicle = inside.find((n: any) => n.type === 'vehicle');
        expect([vehicle.drivetrain, vehicle.parked, vehicle.playerInput]).toEqual(['engine', true, false]);
        const wheels = inside.filter((n: any) => n.type === 'wheel');
        expect(wheels.map((w: any) => [w.steerAngle > 0, w.driven, w.handBrakeTorque > 0])).toEqual([
            [true, false, false], [true, false, false], [false, true, true], [false, true, true],
        ]);
        // The model's own wheels, at the car's size (0.83 of the model's: as tight round the driver as it goes).
        for (const w of wheels) expect(w.radius).toBeCloseTo(0.402 * 0.83, 2);
        // A dynamic chassis on the Vehicle layer, at the preset's mass: one convex hull of the body and its windows
        // (the Car Body model's meshes), not of the wheels.
        const chassis = template.nodeJson.collider;
        expect([chassis.mass, chassis.layer, chassis.shapes.map((s: any) => s.type)]).toEqual([1200, layer('Vehicle'), ['convex']]);
        const hull = chassis.shapes[0];
        expect([hull.sources, hull.quality, hull.v]).toEqual([['Car Body'], 'high', 5]);
        // The wheels out of it: it clears the ground (the tyres stand on it) by the body's own clearance.
        expect(Math.min(...hull.vertices.map((v: number[]) => v[1] + hull.offset[1]))).toBeGreaterThan(0.08);
        // Its own Controller, possessing nothing until someone gets in, aiming its own camera rig; that camera off.
        const controller = inside.find((n: any) => n.type === 'controller');
        const rigNode = inside.find((n: any) => n.type === 'cameraRig');
        expect([controller.possessedId, controller.aimSourceId, controller.controlSource]).toEqual([null, rigNode.id, 'player']);
        expect(rigNode.followId).toBe(inside.find((n: any) => n.name === 'Camera Target').id);
        expect(inside.find((n: any) => n.type === 'camera').active).toBe(false);
        // The Door Zone looks for the characters.
        expect(inside.find((n: any) => n.type === 'trigger').sensor.mask).toBe(layer('Character'));
        expect(template.nodeJson.script).toBe(named('Car').script);
    });

    /** A node of the car's template instance, as parsed into the running scene. */
    const carNodes = (p: ReturnType<typeof play>) => {
        const find = (name: string) => p.scene.findNode(name) as Node & Record<string, any>;
        return {
            car: find('Car'), vehicle: find('Vehicle'), seat: find('Seat'), enter: find('Enter Point'), exit: find('Exit Point'),
            controller: find('Car Controller') as unknown as ControllerNode, rig: find('Car Camera Rig') as unknown as CameraRigNode,
            camera: find('Car Camera'), playerCamera: find('Camera'),
        };
    };
    /** Where the car's Enter Point is in the world, from the bundle (the scene not yet playing). */
    const enterPointWorld = () => {
        const tree = sceneFile().scene;
        const car = tree.children.find((c: any) => c.name === 'Car');
        const seat = car.children.find((c: any) => c.name === 'Seat');
        const enter = seat.children.find((c: any) => c.name === 'Enter Point');
        const pose = (n: any): [number, number, number, number] => [n.position[0], n.position[1], n.position[2], n.rotation[1]];
        return MathUtils.yawPoseMul(pose(car), MathUtils.yawPoseMul(pose(seat), pose(enter)));
    };
    /** The upright pose of `node` in its parent's frame. */
    const localPose = (node: Node): [number, number, number, number] => {
        const q = node.quaternion, p = node.position;
        const fx = 2 * (q[0] * q[2] + q[3] * q[1]), fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
        return [p[0], p[1], p[2], Math.atan2(fx, fz) * DEG];
    };

    it('parks on its wheels at its modelled height, and stays put', () => {
        const p = play();
        const { car } = carNodes(p);
        const from = vec3.clone(car.worldPosition as vec3);
        p.run(3);
        const at = car.worldPosition;
        // On its springs as modelled: the wheels authored lower by the sag their springs settle by (g / (2 pi f)^2, as
        // Jolt springs them; Rapier's port of Bullet's springs sits about twice as low on the same frequency).
        const sinks = TEST_PHYSICS === 'rapier' ? 0.1 : 0.04;
        expect(Math.abs(at[1] - from[1]), `rests ${((at[1] - from[1]) * 100).toFixed(1)} cm off its height`).toBeLessThan(sinks);
        expect(Math.hypot(at[0] - from[0], at[2] - from[2])).toBeLessThan(0.02);
        const f = car.worldForward;
        expect(Math.abs(f[1])).toBeLessThan(0.02);
    });

    it('gets in by the door, drives off with its own Controller and camera, and lets the driver out by its side', () => {
        const start = enterPointWorld();
        // Half a metre off where getting in starts, and turned 20 degrees: the step onto it is the script's.
        const at = MathUtils.yawPoseMul(start, [0.3, 0, -0.4, 20]);
        const p = play([at[0], 0.02, at[2]], {}, {}, at[3]);
        const c = carNodes(p);
        const body = p.collider;
        const states = (from: number) => p.trace.slice(from);
        p.run(1);
        const ownController = p.controller();
        expect(ownController.possessed).toBe(p.player);
        expect(c.playerCamera.active && !c.camera.active).toBe(true);
        // An empty car's lamps are off.
        const lamp = (name: string) => ((p.scene.findNode(name) as any).light as { intensity: number }).intensity;
        const lamps = () => ['Headlight L', 'Headlight R', 'Tail Light L', 'Tail Light R', 'Reverse Light L', 'Reverse Light R'].map(lamp);
        const authored = Object.fromEntries(allNodes(library('templates').find((t: any) => t.name === 'Car').nodeJson)
            .filter((n: any) => n.type === 'light').map((n: any) => [n.name, n.light.intensity]));
        expect(lamps()).toEqual([0, 0, 0, 0, 0, 0]);
        // And facing 45 degrees off the way its body (the Collider) faces: where a character faces is the
        // Character's own turn, which getting in must take along.
        p.player.setRotation([0, 45, 0]);
        p.player.updateTransforms(body.worldTransform);

        // In: Interact by the door.
        let mark = p.trace.length;
        input.tap('Interact');
        p.run(0.1);
        expect(body.parent?.name).toBe('Seat');
        expect((p.physics as any).isSuspended(body.ownBody)).toBe(true);
        expect(c.controller.possessed).toBe(c.vehicle);
        expect(ownController.possessed).toBeNull();
        expect(c.camera.active && !c.playerCamera.active).toBe(true);
        p.run(6.5);
        expect(p.player.seated).toBe(true);
        expect(p.animator.currentStateName).toBe('CarDrive');
        const seated = localPose(body);
        expect(Math.hypot(seated[0], seated[1], seated[2]), `seated ${seated.map(v => v.toFixed(3))} off the seat`).toBeLessThan(0.03);
        expect(Math.abs(wrap(seated[3]))).toBeLessThan(3);
        // Facing ahead in the seat, however it stood when it got in.
        expect(Math.abs(wrap(p.yawOf(p.player) - p.yawOf(c.seat))), 'faces the way the seat does').toBeLessThan(3);
        // With a driver: the headlights on, the tail lights glowing (not braking), the reverse lights off.
        const share = c.car.tailShare as number;
        expect(lamps()).toEqual([authored['Headlight L'], authored['Headlight R'], authored['Tail Light L'] * share, authored['Tail Light R'] * share, 0, 0]);
        expect(states(mark).filter(s => /Fall|Land|Jump/.test(s)), states(mark).join(' ')).toEqual([]);

        // Drive: forward along the car's nose, then to the left (away from the platforms), the driver sitting still.
        const nose = vec3.clone(c.car.worldForward as vec3);
        const from = vec3.clone(c.car.worldPosition as vec3);
        input.setMove(0, 1);
        p.run(1);
        const ahead = vec3.dot(vec3.sub(vec3.create(), c.car.worldPosition as vec3, from), nose);
        // (On Jolt it sets off spinning its rear wheels: the Car preset's engine is stronger than its tyres there.)
        expect(ahead, 'drives forward').toBeGreaterThan(1);
        const heading = p.yawOf(c.car);
        input.setMove(-1, 0.5);
        p.run(1.5);
        expect(wrap(p.yawOf(c.car) - heading), 'turns left (yaw climbs)').toBeGreaterThan(10);
        expect(Math.hypot(...localPose(body).slice(0, 3))).toBeLessThan(0.03);
        input.press('Jump');
        p.run(0.1);
        expect(c.vehicle.handBrake).toBe(1);
        input.release('Jump');

        // Back on S: it brakes first (the brake lights full), then reverses (the reverse lights on), then forward again.
        input.setMove(0, -1);
        p.run(0.3);
        expect(c.vehicle.braking, 'S against its travel brakes').toBeGreaterThan(0.5);
        // (Coming up over a bulb's warm-up: lampSeconds.)
        expect(lamp('Tail Light L')).toBeGreaterThan(authored['Tail Light L'] * 0.95);
        let backing = 0;
        while (!c.vehicle.reversing && backing < 4) { p.run(0.1); backing += 0.1; }
        p.run(0.6);
        expect(c.vehicle.reversing, `in reverse after ${backing.toFixed(1)} s, at ${c.vehicle.speed.toFixed(2)} m/s`).toBe(true);
        expect(c.vehicle.speed).toBeLessThan(0);
        expect([lamp('Reverse Light L'), lamp('Reverse Light R')]).toEqual([authored['Reverse Light L'], authored['Reverse Light R']]);
        expect(lamp('Tail Light L')).toBeCloseTo(authored['Tail Light L'] * share, 3);
        input.setMove(0, 1);
        let forward = 0;
        while (c.vehicle.speed < 3 && forward < 5) { p.run(0.1); forward += 0.1; }
        expect(Math.max(lamp('Reverse Light L'), lamp('Reverse Light R'))).toBeLessThan(1);

        // Out, at speed: the car brakes to a stop, then the driver gets out by its side.
        input.setMove(0, 0.5);
        p.run(0.5);
        expect(Math.abs(c.vehicle.speed)).toBeGreaterThan(2);
        mark = p.trace.length;
        input.setMove(0, 0);
        input.tap('Interact');
        p.run(0.6);
        // Braking to a stop to let the driver out: the brake lights full.
        expect(lamp('Tail Light L')).toBe(authored['Tail Light L']);
        let waited = 0;
        while (p.player.inVehicle && waited < 15) { p.run(0.5); waited += 0.5; }
        expect(p.player.inVehicle, `still in the car after ${waited} s: ${states(mark).join(' ')}`).toBe(false);
        expect(states(mark)).toContain('CarExit');
        // On its feet, its body back in the world, at the Exit Point, upright; its Controller and its camera back,
        // looking where the car's camera did.
        expect(body.parent).toBe(p.scene.root);
        expect((p.physics as any).isSuspended(body.ownBody)).toBe(false);
        expect(Math.abs(body.worldForward[1])).toBeLessThan(1e-3);
        const exit = c.exit.worldPosition;
        expect(Math.hypot(body.worldPosition[0] - exit[0], body.worldPosition[2] - exit[2]), 'at the Exit Point').toBeLessThan(0.05);
        expect(Math.abs(wrap(p.yawOf(p.player) - p.yawOf(c.exit))), 'faces the way the Exit Point does').toBeLessThan(5);
        expect(ownController.possessed).toBe(p.player);
        expect(c.controller.possessed).toBeNull();
        expect(c.playerCamera.active && !c.camera.active).toBe(true);
        expect(Math.abs(wrap(p.rigs[0].yaw - c.rig.yaw))).toBeLessThan(0.5);
        // Empty again: its lamps off.
        p.run(0.6);
        expect(lamps()).toEqual([0, 0, 0, 0, 0, 0]);
        mark = p.trace.length;
        p.run(1);
        expect(p.player.isGrounded).toBe(true);
        expect(states(mark).filter(s => /Fall|Land|Jump/.test(s)), states(mark).join(' ')).toEqual([]);
        // And walks off.
        input.setMove(0, 1);
        let fastest = 0;
        p.run(1, () => { fastest = Math.max(fastest, p.player.planarSpeed); });
        expect(fastest).toBeGreaterThan(1);
        input.setMove(0, 0);
    });
});
