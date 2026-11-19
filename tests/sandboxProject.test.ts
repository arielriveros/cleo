import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { mat4, quat, vec3 } from 'gl-matrix';
import { readExample } from '../tools/exampleKit/readExample.mjs';
// The whole engine: it registers itself as the scripts' 'cleo' module, so the example's script runs headless.
import { Scene, CleoEngine, PhysicsSystem, Animator, Logger, NODE_BUILTINS } from '../src/cleo';
import type { CharacterNode, CameraRigNode, ControllerNode, Node } from '../src/cleo';
import { loadSkin } from '../applications/editor/src/utils/animationAssets';
import { detectFootLockWindows } from '../src/animation/footLockWindows';
import { fakeInput } from './helpers/fakeInput';
import type { FakeInput } from './helpers/fakeInput';
import { TEST_PHYSICS } from './helpers/testPhysics';

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
        expect(nodes().filter(n => n.type === 'collider' && /^Static Collision/.test(n.name))).toHaveLength(1);
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
        for (const p of sm.parameters) {
            expect(p.variable.nodeRef).toBe('parent');
            if (p.variable.source === 'builtin') expect(NODE_BUILTINS[p.variable.varName], p.variable.varName).toBeDefined();
            else expect(['moveDir', 'isJumping', 'turnRequest'].includes(p.variable.varName) || scriptFields.has(p.variable.varName), p.variable.varName).toBe(true);
        }
        const params = new Set(sm.parameters.map((p: any) => p.name));
        const conds = (c: any): any[] => !c ? [] : c.children ? c.children.flatMap(conds) : [c];
        for (const t of sm.transitions) for (const c of conds(t.condition)) expect(params.has(c.param), c.param).toBe(true);
        // Only the turns, the stop (which plants sideways) and the hard landing (which crouches where it came down)
        // drive the character with their root motion.
        const rootMotion = library('animations').filter(a => a.clips[0].rootMotion).map(a => a.name).sort();
        expect(rootMotion).toEqual(['LandHard', 'RunTurnL', 'RunTurnR', 'Stop', 'StopMirror', 'Turn180L', 'Turn180R', 'Turn90L', 'Turn90R']);
    });

    it('ships the current scripts and the actions they read', () => {
        for (const [name, node] of [['SandboxPlayer', 'Player'], ['SandboxCamera', 'Camera Rig']]) {
            const script = library('scripts').find(s => s.name === name);
            expect(script.source).toBe(readFileSync(join(__dirname, '..', 'examples', 'scripts', `${name}.ts`), 'utf8'));
            expect(named(node).script, node).toBe(script.source);
        }
        const actions = read('libraries', 'inputMap.json').maps.find((m: any) => m.name === 'Gameplay').actions.map((a: any) => a.name);
        for (const a of ['Move', 'Look', 'Jump', 'Sprint', 'Walk']) expect(actions).toContain(a);
        // The camera's framing follows the sprint: no action switches it.
        expect(actions).not.toContain('Camera');
    });

    // ----- playing it -------------------------------------------------------------------------------

    /**
     * The scene as the player starts it, on a real physics world, with an Animator in the model's place: the
     * Animator the editor would build from the model's skin, the skeleton's clips and the embedded machine.
     */
    function play(at?: [number, number, number], ikRig: Record<string, unknown> = {}, character: Record<string, unknown> = {}) {
        const file = sceneFile();
        const scene = new Scene();
        const tree = withoutModels(file.scene);
        if (at) tree.children.find((c: any) => c.name === 'Player Collider').position = at;
        Object.assign(allNodes(tree).find((n: any) => n.name === 'Player'), character);
        scene.parse({ ...file, scene: tree }, true);
        const physics = new PhysicsSystem({ gravity: [0, -9.82, 0], backend: TEST_PHYSICS } as any);
        physics.initialize();
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
        animator.setStateMachine(JSON.parse(JSON.stringify(machine())));
        // A ModelNode's frame: its script, then the machine, then the pose.
        const base = model.update.bind(model);
        (model as any).update = (dt: number, t: number) => { base(dt, t); animator.checkTriggers(); animator.update(dt); };
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
        expect(templates.slice(0, 3).map((t: any) => t.name)).toEqual(['Player', 'Environment', 'Course']);
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
        expect(publics('SandboxPlayer')).toEqual(['backDiagonalScale', 'backScale', 'runFootSpeed', 'runFootWeight', 'runTurnSpeed', 'sprintTakeoff', 'turnDelay', 'walkBackDiagonalScale', 'walkFootSpeed', 'walkScale']);
        expect(publics('SandboxCamera')).toEqual(['pivotHeight', 'shoulderArm', 'shoulderOffset', 'thirdPersonArm']);
        expect(inside.find((n: any) => n.type === 'character').script).toBe(named('Player').script);
        expect(inside.find((n: any) => n.type === 'cameraRig').script).toBe(named('Camera Rig').script);
    });

    it('keeps its sky and its course in templates of their own', () => {
        const templates = new Map(library('templates').map((t: any) => [t.name, t]));
        const env = named('Environment'), course = named('Static Collision');
        expect(env.variables.__templateId.value).toBe(templates.get('Environment').id);
        expect(course.variables.__templateId.value).toBe(templates.get('Course').id);
        expect(env.children.map((c: any) => [c.type, c.name])).toEqual([['light', 'Sun'], ['skyAtmosphere', 'Sky Atmosphere'], ['skyLight', 'Sky Light']]);
        expect(course.type).toBe('collider');
        expect(course.collider.shapes.length).toBeGreaterThan(40);
        // The scene's top level is the three placements.
        expect(sceneFile().scene.children.map((c: any) => c.name)).toEqual(['Environment', 'Player Collider', 'Props', 'Static Collision']);
        // And the running scene still finds its sun, sky and sky light inside the Environment.
        const scene = new Scene();
        scene.parse({ ...sceneFile(), scene: withoutModels(sceneFile().scene) }, true);
        expect(scene.findNode('Sky Atmosphere')).toBeTruthy();
        expect([...(scene as any).lights].some((l: any) => l.name === 'Sun')).toBe(true);
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
        const kinds = library('templates').slice(3).map((t: any) => t.name).sort();
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

    it('groups its turns, stops, running turns, air and landings, each state in one group', () => {
        const sm = machine();
        const states = new Set(sm.states.map((s: any) => s.name));
        expect(sm.groups.map((g: any) => g.name)).toEqual(['Turning', 'Stopping', 'Running Turn', 'Air', 'Landing']);
        const seen = new Set<string>();
        for (const g of sm.groups) {
            expect(states.has(g.name), `${g.name} is not also a state`).toBe(false);
            for (const m of g.states) { expect(states.has(m), m).toBe(true); expect(seen.has(m), m).toBe(false); seen.add(m); }
        }
        // Left outside: the ones everything comes back to.
        for (const s of ['Idle', 'Locomotion', 'Start']) expect(seen.has(s), s).toBe(false);
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
});
