import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { quat } from 'gl-matrix';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsSystem } from '../src/physics/physicsSystem';
import type { ModelNode } from '../src/core/scene/nodes/modelNode';
import type { Animation, AnimationLayer } from '../src/cleoCore';
import { resetScriptChannels } from '../src/core/events/hub';
import { groundWorld, humanoidModel, IDLE, boneIndex } from './helpers/humanoidRig';
import { quatConjugateTuple, quatMultiplyTuple, quatToRotationVector } from '../src/core/math';

// Arms that wiggle after a hit (the user's "wiggly arms"): a body on its feet, both hands busy on a weapon, a recoil
// layer kicking the arms and the spine at a rifle's 7.5 rounds a second, and a round in the chest. The muscles once
// reached for the whole drawn pose, the recoil's jerks in it fed forward as a velocity: the simulated arms rang. A
// layer drawn over the body (AnimationLayer.body 'overlay') is not in what the muscles reach for.
//
// Measured on the simulated body: per arm joint, the RMS of its angular velocity's fast part (what a 0.1 s moving
// average leaves out) over 1.5 s from the hit, and how often the elbow's turn reverses. Its own file: each reacting
// world grows Jolt's wasm heap.

const H = 1 / 60;
const RATE = 7.5;

/** An additive kick on the arms and the spine, from the idle pose, `RATE` times a second (looped). */
function recoil(kick = 0.1): Animation {
    const idle: Record<string, quat> = {
        LeftArm: quat.setAxisAngle(quat.create(), [0, 0, 1], -75 * Math.PI / 180),
        RightArm: quat.setAxisAngle(quat.create(), [0, 0, 1], 75 * Math.PI / 180),
        LeftForeArm: quat.setAxisAngle(quat.create(), [0, 1, 0], -15 * Math.PI / 180),
        RightForeArm: quat.setAxisAngle(quat.create(), [0, 1, 0], 15 * Math.PI / 180),
        Spine2: quat.create(),
    };
    const period = 1 / RATE, times = [0, 0.02, 0.1, period];
    const samplers: Animation['samplers'] = [], channels: Animation['channels'] = [];
    for (const [bone, base] of Object.entries(idle)) {
        const kicked = quat.multiply(quat.create(), base, quat.setAxisAngle(quat.create(), [1, 0, 0], kick));
        samplers.push({ input: times, output: [...base, ...kicked, ...base, ...base], interpolation: 'LINEAR' });
        channels.push({ samplerIndex: samplers.length - 1, targetNodeIndex: boneIndex(bone), targetPath: 'rotation' });
    }
    return { name: 'Recoil', samplers, channels };
}

describe('arm wiggle after a hit, firing (jolt)', () => {
    beforeAll(async () => { await acquirePhysicsBackend('jolt'); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });

    function shotWhileFiring(body: AnimationLayer['body']) {
        const physics = groundWorld('jolt');
        made.push(physics);
        const node: ModelNode = humanoidModel([IDLE(), recoil()]);
        node.animator!.setStateMachine({
            parameters: [], events: [], transitions: [],
            states: [{ name: 'Idle', clipName: 'Idle', loop: true, speed: 1, isEntry: true }],
            layers: [{ name: 'Recoil', blend: 'additive', body, states: [{ name: 'Kick', clipName: 'Recoil', loop: true, speed: 1, isEntry: true }], transitions: [] }],
        });
        const r = physics.reactionsOf(node)!;
        r.busyHands = { L: true, R: true };
        const arms = () => ['upperArm.L', 'foreArm.L', 'hand.L', 'upperArm.R', 'foreArm.R', 'hand.R'].map(s => r.ragdoll!.findPart(s));
        let parts: number[] = [];
        const prev = new Map<number, number[]>(), ema = new Map<number, number[]>();
        let sum = 0, count = 0, reversals = 0, lastSign = 0, sway = 0;
        for (let f = 0; f < 120; f++) {
            if (f === 20) r.hit({ part: 'Chest', direction: [0, 0, -1], impulse: 18 });
            physics.update(H);
            node.animator!.update(H);
            if (f < 21 || !r.ragdoll) continue;
            if (!parts.length) parts = arms();
            const rp = r.ragdoll.parts;
            for (const i of parts) {
                const b = rp[i].body.quaternion, pb = rp[rp[i].parent].body.quaternion;
                const rel = quatMultiplyTuple([-pb.x, -pb.y, -pb.z, pb.w], [b.x, b.y, b.z, b.w]);
                const was = prev.get(i);
                prev.set(i, rel);
                if (!was) continue;
                const w = quatToRotationVector(quatMultiplyTuple(rel, quatConjugateTuple(was))).map(v => v / H);
                const m = ema.get(i) ?? [...w];
                for (let k = 0; k < 3; k++) m[k] += (w[k] - m[k]) * (H / 0.1);
                ema.set(i, m);
                sum += (w[0] - m[0]) ** 2 + (w[1] - m[1]) ** 2 + (w[2] - m[2]) ** 2;
                count++;
                if (rp[i].role === 'foreArm.L') {
                    const fast = w[0] - m[0] + w[1] - m[1] + w[2] - m[2];
                    const sign = Math.abs(fast) > 0.3 ? Math.sign(fast) : 0;
                    if (sign !== 0 && lastSign !== 0 && sign !== lastSign) reversals++;
                    if (sign !== 0) lastSign = sign;
                }
            }
            // How far the chest sways from where the animation has it.
            const c = r.ragdoll.findPart('chest') >= 0 ? r.ragdoll.findPart('chest') : r.ragdoll.findPart('spine');
            if (c >= 0) {
                const cq = rp[c].body.quaternion, pq = rp[rp[c].parent].body.quaternion;
                const rel = quatMultiplyTuple([-pq.x, -pq.y, -pq.z, pq.w], [cq.x, cq.y, cq.z, cq.w]);
                sway = Math.max(sway, Math.hypot(...quatToRotationVector(rel)));
            }
        }
        return { wiggle: Math.sqrt(sum / Math.max(1, count)), reversals: reversals / 1.5, sway, alive: r.alive };
    }

    it("keeps a fast layer drawn over the body out of its muscles: the arms ring less than half as much, the hit still sways it", () => {
        const follow = shotWhileFiring('follow');
        const overlay = shotWhileFiring('overlay');
        console.log(`wiggle: following the recoil ${follow.wiggle.toFixed(3)} rad/s (${follow.reversals.toFixed(1)} elbow reversals/s), drawn over ${overlay.wiggle.toFixed(3)} (${overlay.reversals.toFixed(1)}/s); sway ${overlay.sway.toFixed(3)} rad`);
        expect(overlay.wiggle).toBeLessThan(follow.wiggle * 0.5);
        expect(overlay.reversals).toBeLessThanOrEqual(3);
        expect(overlay.sway).toBeGreaterThan(0.02);
        expect(overlay.alive).toBe(true);
    });
});
