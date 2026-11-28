import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { acquirePhysicsBackend } from '../src/physics/pal/createWorld';
import type { PhysicsSystem } from '../src/physics/physicsSystem';
import { autoHumanoidProfile } from '../src/physics/ragdollProfile';
import { resetScriptChannels } from '../src/core/events/hub';
import { groundWorld, humanoidModel } from './helpers/humanoidRig';

// Balance under a shove (the user's "balance preservation is still bad"): a body standing at the origin, facing +Z,
// shoved forward, back, to its left and to its right, softly to hard. It steps with whichever foot catches it best
// (balancer.ts), its planted legs on muscles sized to the weight they carry, and it falls only when its steps cannot. On the automatic humanoid and on one built like the Sandbox's Mannequin (thighs that bend forward
// further than back). Its own file: every reacting world grows Jolt's wasm heap.

const H = 1 / 60;
type Dir = 'forward' | 'back' | 'left' | 'right';
const DIRS: Record<Dir, [number, number, number]> = { forward: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0] };

describe('balance under a shove (jolt)', () => {
    beforeAll(async () => { await acquirePhysicsBackend('jolt'); });
    const made: PhysicsSystem[] = [];
    afterEach(() => { for (const p of made.splice(0)) p.dispose(); resetScriptChannels(); });

    function shove(dir: Dir, impulse: number, mannequin: boolean) {
        const physics = groundWorld('jolt');
        made.push(physics);
        const node = humanoidModel();
        if (mannequin) {
            // Thighs as the Sandbox's Mannequin now has them: a cone of 58° tilted 32° forward.
            const skin = (node.model as any).skin;
            const profile = autoHumanoidProfile(skin)!;
            for (const p of profile.parts) if (/thigh/i.test(p.name)) p.joint = { ...p.joint, type: 'cone', swing: 58, twist: 35, tilt: [32, 0] } as any;
            skin.ragdollProfile = profile;
        }
        const r = physics.reactionsOf(node)!;
        let fell = false, staggered = false, steps = 0, longest = 0, lowest = Infinity, gaveUp: string | null = null;
        try {
        for (let f = 0; f < 300; f++) {
            if (f === 5) r.push(DIRS[dir].map(v => v * impulse / 70));
            physics.update(H);
            node.animator!.update(H);
            if (r.state === 'falling') fell = true;
            if (r.state === 'stagger') staggered = true;
            const b = r.balance;
            if (b) { steps = Math.max(steps, b.steps); longest = Math.max(longest, ...b.stepLengths, 0); gaveUp = b.gaveUp ?? gaveUp; }
            if (r.ragdoll) lowest = Math.min(lowest, r.ragdoll.parts[0].body.position.y);
        }
        } finally {
            // At once: a world per shove, and every one grows Jolt's heap.
            made.splice(made.indexOf(physics), 1);
            physics.dispose();
        }
        return { dir, impulse, fell, staggered, steps, longest, gaveUp, lowest, state: r.state };
    }

    for (const mannequin of [false, true]) for (const dir of Object.keys(DIRS) as Dir[]) {
        it(`${mannequin ? 'built like the Mannequin' : 'the automatic humanoid'}, shoved ${dir}: stays up to 120 N·s in short steps, and falls past it only after stepping`, () => {
            const rows: ReturnType<typeof shove>[] = [];
            for (const J of [60, 90, 120, 145]) rows.push(shove(dir, J, mannequin));
            for (const r of rows) console.log(`${mannequin ? 'mannequin' : 'auto'} ${r.dir.padEnd(7)} ${String(r.impulse).padStart(3)} N·s: ${r.fell ? `FELL (${r.gaveUp})` : 'up'}, ${r.steps} steps, longest ${r.longest.toFixed(2)} m, lowest pelvis ${Number.isFinite(r.lowest) ? r.lowest.toFixed(2) : '-'}, ends ${r.state}`);
            for (const r of rows) {
                if (r.impulse <= 120) expect(r.fell, `${r.dir} ${r.impulse}`).toBe(false);
                if (r.fell) expect(r.steps, `${r.dir} ${r.impulse}`).toBeGreaterThanOrEqual(1);
                expect(r.longest, `${r.dir} ${r.impulse}`).toBeLessThan(0.46);
            }
        });
    }
});
