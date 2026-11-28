import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { quat, vec3 } from 'gl-matrix';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsSystem } from '../src/physics/physicsSystem';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';
import type { ReactionController, ReactionEventInfo } from '../src/physics/reactive/reactionController';
import { getChannel, resetScriptChannels } from '../src/core/events/hub';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';

// Where a hit lands decides how it reacts (the reactions' zones: head, chest, gut, back, arm, leg), and the pain it
// leaves. On Jolt, the procedural person standing (tests/helpers/humanoidRig.ts); in a file of its own, as every
// reacting body's world takes Jolt heap the reactions suite already fills.

const H = 1 / 60;

describe('hits by where they land (jolt)', () => {
    beforeAll(async () => { await acquirePhysicsBackend('jolt'); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });
    const person = () => {
        const physics = groundWorld('jolt');
        made.push(physics);
        const node = humanoidModel();
        return { physics, node, r: physics.reactionsOf(node)! };
    };
    const step = (s: { physics: PhysicsSystem; node: ModelNode }) => { s.physics.update(H); s.node.animator!.update(H); s.physics.endFrame?.(H); };
    const angle = (a: ArrayLike<number>, b: ArrayLike<number>) => 2 * Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3])));
    const rel = (poses: number[][], pelvis: number, i: number) => quat.multiply(quat.create(),
        quat.conjugate(quat.create(), [poses[pelvis][3], poses[pelvis][4], poses[pelvis][5], poses[pelvis][6]]), [poses[i][3], poses[i][4], poses[i][5], poses[i][6]]);

    /** The chest's lean against the hips, as simulated against as animated: + forward (radians), and its turn round the spine. */
    const lean = (s: { r: ReactionController }) => {
        const b = s.r.body!;
        const fwd = (poses: number[][]) => {
            const r = rel(poses, b.pelvis, b.chest);
            const y = vec3.transformQuat(vec3.create(), [0, 1, 0], r), z = vec3.transformQuat(vec3.create(), [0, 0, 1], r);
            return { pitch: Math.atan2(y[2], y[1]), yaw: Math.atan2(z[0], z[2]) };
        };
        const a = fwd(b.sim), n = fwd(b.anim);
        return { pitch: a.pitch - n.pitch, yaw: a.yaw - n.yaw };
    };

    it('reacts by where a hit lands: the gut folds, the back arches, an arm turns the trunk, each Hit naming its zone', () => {
        const zones: string[] = [];
        getChannel('reaction').on('Hit', (info: ReactionEventInfo) => zones.push(info.zone ?? ''));
        const run = (part: string, dir: [number, number, number], impulse = 20) => {
            const s = person();
            let forwardMost = 0, backMost = 0, turnMost = 0;
            for (let f = 0; f < 90; f++) {
                if (f === 5) s.r.hit({ part, direction: dir, impulse });
                step(s);
                if (!s.r.body || !['hitReact', 'recover'].includes(s.r.state)) continue;
                const l = lean(s);
                forwardMost = Math.max(forwardMost, l.pitch); backMost = Math.max(backMost, -l.pitch); turnMost = Math.max(turnMost, Math.abs(l.yaw));
            }
            return { forwardMost, backMost, turnMost };
        };
        // In the gut from in front: it folds over it (forward), though the hit pushes it back.
        const gut = run('Spine', [0, 0, -1]);
        // From behind: it arches (back), though the hit pushes it forward.
        const back = run('Chest', [0, 0, 1]);
        // The left upper arm from in front: the trunk turns with it.
        const arm = run('Upper Arm L', [0, 0, -1]);
        const chest = run('Chest', [0, 0, -1]);
        expect(zones).toEqual(['gut', 'back', 'arm', 'chest']);
        expect(gut.forwardMost).toBeGreaterThan(0.05);
        expect(back.backMost).toBeGreaterThan(0.05);
        expect(arm.turnMost).toBeGreaterThan(chest.turnMost * 0.8);
    });

    it('shot in a leg: the Hit names the leg, the trunk is not tipped toward the shooter, and a hard one staggers it, the knee giving', () => {
        const parts: string[] = [];
        getChannel('reaction').on('Hit', (info: ReactionEventInfo) => parts.push(`${info.partName}:${info.zone}`));
        const soft = person();
        let tipped = 0;
        for (let f = 0; f < 60; f++) {
            if (f === 5) soft.r.hit({ part: 'Shin L', direction: [0, 0, -1], impulse: 8 });
            step(soft);
            if (soft.r.body && soft.r.state === 'hitReact') tipped = Math.max(tipped, lean(soft).pitch);
        }
        // The kick at the trunk's centre: no forward tip from a push low on the body.
        expect(tipped).toBeLessThan(0.05);
        const hard = person();
        const qOf = (i: number) => { const b = hard.r.ragdoll!.parts[i].body.quaternion; return [b.x, b.y, b.z, b.w]; };
        let knee = 0, staggered = false;
        for (let f = 0; f < 90; f++) {
            if (f === 5) hard.r.hit({ part: 'Thigh L', direction: [0, 0, -1], impulse: 26 });
            step(hard);
            const b = hard.r.body;
            if (b && hard.r.state === 'stagger') {
                staggered = true;
                knee = Math.max(knee, angle(qOf(b.legs.L!.root), qOf(b.legs.L!.mid)));
            }
        }
        expect(parts.map(p => p.split(':')[1])).toEqual(['leg', 'leg']);
        expect(parts[0].startsWith('Shin')).toBe(true);
        expect(staggered).toBe(true);
        expect(knee).toBeGreaterThan(0.25);
    });

    it('hurts: its pain rises with a hit, by how bad, and eases off; a bad wound is kept longer than a slight one', () => {
        const s = person();
        let peak = 0;
        for (let f = 0; f < 60; f++) { if (f === 5) s.r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 25 }); step(s); peak = Math.max(peak, s.r.pain); }
        expect(peak).toBeGreaterThan(0.2);
        for (let f = 0; f < 60 * 8; f++) step(s);
        expect(s.r.pain).toBeLessThan(peak * 0.2);
        // Five wounds: the slightest goes, not the first.
        const t = person();
        for (const [i, impulse] of [40, 5, 30, 35, 45].entries()) { t.r.hit({ part: i % 2 ? 'Spine' : 'Chest', direction: [0, 0, -1], impulse }); step(t); }
        expect(t.r.wounds.map(w => Math.round(w.severity * 100))).not.toContain(Math.round(Math.min(1, 5 / t.r.set.thresholds.fallImpulse * 2) * 100));
    });
});
