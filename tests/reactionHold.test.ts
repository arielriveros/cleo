import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Scene, CleoEngine, PhysicsSystem } from '../src/cleo';
import type { CharacterNode, Node } from '../src/cleo';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import { LoopbackPort } from '../src/physics/worker/ports';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';
import { NO_REACTION_EFFECTS } from '../src/animation/reactionLink';
import type { ReactionController } from '../src/physics/reactive/reactionController';
import { BEHAVIOURS } from '../src/physics/reactive/behaviours';
import { ControllerNode } from '../src/core/scene/nodes/controllerNode';

// The reaction holds a character's control while a hit has its body on its feet (CharacterNode.reactionHold): a
// moment's flinch after a hit before it walks or turns, none while it steps to stay up (its facing following its
// body's), handed back after. Reported (2026-11-28): shot, an NPC ran off on the same frame, its capsule turning at
// 480 degrees a second under a body that could not follow it; a stagger begun in that turn stepped while it spun, and
// came back to its animation with the whole body snapped round to the capsule's heading. Reactions are Jolt's alone;
// a file of its own (each world a Jolt heap).

const FRAME = 1 / 60;
const DEG = 180 / Math.PI;
const R = 0.28, HEIGHT = 1.76, MASS = 75;

let authoring = false;
const played: PhysicsSystem[] = [];
beforeEach(() => { authoring = CleoEngine.authoringMode; CleoEngine.authoringMode = false; });
afterEach(() => { CleoEngine.authoringMode = authoring; for (const p of played.splice(0)) p.dispose(); });

const wrap = (a: number) => ((a + 540) % 360) - 180;

/** A Character in a capsule on flat ground, the procedural humanoid under it, reacting on Jolt, driven by `drive`. */
async function play(opts: { holdsControl?: boolean; worker?: boolean } = {}) {
    await acquirePhysicsBackend('jolt');
    const ground = {
        type: 'collider', id: 'ground', name: 'Ground', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        collider: { mass: 0, friction: 0.8, shapes: [{ type: 'box', width: 80, height: 1, depth: 80, offset: [0, -0.5, 0], rotation: [0, 0, 0] }] },
        children: [],
    };
    const pawn = {
        type: 'collider', id: 'pawn:collider', name: 'Pawn Collider', position: [0, 0.005, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
        collider: {
            mass: MASS, friction: 0, restitution: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [0, 0, 0],
            groundProbeDistance: 0.12, simulationMode: 'always',
            shapes: [{ type: 'capsule', radius: R, height: HEIGHT, numSegments: 16, offset: [0, HEIGHT / 2, 0], rotation: [0, 0, 0] }],
        },
        children: [{
            type: 'character', id: 'pawn', name: 'Pawn', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
            walkSpeed: 1.5, runSpeed: 5, acceleration: 10, turnSpeed: 480, facingMode: 'velocity', driveWhenUnpossessed: true,
        }],
    };
    const scene = new Scene();
    scene.parse({ scene: { id: 'root', name: 'root', type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [ground, pawn] } }, true);
    const physics = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: 'jolt' } as any);
    physics.initialize();
    physics.scene = scene;
    played.push(physics);
    if (opts.worker) physics.setWorkerMode('on', () => new LoopbackPort());
    const character = scene.findNode('Pawn') as CharacterNode;
    const model = humanoidModel();
    if (opts.holdsControl === false) (model as any).ragdollConfig = { ...((model as any).ragdollConfig ?? {}), reactions: { holdsControl: false } };
    character.addChild(model);
    scene.start();
    const reactions = physics.reactionsOf(model) as ReactionController;
    expect(reactions.config.holdsControl).toBe(opts.holdsControl === false ? false : undefined);
    let t = 0;
    const yaw = () => { const f = character.worldForward; return Math.atan2(f[0], f[2]) * DEG; };
    /** The hips as drawn (their skinning matrix in the world): their heading, degrees. */
    const drawnHips = () => {
        const m = mat4.multiply(mat4.create(), model.worldTransform as mat4, model.animator!.getFinalBoneMatrices()[0] as mat4);
        return Math.atan2(m[8], m[10]) * DEG;
    };
    const pelvis = () => reactions.ragdoll?.parts.find(p => p.parent < 0) ?? null;
    /** The simulated pelvis' heading, degrees (its forward is its Z). */
    const bodyYaw = () => {
        const p = pelvis();
        if (!p) return NaN;
        const q = p.body.quaternion, x = q.x, y = q.y, z = q.z, w = q.w;
        return Math.atan2(2 * (x * z + w * y), 1 - 2 * (x * x + y * y)) * DEG;
    };
    const run = (seconds: number, each?: (t: number) => void) => {
        for (let k = 0; k < Math.round(seconds / FRAME); k++) {
            each?.(t);
            physics.update(FRAME);
            scene.update(FRAME, t * 1000, false);
            physics.endFrame(FRAME);
            t += FRAME;
        }
    };
    /** Walk (or run) the stick toward `basisYaw` degrees. */
    const walk = (basisYaw: number, sprint = false) => { const i = character.drive(); i.move = [0, 1]; i.basisYaw = basisYaw; i.sprint = sprint; };
    return { scene, physics, character, model, reactions, run, walk, yaw, drawnHips, bodyYaw, pelvis, time: () => t };
}

describe('a reaction holds the character on its feet (jolt)', () => {
    it('shot walking, it flinches before it turns to run off, then turns at its pace', async () => {
        const held = await play();
        held.run(1, () => held.walk(0));
        const before = held.yaw();
        held.reactions.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 18 });
        expect(held.reactions.state).toBe('hitReact');
        // The second round of a burst does not make the flinch longer.
        let turned03 = 0, turned12 = 0;
        held.run(1.2, (t0) => {
            const since = held.time() - 1;
            if (Math.abs(since - 0.13) < FRAME / 2) held.reactions.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 18 });
            held.walk(180, true);
            if (since <= 0.3) turned03 = Math.max(turned03, Math.abs(wrap(held.yaw() - before)));
            turned12 = Math.max(turned12, Math.abs(wrap(held.yaw() - before)));
            void t0;
        });
        // The same with its control its own (a player's character).
        const free = await play({ holdsControl: false });
        free.run(1, () => free.walk(0));
        const fromFree = free.yaw();
        free.reactions.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 18 });
        let freeTurned03 = 0;
        free.run(0.3, () => { free.walk(180, true); freeTurned03 = Math.max(freeTurned03, Math.abs(wrap(free.yaw() - fromFree))); });
        console.log(`[hold] turned in 0.3 s: held ${turned03.toFixed(1)} deg, own control ${freeTurned03.toFixed(1)} deg; held by 1.2 s ${turned12.toFixed(1)} deg`);
        expect(turned03, 'held: no turn in the flinch').toBeLessThan(5);
        expect(turned12, 'and then it turns').toBeGreaterThan(90);
        expect(freeTurned03, 'its own control: it turns at once').toBeGreaterThan(60);
        expect(free.character.reactionHold).toBeNull();
    }, 60000);

    it('staggered as it turns, it stops turning, steps, stays up and comes back to its animation without a snap', async () => {
        for (const worker of [false, true]) {
            const s = await play({ worker });
            // Running round in a circle: its facing turns at 400 degrees a second.
            let heading = 0;
            s.run(1, () => { heading += 400 * FRAME; s.walk(heading, true); });
            s.reactions.push([1.1, 0, 0]);
            const seen = new Set<string>();
            let spinLate = 0, worstGap = 0, worstJump = 0, last = s.drawnHips(), steps = 0;
            const pushedAt = s.time();
            s.run(4, () => {
                heading += 400 * FRAME;
                s.walk(heading, true);
                const since = s.time() - pushedAt;
                seen.add(s.reactions.state);
                const p = s.pelvis();
                if (s.reactions.state === 'stagger' && p && since > 0.3 && since < 0.6) spinLate = Math.max(spinLate, Math.abs(p.body.angularVelocity.y));
                if (s.reactions.state === 'stagger' && since > 0.3 && Number.isFinite(s.bodyYaw())) worstGap = Math.max(worstGap, Math.abs(wrap(s.yaw() - s.bodyYaw())));
                const now = s.drawnHips();
                if (since > 0.05) worstJump = Math.max(worstJump, Math.abs(wrap(now - last)));
                last = now;
                steps = Math.max(steps, s.reactions.balance?.steps ?? 0);
            });
            console.log(`[hold] ${worker ? 'worker' : 'inline'}: states ${[...seen].join('>')}, pelvis yaw rate 0.3-0.6 s ${spinLate.toFixed(2)} rad/s, capsule off the body ${worstGap.toFixed(1)} deg, drawn hips' biggest frame ${worstJump.toFixed(1)} deg, steps ${steps}`);
            expect(seen.has('stagger')).toBe(true);
            expect(seen.has('falling'), 'it stays up').toBe(false);
            expect(steps).toBeGreaterThan(0);
            expect(spinLate, 'it stops turning as it steps').toBeLessThan(1.5);
            expect(worstGap, 'the capsule faces the way the body does').toBeLessThan(15);
            expect(worstJump, 'no snap back to the animation').toBeLessThan(10);
        }
    }, 120000);

    it('turning with its walk does not throw its arms out; a shove still does', async () => {
        const s = await play();
        let heading = 0;
        s.run(0.5, () => { heading += 400 * FRAME; s.walk(heading, true); });
        // A light hit while it runs round: a flinch, no stagger.
        s.reactions.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 8 });
        let out = 0;
        s.run(1, () => { heading += 400 * FRAME; s.walk(heading, true); out = Math.max(out, (s.reactions as any)._running.get(armsOutBehaviour(s.reactions)) ?? 0); });
        expect(out, 'arms out on a walk\'s turn').toBe(0);
        s.reactions.push([0, 0, -1.6]);
        let shoved = 0;
        s.run(1, () => { shoved = Math.max(shoved, (s.reactions as any)._running.get(armsOutBehaviour(s.reactions)) ?? 0); });
        expect(shoved, 'arms out on a shove').toBeGreaterThan(0.5);
    }, 60000);
});

describe('an AI steering a reacting body (jolt)', () => {
    // Shot, an NPC's whiskers (and its sight, and its look ahead) met the limbs of its own reacting body round the
    // capsule they are cast from: it swerved from itself one way and the other every frame as it ran off.
    it('does not see its own limbs: its whiskers find nothing on open ground while its body reacts', async () => {
        const s = await play();
        const brain = new ControllerNode('brain');
        s.scene.addNode(brain);
        brain.possess(s.character);
        brain.steering.avoidDistance = 2;
        // Its rays from 1 m up (half its eye height), through the hips.
        brain.eyeHeight = 2.1;
        s.run(0.5, () => s.walk(0));
        s.reactions.hit({ part: 'Spine', direction: [0, 0, -1], impulse: 18 });
        s.run(0.1);
        expect(s.reactions.ragdoll, 'a body reacting').toBeTruthy();
        const b = brain as any;
        b._desired[0] = 0; b._desired[1] = 0; b._desired[2] = 1;
        b._probeObstacles(s.character);
        expect(b._probes, 'whisker hits').toEqual([]);
        expect(b._senseAhead('wallAhead', s.character), 'a wall ahead').toBe(false);
    }, 60000);
});

describe('what a hit lands on (jolt)', () => {
    it('a shot through the capsule past every limb grazes the nearest part on its surface, not the capsule surface', async () => {
        await acquirePhysicsBackend('jolt');
        const physics = groundWorld('jolt');
        played.push(physics);
        const node = humanoidModel();
        const r = physics.reactionsOf(node)!;
        // At the waist, 0.22 m to its right, along +Z: inside a 0.28 m capsule round the body, between the trunk and the
        // hanging right arm, missing both.
        const from = [-0.22, 1.15, -1], to = [-0.22, 1.15, 2];
        expect(r.partByRay(from, to)).toBeNull();
        const graze = r.partNearRay(from, to)!;
        expect(graze).not.toBeNull();
        // On that part's surface (its radius off its axis), toward the shot's line, not where the shot met the capsule.
        const seg = (r as any)._segments().find((s: any) => s.name === graze.part);
        const k = Math.max(0, seg.half - seg.r), p = graze.point;
        const t = Math.max(-k, Math.min(k, (p[0] - seg.c[0]) * seg.y[0] + (p[1] - seg.c[1]) * seg.y[1] + (p[2] - seg.c[2]) * seg.y[2]));
        const offAxis = Math.hypot(p[0] - seg.c[0] - seg.y[0] * t, p[1] - seg.c[1] - seg.y[1] * t, p[2] - seg.c[2] - seg.y[2] * t);
        expect(offAxis).toBeCloseTo(seg.r, 3);
        expect(Math.hypot(p[0] - from[0], p[1] - from[1])).toBeLessThan(Math.hypot(seg.c[0] - from[0], seg.c[1] - from[1]));
    }, 60000);

    it('a hand the support-hand IK holds on a weapon is never free for a wound, whatever the state says of it', async () => {
        await acquirePhysicsBackend('jolt');
        const physics = groundWorld('jolt');
        played.push(physics);
        const node = humanoidModel();
        const r = physics.reactionsOf(node)! as any;
        // The state says only the right hand is busy (the weapon's); the left is on its grip by the IK.
        r._effectsNow = () => ({ ...NO_REACTION_EFFECTS, busyHands: { R: true } });
        (node.animator as any)._handIkActive = 'left';
        expect(r._handFree('L')).toBe(false);
        expect(r._handFree('R')).toBe(false);
        (node.animator as any)._handIkActive = null;
        expect(r._handFree('L')).toBe(true);
    }, 60000);
});

/** The Arms out behaviour (what the controller's running weights are keyed by). */
function armsOutBehaviour(_r: ReactionController): unknown {
    return BEHAVIOURS.find(b => b.id === 'armsOut');
}

void (null as unknown as Node);
