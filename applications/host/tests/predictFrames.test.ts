// A browser peer simulates frame by frame, not in host ticks (PeerFrames): its engine runs its own loop at the
// display's rate, and the character is sampled at each host tick its clock passes. Here three peers drive the same
// course at once — one stepping in ticks (as phase 5 tests), one at 60 Hz, one at an uneven 7–25 ms — and each
// must stay on the host's path. 150 ms RTT with jitter and 5 % loss.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { ControllerNode, Node } from 'cleo';
import { packExampleGame } from '../src/exampleGame';
import { LOSSY, intent, world, type TestPeer, type World } from './helpers/world';

let w: World;
const spawned = new Map<number, Node>();
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))] ?? 0; };
let peers: { label: string; p: TestPeer }[] = [];

beforeAll(async () => {
    const bin = await packExampleGame(path.resolve(__dirname, '../../editor/public/examples/sandbox'));
    w = await world(bin, {
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 5, 0.05, -30] })!;
                spawned.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
        }),
    });
    peers = [
        { label: 'ticks', p: await w.join(LOSSY, 'predict') },
        { label: '60 Hz frames', p: await w.join({ ...LOSSY, seed: 5 }, 'frames', [1000 / 60]) },
        { label: 'uneven frames', p: await w.join({ ...LOSSY, seed: 6 }, 'frames', [7, 16, 25, 9, 31, 12]) },
    ];
    await w.run(45);
}, 120_000);
afterAll(() => w.dispose());

describe('NetSync: a peer simulating frame by frame', () => {
    it('stays on the host’s path across the open course, at any frame rate', async () => {
        const before = peers.map(({ p }) => ({ checked: p.predictor!.stats.checked, corrections: p.predictor!.stats.corrections, errors: p.predictor!.stats.errors.length }));
        const plan: [number, () => ReturnType<typeof intent>][] = [
            [30, () => intent([0, 1])],
            [30, () => intent([1, 0])],
            [30, () => intent([0, 1], (i) => { i.sprint = true; })],
            [1, () => intent([0, 1], (i) => { i.requests.jump = 0.2; })],
            [30, () => intent([0, 1])],
            [30, () => intent([-0.7, -0.7])],
        ];
        for (const [ticks, drive] of plan) { for (const { p } of peers) p.drive = drive; await w.run(ticks); }
        for (const { p } of peers) p.drive = null;
        await w.run(45);
        for (const [i, { label, p }] of peers.entries()) {
            const st = p.predictor!.stats;
            const checked = st.checked - before[i].checked, corrected = st.corrections - before[i].corrections;
            const errors = st.errors.slice(before[i].errors);
            const root = spawned.get(p.session.peerId)!;
            const off = vec3.distance(root.position as vec3, p.scene.getNodeById(root.id)!.position as vec3);
            console.log(`${label}: ${checked} checked, ${corrected} corrected (${(100 * corrected / checked).toFixed(1)} %), error p50 ${(pct(errors, 0.5) * 100).toFixed(1)} cm, ` +
                `p95 ${(pct(errors, 0.95) * 100).toFixed(1)} cm, max ${(Math.max(...errors) * 100).toFixed(1)} cm; at rest ${(off * 100).toFixed(1)} cm; ` +
                `frames ${p.frames ? `${p.frames.ticks} ticks, ${p.frames.skipped} skipped` : '-'}`);
            expect(checked).toBeGreaterThan(100);
            // Spreading a tick's intent over the frames that fell in it integrates a little differently from the
            // host's one step: centimetres, corrected (blended) as they come. Measured 60 Hz p95 2.8 cm, uneven
            // 6.5 cm; ticks 0.1 cm.
            expect(pct(errors, 0.95)).toBeLessThan(0.1);
            expect(Math.max(...errors)).toBeLessThan(0.2);
            expect(off).toBeLessThan(0.03);
            if (p.frames) expect(p.frames.skipped).toBe(0);
        }
    });
});
