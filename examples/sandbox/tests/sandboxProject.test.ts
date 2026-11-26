import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { EXAMPLE, dataReady, readThisExample } from '@tools/exampleKit/testKit';
import { mat3, mat4, quat, vec3 } from 'gl-matrix';
// The whole engine: it registers itself as the scripts' 'cleo' module, so the example's script runs headless.
import { Scene, CleoEngine, PhysicsSystem, Animator, Logger, NODE_BUILTINS, MathUtils, Game } from 'cleo';
import type { CharacterNode, CameraRigNode, ControllerNode, Node } from 'cleo';
import { loadSkin } from '@editor/utils/animationAssets';
import { detectFootLockWindows } from '@engine/animation/footLockWindows';
import { fakeInput } from '@engine-tests/helpers/fakeInput';
import type { FakeInput } from '@engine-tests/helpers/fakeInput';
import { TEST_PHYSICS } from '@engine-tests/helpers/testPhysics';
import { PhysicsBody } from '@engine/physics/physicsBody';
import { ALL_LAYERS, LAYER, layerByName } from '@engine/physics/collisionLayers';
import { MaterialBinder } from '@engine/graphics/render/materialBinder';
import { fieldWeights, poseSampleKey } from '@engine/animation/animationField';
import { resolveTablePose } from '@engine/animation/animationPose';
import { reembedPoses } from '@editor/utils/animationControllers';
import { registerTemplates, clearTemplates } from '@engine/core/scene/templates';
import { Events } from '@engine/core/events';

// The Sandbox example: a mannequin with ALS-style locomotion built from the engine's own tools.
// Almost everything that can go wrong with it is silent: a parameter bound to a field that does not exist reads
// its default forever, a turn clip whose root motion tilts the capsule tips the character over, a landing gated
// on the wrong flag fires at take-off. So this suite reads the bundle and PLAYS it, headless: the real Collider,
// Character and Controller on a real physics world, the scene's own script, and an Animator built from the
// bundle's skeleton, clips and machine, hung under the Character exactly where the model would be.

const PROJECT = EXAMPLE;
const present = dataReady();
const sandbox = present ? await readThisExample() : null;
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
/** The most an aimed rifle's chest turns over a walk's stride, degrees (Steady holds it near still). */
const CHEST_SWAY_AIMED = 4;
const DEG = 180 / Math.PI;
const wrap = (a: number) => ((a + 180) % 360 + 360) % 360 - 180;

let authoring = false;
let input: FakeInput;
/** Every world a test played: disposed after it, since a WASM backend's heap is fixed (Jolt's 128 MB holds a few). */
const played: PhysicsSystem[] = [];
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; input = fakeInput(['Move', 'Drive']); });
afterEach(() => {
    CleoEngine.authoringMode = authoring; input.restore();
    for (const p of played.splice(0)) p.dispose();
});

/** Every node of a running scene, depth first. */
const allSceneNodes = (scene: any): any[] => { const out: any[] = []; const walk = (n: any) => { out.push(n); for (const c of n.children) walk(c); }; walk(scene.root); return out; };

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
        expect(types).toEqual(['cameraRig', 'model', 'node', 'node', 'uiRoot', 'controller']);
        expect(player.children[2].name).toBe('Weapons');
        expect(player.children[3].name).toBe('Sounds');
        // The Player's own HUD: a screen canvas (the crosshair, the ammunition, the reload).
        expect([player.children[4].name, player.children[4].ui.space]).toEqual(['HUD', 'screen']);
        const [camera] = player.children;
        expect(camera.name).toBe('Camera Rig');
        expect(camera.children[0].active).toBe(true);
        const controller = player.children[5];
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

    /** The flights of stairs: where to set off from, the riser, the step count. */
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
        const own = library('animations').filter(a => a.rigId === rig().id)
        const clipNames = new Set(own.map(a => a.clips[0].name));
        expect(new Set(rig().animationIds)).toEqual(new Set(own.map(a => a.id)));
        const sm = machine();
        for (const s of sm.states) {
            if (s.field) for (const sample of s.field.samples) expect(clipNames.has(sample.clipName), sample.clipName).toBe(true);
            else expect(clipNames.has(s.clipName), `${s.name}: ${s.clipName}`).toBe(true);
        }
        // The layers' blend spaces (the Look layer's) play clips the skeleton owns too; a pose sample or state holds a
        // pose of the project's (the weapons'), embedded.
        const poseIds = new Set(library('poseAssets').flatMap((a: any) => a.poses.map((p: any) => p.id)));
        for (const l of sm.layers) for (const s of l.states) {
            if (s.field) for (const sample of s.field.samples) {
                if (sample.poseRef) expect(poseIds.has(sample.poseRef.poseId) && !!s.field.poses[sample.clipName], `${l.name}: ${sample.clipName}`).toBe(true);
                else expect(clipNames.has(sample.clipName), `${l.name}: ${sample.clipName}`).toBe(true);
            }
            else if (s.poseRef) expect(poseIds.has(s.poseRef.poseId) && !!s.pose, `${l.name}: ${s.name}`).toBe(true);
            // An empty state (the Recoil layer's Off) adds nothing.
            else if (s.clipName) expect(clipNames.has(s.clipName), `${l.name}: ${s.clipName}`).toBe(true);
        }
        const field = sm.states.find((s: any) => s.name === 'Locomotion').field;
        // The embedded copy is the blend space asset's.
        expect(field.samples).toEqual(library('animationFields').find((f: any) => f.name === 'Locomotion').samples);
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
        // The car's triggers, and each gun's recoil (the Recoil layer's kick, raised by the holder on every shot).
        expect(sm.parameters.filter((p: any) => p.type === 'trigger').map((p: any) => p.name)).toEqual(['EnterCar', 'ExitCar', 'PistolFire', 'RifleFire', 'ShotgunFire']);
        for (const p of sm.parameters) {
            if (p.type === 'trigger') continue;
            expect(p.variable.nodeRef).toBe('parent');
            if (p.variable.source === 'builtin') expect(NODE_BUILTINS[p.variable.varName], p.variable.varName).toBeDefined();
            else expect(['moveDir', 'isJumping', 'turnRequest', 'crouched'].includes(p.variable.varName) || scriptFields.has(p.variable.varName), p.variable.varName).toBe(true);
        }
        const params = new Set(sm.parameters.map((p: any) => p.name));
        const conds = (c: any): any[] => !c ? [] : c.children ? c.children.flatMap(conds) : [c];
        for (const t of sm.transitions) for (const c of conds(t.condition)) expect(params.has(c.param), c.param).toBe(true);
        // Only the turns, the stop (which plants sideways), the hard landing (which crouches where it came down) and
        // getting in and out of the car (from the door to the seat and back) drive the character with their root motion.
        const rootMotion = library('animations').filter(a => a.clips[0].rootMotion).map(a => a.name).sort();
        expect(rootMotion).toEqual(['CarEnter', 'CarExit', 'CrouchTurn90L', 'CrouchTurn90R', 'LandHard', 'Rifle CrouchTurn90L', 'Rifle CrouchTurn90R', 'Rifle Turn90L', 'Rifle Turn90R', 'RunTurnL', 'RunTurnR', 'Stop', 'StopMirror', 'Turn180L', 'Turn180R', 'Turn90L', 'Turn90R']);
    });

    it('ships the current scripts and the actions they read', () => {
        for (const [name, node] of [['SandboxPlayer', 'Player'], ['SandboxCamera', 'Camera Rig'], ['SandboxCar', 'Car'], ['SandboxCarCamera', 'Car Camera Rig'], ['SandboxGameManager', 'Game Manager']]) {
            const script = library('scripts').find(s => s.name === name);
            // The node runs the script's own .ts (a reader puts the source back on it, as Play does).
            expect(named(node).script, node).toBe(script.source);
        }
        const actions = read('libraries', 'inputMap.json').maps.find((m: any) => m.name === 'Gameplay').actions.map((a: any) => a.name);
        for (const a of ['Move', 'Look', 'Jump', 'Sprint', 'Walk', 'Interact', 'Drive', 'Day', 'Sunset', 'Night', 'Reload', 'Crouch', 'View']) expect(actions).toContain(a);
        // The camera's framing follows the sprint: no action switches it.
        expect(actions).not.toContain('Camera');
    });

    it('lays the gamepad out as asked: X jumps, A runs, the triggers drive, the sticks look twice as fast', () => {
        const gameplay = read('libraries', 'inputMap.json').maps.find((m: any) => m.name === 'Gameplay');
        const bindings = (name: string) => gameplay.actions.find((a: any) => a.name === name).bindings;
        const pad = (name: string) => bindings(name).filter((b: any) => b.source.device === 'gamepad').map((b: any) => b.source.button);
        expect(pad('Jump')).toEqual(['x']);
        expect(pad('Sprint')).toEqual(['a']);
        // The sticks at twice the engine default's rate (4); the mouse as it was (no scale at all).
        const look = bindings('Look');
        const scale = (b: any) => b.processors?.find((p: any) => p.kind === 'scale')?.factor;
        expect(look.filter((b: any) => b.source.device === 'gamepadAxis').map((b: any) => [b.source.axis, scale(b)])).toEqual([['rightStickX', 8], ['rightStickY', -8]]);
        for (const b of look.filter((b: any) => b.source.device === 'pointer')) expect(scale(b), b.id).toBeUndefined();
        // In the car: the left stick only steers, the right trigger drives on, the left one brakes and reverses.
        const drive = bindings('Drive');
        const padDrive = drive.filter((b: any) => b.source.device === 'gamepad' || b.source.device === 'gamepadAxis')
            .map((b: any) => `${b.source.button ?? b.source.axis} ${b.part}`);
        expect(padDrive).toEqual(['leftStickX x', 'rightTrigger up', 'leftTrigger down']);
        // The keys drive as Move's do.
        const keys = (bs: any[]) => bs.filter((b: any) => b.source.device === 'key').map((b: any) => `${b.source.code} ${b.part}`);
        expect(keys(drive)).toEqual(keys(bindings('Move')));
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
        // The model node's skeleton keeps the rig's sockets (the grips, the support hands' targets); loadSkin does not.
        skin.sockets = stored.sockets;
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

    it('jumps on the move the way it flies, not the way the camera looks, and faces the camera again once down', () => {
        const p = play(OPEN);
        p.run(0.5);
        const aim = p.yawOf(p.player);
        // A strafe to the right at a jog: the body faces the camera, travelling 90 degrees off it.
        input.setMove(1, 0);
        p.run(1.2);
        expect(Math.abs(wrap(p.yawOf(p.player) - aim)), 'strafes facing the camera').toBeLessThan(10);
        const v0 = p.player.velocity;
        expect(Math.abs(wrap(Math.atan2(v0[0], v0[2]) * DEG - aim)), 'travels off the camera').toBeGreaterThan(70);
        input.tap('Jump');
        let offTravel = Infinity, airborne = 0;
        p.run(1.5, () => {
            if (!p.player.isJumping) return;
            airborne++;
            const v = p.player.velocity;
            offTravel = Math.abs(wrap(p.yawOf(p.player) - Math.atan2(v[0], v[2]) * DEG));
        });
        expect(airborne, 'flies').toBeGreaterThan(10);
        expect(p.trace).toContain('JumpRun');
        // Facing where it flies by the time it comes down: the running jump goes the way the body does.
        expect(offTravel, 'faces its flight').toBeLessThan(5);
        // Down again and still strafing: the camera's way once more.
        p.run(1);
        expect(Math.abs(wrap(p.yawOf(p.player) - aim)), 'faces the camera again').toBeLessThan(10);
        input.setMove(0, 0);
    });

    it('keeps facing as it stood through a standing jump, the camera turned away', () => {
        const p = play(OPEN);
        p.run(0.5);
        const start = p.yawOf(p.player);
        input.tap('Jump');
        p.run(0.1);
        // The camera swung round while in the air: nothing turns the body for the jump.
        p.rigs[0].setOrbit(start + 60, 12);
        p.run(0.2);
        expect(p.player.isJumping).toBe(true);
        expect(Math.abs(wrap(p.yawOf(p.player) - start))).toBeLessThan(2);
        p.run(1.5);
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
            ['Pistol', 'override', 'PistolWeight'], ['Rifle', 'override', 'RifleWeight'], ['Shotgun', 'override', 'ShotgunWeight'],
            ['Lowered', 'additive', 'LoweredWeight'],
            ['Lean Left', 'additive', 'LeanLeft'], ['Lean Right', 'additive', 'LeanRight'], ['Lean Forward', 'additive', 'LeanForward'],
            ['Pistol Aim', 'additive', 'PistolAimWeight'], ['Rifle Aim', 'additive', 'RifleAimWeight'], ['Shotgun Aim', 'additive', 'ShotgunAimWeight'],
            ['Recoil', 'additive', undefined], ['Look', 'additive', 'LookWeight'], ['Look Head', 'additive', 'LookHeadWeight']]);
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
        // A folder lists its templates in explorer order, not in the order the generator made them.
        for (const name of ['Player', 'Environment', 'Course', 'Car']) expect(templates.some((t: any) => t.name === name), name).toBe(true);
        const template = templates.find((t: any) => t.name === 'Player');
        // The scene lists the templates placed in it, as the editor saves it; the ones scripts spawn by name (the
        // shot's effects) are not placed, and a published game bakes every template in the library anyway.
        const placed = new Set(nodes().map((n: any) => n.variables?.__templateId?.value).filter(Boolean));
        expect([...read('manifest.json').sceneMetas[0].refs.templateIds].sort()).toEqual([...placed].sort());
        expect([...placed].every(id => templates.some((t: any) => t.id === id))).toBe(true);
        const instance = named('Player Collider');
        expect(instance.variables.__templateId.value).toBe(template.id);
        const inside = allNodes(template.nodeJson);
        // The weapons: Weapons, then each grip holder, its model instance (a node with the mesh under it) and its Muzzle;
        // under the camera the Viewmodels, each a model and its Muzzle; the Sounds, three shots; the HUD, the crosshair
        // (a dot and four ticks), the ammunition (its three texts) and the reload.
        const weapon = ['node', 'node', 'model', 'node'];
        const viewmodel = ['model', 'node'];
        const hud = ['uiRoot', 'uiPanel', 'uiPanel', 'uiPanel', 'uiPanel', 'uiPanel', 'uiPanel', 'uiPanel', 'uiText', 'uiText', 'uiText', 'uiText'];
        expect(inside.map((n: any) => n.type)).toEqual(['collider', 'character', 'cameraRig', 'camera', 'node', ...viewmodel, ...viewmodel, ...viewmodel,
            'model', 'node', ...weapon, ...weapon, ...weapon, 'node', 'sound', 'sound', 'sound', ...hud, 'controller']);
        // The instance holds just what the template holds, and references inside it point inside it.
        expect(allNodes(instance).map((n: any) => n.type)).toEqual(inside.map((n: any) => n.type));
        // The shot cues overlap on their own voices: a held AK-47 rings on over its 4.5 s shot.
        for (const nodes of [inside, allNodes(instance)]) {
            const cues = nodes.filter((n: any) => n.type === 'sound');
            expect(cues.map((n: any) => n.name)).toEqual(['ShotPistol', 'ShotRifle', 'ShotShotgun']);
            for (const cue of cues) {
                const { voices, whenFull, pitchVariation, volumeVariation } = cue.sound;
                expect({ voices, whenFull, pitchVariation, volumeVariation }, cue.name).toEqual({ voices: 16, whenFull: 'quietest', pitchVariation: 0.5, volumeVariation: 0.1 });
            }
        }
        const ids = new Set(inside.map((n: any) => n.id));
        const controller = inside.find((n: any) => n.type === 'controller');
        expect(ids.has(controller.possessedId) && ids.has(controller.aimSourceId)).toBe(true);
        const publics = (name: string) => library('scripts').find(s => s.name === name).variables
            .filter((v: any) => v.attribute && !v.hidden && v.access === 'public').map((v: any) => v.name).sort();
        expect(publics('SandboxPlayer')).toEqual(['backDiagonalScale', 'backScale', 'enterTrigger', 'exitTrigger', 'eyeCrouch', 'eyeStand', 'runFootSpeed', 'runFootWeight', 'runTurnSpeed', 'sprintTakeoff',
            'stairDownRunSpeed', 'stairDownWalkSpeed', 'stairUpRunSpeed', 'stairUpWalkSpeed', 'stairsLayer', 'turnDelay', 'walkBackDiagonalScale', 'walkFootSpeed', 'walkScale']);
        expect(publics('SandboxCamera')).toEqual(['aimArm', 'aimShoulderOffset', 'crouchDrop', 'pivotHeight', 'shoulderArm', 'shoulderOffset', 'thirdPersonArm']);
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
        expect([gi.type, gi.position, gi.giVolume.size, gi.giVolume.probeCounts, gi.giVolume.probeInset])
            .toEqual(['giVolume', [0, 2, 0], [120, 8, 120], [20, 1, 20], 0.5]);
        // Unbaked, or baked by the editor (it bakes a volume on open): then its bake is in the project's Baked folder.
        const bake = gi.giVolume.bakeId;
        if (bake) expect(existsSync(join(PROJECT, 'Baked', `${bake}.bake`)), bake).toBe(true);
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
        // followWind is saved only when on.
        expect([ocean.type, ocean.position, ocean.waterVolume.waterType, ocean.waterVolume.followWind ?? false]).toEqual(['waterVolume', [0, -2, 0], 'ocean', false]);
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

    // ----- the weapons ------------------------------------------------------------------------------

    /** A joint's model matrix (the joints are unit scale), as posed this frame. */
    const jointMatrix = (p: ReturnType<typeof play>, base: string) => {
        const names = new Map<number, string>(rig().skin.nodeNames);
        const j = rig().skin.joints.findIndex((x: any) => (names.get(x.nodeIndex) ?? '').endsWith(':' + base));
        const bind = mat4.invert(mat4.create(), rig().skin.joints[j].inverseBindMatrix as unknown as mat4)!;
        return mat4.multiply(mat4.create(), p.animator.getFinalBoneMatrices()[j] as mat4, bind);
    };
    /** A weapon's frame in model space, as the hand holds it: the right hand's joint and its grip socket's offset. */
    const weaponFrame = (p: ReturnType<typeof play>, socket: string) => {
        const sk = rig().skin.sockets.find((x: any) => x.name === socket);
        return mat4.multiply(mat4.create(), jointMatrix(p, 'RightHand'), mat4.fromRotationTranslation(mat4.create(), sk.offset.r, sk.offset.t));
    };
    /** Where the left hand's joint is in a weapon's frame: the support hand on it. */
    const leftOnWeapon = (p: ReturnType<typeof play>, socket: string) =>
        vec3.transformMat4(vec3.create(), mat4.getTranslation(vec3.create(), jointMatrix(p, 'LeftHand')), mat4.invert(mat4.create(), weaponFrame(p, socket))!);
    /** Take out `weapon` (1 the pistol, 2 the rifle, 3 the shotgun): tap Equip until it is up. */
    const equip = (p: ReturnType<typeof play>, weapon: number) => {
        for (let k = 0; k < 4 && p.player.weapon !== weapon; k++) { input.tap('Equip'); p.run(0.7); }
        expect(p.player.weapon).toBe(weapon);
    };

    it('holds a pistol, a rifle and a shotgun by grip sockets on the right hand, each with its model and muzzle', () => {
        const stored = rig().skin;
        // The grips, and where the left hand goes on the long guns (their handguard, their pump): all on the right hand.
        const NAMES = ['Pistol Grip', 'Rifle Grip', 'Shotgun Grip', 'Rifle Support', 'Shotgun Support', 'Pistol Support'];
        expect(stored.sockets.map((x: any) => [x.name, x.bone.replace(/^.*:/, '')])).toEqual(NAMES.map(n => [n, 'RightHand']));
        expect(rig().sockets.map((x: any) => x.name)).toEqual(NAMES);
        const weapons = named('Weapons');
        // Firing Line's: its pistol, its AK-47, its SAPS-12 (lengths in metres, grip to muzzle and the rest).
        for (const [holder, model, length] of [['Pistol Grip', 'Pistol', 0.268], ['Rifle Grip', 'Rifle', 0.868], ['Shotgun Grip', 'Shotgun', 0.836]] as const) {
            const h = weapons.children.find((c: any) => c.name === holder);
            expect(h.socketAttachment).toEqual({ target: 'parent', socket: holder });
            expect(h.children.map((c: any) => c.name)).toEqual([model, 'Muzzle']);
            const asset = library('models').find((m: any) => m.name === model);
            expect(h.children[0].variables.__modelId.value).toBe(asset.id);
            // In weapon space the bore is +Z: the model sits unturned under its grip (only moved, to put its grip in
            // the fist), so the barrel is where the aim points, and the muzzle is straight ahead of the model's grip.
            const placed = h.children[0];
            expect(placed.rotation, model).toEqual([0, 0, 0]);
            const muzzle = h.children[1].position;
            expect(Math.abs(muzzle[0] - placed.position[0]), model).toBeLessThan(0.005);
            expect(muzzle[2] - placed.position[2]).toBeGreaterThan(length * 0.6);
            expect(muzzle[2] - placed.position[2]).toBeLessThan(length);
        }
        // Every copy of the sockets (the rig's skeleton, the Mannequin model, the template, the scene: the game reads
        // those) is the rig's own.
        const copies: any[][] = [];
        const walk = (v: any) => {
            if (!v || typeof v !== 'object') return;
            if (Array.isArray(v)) { v.forEach(walk); return; }
            if (Array.isArray(v.sockets) && v.sockets.some((s: any) => s?.name === 'Rifle Grip')) copies.push(v.sockets);
            for (const k of Object.keys(v)) walk(v[k]);
        };
        walk(stored);
        walk(library('models').find((m: any) => m.name === 'Mannequin'));
        walk(library('templates').find((t: any) => t.name === 'Player'));
        walk(sceneFile());
        expect(copies.length).toBeGreaterThanOrEqual(4);
        for (const list of copies) for (const s of list) expect(s.offset, s.name).toEqual(rig().sockets.find((x: any) => x.name === s.name).offset);
        // Firing Line's weapons, the same models in either view: the third person's are cut from the viewmodels'.
        const description = JSON.parse(readFileSync(join(PROJECT, 'example.json'), 'utf8')).description;
        expect(description).toMatch(/Firing Line/);
        expect(description).not.toMatch(/TastyTony/);
        for (const [model, viewmodel] of [['Pistol', 'Pistol Viewmodel'], ['Rifle', 'AK-47 Viewmodel'], ['Shotgun', 'SAPS-12 Viewmodel']]) {
            const third = library('models').find((m: any) => m.name === model), first = library('models').find((m: any) => m.name === viewmodel);
            for (const id of third.materialIds) expect(first.materialIds, `${model}: ${id}`).toContain(id);
        }
    });

    it('takes out the pistol, then the rifle, then the shotgun, then puts it away, a tap of Equip each', () => {
        const p = play(OPEN);
        p.run(0.5);
        const shown = () => ['Pistol Grip', 'Rifle Grip', 'Shotgun Grip'].map(n => (p.scene.findNode(n) as Node).visible);
        const weights = () => [p.player.pistolWeight, p.player.rifleWeight, p.player.shotgunWeight];
        expect(p.player.weapon).toBe(0);
        expect(shown()).toEqual([false, false, false]);
        input.tap('Equip');
        p.run(0.7);
        expect(p.player.weapon).toBe(1);
        expect(p.player.pistolWeight).toBe(1);
        // The body moves on the pistol's set now.
        expect(p.player.stance).toBe(1);
        expect(p.animator.currentStateName).toBe('Pistol Idle');
        expect(shown()).toEqual([true, false, false]);
        expect(p.animator.layerStateName('Pistol')).toBe('Carry');
        input.tap('Equip');
        p.run(0.9);
        expect(p.player.weapon).toBe(2);
        expect(weights()).toEqual([0, 1, 0]);
        expect(shown()).toEqual([false, true, false]);
        expect([p.player.stance, p.animator.currentStateName]).toEqual([2, 'Rifle Idle']);
        input.tap('Equip');
        p.run(0.9);
        expect(p.player.weapon).toBe(3);
        expect(weights()).toEqual([0, 0, 1]);
        expect(shown()).toEqual([false, false, true]);
        // The shotgun moves as the rifle does.
        expect([p.player.stance, p.animator.currentStateName]).toEqual([2, 'Rifle Idle']);
        expect(p.animator.layerStateName('Shotgun')).toBe('Carry');
        input.tap('Equip');
        p.run(0.7);
        expect(p.player.weapon).toBe(0);
        expect(weights()).toEqual([0, 0, 0]);
        expect(shown()).toEqual([false, false, false]);
        expect([p.player.stance, p.animator.currentStateName]).toEqual([0, 'Idle']);
    });

    it('holds its weapons in Mixamo’s hands: each set’s clips, the aim’s directions variants of its mocap aim', () => {
        const poseAssets = library('poseAssets');
        const fields = new Map(library('animationFields').map((f: any) => [f.name, f]));
        const own = new Map(library('animations').filter((a: any) => a.rigId === rig().id).map((a: any) => [a.name, a]));
        // What the generated holds were is the mocap now: no carry, sprint or long-gun reload poses, no shotgun poses.
        expect(poseAssets.map((a: any) => a.name).sort()).toEqual(['Pistol Poses', 'Rifle Poses']);
        for (const [W, kept] of [['Pistol', ['Aim', 'Reload']], ['Rifle', ['Aim']]] as const) {
            const asset = poseAssets.find((a: any) => a.name === `${W} Poses`);
            const byName = new Map<string, any>(asset.poses.map((p: any) => [p.name, p]));
            expect(asset.poses.filter((p: any) => !p.baseRef).map((p: any) => p.name)).toEqual(kept);
            // Aim: the mocap aiming idle's first frame (the Shooter pack's for the rifle, the pistol pack's idle).
            const aim = byName.get('Aim');
            const clip = own.get(W === 'Rifle' ? 'Rifle Aim' : 'Handgun Idle').clips[0];
            const names = new Map<number, string>(rig().skin.nodeNames);
            const spine = clip.channels.find((c: any) => names.get(c.targetNodeIndex)!.endsWith(':Spine1') && c.targetPath === 'rotation');
            expect(spine, W).toBeTruthy();
            expect(aim.bones.some((b: any) => b.name.endsWith(':Hips')), `${W} Aim: Hips`).toBe(true);
            // The 25 directions: only the upper spine turned (the hips are the legs' own under the aim).
            const directions = asset.poses.filter((p: any) => p.baseRef && p.name !== 'Low Ready');
            expect(directions.length).toBe(25);
            for (const d of directions) {
                expect(d.baseRef).toEqual({ assetId: asset.id, poseId: aim.id });
                for (const b of d.bones) expect(b.name, d.name).toMatch(/:Spine[12]$/);
            }
            const offset = fields.get(`${W} Aim Offset`);
            expect(offset.samples.map((x: any) => x.poseRef.poseId).sort()).toEqual(directions.map((d: any) => d.id).sort());
            // The Low Ready: a variant of Aim too, changing only the arms, the neck and the head.
            const low = byName.get('Low Ready');
            expect(low.baseRef).toEqual({ assetId: asset.id, poseId: aim.id });
            for (const b of low.bones) expect(b.name, 'Low Ready').toMatch(/:(Neck|Head|(Left|Right)(Arm|ForeArm|Hand))$/);
        }
        // The arms layers: the aiming idle carried (the Lowered layer turns it muzzle-down), the sprint's arms in step
        // with the legs, the aim and the reload clips (the pistol's reload a pose: no clip has one), Steady, the aim
        // steadier; the left hand held on OUR guns by their support sockets, the pistol's let go at a sprint.
        const layers = new Map<string, any>(machine().layers.map((l: any) => [l.name, l]));
        const state = (l: string, n: string) => layers.get(l).states.find((s: any) => s.name === n);
        for (const L of ['Rifle', 'Shotgun']) {
            expect(['Carry', 'Crouch', 'Sprint', 'Aim', 'Crouch Aim', 'Reload'].map(n => state(L, n).clipName)).toEqual(
                ['Rifle Aim', 'Rifle Aim', 'Rifle Sprint Arms', 'Rifle Aim', 'Rifle CrouchAim', 'Rifle Reload']);
            expect([state(L, 'Carry').syncGroup, state(L, 'Sprint').syncGroup]).toEqual([undefined, 'Gait']);
            expect(state(L, 'Aim').meshSpace).toBeGreaterThan(state(L, 'Carry').meshSpace);
            expect(layers.get(L).handIk).toEqual({ hand: 'left', socket: `${L} Support` });
        }
        // The Reload clip plays over each gun's reloadSeconds.
        const seconds = (clip: string) => Math.max(...own.get(clip).clips[0].samplers.map((x: any) => x.input[x.input.length - 1]));
        for (const [L, grip] of [['Rifle', 'Rifle Grip'], ['Shotgun', 'Shotgun Grip']]) {
            expect(state(L, 'Reload').speed * named(grip).scriptVars.reloadSeconds, L).toBeCloseTo(seconds('Rifle Reload'), 1);
        }
        expect(['Carry', 'Crouch', 'Sprint', 'Aim', 'Crouch Aim'].map(n => state('Pistol', n).clipName)).toEqual(
            ['Handgun Idle', 'Handgun Idle', 'Handgun Sprint', 'Handgun Idle', 'Handgun Idle']);
        expect(state('Pistol', 'Reload').poseRef).toBeTruthy();
        expect(layers.get('Pistol').handIk).toEqual({ hand: 'left', socket: 'Pistol Support', weightParam: 'SupportHand' });
        // No carry blend spaces: the arms hold the aiming idle at every gait.
        expect([fields.has('Rifle Carry'), fields.has('Pistol Carry')]).toEqual([false, false]);
        // The sprint's arms start on the right foot's plant, as the legs' sample does (its phase offset taken in).
        const sprintSeconds = (n: string) => Math.max(...own.get(n).clips[0].samplers.map((x: any) => x.input[x.input.length - 1]));
        const phase = fields.get('Rifle Locomotion').samples.find((x: any) => x.clipName === 'Rifle SprintF').phaseOffset ?? 0;
        const spineAt = (n: string, t: number) => {
            const c = own.get(n).clips[0];
            const ch = c.channels.find((x: any) => (rig().skin.nodeNames as [number, string][]).find(([i]) => i === x.targetNodeIndex)?.[1].endsWith(':Spine2') && x.targetPath === 'rotation');
            const s = c.samplers[ch.samplerIndex];
            let k = 0;
            while (k < s.input.length - 2 && s.input[k + 1] <= t) k++;
            return s.output.slice(k * 4, k * 4 + 4);
        };
        const apart = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;
        expect(apart(spineAt('Rifle Sprint Arms', 0), spineAt('Rifle SprintF', phase * sprintSeconds('Rifle SprintF')))).toBeLessThan(3);
        // The Mannequin's pistol clips are 'Handgun ...': Firing Line's viewmodel clips (on their own rigs) are 'Pistol ...'.
        expect([...own.keys()].some(n => /^Pistol /.test(n))).toBe(false);
        expect(library('animations').filter((a: any) => /^Pistol /.test(a.name)).every((a: any) => a.rigId !== rig().id)).toBe(true);
    });

    it('follows an edit to a pose: Aim moves every aim direction with it, a direction moves only itself', () => {
        const poseAssets = library('poseAssets');
        const rifle = poseAssets.find((a: any) => a.name === 'Rifle Poses');
        const aim = rifle.poses.find((p: any) => p.name === 'Aim');
        const up = rifle.poses.find((p: any) => p.name === 'Aim Up 30');
        const sm = machine();
        const offset = (m: any) => m.layers.find((l: any) => l.name === 'Rifle Aim').states[0].field;
        const chestOf = (bones: any[]) => bones.find((b: any) => b.name.endsWith(':Spine2')).rotation;
        const directionChest = (m: any, poseId: string) => chestOf(resolveTablePose(offset(m).poses[poseSampleKey(poseId)], offset(m).poses).bones);
        const degrees = (a: number[], b: number[]) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]))) * DEG;
        const nudge = quat.setAxisAngle(quat.create(), [0, 1, 0], 10 / DEG);

        // Turn Aim's chest 10 degrees more: every direction's chest turns with it, each still what it was relative to Aim.
        const turned = JSON.parse(JSON.stringify(poseAssets));
        const chest = turned.find((a: any) => a.id === rifle.id).poses.find((p: any) => p.id === aim.id).bones.find((b: any) => b.name.endsWith(':Spine2'));
        chest.rotation = Array.from(quat.normalize(quat.create(), quat.multiply(quat.create(), nudge, chest.rotation)));
        const next = reembedPoses(sm, turned)!;
        expect(next).toBeTruthy();
        for (const d of rifle.poses.filter((p: any) => p.baseRef && p.name !== 'Low Ready')) {
            expect(degrees(directionChest(next, d.id), directionChest(sm, d.id)), d.name).toBeCloseTo(10, 2);
            expect(offset(next).poses[poseSampleKey(d.id)]).toEqual(offset(sm).poses[poseSampleKey(d.id)]);
        }

        // Turn one direction instead (the head of Aim Up 30): only its entry changes.
        const one = JSON.parse(JSON.stringify(poseAssets));
        const u = one.find((a: any) => a.id === rifle.id).poses.find((p: any) => p.id === up.id);
        u.bones = [...u.bones, { name: chest.name.replace('Spine2', 'Head'), rotation: Array.from(nudge) }];
        const only = reembedPoses(sm, one)!;
        const changed = Object.keys(offset(sm).poses).filter(k => JSON.stringify(offset(sm).poses[k]) !== JSON.stringify(offset(only).poses[k]));
        expect(changed).toEqual([poseSampleKey(up.id)]);

        // And a character aiming up shows a direction's edit at once, mid-aim, without restarting anything: its chest
        // turned 10 degrees more puts the bore off where it was.
        const tilted = JSON.parse(JSON.stringify(poseAssets));
        const t = tilted.find((a: any) => a.id === rifle.id).poses.find((p: any) => p.id === up.id);
        for (const b of t.bones) b.rotation = Array.from(quat.normalize(quat.create(), quat.multiply(quat.create(), nudge, b.rotation)));
        const edited = reembedPoses(sm, tilted)!;
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 2);
        input.press('Aim');
        p.rigs[0].setOrbit(p.rigs[0].yaw, -30);
        p.run(0.8);
        const model = (p.scene.findNode('Mannequin') as any);
        const bore = () => {
            const m = mat4.multiply(mat4.create(), model.worldTransform as mat4, weaponFrame(p, 'Rifle Grip'));
            return vec3.normalize(vec3.create(), vec3.sub(vec3.create(), vec3.transformMat4(vec3.create(), [0, 0, 1], m), mat4.getTranslation(vec3.create(), m)));
        };
        const before = bore();
        expect(p.animator.updateStateMachine(edited)).toBe(true);
        expect(p.animator.layerStateName('Rifle')).toBe('Aim');
        p.run(0.05);
        expect(Math.acos(Math.min(1, vec3.dot(before, bore()))) * DEG).toBeGreaterThan(5);
        input.release('Aim');
    });

    it('keeps an aimed rifle’s chest steady over the stride, where carried it sways with it', () => {
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 2);
        const chest = () => { const r = quat.create(); mat4.getRotation(r, jointMatrix(p, 'Spine2')); return quat.normalize(r, r); };
        const spread = () => {
            const turns: quat[] = [];
            p.run(1.2, () => turns.push(chest()));
            let worst = 0;
            for (const a of turns) for (const b of turns) worst = Math.max(worst, 2 * Math.acos(Math.min(1, Math.abs(quat.dot(a, b)))) * DEG);
            return worst;
        };
        input.setMove(0, 1);
        p.run(1.2);
        const carried = spread();
        input.press('Aim');
        p.run(1.2);
        const aimed = spread();
        input.release('Aim'); input.setMove(0, 0);
        console.log(`chest sway over the stride: carried ${carried.toFixed(1)}, aimed ${aimed.toFixed(1)} degrees`);
        expect(aimed).toBeLessThan(CHEST_SWAY_AIMED);
        expect(carried).toBeGreaterThan(aimed);
    });

    it('keeps both hands on the weapon standing, walking, jogging and sprinting', () => {
        for (const [weapon, socket, gaits] of [[2, 'Rifle Grip', ['walk', 'jog', 'sprint']], [1, 'Pistol Grip', ['walk', 'jog']]] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            p.run(0.5);
            const rest = leftOnWeapon(p, socket);
            if (weapon === 2) {
                // On the handguard: ahead of the grip, under the bore.
                expect(rest[2], 'ahead of the grip').toBeGreaterThan(0.1);
                expect(Math.abs(rest[0]), 'under it').toBeLessThan(0.15);
            } else expect(vec3.length(rest), 'round the grip (the wrist joint, a hand back from the fist)').toBeLessThan(0.15);
            for (const gait of gaits) {
                if (gait === 'walk') input.press('Walk'); else input.release('Walk');
                if (gait === 'sprint') input.press('Sprint'); else input.release('Sprint');
                input.setMove(0, 1);
                p.run(1.2);
                let worst = 0;
                p.run(1.2, () => { worst = Math.max(worst, vec3.distance(leftOnWeapon(p, socket), rest)); });
                expect(worst, `${socket} ${gait}: the left hand strays ${(worst * 100).toFixed(1)} cm off the weapon`).toBeLessThan(0.02);
            }
            input.release('Walk'); input.release('Sprint'); input.setMove(0, 0);
        }
    });

    it('keeps the rifle in both hands, aimed, up a flight of stairs and turning on the spot', () => {
        // One held pose over the climb: Steady keeps the chest the pose's whatever the hips do on the steps, and the
        // hand IK keeps the left hand where the pose has it.
        const f = FLIGHTS[1];
        const p = play([f.x, 0.02, STAIRS_Z - 3]);
        p.run(0.5);
        equip(p, 2);
        input.press('Aim');
        p.run(0.8);
        const rest = leftOnWeapon(p, 'Rifle Grip');
        let worst = 0, climbed = 0;
        input.setMove(0, 1);
        p.run(5, () => {
            worst = Math.max(worst, vec3.distance(leftOnWeapon(p, 'Rifle Grip'), rest));
            if (p.animator.currentStateName === 'Stairs') climbed++;
        });
        input.setMove(0, 0);
        expect(climbed, 'it climbed').toBeGreaterThan(30);
        expect(worst, `the left hand strays ${(worst * 100).toFixed(1)} cm off the rifle on the flight`).toBeLessThan(0.02);
        // Turning in place (the camera swung round while aimed): the body turns under the hold.
        const start = p.yawOf(p.player);
        worst = 0;
        p.rigs[0].setOrbit(start + 90, 0);
        p.run(1.5, () => { worst = Math.max(worst, vec3.distance(leftOnWeapon(p, 'Rifle Grip'), rest)); });
        expect(worst, `the left hand strays ${(worst * 100).toFixed(1)} cm off the rifle turning`).toBeLessThan(0.02);
        input.release('Aim');
    });

    it('holds each weapon with natural arms: wrists nearly straight, elbows below the shoulders', () => {
        // The grips were once read off the wrong line through the rifle pack's hand: every hold then twisted the hands
        // to make up for it, the wrists bent 90 to 130 degrees and the elbows splayed up and out.
        const at = (p: ReturnType<typeof play>, base: string) => mat4.getTranslation(vec3.create(), jointMatrix(p, base));
        /** Degrees between the forearm and the hand (wrist to the middle finger's base). */
        const bend = (p: ReturnType<typeof play>, side: string) => {
            const e = at(p, side + 'ForeArm'), w = at(p, side + 'Hand'), m = at(p, side + 'HandMiddle1');
            const f = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), w, e)), h = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), m, w));
            return Math.acos(Math.min(1, vec3.dot(f, h))) * DEG;
        };
        for (const weapon of [1, 2]) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            for (const [aim, move] of [[false, 0], [true, 0], [false, 1], [true, 1]] as const) {
                if (aim) input.press('Aim'); else input.release('Aim');
                input.setMove(0, move);
                p.run(1);
                let worst = 0, high = -1;
                p.run(0.6, () => {
                    for (const side of ['Right', 'Left']) {
                        worst = Math.max(worst, bend(p, side));
                        high = Math.max(high, at(p, side + 'ForeArm')[1] - at(p, side + 'Arm')[1]);
                    }
                });
                const what = `weapon ${weapon}${aim ? ' aimed' : ''}${move ? ' jogging' : ''}`;
                // The pistol pack's two-handed grip cups the support wrist round the gun hand (48 degrees in its clips, a
                // little more jogging). The rifle at the low ready holds its handguard from below with the muzzle down:
                // the support wrist bent 39 degrees standing (the least any elbow gives), a few more at a jog, where the
                // carried chest sways under the steadied arms.
                const limit = weapon === 1 ? 56 : !aim && move ? 46 : 40;
                expect(worst, `${what}: a wrist bends ${worst.toFixed(0)} degrees`).toBeLessThan(limit);
                expect(high, `${what}: an elbow ${(high * 100).toFixed(0)} cm above its shoulder`).toBeLessThan(0.02);
            }
            input.release('Aim'); input.setMove(0, 0);
        }
    });

    it('aims where the camera looks, standing and walking', () => {
        for (const [weapon, socket] of [[2, 'Rifle Grip'], [1, 'Pistol Grip']] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            input.press('Aim');
            p.run(0.5);
            expect(p.player.aiming).toBe(true);
            expect(p.animator.layerStateName(weapon === 2 ? 'Rifle' : 'Pistol')).toBe('Aim');
            const model = p.scene.findNode('Mannequin') as Node;
            /** Degrees between the bore and the camera's aim. */
            const off = () => {
                const m = mat4.multiply(mat4.create(), model.worldTransform as mat4, weaponFrame(p, socket));
                const bore = vec3.sub(vec3.create(), vec3.transformMat4(vec3.create(), [0, 0, 1], m), mat4.getTranslation(vec3.create(), m));
                vec3.normalize(bore, bore);
                const yaw = p.rigs[0].yaw / DEG, pitch = p.rigs[0].pitch / DEG;
                const aim = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
                return Math.acos(Math.min(1, vec3.dot(bore, aim as any))) * DEG;
            };
            const start = p.yawOf(p.player);
            for (const [move, limit] of [[0, 4], [1, 6]] as const) {
                input.setMove(0, move);
                for (const [yaw, pitch] of [[0, 0], [0, -35], [0, 30], [25, 10], [-25, -15], [40, 0]]) {
                    p.rigs[0].setOrbit(start + yaw, pitch);
                    p.run(0.8);
                    let worst = 0;
                    p.run(0.4, () => { worst = Math.max(worst, off()); });
                    expect(worst, `weapon ${weapon} ${move ? 'walking' : 'standing'} at ${yaw}, ${pitch}: the bore ${worst.toFixed(1)} degrees off the aim`).toBeLessThan(limit);
                }
                input.setMove(0, 0);
            }
            // Aiming faces the camera, and the camera comes in over the shoulder.
            expect(Math.abs(wrap(p.yawOf(p.player) - p.rigs[0].yaw))).toBeLessThan(20);
            const aimArm = library('scripts').find(x => x.name === 'SandboxCamera').variables.find((v: any) => v.name === 'aimArm').default;
            expect(p.rigs[0].armLength).toBeCloseTo(aimArm, 2);
            input.release('Aim');
            p.run(0.5);
            expect(p.player.aiming).toBe(false);
            expect(p.player.rifleAimWeight + p.player.pistolAimWeight).toBe(0);
        }
    });

    it('lowers the weapon to sprint, the arms on the set’s sprint', () => {
        for (const [weapon, layer, state, legs] of [[1, 'Pistol', 'Pistol Locomotion', 'SprintF'], [2, 'Rifle', 'Rifle Locomotion', 'Rifle SprintF']] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            input.press('Aim');
            input.press('Sprint');
            input.setMove(0, 1);
            p.run(2);
            expect(p.player.sprinting).toBe(true);
            expect(p.player.aiming).toBe(false);
            expect(p.animator.currentStateName).toBe(state);
            // The arms on the sprint's (the pistol one-handed, its left hand let go), no low ready over them.
            expect(p.animator.layerStateName(layer)).toBe('Sprint');
            expect(p.animator.layerStateName('Lowered')).toBe('Off');
            // (SupportHand: only the Pistol layer's hand IK reads it; the long guns keep both hands on.)
            expect(p.player.supportHand, layer).toBe(0);
            // The legs: with the pistol on the unarmed sprint (the pistol pack has none), with the long guns on the
            // rifle pack's.
            const sprint = (p.animator.activeFieldWeights ?? []).filter((w: any) => w.clipName === legs).reduce((a: number, w: any) => a + w.weight, 0);
            expect(sprint, `${layer}: ${legs} plays`).toBeGreaterThan(0.85);
            input.release('Sprint'); input.release('Aim'); input.setMove(0, 0);
            p.run(1);
            expect([p.animator.layerStateName(layer), p.player.supportHand]).toEqual(['Carry', 1]);
        }
    });

    /** The bore of the weapon in the hands, in the world: the right hand's grip socket's +Z. */
    const boreOf = (p: ReturnType<typeof play>, socket: string) => {
        const model = p.scene.findNode('Mannequin') as Node;
        const m = mat4.multiply(mat4.create(), model.worldTransform as mat4, weaponFrame(p, socket));
        return vec3.normalize(vec3.create(), vec3.sub(vec3.create(), vec3.transformMat4(vec3.create(), [0, 0, 1], m), mat4.getTranslation(vec3.create(), m)));
    };
    const pitchOf = (b: vec3) => Math.asin(b[1]) * DEG;

    it('holds the weapon at the low ready unless it aims: the aim’s own hold turned muzzle-down, lifted the moment it aims', () => {
        for (const [weapon, grip, set] of [[1, 'Pistol Grip', 'Pistol'], [2, 'Rifle Grip', 'Rifle'], [3, 'Shotgun Grip', 'Rifle']] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            p.run(0.6);
            expect(p.animator.layerStateName('Lowered'), `weapon ${weapon}`).toBe(set);
            expect(p.player.loweredWeight).toBeCloseTo(1, 2);
            const held = leftOnWeapon(p, grip);
            // Standing, walking, jogging and crouched: the muzzle at the ground, both hands on the weapon.
            const ways: [string, () => void][] = [
                ['standing', () => {}],
                ['walking', () => { input.press('Walk'); input.setMove(0, 1); }],
                ['jogging', () => { input.release('Walk'); input.setMove(0, 1); }],
                ['crouched', () => { input.setMove(0, 0); input.tap('Crouch'); }],
            ];
            for (const [what, go] of ways) {
                go();
                p.run(1.2);
                let highest = -90, stray = 0;
                p.run(0.8, () => {
                    highest = Math.max(highest, pitchOf(boreOf(p, grip)));
                    stray = Math.max(stray, vec3.distance(leftOnWeapon(p, grip), held));
                });
                expect(highest, `weapon ${weapon} ${what}: the muzzle at ${highest.toFixed(0)} degrees`).toBeLessThan(-25);
                expect(stray, `weapon ${weapon} ${what}: the left hand ${(stray * 100).toFixed(1)} cm off its hold`).toBeLessThan(0.02);
            }
            input.tap('Crouch');
            p.run(1.2);
            // Aim: up it comes on the very hold it was lowered from, onto the camera's line in a quarter of a second.
            input.press('Aim');
            p.run(0.25);
            expect(p.player.loweredWeight).toBe(0);
            const yaw = p.rigs[0].yaw / DEG, pitch = p.rigs[0].pitch / DEG;
            const aim = [Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
            const off = Math.acos(Math.min(1, vec3.dot(boreOf(p, grip), aim as any))) * DEG;
            expect(off, `weapon ${weapon}: the bore ${off.toFixed(1)} degrees off the aim 0.25 s after Aim`).toBeLessThan(6);
            input.release('Aim');
            p.run(0.5);
            expect(pitchOf(boreOf(p, grip)), `weapon ${weapon}: down again`).toBeLessThan(-25);
        }
    });

    /** A joint's position in model space, as posed this frame. */
    const jointAt = (p: ReturnType<typeof play>, base: string) => mat4.getTranslation(vec3.create(), jointMatrix(p, base));

    it('hangs the pistol’s right elbow at the low ready, the elbow bending on the hinge it bends on aiming', () => {
        // The elbow where the wrist bends least lay across the chest; raised off it, the arm twisted up and out.
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 1);
        p.run(1.2);
        expect(p.player.loweredWeight).toBeCloseTo(1, 2);
        /** The axis the right elbow bends about, in the upper arm's own frame: cross(upper arm, forearm). */
        const hinge = () => {
            const u = vec3.sub(vec3.create(), jointAt(p, 'RightForeArm'), jointAt(p, 'RightArm'));
            const f = vec3.sub(vec3.create(), jointAt(p, 'RightHand'), jointAt(p, 'RightForeArm'));
            const n = vec3.normalize(vec3.create(), vec3.cross(vec3.create(), u, f));
            const upper = mat3.fromMat4(mat3.create(), jointMatrix(p, 'RightArm'));
            return vec3.normalize(vec3.create(), vec3.transformMat3(vec3.create(), n, mat3.transpose(mat3.create(), upper)));
        };
        let highest = -1, lowered = hinge();
        p.run(0.6, () => { highest = Math.max(highest, jointAt(p, 'RightForeArm')[1] - jointAt(p, 'RightArm')[1]); lowered = hinge(); });
        expect(-highest, `the right elbow ${(-highest * 100).toFixed(1)} cm below the shoulder`).toBeGreaterThan(0.18);
        input.press('Aim');
        p.run(0.8);
        const aimed = hinge();
        input.release('Aim');
        const off = Math.acos(Math.min(1, vec3.dot(lowered, aimed))) * DEG;
        expect(off, `the lowered elbow bends ${off.toFixed(1)} degrees off the aimed elbow's hinge`).toBeLessThan(12);
    });

    it('keeps the support arm steady as the view swings and the body strafes from side to side, the elbow never through the chest', () => {
        // The pistol's layer once held the right arm alone: its left arm was the body's, whatever played under it (a
        // strafe, a walk turned round, a turn in place), the low ready's difference thrown onto it and the hand IK's
        // bend plane with it, so the elbow snapped across, through the chest (6.6 cm in a frame, walking round).
        /** The left elbow in the chest's own frame (Spine2's): where the arm is on the body, whatever the body does. */
        const onChest = (p: ReturnType<typeof play>) => vec3.transformMat4(vec3.create(), jointAt(p, 'LeftForeArm'), mat4.invert(mat4.create(), jointMatrix(p, 'Spine2'))!);
        /** The left elbow's distance from the torso's axis (Spine1 to Neck), model space. */
        const fromTorso = (p: ReturnType<typeof play>) => {
            const a = jointAt(p, 'Spine1'), b = jointAt(p, 'Neck'), e = jointAt(p, 'LeftForeArm');
            const ab = vec3.sub(vec3.create(), b, a);
            const t = Math.max(0, Math.min(1, vec3.dot(vec3.sub(vec3.create(), e, a), ab) / vec3.squaredLength(ab)));
            return vec3.distance(e, vec3.scaleAndAdd(vec3.create(), a, ab, t));
        };
        for (const [weapon, layer] of [[1, 'Pistol'], [2, 'Rifle'], [3, 'Shotgun']] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            p.run(1.2);
            for (const aimed of [false, true]) {
                if (aimed) { input.press('Aim'); p.run(0.6); }
                const steady = fromTorso(p);
                // The pistol's low ready holds its left elbow out off the belly (it was 11.6 cm from the torso's axis).
                if (weapon === 1 && !aimed) expect(steady, `the pistol's lowered left elbow ${(steady * 100).toFixed(1)} cm from the torso's axis`).toBeGreaterThan(0.15);
                let prev = onChest(p), jump = 0, closest = steady, at = '', near = '';
                const watch = (what: string) => () => {
                    const e = onChest(p);
                    const where = `${what}: ${p.animator.currentStateName} / ${p.animator.layerStateName(layer)}`;
                    const d = vec3.distance(e, prev);
                    if (d > jump) { jump = d; at = where; }
                    const t = fromTorso(p);
                    if (t < closest) { closest = t; near = where; }
                    prev = e;
                };
                // The view round to 100 degrees on the body's left, across to 100 on its right, and back: past the turn
                // in place both ways while it aims.
                const start = p.yawOf(p.player);
                for (const [from, to] of [[0, 100], [100, -100], [-100, 0]]) {
                    const seconds = Math.abs(to - from) / 100, frames = Math.round(seconds / FRAME);
                    let k = 0;
                    const look = watch(`view ${from} to ${to}`);
                    p.run(seconds, () => { p.rigs[0].setOrbit(start + from + (to - from) * Math.min(1, ++k / frames), 5); look(); });
                }
                // Strafing left and right, walking and jogging, the diagonals, back and forward again.
                for (const walk of [true, false]) {
                    if (walk) input.press('Walk'); else input.release('Walk');
                    for (const [x, y] of [[-1, 0], [1, 0], [-1, 0], [-0.7, 0.7], [0.7, 0.7], [-0.7, -0.7], [0.7, -0.7], [0, -1], [0, 1]]) {
                        input.setMove(x, y);
                        p.run(0.9, watch(`${walk ? 'walking' : 'jogging'} ${x}, ${y}`));
                    }
                }
                input.setMove(0, 0); input.release('Walk');
                p.run(1);
                const what = `weapon ${weapon}${aimed ? ' aimed' : ''}`;
                expect(jump, `${what}: the left elbow jumps ${(jump * 100).toFixed(1)} cm on the chest in a frame (${at})`).toBeLessThan(0.025);
                expect(steady - closest, `${what}: the left elbow ${(closest * 100).toFixed(1)} cm from the torso's axis, ${(steady * 100).toFixed(1)} held still (${near})`).toBeLessThan(0.02);
            }
            input.release('Aim');
        }
    });

    it('holds the rifle by its pistol grip: the right fist round the grip, carried and aimed', () => {
        // The AK's grip sits further behind its trigger than the motion capture's rifle's: the rifle is moved forward in
        // the hand (the Rifle node) and the aiming holds' hand back, so the grip is in the fist and the aimed rifle where
        // it was. The grip's centre line in the model's space, measured off its mesh at two heights:
        const top = vec3.fromValues(0, 0.013, 0.0161), bottom = vec3.fromValues(0, -0.02, 0.0062);
        const placed = named('Rifle Grip').children.find((c: any) => c.name === 'Rifle');
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 2);
        /** The centre of the circle through three points: a curled finger's joints wrap round it. */
        const circle = (a: vec3, b: vec3, c: vec3) => {
            const ab = vec3.sub(vec3.create(), b, a), ac = vec3.sub(vec3.create(), c, a), n = vec3.cross(vec3.create(), ab, ac);
            const t1 = vec3.scale(vec3.create(), vec3.cross(vec3.create(), n, ab), vec3.squaredLength(ac));
            const t2 = vec3.scale(vec3.create(), vec3.cross(vec3.create(), ac, n), vec3.squaredLength(ab));
            return vec3.add(vec3.create(), a, vec3.scale(vec3.create(), vec3.add(vec3.create(), t1, t2), 1 / (2 * vec3.squaredLength(n))));
        };
        /** The middle and ring fingers' curl centres in the rifle model's space. */
        const fist = () => {
            const model = mat4.multiply(mat4.create(), weaponFrame(p, 'Rifle Grip'), mat4.fromTranslation(mat4.create(), placed.position));
            const inv = mat4.invert(mat4.create(), model)!;
            return ['Middle', 'Ring'].map(f => vec3.transformMat4(vec3.create(), circle(jointAt(p, `RightHand${f}1`), jointAt(p, `RightHand${f}2`), jointAt(p, `RightHand${f}3`)), inv));
        };
        const axis = vec3.normalize(vec3.create(), vec3.sub(vec3.create(), top, bottom));
        const offLine = (c: vec3) => { const d = vec3.sub(vec3.create(), c, bottom); return vec3.length(vec3.scaleAndAdd(vec3.create(), d, axis, -vec3.dot(d, axis))); };
        for (const [what, aim] of [['carried', false], ['aimed', true]] as const) {
            if (aim) input.press('Aim');
            p.run(0.8);
            let worst = 0;
            p.run(0.4, () => { for (const c of fist()) { worst = Math.max(worst, offLine(c)); expect(c[1], `${what}: the fist on the grip's height`).toBeGreaterThan(-0.035); expect(c[1]).toBeLessThan(0.03); } });
            expect(worst, `${what}: the fist ${(worst * 100).toFixed(1)} cm off the grip's centre line`).toBeLessThan(0.012);
        }
        input.release('Aim');
    });

    it('zooms in and blurs everything but the target while Aim is held in third person, not for a shot from the hip', () => {
        const written: any[] = [];
        const spy = vi.spyOn(Game, 'updateRenderSettings').mockImplementation((s: any) => { written.push(s); });
        try {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, 2);
            const rig = p.rigs[0] as any;
            const camera = (n: string) => library('scripts').find(x => x.name === 'SandboxCamera').variables.find((v: any) => v.name === n).default;
            const hipFov = camera('thirdPersonFov'), aimFov = camera('aimFov');
            expect(aimFov).toBeLessThan(hipFov);
            expect(rig.fov).toBeCloseTo(hipFov, 1);
            // A shot from the hip brings the gun up, and nothing else: the lens stays, nothing blurs.
            input.press('Fire');
            p.run(0.3);
            input.release('Fire');
            expect(p.player.aiming).toBe(true);
            expect(p.player.aimingDown).toBe(false);
            expect(rig.fov).toBeCloseTo(hipFov, 1);
            expect(written.some(s => s.dofEnabled)).toBe(false);
            p.run(1.5);
            // Aim held: the lens narrows (the mouse slowed as much), and a hard depth of field comes on, focused where
            // the crosshair is, nothing nearer kept sharp.
            input.press('Aim');
            p.run(0.6);
            expect(p.player.aimingDown).toBe(true);
            expect(rig.fov).toBeCloseTo(aimFov, 1);
            const half = (d: number) => Math.tan(d * Math.PI / 360);
            expect(rig.zoomSensitivity).toBeCloseTo(half(aimFov) / half(hipFov), 3);
            const on = written.filter(s => s.dofEnabled).at(-1);
            expect(on).toBeTruthy();
            expect(on.dofNearCutoff).toBe(0);
            expect(on.dofAperture).toBeLessThan(2);
            expect(on.dofMaxBlur).toBeGreaterThan(20);
            expect(on.dofFocusDistance).toBeGreaterThan(1.4);
            input.release('Aim');
            p.run(0.6);
            expect(rig.fov).toBeCloseTo(hipFov, 1);
            expect(rig.zoomSensitivity).toBeCloseTo(1, 3);
            expect(written.at(-1).dofEnabled).toBe(false);
        } finally { spy.mockRestore(); }
    });

    for (const [weapon, set] of [[2, 'Rifle'], [1, 'Pistol']] as const) {
        it(`walks and jogs in eight directions on the ${set.toLowerCase()}'s own clips, facing the camera, its feet holding`, () => {
            const jog = named('Player').walkSpeed;
            const walk = jog * named('Player').scriptVars.walkScale;
            const lines: string[] = [];
            for (const gait of ['walk', 'jog'] as const) for (const [name, x, y, dir] of DIRECTIONS) {
                const p = play(OPEN);
                p.run(0.5);
                equip(p, weapon);
                p.run(0.3);
                if (gait === 'walk') input.press('Walk');
                input.setMove(x, y);
                p.run(1.5);
                const slide = footSlide(p, 1.5);
                const speed = p.player.planarSpeed;
                expect(p.animator.currentStateName, `${set} ${gait} ${name}`).toBe(`${set} Locomotion`);
                expect(Math.abs(wrap(p.player.moveDir - dir)), `${set} ${gait} ${name} moveDir ${p.player.moveDir}`).toBeLessThan(12);
                const nominal = gait === 'walk' ? walk : jog;
                expect(speed, `${set} ${gait} ${name}`).toBeLessThanOrEqual(nominal * 1.03);
                expect(speed, `${set} ${gait} ${name}`).toBeGreaterThan(nominal * 0.4);
                lines.push(`${set} ${gait} ${name}: ${speed.toFixed(2)} m/s, foot slide ${slide.toFixed(2)} m/s`);
                // As unarmed: within 8% of the travel on the cardinal directions, 15% on the diagonals.
                const limit = name.includes('-') ? Math.max(0.35, speed * 0.15) : Math.max(0.15, speed * 0.08);
                expect(slide, `${set} ${gait} ${name}: foot slide at ${speed.toFixed(2)} m/s`).toBeLessThan(limit);
                input.setMove(0, 0);
                input.release('Walk');
                p.run(1.2);
                expect(p.animator.currentStateName, `${set} ${gait} ${name} at rest`).toBe(`${set} Idle`);
            }
            console.log(lines.join('\n'));
        });
    }

    it('changes stance with the weapon in step: a weapon coming up mid-stride carries the stride across', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.setMove(0, 1);
        p.run(1.5);
        expect(p.animator.currentStateName).toBe('Locomotion');
        for (const [taps, to] of [[1, 'Pistol Locomotion'], [1, 'Rifle Locomotion'], [2, 'Locomotion']] as const) {
            const from = p.animator.currentStateName;
            for (let k = 0; k < taps; k++) { input.tap('Equip'); p.run(0.12); }
            const seen = new Set<string>();
            const slide = footSlide(p, 1.6, undefined, () => seen.add(p.animator.currentStateName));
            // Straight across, never through a stop or a stand (the shotgun on the way back down is the rifle's set).
            expect([...seen].every(n => /Locomotion$/.test(n)), `${from} -> ${to}: ${[...seen]}`).toBe(true);
            expect(p.animator.currentStateName).toBe(to);
            expect(slide, `${from} -> ${to}: foot slide`).toBeLessThan(0.35);
        }
        input.setMove(0, 0);
    });

    it('takes each shot’s recoil on the body, and reloads on the Shooter pack’s clip', () => {
        withEffects();
        try {
            for (const [weapon, layer, kick] of [[2, 'Rifle', 'Rifle Fire'], [1, 'Pistol', 'Pistol Fire'], [3, 'Shotgun', 'Shotgun Fire']] as const) {
                const p = play(OPEN);
                p.run(0.5);
                equip(p, weapon);
                input.press('Aim');
                p.run(0.5);
                const seen = new Set<string>();
                input.tap('Fire');
                p.run(0.3, () => seen.add(p.animator.layerStateName('Recoil') ?? ''));
                expect(seen.has(kick), `${layer}: ${[...seen]}`).toBe(true);
                p.run(1.2);
                expect(p.animator.layerStateName('Recoil')).not.toBe(kick);
                input.release('Aim');
                p.run(0.4);
                input.tap('Reload');
                p.run(0.3);
                expect(p.player.reloading, layer).toBe(true);
                expect(p.animator.layerStateName(layer)).toBe('Reload');
            }
        } finally { clearTemplates(); }
    });

    it('stands up from an unarmed crouch through Crouch To Stand, and kneels down and gets up with the pistol', () => {
        const p = play(OPEN);
        p.run(0.5);
        const through = (seconds: number) => { const seen = new Set<string>(); p.run(seconds, () => seen.add(p.animator.currentStateName)); return seen; };
        input.tap('Crouch');
        p.run(0.8);
        expect(p.animator.currentStateName).toBe('Crouch');
        input.tap('Crouch');
        expect(through(1.4).has('CrouchStand')).toBe(true);
        expect(p.animator.currentStateName).toBe('Idle');
        equip(p, 1);
        p.run(0.4);
        input.tap('Crouch');
        expect(through(1.2).has('Pistol KneelDown')).toBe(true);
        expect(p.animator.currentStateName).toBe('Pistol Crouch');
        input.tap('Crouch');
        expect(through(1.4).has('Pistol KneelUp')).toBe(true);
        expect(p.animator.currentStateName).toBe('Pistol Idle');
        // On the move, a crouch is a cross-fade: no kneeling down mid-stride.
        input.setMove(0, 1);
        p.run(1);
        input.tap('Crouch');
        const moving = through(0.8);
        expect(moving.has('Pistol KneelDown')).toBe(false);
        expect(p.animator.currentStateName).toBe('Pistol Crouch');
        input.setMove(0, 0);
    });

    it('moves exactly as it did unarmed while no weapon is out', () => {
        const pose = (strip: boolean) => {
            const p = play(OPEN, {}, {}, undefined, strip ? (sm: any) => { sm.layers = sm.layers.filter((l: any) => !/^(Pistol|Rifle)/.test(l.name)); } : undefined);
            input.setMove(0.3, 1);
            p.run(2);
            input.setMove(0, 0);
            p.run(0.5);
            return ['Hips', 'Spine2', 'Head', 'LeftHand', 'RightHand', 'LeftFoot', 'RightToeBase'].map(b => Array.from(p.jointModel(b)));
        };
        const armed = pose(false), bare = pose(true);
        armed.forEach((v, k) => v.forEach((x, a) => expect(x).toBeCloseTo(bare[k][a], 6)));
    });

    // ----- shooting ---------------------------------------------------------------------------------

    /** The guns' effect templates, registered for `scene.instantiate` (models plain nodes: there is no GPU here). */
    const withEffects = () => registerTemplates(library('templates')
        .filter((t: any) => ['Muzzle Flash', 'Bullet Impact', 'Bullet Hole', 'Tracer'].includes(t.name))
        .map((t: any) => ({ id: t.id, name: t.name, node: withoutModels(t.nodeJson) })));

    /** Turn the camera so the crosshair (the middle of its view) looks at `target`, from wherever the camera is. */
    const aimCamera = (p: ReturnType<typeof play>, target: ArrayLike<number>) => {
        for (let k = 0; k < 6; k++) {
            const cam = (p.rigs[0].children.find((c: any) => c.nodeType === 'camera') ?? p.rigs[0]) as Node;
            const e = cam.worldPosition;
            const d = [target[0] - e[0], target[1] - e[1], target[2] - e[2]];
            p.rigs[0].setOrbit(Math.atan2(d[0], d[2]) * DEG, -Math.atan2(d[1], Math.hypot(d[0], d[2])) * DEG);
            p.run(0.15);
        }
    };
    const gunOf = (p: ReturnType<typeof play>, holder: string) => p.scene.findNode(holder) as any;

    it('holds a gun on each weapon, and an effect template for each part of a shot', () => {
        const templates = new Map(library('templates').map((t: any) => [t.name, t]));
        const scriptName = (n: any) => library('scripts').find((x: any) => x.id === n.variables?.__scriptId?.value)?.name;
        expect(scriptName(templates.get('Muzzle Flash').nodeJson)).toBe('SandboxShotFx');
        expect(scriptName(templates.get('Bullet Impact').nodeJson)).toBe('SandboxShotFx');
        expect(scriptName(templates.get('Bullet Hole').nodeJson)).toBe('SandboxBulletHole');
        expect(scriptName(templates.get('Tracer').nodeJson)).toBe('SandboxTracer');
        expect(allNodes(templates.get('Bullet Hole').nodeJson).some((n: any) => n.type === 'decal')).toBe(true);
        expect(allNodes(templates.get('Muzzle Flash').nodeJson).map((n: any) => n.type)).toEqual(['node', 'particleSystem', 'particleSystem', 'light']);
        // The glows take a tenth of the camera's exposure (the Sandbox goes from day to night); the smoke and dust all of it.
        for (const name of ['Muzzle Flash', 'Bullet Impact']) {
            const systems = allNodes(templates.get(name).nodeJson).filter((n: any) => n.type === 'particleSystem');
            expect(systems.map((n: any) => [n.name, n.particleSystem.exposureWeight ?? 1]), name)
                .toEqual(name === 'Muzzle Flash' ? [['Flash', 0.1], ['Smoke', 1]] : [['Sparks', 0.1], ['Dust', 1]]);
        }
        const ids = new Set(library('particleSystems').map((x: any) => x.id));
        for (const n of allNodes(templates.get('Muzzle Flash').nodeJson).concat(allNodes(templates.get('Bullet Impact').nodeJson)))
            if (n.type === 'particleSystem') expect(ids.has(n.particleSystem.particleSystemId)).toBe(true);
        for (const holder of ['Pistol Grip', 'Rifle Grip']) {
            const h = named('Weapons').children.find((c: any) => c.name === holder);
            expect(scriptName(h), holder).toBe('SandboxGun');
        }
        expect(named('Rifle Grip').scriptVars.auto).toBe(true);
        expect(named('Pistol Grip').scriptVars.auto).toBe(false);
        // The crosshair, the ammunition and the reload are the Player's own: a screen canvas in the Player template
        // (every copy has its own), the crosshair hidden until a weapon is out. The scene's HUD keeps the controls.
        const playerHud = named('Player Collider').children.find((c: any) => c.name === 'Player')
            .children.find((c: any) => c.name === 'HUD');
        expect(playerHud?.type).toBe('uiRoot');
        expect(playerHud.children.map((c: any) => c.name)).toEqual(['Crosshair', 'Ammunition', 'Reloading']);
        expect(allNodes(playerHud).filter((n: any) => /^Crosshair/.test(n.name)).map((n: any) => n.name))
            .toEqual(['Crosshair', 'Crosshair Dot', 'Crosshair Top', 'Crosshair Bottom', 'Crosshair Left', 'Crosshair Right']);
        const template = allNodes(templates.get('Player').nodeJson);
        expect(template.filter((n: any) => n.type === 'uiRoot').map((n: any) => n.name)).toEqual(['HUD']);
        expect(named('HUD').children.map((c: any) => c.name)).toEqual(['Controls']);
    });

    it('shoots where the crosshair looks, the bullet pushing the crate it hits', () => {
        withEffects();
        try {
            const p = play();
            p.run(0.5);
            equip(p, 2);
            const crates = p.scene.findNode('Props')!.children.filter((c: any) => c.name === 'Crate Collider') as Node[];
            const crate = crates.sort((a, b) => vec3.distance(a.worldPosition, [6.2, 0.4, 0.6]) - vec3.distance(b.worldPosition, [6.2, 0.4, 0.6]))[0];
            const start = vec3.clone(crate.worldPosition);
            input.press('Aim');
            p.run(0.4);
            aimCamera(p, [start[0], start[1] - 0.1, start[2]]);
            const gun = gunOf(p, 'Rifle Grip');
            const before = gun.shots;
            input.press('Fire');
            const hits: string[] = [];
            p.run(0.7, () => { if (gun.lastHit) hits.push(gun.lastHit.node?.name ?? 'ground'); });
            input.release('Fire');
            const fired = gun.shots - before;
            // 600 rounds a minute: seven or eight in 0.7 s.
            expect(fired).toBeGreaterThanOrEqual(6);
            expect(fired).toBeLessThanOrEqual(8);
            p.run(0.4);
            // How far depends on each backend's friction (Jolt slides it most): a push, on all of them.
            const moved = vec3.distance(crate.worldPosition, start);
            expect(moved, `the crate moved ${(moved * 100).toFixed(1)} cm`).toBeGreaterThan(0.02);
            // Away from the shooter, along the shot.
            const away = [start[0] - p.collider.worldPosition[0], 0, start[2] - p.collider.worldPosition[2]];
            const push = [crate.worldPosition[0] - start[0], 0, crate.worldPosition[2] - start[2]];
            expect(push[0] * away[0] + push[2] * away[2]).toBeGreaterThan(0);
            // The shots left holes on it, which ride with it.
            const holes = allSceneNodes(p.scene).filter((n: any) => n.name === 'Bullet Hole');
            expect(holes.length).toBeGreaterThan(0);
            expect(holes.some((h: any) => h.parent === crate)).toBe(true);
            input.release('Aim');
        } finally { clearTemplates(); }
    });

    it('fires the rifle while the trigger is held and the pistol once a pull', () => {
        withEffects();
        try { for (const [weapon, holder] of [[2, 'Rifle Grip'], [1, 'Pistol Grip']] as const) {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, weapon);
            input.press('Aim');
            p.run(0.4);
            const gun = gunOf(p, holder);
            const before = gun.shots;
            input.press('Fire');
            p.run(1);
            input.release('Fire');
            const held = gun.shots - before;
            if (weapon === 2) { expect(held).toBeGreaterThanOrEqual(9); expect(held).toBeLessThanOrEqual(11); }
            else expect(held).toBe(1);
            // Three pulls, three shots, as fast as the pistol cycles.
            p.run(0.1);
            const after = gun.shots;
            for (let k = 0; k < 3; k++) { input.tap('Fire'); p.run(0.2); }
            expect(gun.shots - after).toBe(3);
            input.release('Aim');
        } } finally { clearTemplates(); }
    });

    it('plays the rifle cue once a shot, each shot on a voice of the cue (no copies of it)', () => {
        withEffects();
        try {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, 2);
            const cue = p.scene.findNode('ShotRifle') as any;
            expect([cue.voices, cue.whenFull]).toEqual([16, 'quietest']);
            const plays = vi.spyOn(cue, 'play');
            const gun = gunOf(p, 'Rifle Grip');
            input.press('Aim');
            p.run(0.4);
            const shots = gun.shots;
            input.press('Fire');
            p.run(1);
            input.release('Fire');
            p.run(0.3);
            // Third person: the gun plays it (first person: the viewmodel's Fire clip, through its Event Actions; this
            // headless run builds no viewmodel animators).
            expect(gun.shots - shots).toBeGreaterThanOrEqual(9);
            expect(plays.mock.calls.length).toBe(gun.shots - shots);
            input.release('Aim');
            // No spare copies of the cue (how overlap used to be faked, six at most).
            const names: string[] = [];
            const walkAll = (n: Node) => { names.push(n.name); n.children.forEach(walkAll); };
            walkAll(p.scene.root);
            expect(names.filter(n => n.includes('(overlap)'))).toEqual([]);
        } finally { clearTemplates(); }
    });

    it('raises the weapon to fire from the hip, and kicks the camera up, most of it coming back', () => {
        withEffects();
        try {
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 1);
        expect(p.player.aiming).toBe(false);
        const gun = gunOf(p, 'Pistol Grip');
        const pitch0 = p.rigs[0].pitch;
        input.press('Fire');
        // Not yet up: no shot on the first frame from the hip.
        p.run(FRAME);
        expect(gun.shots).toBe(0);
        expect(p.player.aiming).toBe(true);
        let kicked = 0;
        p.run(0.3, () => { kicked = Math.max(kicked, pitch0 - p.rigs[0].pitch); });
        input.release('Fire');
        expect(gun.shots).toBe(1);
        // The camera kicked up (pitch is + down)...
        expect(kicked).toBeGreaterThan(0.1);
        // ...and most of it comes back.
        p.run(1);
        const left = pitch0 - p.rigs[0].pitch;
        expect(left).toBeLessThan(kicked * 0.6);
        expect(left).toBeGreaterThan(0);
        // It stays up a moment after, then goes back down.
        expect(p.player.aiming).toBe(false);
        // Sprinting, it does not fire.
        input.press('Sprint');
        input.setMove(0, 1);
        p.run(1);
        const shots = gun.shots;
        input.tap('Fire');
        p.run(0.3);
        expect(gun.shots).toBe(shots);
        input.release('Sprint'); input.setMove(0, 0);
        } finally { clearTemplates(); }
    });

    it('tells each shot as weapon:Shot, which the holder hears for its recoil and anyone may hear', () => {
        withEffects();
        const heard: { gun: string; recoil: boolean; atGun: boolean }[] = [];
        const off = Events.on('weapon:Shot', (shot: any) => heard.push({
            gun: shot.gun.name, recoil: !!shot.recoil, atGun: Events.current?.target === shot.gun,
        }));
        try {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, 2);
            const gun = gunOf(p, 'Rifle Grip');
            input.press('Aim');
            p.run(0.6);
            const pitch0 = p.rigs[0].pitch;
            input.tap('Fire');
            p.run(0.05);
            input.release('Aim');
            // Dispatched at the gun, with the pull's recoil; the holder's listener kicked the camera with it.
            expect(heard).toEqual([{ gun: 'Rifle Grip', recoil: true, atGun: true }]);
            expect(gun.shots).toBe(1);
            expect(p.rigs[0].pitch).toBeLessThan(pitch0);
        } finally { off(); clearTemplates(); }
    });

    it('shows the model of the weapon in the hands through weapon:Equipped', () => {
        const p = play(OPEN);
        p.run(0.3);
        const pistol = gunOf(p, 'Pistol Grip'), rifle = gunOf(p, 'Rifle Grip'), shotgun = gunOf(p, 'Shotgun Grip');
        const told: [number, number][] = [];
        const off = p.player.addEventListener('weapon:Equipped', (now: number, was: number) => told.push([now, was]));
        try {
            equip(p, 1);
            expect([pistol.visible, rifle.visible, shotgun.visible]).toEqual([true, false, false]);
            equip(p, 2);
            expect([pistol.visible, rifle.visible, shotgun.visible]).toEqual([false, true, false]);
            equip(p, 3);
            expect([pistol.visible, rifle.visible, shotgun.visible]).toEqual([false, false, true]);
            equip(p, 0);
            expect([pistol.visible, rifle.visible, shotgun.visible]).toEqual([false, false, false]);
            expect(told).toEqual([[1, 0], [2, 1], [3, 2], [0, 3]]);
        } finally { off(); }
    });

    it('fires the shotgun nine pellets a shot, a round off the magazine each, and reloads it from the reserve', () => {
        withEffects();
        try {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, 3);
            p.run(0.5);
            const gun = gunOf(p, 'Shotgun Grip');
            // Firing Line's SAPS-12: six in the magazine, thirty-six more.
            expect([gun.ammo, gun.reserve, gun.pellets]).toEqual([6, 36, 9]);
            input.press('Aim');
            p.run(0.4);
            const told: any[] = [];
            const off = p.player.addEventListener('weapon:Shot', (shot: any) => told.push(shot));
            try { input.tap('Fire'); p.run(0.9); } finally { off(); }
            expect(told).toHaveLength(1);
            expect(told[0].hits).toHaveLength(9);
            expect(gun.ammo).toBe(5);
            // The Player's own HUD (its canvas, not the scene's) counts what is left.
            const hud = allSceneNodes({ root: (p.player as any).getChildByName('HUD')[0] });
            const ui = (name: string) => hud.find((n: any) => n.name === name);
            expect([ui('Ammunition').visible, ui('Ammo').text, ui('Reserve').text, ui('Weapon Name').text])
                .toEqual([true, '5', '/ 36', gun.displayName]);
            expect(ui('Crosshair').opacity).toBeGreaterThan(0);
            input.release('Aim');
            p.run(0.3);
            // R: the Reload pose held, the magazine filled near its end from the reserve.
            input.tap('Reload');
            p.run(0.5);
            expect(p.player.reloading).toBe(true);
            expect(ui('Reloading').visible).toBe(true);
            expect(p.animator.layerStateName('Shotgun')).toBe('Reload');
            p.run(gun.reloadSeconds);
            expect(p.player.reloading).toBe(false);
            expect([gun.ammo, gun.reserve]).toEqual([6, 35]);
            expect([ui('Reloading').visible, ui('Ammo').text, ui('Reserve').text]).toEqual([false, '6', '/ 35']);
            expect(p.animator.layerStateName('Shotgun')).toBe('Carry');
        } finally { clearTemplates(); }
    });

    it('runs dry once the reserve is spent, and a pull on an empty magazine reloads', () => {
        withEffects();
        try {
            const p = play(OPEN);
            p.run(0.5);
            equip(p, 1);
            const gun = gunOf(p, 'Pistol Grip');
            input.press('Aim');
            p.run(0.4);
            // The last round, then a pull on the empty magazine: it reloads from the reserve.
            gun.ammo = 1;
            input.tap('Fire');
            p.run(0.4);
            expect(gun.ammo).toBe(0);
            input.tap('Fire');
            p.run(0.2);
            expect(p.player.reloading).toBe(true);
            p.run(gun.reloadSeconds);
            expect([gun.ammo, gun.reserve]).toEqual([12, 72]);
            // With nothing left in reserve, an empty magazine stays empty.
            gun.ammo = 0;
            gun.reserve = 0;
            const shots = gun.shots;
            input.tap('Fire');
            p.run(0.4);
            input.tap('Reload');
            p.run(0.4);
            expect(p.player.reloading).toBe(false);
            expect(gun.shots).toBe(shots);
            expect(gun.ammo).toBe(0);
            input.release('Aim');
        } finally { clearTemplates(); }
    });

    it('switches to first person and back with View: the camera at the eyes, the body in the shadows alone, the viewmodel in the hands', () => {
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 2);
        const rig = p.rigs[0] as any;
        const mannequin = p.scene.findNode('Mannequin') as Node, weapons = p.scene.findNode('Weapons') as Node;
        const views = ['Pistol Viewmodel', 'AK-47 Viewmodel', 'SAPS-12 Viewmodel'].map(n => p.scene.findNode(n) as Node);
        const shown = () => views.map(v => v.visible);
        expect(rig.armLength).toBeGreaterThan(1);
        expect([mannequin.shadowOnly, weapons.shadowOnly]).toEqual([false, false]);
        expect(shown()).toEqual([false, false, false]);
        input.tap('View');
        p.run(0.6);
        expect(p.player.firstPerson).toBe(true);
        expect(rig.armLength).toBeLessThan(0.01);
        expect(rig.followOffset[1]).toBeCloseTo(p.player.eyeStand, 2);
        // Drawn into the shadows alone: not hidden (it keeps animating and casting).
        expect([mannequin.shadowOnly, weapons.shadowOnly]).toEqual([true, true]);
        expect(mannequin.visible).toBe(true);
        expect(shown()).toEqual([false, true, false]);
        expect(views.every(v => v.viewmodel)).toBe(true);
        expect(rig.fov).toBeGreaterThan(70);
        // The body faces the camera at once, standing still too: no turn in place.
        rig.yaw = rig.yaw + 90;
        p.run(0.1);
        expect(Math.abs(wrap(p.yawOf(p.player) - rig.yaw))).toBeLessThan(2);
        // The weapon changes: its viewmodel comes up.
        input.tap('Equip');
        p.run(0.5);
        expect(p.player.weapon).toBe(3);
        expect(shown()).toEqual([false, false, true]);
        input.tap('View');
        p.run(0.6);
        expect(p.player.firstPerson).toBe(false);
        expect(rig.armLength).toBeGreaterThan(1);
        expect([mannequin.shadowOnly, weapons.shadowOnly]).toEqual([false, false]);
        expect(shown()).toEqual([false, false, false]);
    });

    it('crouches and stands with a tap of Crouch: the capsule shortened, the crouch walk playing, a sprint standing it up', () => {
        const p = play(OPEN);
        p.run(0.5);
        const body = (p.collider as any).body;
        const height = () => { const c = body.colliders.find((d: any) => d.shape.kind === 'capsule'); return c.shape.height + 2 * c.shape.radius; };
        expect(height()).toBeCloseTo(1.765, 2);
        input.tap('Crouch');
        p.run(0.6);
        expect(p.player.crouched).toBe(true);
        expect(height()).toBeCloseTo(1.2, 2);
        expect(p.animator.currentStateName).toBe('Crouch');
        input.setMove(0, 1);
        p.run(1.5);
        expect(p.animator.currentStateName).toBe('Crouch');
        // The crouch walk's own pace.
        expect(p.player.planarSpeed).toBeGreaterThan(1.1);
        expect(p.player.planarSpeed).toBeLessThan(1.8);
        input.press('Sprint');
        p.run(0.6);
        expect(p.player.crouched).toBe(false);
        expect(height()).toBeCloseTo(1.765, 2);
        input.release('Sprint');
        input.setMove(0, 0);
        p.run(0.8);
        input.tap('Crouch');
        p.run(0.5);
        expect(p.player.crouched).toBe(true);
        input.tap('Crouch');
        p.run(0.8);
        expect(p.player.crouched).toBe(false);
        expect(p.animator.currentStateName).not.toBe('Crouch');
    });

    it('crouches on Mixamo’s crouch: the unarmed arms free, the rifle’s and the pistol’s on their own clips, the turns on the Pivot', () => {
        const names = new Map<number, string>(rig().skin.nodeNames);
        const own = library('animations').filter((a: any) => a.rigId === rig().id);
        const crouch = own.filter((a: any) => /^Crouch/.test(a.name));
        expect(crouch.map((a: any) => a.name).sort()).toEqual(['CrouchB', 'CrouchBL', 'CrouchBR', 'CrouchF', 'CrouchFL', 'CrouchFR', 'CrouchIdle', 'CrouchL', 'CrouchR', 'CrouchStand', 'CrouchTurn90L', 'CrouchTurn90R']);
        for (const a of [...crouch, ...own.filter((x: any) => /^Rifle Crouch/.test(x.name))]) {
            const clip = a.clips[0];
            const pivot = clip.channels.some((c: any) => names.get(c.targetNodeIndex) === 'Pivot');
            expect(pivot, `${a.name} turns on the Pivot`).toBe(/Turn/.test(a.name));
            expect(!!clip.rootMotion, a.name).toBe(/Turn/.test(a.name));
            if (/Crouch(F|B|L|R|FL|FR|BL|BR)$/.test(a.name)) expect(clip.footLocks, a.name).toBeTruthy();
        }
        // The unarmed crouch walk's hands hang free (the rifle pack's hold its rifle, a third of a metre apart).
        const skin = loadSkin(rig().skin, (a: number[]) => mat4.clone(a as any));
        const handsApart = (clipName: string) => {
            const a = new Animator({ skin, animations: own.map((x: any) => x.clips[0]), hasSkin: true } as any);
            a.playAnimationByName(clipName, true, false);
            for (let k = 0; k < 18; k++) a.update(FRAME);
            const at = (bone: string) => {
                const j = skin.joints.findIndex((x: any) => (names.get(x.nodeIndex) ?? '').endsWith(':' + bone));
                const world = mat4.multiply(mat4.create(), a.getFinalBoneMatrices()[j] as mat4, mat4.invert(mat4.create(), skin.joints[j].inverseBindMatrix));
                return mat4.getTranslation(vec3.create(), world);
            };
            return vec3.distance(at('LeftHand'), at('RightHand'));
        };
        expect(handsApart('CrouchF')).toBeGreaterThan(0.45);
        expect(handsApart('Rifle CrouchF')).toBeLessThan(0.4);
        // Each stance crouches on its own blend space; the Character's crouched drives them all.
        const fields = new Map(library('animationFields').map((f: any) => [f.name, f]));
        for (const [state, field] of [['Crouch', 'Crouch Locomotion'], ['Rifle Crouch', 'Rifle Crouch'], ['Pistol Crouch', 'Pistol Crouch']]) {
            expect(machine().states.find((s: any) => s.name === state).fieldId, state).toBe(fields.get(field).id);
            expect(machine().states.find((s: any) => s.name === state).syncGroup, state).toBe('Crouch');
        }
        expect(machine().parameters.find((p: any) => p.name === 'Crouching').variable.varName).toBe('crouched');
    });

    it('never shoots itself, and passes through the stairs\' ramps', () => {
        // Point blank, the camera behind and over the shoulder: every shot leaves the body alone.
        const p = play(OPEN);
        p.run(0.5);
        equip(p, 2);
        input.press('Aim');
        p.run(0.4);
        const gun = gunOf(p, 'Rifle Grip');
        const body = (p.player as any).collider.body;
        const cam = (p.rigs[0].children.find((c: any) => c.nodeType === 'camera') ?? p.rigs[0]) as Node;
        const e = cam.worldPosition;
        const toward = [p.collider.worldPosition[0] - e[0], p.collider.worldPosition[1] + 1 - e[1], p.collider.worldPosition[2] - e[2]];
        const l = Math.hypot(toward[0], toward[1], toward[2]);
        const hit = gun.fire([e[0], e[1], e[2]], [toward[0] / l, toward[1] / l, toward[2] / l], 0, body);
        expect(hit?.node?.name ?? 'nothing').not.toBe('Player Collider');
        input.release('Aim');
    });

    it('looks round crouched with its head alone, the trunk staying as the crouch holds it', () => {
        const p = play(OPEN);
        p.run(0.5);
        input.tap('Crouch');
        p.run(1.5);
        expect(p.animator.currentStateName).toBe('Crouch');
        const start = p.yawOf(p.player);
        const chest = () => { const r = quat.create(); mat4.getRotation(r, jointMatrix(p, 'Spine2')); return quat.normalize(r, r); };
        const head = () => { const r = quat.create(); mat4.getRotation(r, jointMatrix(p, 'Head')); return quat.normalize(r, r); };
        const chest0 = chest(), head0 = head();
        p.rigs[0].setOrbit(start + 60, 12);
        p.run(1.2);
        expect(p.player.lookHeadWeight).toBeGreaterThan(0.9);
        expect(p.player.lookWeight).toBeLessThan(0.05);
        expect(Math.abs(wrap(p.yawOf(p.player) - start)), 'no turn in place yet').toBeLessThan(1);
        expect(degreesApart(chest(), chest0), 'the chest').toBeLessThan(4);
        expect(degreesApart(head(), head0), 'the head').toBeGreaterThan(40);
        // Standing up, the trunk turns under the head again.
        input.tap('Crouch');
        p.run(2);
        expect(p.player.lookWeight).toBeGreaterThan(0.9);
        expect(p.player.lookHeadWeight).toBeLessThan(0.05);
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
        const effects = ['Muzzle Flash', 'Bullet Impact', 'Bullet Hole', 'Tracer'];
        const made = ['Player', 'Environment', 'Course', 'Car'];
        const kinds = library('templates').map((t: any) => t.name).filter((n: string) => !effects.includes(n) && !made.includes(n)).sort();
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
        const forks = new Set((sm.forks ?? []).map((f: any) => f.name));
        expect(sm.groups.map((g: any) => g.name)).toEqual(['Turning', 'Stopping', 'Running Turn', 'Air', 'Landing', 'Car', 'Crouching', 'Standing', 'Moving']);
        const seen = new Set<string>();
        for (const g of sm.groups) {
            expect(states.has(g.name) || forks.has(g.name), `${g.name} is not also a state or a fork`).toBe(false);
            for (const m of g.states) { expect(states.has(m) || forks.has(m), m).toBe(true); expect(seen.has(m), m).toBe(false); seen.add(m); }
        }
        // Left outside: the ones everything comes back to. Standing and Moving hold each stance's idle and locomotion
        // (folded on the graph), with no line of their own: each of their states leaves as it does.
        for (const s of ['Start', 'Stairs']) expect(seen.has(s), s).toBe(false);
        for (const g of ['Standing', 'Moving']) expect(sm.transitions.some((t: any) => t.from === g || t.to === g), g).toBe(false);
        const fromGroups = sm.transitions.filter((t: any) => sm.groups.some((g: any) => g.name === t.from));
        expect(fromGroups.length).toBeGreaterThan(6);
        expect(sm.states.find((s: any) => s.name === 'LandHard').holdMovement).toBe(true);
    });

    it('untangles its transitions with forks: each group entered at several states starts with one, entered by one line from each source', () => {
        const sm = machine();
        const states = new Set(sm.states.map((s: any) => s.name));
        const forks = new Set((sm.forks ?? []).map((f: any) => f.name));
        expect([...forks].slice(0, 5)).toEqual(['Take Off', 'Pick Turn', 'Pick Stop', 'Settle', 'Pick Run Turn']);
        // A stance's states are entered through their role's fork, which picks by Stance.
        expect([...forks].slice(5).sort()).toEqual(['Crouch Down', ...['Crouch', 'CrouchTurn90L', 'CrouchTurn90R', 'Fall', 'FallFar', 'Idle', 'JumpLand', 'JumpRun', 'JumpStand', 'LandRun', 'Locomotion', 'Turn90L', 'Turn90R'].map(r => `Pick ${r}`)].sort());
        for (const f of forks) expect(states.has(f), `${f} is not also a state`).toBe(false);
        const group = (name: string) => sm.groups.find((g: any) => g.name === name);
        for (const [g, f] of [['Air', 'Take Off'], ['Turning', 'Pick Turn'], ['Stopping', 'Pick Stop'], ['Running Turn', 'Pick Run Turn']]) {
            expect(group(g).entry, `${g} starts with its fork`).toBe(f);
            expect(group(g).states).toContain(f);
            // Nothing outside the group names one of its states: everything comes in through the group, so its fork.
            const outside = sm.transitions.filter((t: any) => group(g).states.includes(t.to) && !group(g).states.includes(t.from) && t.from !== g);
            if (g !== 'Stopping') expect(outside.map((t: any) => `${t.from} -> ${t.to}`), g).toEqual([]);
            // Into the group: at most one transition from each source.
            const into = sm.transitions.filter((t: any) => t.to === g).map((t: any) => t.from);
            expect(new Set(into).size, `${g}: one line from each source`).toBe(into.length);
        }
        // Into the air from nine places, each one line: 22 transitions once.
        expect(sm.transitions.filter((t: any) => t.to === 'Air').map((t: any) => t.from).sort())
            .toEqual(['Crouching', 'Idle', 'Landing', 'Locomotion', 'Pistol Idle', 'Pistol Locomotion', 'Rifle Idle', 'Rifle Locomotion', 'Running Turn', 'Stairs', 'Start', 'Stopping', 'Turning']);
        expect(sm.transitions.filter((t: any) => t.from === 'Take Off').map((t: any) => t.to)).toEqual(['Pick JumpRun', 'Pick JumpStand', 'Pick Fall']);
        // The start's stop goes straight to the early stop: Pick Stop's exit is the run's phase, not the start clip's.
        expect(sm.transitions.filter((t: any) => group('Stopping').states.includes(t.to) && t.from === 'Start').map((t: any) => t.to)).toHaveLength(1);
        // The Car keeps its triggers (no fork): getting in and out are entered from anywhere by them.
        expect(group('Car').entry).toBeUndefined();
        // Three stances: the roles with variants leave as they do (one copy of each way out per variant) and switch
        // stance among themselves; still no line per pair of states.
        expect(sm.transitions.length).toBeLessThan(210);
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
        // It drives on Drive (the triggers), not Move; X holds the hand brake as it jumps on foot.
        expect([controller.moveAction, controller.lookAction, controller.jumpAction]).toEqual(['Drive', 'Look', 'Jump']);
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
