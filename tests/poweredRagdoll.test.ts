import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsBackendKind } from '../src/physics/pal/types';
import type { Ragdoll } from '../src/physics/ragdoll';
import { ragdollPartPose } from '../src/physics/ragdollProfile';
import type { AnimatedModel } from '../src/animation/animatedModel';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';

// A powered ragdoll (RagdollOptions.mode 'powered'): muscles on its joints, the animation running underneath as
// their target, the skeleton drawn by how much of each part the simulation owns (Animator physics mapping).

const BACKENDS: PhysicsBackendKind[] = ['cannon', 'rapier', 'jolt'];
const H = 1 / 60;

const MUSCLE = { frequency: 6, damping: 1, maxTorque: 400, gravityCompensation: 1 };
const PIN = { linearFrequency: 3, angularFrequency: 3, damping: 1, maxForce: 2500, maxTorque: 400 };

function pelvisOf(r: Ragdoll): vec3 {
    const p = r.parts[0].body.position;
    return vec3.fromValues(p.x, p.y, p.z);
}

describe.each(BACKENDS)('a powered ragdoll on %s', backend => {
    beforeAll(async () => { await acquirePhysicsBackend(backend); });
    // A WASM backend's heap may not grow (Jolt's is a fixed 128 MB): every world goes after its test.
    const made: { dispose(): void }[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); });

    function setup() {
        const physics = groundWorld(backend);
        made.push(physics);
        const node = humanoidModel();
        const ragdoll = physics.startRagdoll(node, { mode: 'powered' });
        return { physics, node, ragdoll };
    }
    const frame = (s: ReturnType<typeof setup>, before?: () => void) => {
        before?.();
        s.physics.update(H);
        s.node.animator!.update(H);
    };

    it('has its parts named, placed, roled and jointed', () => {
        const { ragdoll } = setup();
        expect(ragdoll.powered).toBe(true);
        expect(ragdoll.parts.length).toBe(16);
        const byName = new Map(ragdoll.parts.map(p => [p.name, p]));
        expect(byName.get('Pelvis')!.region).toBe('pelvis');
        expect(byName.get('Forearm L')!.role).toBe('foreArm.L');
        expect(byName.get('Forearm L')!.region).toBe('arms');
        expect(byName.get('Forearm L')!.hinge).toBe(true);
        expect(byName.get('Shin R')!.side).toBe('R');
        expect(byName.get('Head')!.region).toBe('neck');
        for (const p of ragdoll.parts) expect(p.joint === null, p.name).toBe(p.parent < 0);
        // A thigh holds up the shin and foot below it.
        expect(byName.get('Thigh L')!.subtree.length).toBe(3);
    });

    it('stands on its animation: muscles and pins hold it where the animation is', () => {
        const s = setup();
        const start = pelvisOf(s.ragdoll);
        let worst = 0;
        const poses: number[][] = [];
        for (let i = 0; i < 180; i++) {
            frame(s, () => s.ragdoll.followAnimation(MUSCLE, PIN));
            s.ragdoll.animatedPartPoses(poses);
            worst = Math.max(worst, vec3.distance(pelvisOf(s.ragdoll), poses[0].slice(0, 3) as vec3));
        }
        // Within a few centimetres of the animation all along (what 3 Hz strings sag under its weight), and not
        // sunk or risen from where it started by more.
        expect(worst).toBeLessThan(0.065);
        expect(vec3.distance(pelvisOf(s.ragdoll), start)).toBeLessThan(0.065);
        for (const p of s.ragdoll.parts) expect(Number.isFinite(p.body.position.y), p.name).toBe(true);
    });

    it('collapses without its pins and muscles, like a passive one', () => {
        const s = setup();
        const start = pelvisOf(s.ragdoll);
        for (let i = 0; i < 150; i++) frame(s);
        expect(pelvisOf(s.ragdoll)[1]).toBeLessThan(start[1] - 0.5);
    });

    it('draws the animation where a part weighs 0 and the body where it weighs 1', () => {
        const s = setup();
        for (let i = 0; i < 40; i++) frame(s);     // fall a little, so body and animation part
        const animator = s.node.animator!;
        const skin = (s.node.model as AnimatedModel).skin!;
        const bones = animator.getFinalBoneMatrices(), target = animator.getTargetBoneMatrices();
        const world = s.node.worldTransform as mat4;
        // Weight 1 (default): each part's own bone sits where its body is.
        for (const p of s.ragdoll.parts) {
            const drawn = ragdollPartPose(skin, p.layout, world, bones[p.layout.joint]);
            const b = p.body.position;
            expect(vec3.distance(drawn.center, [b.x, b.y, b.z]), p.name).toBeLessThan(1e-4);
        }
        // Weight 0 everywhere: the skin is the animation's, bit for bit.
        for (const p of s.ragdoll.parts) s.ragdoll.setMapping(p.index, 0);
        animator.update(H);
        for (let j = 0; j < bones.length; j++) expect(Array.from(bones[j])).toEqual(Array.from(target[j]));
    });

    it('resolves a ray to the part it hits', () => {
        const s = setup();
        const chest = s.ragdoll.findPart('Chest');
        const c = s.ragdoll.parts[chest].body.position;
        const hit = s.physics.raycast(vec3.fromValues(c.x, c.y, c.z + 2), vec3.fromValues(c.x, c.y, c.z - 2));
        expect(hit?.ragdoll).toBe(s.ragdoll);
        expect(hit?.part).toBe(chest);
        expect(s.ragdoll.partAt([c.x, c.y, c.z])?.part).toBe(chest);
    });

    it('takes a hit at a point on a part', () => {
        const s = setup();
        const hand = s.ragdoll.findPart('hand.L');
        const before = s.ragdoll.parts[hand].body.velocity.length();
        s.ragdoll.applyImpulse([0, 0, -4], null, hand);
        expect(s.ragdoll.parts[hand].body.velocity.length()).toBeGreaterThan(before + 1);
    });

    it('freezes at rest and comes back to life where it lies', () => {
        const s = setup();
        s.ragdoll.freeze();
        expect(s.ragdoll.frozen).toBe(true);
        const lying = pelvisOf(s.ragdoll);
        s.ragdoll.unfreeze();
        expect(s.ragdoll.frozen).toBe(false);
        for (const p of s.ragdoll.parts) if (p.parent >= 0) expect(p.joint, p.name).not.toBeNull();
        for (let i = 0; i < 120; i++) frame(s, () => s.ragdoll.followAnimation(MUSCLE, PIN));
        expect(vec3.distance(pelvisOf(s.ragdoll), lying)).toBeLessThan(0.065);
    });

    it('gives the skeleton back to the animation when it ends', () => {
        const s = setup();
        for (let i = 0; i < 30; i++) frame(s);
        s.physics.stopRagdoll(s.node);
        expect(s.node.animator!.physicsMapped).toBe(false);
        const bones = s.node.animator!.getFinalBoneMatrices(), target = s.node.animator!.getTargetBoneMatrices();
        expect(bones).toBe(target);
    });
});
