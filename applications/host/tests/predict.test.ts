// NetSync phase 5 end to end: a peer predicts its own character. It simulates it locally, ahead of the host, so
// the character answers its player at once; it compares what it predicted with what the host says and corrects.
// 150 ms RTT with jitter and 5 % loss throughout.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { ControllerNode, Node } from 'cleo';
import { packExampleGame } from '../src/exampleGame';
import { LOSSY, intent, world, type TestPeer, type World } from './helpers/world';

let w: World;
let me: TestPeer;
const spawned = new Map<number, Node>();
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];

/** Where the character's body is: on the host, and in this peer's own (predicted) scene. */
const onHost = () => vec3.clone(spawned.get(me.session.peerId)!.position as vec3);
const local = () => vec3.clone(me.scene.getNodeById(spawned.get(me.session.peerId)!.id)!.position as vec3);
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };

beforeAll(async () => {
    const bin = await packExampleGame(path.resolve(__dirname, '../../editor/public/examples/sandbox'));
    w = await world(bin, {
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 4, 0.05, -30] })!;
                spawned.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
        }),
    });
    me = await w.join(LOSSY, 'predict');
    await w.run(45); // possessed, spawned, landed, clocks synced
}, 120_000);
afterAll(() => w.dispose());

describe('NetSync phase 5: a peer predicts its own character', () => {
    it('simulates its own character, while the host bodies are followers here', () => {
        expect(me.predictor!.pawn).toBeTruthy();
        const body = (me.predictor!.pawn!.parent as any).body;
        expect(body.isDynamic).toBe(true);
        // A prop on this peer is a follower: static, no collision response.
        const crate = [...me.scene.nodes].find((n: any) => n.nodeType === 'collider' && n.name === 'Crate Collider') as any;
        expect(crate.mass).toBe(0);
        expect(crate.body.simulatePhysics).toBe(false);
        // Ahead of the host, by about half the round trip.
        expect(me.predictor!.lastTick).toBeGreaterThan(w.tick);
    });

    it('answers its player at once, a round trip before the host could', async () => {
        const local0 = local(), host0 = onHost();
        let localAt = -1, hostAt = -1, frame = 0;
        me.drive = () => intent([0, 1]);
        // Frame by frame (one host tick each): when does the character move, here and on the host?
        await w.run(20, () => {
            if (localAt < 0 && vec3.distance(local(), local0) > 0.005) localAt = frame;
            if (hostAt < 0 && vec3.distance(onHost(), host0) > 0.005) hostAt = frame;
            frame++;
        });
        me.drive = null;
        await w.run(30);
        console.log(`moving after input: here after ${localAt} frames, on the host after ${hostAt}`);
        expect(localAt).toBeGreaterThanOrEqual(0);
        expect(localAt).toBeLessThanOrEqual(2);
        expect(hostAt - localAt).toBeGreaterThanOrEqual(2);
    });

    it('keeps its prediction on the host’s path across the open course: walk, strafe, sprint, jump, stop', async () => {
        const stats = me.predictor!.stats;
        const before = { checked: stats.checked, corrections: stats.corrections, errors: stats.errors.length };
        const plan: [number, (t: number) => ReturnType<typeof intent>][] = [
            [30, () => intent([0, 1])],
            [30, () => intent([1, 0])],
            [30, () => intent([0, 1], (i) => { i.sprint = true; })],
            [1, () => intent([0, 1], (i) => { i.requests.jump = 0.2; })],
            [30, () => intent([0, 1])],
            [30, () => intent([-0.7, -0.7])],
        ];
        for (const [ticks, drive] of plan) { me.drive = drive; await w.run(ticks); }
        me.drive = null;
        await w.run(45);
        const checked = stats.checked - before.checked;
        const corrected = stats.corrections - before.corrections;
        const errors = stats.errors.slice(before.errors);
        console.log(`open course: ${checked} host states checked, ${corrected} corrected (${(100 * corrected / checked).toFixed(1)} %), ` +
            `error p50 ${(pct(errors, 0.5) * 100).toFixed(1)} cm, p95 ${(pct(errors, 0.95) * 100).toFixed(1)} cm, max ${(Math.max(...errors) * 100).toFixed(1)} cm; ` +
            `here vs host at rest ${(vec3.distance(local(), onHost()) * 100).toFixed(1)} cm`);
        expect(checked).toBeGreaterThan(100);
        expect(corrected / checked).toBeLessThan(0.1);
        expect(vec3.distance(local(), onHost())).toBeLessThan(0.03);
    });

    it('corrects to the host when the character runs into props it does not collide with here', async () => {
        const stats = me.predictor!.stats;
        const before = { checked: stats.checked, corrections: stats.corrections, snaps: stats.snaps, errors: stats.errors.length };
        // A wall of crates across the character's path, on the host (followers on this peer).
        const at = onHost();
        await w.run(1, () => {
            for (let i = -3; i <= 3; i++) w.runtime.scene.instantiate('Large Crate', { position: [at[0] + i * 1.2, 0.6, at[2] + 4] });
        });
        await w.run(30);
        const forward = vec3.subtract(vec3.create(), [at[0], at[1], at[2] + 4] as vec3, at);
        // Toward the crates (the move basis is world-fixed here: forward is whichever way +Z goes for this rig).
        me.drive = () => intent([0, Math.sign(forward[2]) || 1]);
        await w.run(60);
        me.drive = null;
        await w.run(45);
        const checked = stats.checked - before.checked;
        const corrected = stats.corrections - before.corrections;
        const errors = stats.errors.slice(before.errors);
        console.log(`into props: ${checked} checked, ${corrected} corrected, ${stats.snaps - before.snaps} snaps, ` +
            `error p95 ${(pct(errors, 0.95) * 100).toFixed(1)} cm, max ${(Math.max(...errors) * 100).toFixed(1)} cm; ` +
            `here vs host at rest ${(vec3.distance(local(), onHost()) * 100).toFixed(1)} cm`);
        // Whatever happened on the way, it ends where the host says.
        expect(vec3.distance(local(), onHost())).toBeLessThan(0.03);
    });
});
