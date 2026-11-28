import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { DEG, TICK, play, present, shoot, useNpcHooks } from './npcKit';

// The Sandbox's NPCs held by their reactions a moment after a hit (CharacterNode.reactionHold), on Jolt (reactions are
// Jolt's alone). A suite of its own: the NPC suite's fork reaches its heap's ceiling with every game it plays.

useNpcHooks();

describe.skipIf(!present)('the Sandbox\'s NPCs held by a hit (jolt)', { timeout: 300_000 }, () => {
    // Reported (2026-11-28): shot, a civilian sprinted off on the same frame, its capsule turning at 480 degrees a second
    // under a body that could not follow, its free arms flung out by the turn; a stagger begun in that turn came back
    // to its animation with the whole body snapped round. The reaction now holds its walk and its turning a moment
    // (CharacterNode.reactionHold), and its heading follows its body while it steps.
    it('shot facing the shooter, a civilian flinches before it runs off, its body never whipped round and its arms not flung out', async () => {
        const p = await play({ npcs: { 'Civilian 1': { at: [32, 0, -24], yaw: 180 } }, player: { at: [32, 0.02, -34], yaw: 0 } }, { physicsBackend: 'jolt' });
        const civ = p.npc('Civilian 1');
        p.watch(civ);
        const model = civ.children.find((c: any) => c.nodeType === 'model');
        const skin = model.model.skin;
        const hips = skin.joints.findIndex((j: any) => /Hips$/.test(skin.nodeNames.get(j.nodeIndex) ?? ''));
        expect(hips).toBeGreaterThanOrEqual(0);
        /** The hips' heading as drawn (degrees, against their bind). */
        const drawnHips = () => { const m = mat4.multiply(mat4.create(), model.worldTransform, model.animator.getFinalBoneMatrices()[hips]); return Math.atan2(m[8], m[10]) * DEG; };
        const yaw = () => { const f = civ.worldForward; return Math.atan2(f[0], f[2]) * DEG; };
        const wrap = (a: number) => ((a + 540) % 360) - 180;
        const armsOut = () => { for (const [b, w] of civ.reactions?._running ?? []) if (b.id === 'armsOut') return w; return 0; };
        await p.run(1);
        const before = yaw();
        shoot(p, [civ.worldPosition[0], civ.worldPosition[1] + 1.25, civ.worldPosition[2]]);
        let since = 0, turned = 0, worst = 0, last = drawnHips(), out = 0, swing = 0, lastAim: number | null = null;
        await p.run(3, undefined, () => {
            since += 1 / TICK;
            if (since <= 0.3) turned = Math.max(turned, Math.abs(wrap(yaw() - before)));
            const now = drawnHips();
            worst = Math.max(worst, Math.abs(wrap(now - last)));
            last = now;
            // Where its brain steers it, tick to tick, while it runs off (its whiskers swerved from its own limbs).
            const aim = civ.intent.aimYaw;
            if (civ.state === 'flee' && lastAim !== null && since > 0.4) swing = Math.max(swing, Math.abs(wrap(aim - lastAim)));
            lastAim = aim;
            out = Math.max(out, armsOut());
        });
        expect(p.states.get(civ)!, 'it runs off').toContain('flee');
        expect(turned, 'no turn in the flinch').toBeLessThan(5);
        // Its turn speed is 480 degrees a second, 16 a tick, its run's hips swinging a little on top: never a snap.
        expect(worst, 'the farthest the drawn hips turned in a tick').toBeLessThan(25);
        // Running off in a straight line, its brain steers it steadily: it did one way and the other every tick.
        expect(swing, 'the most its steering swung in a tick').toBeLessThan(10);
        expect(out, 'its arms out').toBe(0);
        expect(civ.reactions.state, 'still on its feet').not.toMatch(/falling|tumble|down/);
    });

    it('the player\'s control is never held by its reactions (its Flinch holds control is off)', async () => {
        const p = await play({ npcs: {}, player: { at: [32, 0.02, -34], yaw: 0 } }, { physicsBackend: 'jolt' });
        const model = p.player.children.find((c: any) => c.nodeType === 'model');
        expect(model.ragdollConfig?.reactions?.holdsControl).toBe(false);
        await p.run(0.5);
        p.player.reactions.push([0, 0, 1.1]);
        let held = false, staggered = false;
        await p.run(1.5, undefined, () => { held ||= !!p.player.reactionHold; staggered ||= p.player.reactions.state === 'stagger'; });
        expect(staggered).toBe(true);
        expect(held).toBe(false);
    });
});
