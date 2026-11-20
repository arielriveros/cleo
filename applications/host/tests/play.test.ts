// NetSync phase 6 end to end: carrying and throwing props, hitscan shots judged at the shooter's view, and
// projectiles that leave the muzzle at once. Sandbox, 150 ms RTT with jitter and 5 % loss; peer A predicts its own
// character, peer B is another player moving about.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { ControllerNode, Node } from 'cleo';
import { packExampleGame } from '../src/exampleGame';
import { LOSSY, TICK_MS, intent, world, type TestPeer, type World } from './helpers/world';

let bin: Uint8Array;
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];

/** A world where each peer gets a Player on open ground, with carrying and weapons at `trust`. */
async function playWorld(trust: 'coop' | 'versus') {
    const spawned = new Map<number, Node>();
    const w = await world(bin, {
        remote: (runtime) => ({
            possess: (peer) => {
                const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 5, 0.05, -30] })!;
                spawned.set(peer.id, root);
                return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
            },
        }),
        play: { trust },
    });
    const a = await w.join(LOSSY, 'predict');
    const b = await w.join({ ...LOSSY, seed: 9 });
    await w.run(45);
    /** A peer's character root (its Collider) on the host, and in a peer's scene. */
    const hostRoot = (p: TestPeer) => spawned.get(p.session.peerId)!;
    const seenBy = (viewer: TestPeer, p: TestPeer) => viewer.scene.getNodeById(hostRoot(p).id)!;
    return { w, a, b, hostRoot, seenBy };
}

beforeAll(async () => {
    bin = await packExampleGame(path.resolve(__dirname, '../../editor/public/examples/sandbox'));
}, 120_000);

describe('NetSync phase 6: carrying', () => {
    let x: Awaited<ReturnType<typeof playWorld>>;
    beforeAll(async () => { x = await playWorld('coop'); }, 120_000);
    afterAll(() => x.w.dispose());

    it('carries a prop on the carrier’s screen at once, and on the host where it is held', async () => {
        const { w, a, b, hostRoot } = x;
        const me = hostRoot(a);
        let crate: Node | null = null;
        await w.run(1, () => { crate = w.runtime.scene.instantiate('Small Crate', { position: [me.position[0] + 1.2, 0.4, me.position[2]] }); });
        await w.run(30);
        const mine = a.scene.getNodeById(crate!.id)!;
        expect(a.carry!.grab(mine)).toBe(true);
        // Held 1.2 m up and 1 m to the side of this peer's own (predicted) character.
        const held = () => { const p = a.scene.getNodeById(me.id)!.position; return [p[0] + 1, p[1] + 1.2, p[2]]; };
        a.hold = () => ({ pos: held(), rot: [0, 0, 0, 1] });
        await w.run(2);
        // On the carrier's screen: where it is held, now.
        expect(vec3.distance(mine.position as vec3, held() as vec3)).toBeLessThan(0.01);
        await w.run(20);
        expect(w.carry!.carrierOf(w.sync.netIdOf(crate!)!)).toBe(a.session.peerId);
        const hostHeld = [me.position[0] + 1, me.position[1] + 1.2, me.position[2]];
        expect(vec3.distance(crate!.position as vec3, hostHeld as vec3)).toBeLessThan(0.15);
        // Walking with it: it stays held on the host, within reach.
        a.drive = () => intent([0, 1]);
        await w.run(30);
        a.drive = null;
        await w.run(15);
        expect(vec3.distance(crate!.worldPosition, me.worldPosition)).toBeLessThan(2.5);
        // The other player sees it there too.
        expect(vec3.distance(b.scene.getNodeById(crate!.id)!.position as vec3, crate!.position as vec3)).toBeLessThan(0.1);

        // Another player cannot take it from the carrier.
        let refused = false;
        b.carry!.onRefused = () => { refused = true; };
        b.carry!.grab(b.scene.getNodeById(crate!.id)!);
        await w.run(15);
        expect(refused).toBe(true);
        expect(w.carry!.carrierOf(w.sync.netIdOf(crate!)!)).toBe(a.session.peerId);

        // The throw: it flies on the host, and on the carrier's screen without a jump at the hand-over.
        const from = vec3.clone(crate!.position as vec3);
        a.hold = null;
        a.carry!.throw([0, 4, 8]);
        const shown: vec3[] = [];
        await w.run(45, () => shown.push(vec3.clone(mine.position as vec3)));
        expect(vec3.distance(crate!.position as vec3, from)).toBeGreaterThan(3);
        let jump = 0;
        for (let i = 1; i < shown.length; i++) jump = Math.max(jump, vec3.distance(shown[i], shown[i - 1]));
        console.log(`throw: host prop flew ${vec3.distance(crate!.position as vec3, from).toFixed(2)} m; largest frame-to-frame step on the thrower's screen ${(jump * 100).toFixed(0)} cm`);
        // 8.9 m/s is ~30 cm a frame; a hand-over pop would be a metre or more.
        expect(jump).toBeLessThan(0.5);
        await w.run(60);
        expect(vec3.distance(mine.position as vec3, crate!.position as vec3)).toBeLessThan(0.02);
    });
});

describe('NetSync phase 6: hitscan', () => {
    let x: Awaited<ReturnType<typeof playWorld>>;
    beforeAll(async () => { x = await playWorld('coop'); }, 120_000);
    afterAll(() => x.w.dispose());

    it('hits a moving player where the shooter saw it, which the host’s present would miss', async () => {
        const { w, a, b, hostRoot, seenBy } = x;
        const hits: string[] = [];
        a.weapons!.onHit = (h) => hits.push(h.nodeId);
        // B runs across A's line of fire (they stand side by side along X; B runs along Z).
        b.drive = () => intent([0, 1]);
        await w.run(25);
        const shots = 5;
        for (let i = 0; i < shots; i++) {
            await w.run(4, (tick) => {
                if (tick % 4) return;
                // A aims at the middle of B's capsule as A sees it now (followed, so a little in the past).
                const origin = vec3.add(vec3.create(), a.scene.getNodeById(hostRoot(a).id)!.position as vec3, [0, 1.5, 0]);
                const target = vec3.add(vec3.create(), seenBy(a, b).position as vec3, [0, 0.9, 0]);
                const dir = vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), target, origin));
                a.weapons!.shoot('rifle', origin, dir, seenBy(a, b));
            });
        }
        b.drive = null;
        await w.run(15);
        const s = w.weapons!.stats;
        console.log(`hitscan at 150 ms: ${s.shots} shots, ${s.hits} hits (${s.savedByRewind} only thanks to the rewind, ${s.claimsAccepted} on a claim), ${s.refused} refused`);
        expect(s.hits).toBe(shots);
        expect(s.claimsAccepted).toBe(0);
        expect(s.savedByRewind).toBeGreaterThanOrEqual(3);
        // Every peer is told, with the node that was hit.
        expect(hits.filter((id) => id === hostRoot(b).id).length).toBe(shots);
    });
});

describe('NetSync phase 6: trust', () => {
    for (const trust of ['coop', 'versus'] as const) {
        it(`${trust}: judges a near miss claimed as a hit, a forged claim, and an old view`, async () => {
            const x = await playWorld(trust);
            const { w, a, b, hostRoot, seenBy } = x;
            try {
                const origin = () => vec3.add(vec3.create(), a.scene.getNodeById(hostRoot(a).id)!.position as vec3, [0, 1.5, 0]);
                const aimAt = (offset: [number, number, number]) => {
                    const target = vec3.add(vec3.create(), seenBy(a, b).position as vec3, [0.0 + offset[0], 0.9 + offset[1], offset[2]]);
                    return vec3.normalize(vec3.create(), vec3.subtract(vec3.create(), target, origin()));
                };
                const s = w.weapons!.stats;
                // A near miss, 0.45 m over B's capsule middle... still 0.45 m above its head line: claimed as a hit.
                a.weapons!.shoot('rifle', origin(), aimAt([0, 1.35, 0]), seenBy(a, b));
                await w.run(10);
                const nearMiss = s.hits;
                // A forged claim: aimed into the sky, claiming B.
                a.weapons!.shoot('rifle', origin(), [0, 1, 0], seenBy(a, b));
                await w.run(10);
                const forged = s.hits - nearMiss;
                // A shot claiming an old view (a second ago), aimed where B is now.
                const old = new (a.weapons as any).constructor(a.session, a.sync);
                old.viewTick = () => w.tick - 30;
                old.shoot('rifle', origin(), aimAt([0, 0, 0]), null);
                await w.run(10);
                const refusedOld = s.refused;
                console.log(`${trust}: near-miss claim ${nearMiss ? 'accepted' : 'refused'}, forged claim ${forged ? 'ACCEPTED' : 'refused'}, old view ${refusedOld ? 'refused' : 'clamped'}`);
                expect(forged).toBe(0);
                if (trust === 'coop') {
                    expect(nearMiss).toBe(1);
                    expect(s.claimsAccepted).toBe(1);
                    expect(refusedOld).toBe(0);
                } else {
                    expect(nearMiss).toBe(0);
                    expect(s.claimsAccepted).toBe(0);
                    expect(refusedOld).toBe(1);
                }
            } finally { w.dispose(); }
        }, 120_000);
    }
});

describe('NetSync phase 6: projectiles', () => {
    let x: Awaited<ReturnType<typeof playWorld>>;
    beforeAll(async () => { x = await playWorld('coop'); }, 120_000);
    afterAll(() => x.w.dispose());

    it('flies a stand-in at once, swaps it for the host’s projectile without a jump, and lands where the host does', async () => {
        const { w, a, hostRoot } = x;
        const origin = vec3.add(vec3.create(), a.scene.getNodeById(hostRoot(a).id)!.position as vec3, [0, 1.6, 1]);
        // A lob that lands on the course a few metres away (a longer throw leaves the map and never settles).
        const velocity: [number, number, number] = [0, 4, 5];
        // The stand-in: the same template (a small crate, lobbed like a grenade), launched in A's own physics now.
        const standIn = a.scene.instantiate('Small Crate', { position: [origin[0], origin[1], origin[2]] })!;
        (standIn as any).body.velocity.set(...velocity);
        a.weapons!.fire('Small Crate', origin, velocity, standIn);
        const shown: vec3[] = [];
        let real: Node | null = null;
        const before = new Set([...w.runtime.scene.nodes].map((n) => n.id));
        await w.run(60, () => {
            real ??= [...w.runtime.scene.nodes].find((n: any) => !before.has(n.id) && n.nodeType === 'collider') ?? null;
            const mine = real && a.scene.getNodeById(real.id);
            shown.push(vec3.clone(((mine && !standIn.scene ? mine : standIn).position) as vec3));
        });
        expect(w.weapons!.stats.lastRefusal).toBe('');
        expect(real).toBeTruthy();
        expect(standIn.scene).toBeFalsy(); // swapped out
        let jump = 0;
        for (let i = 1; i < shown.length; i++) jump = Math.max(jump, vec3.distance(shown[i], shown[i - 1]));
        // Until it is at rest on the host (a ball rolls on; a peer draws a moving one a little in the past).
        for (let i = 0; i < 20 && (real as any).body.velocity.length() > 0.01; i++) await w.run(30);
        expect((real as any).body.velocity.length()).toBeLessThan(0.01);
        await w.run(15);
        const landedHere = a.scene.getNodeById(real!.id)!.position as vec3;
        console.log(`projectile: largest frame-to-frame step on the shooter's screen ${(jump * 100).toFixed(0)} cm (flying ~21 cm/frame); lands ${(vec3.distance(landedHere, real!.position as vec3) * 100).toFixed(1)} cm from the host's`);
        expect(w.weapons!.stats.fired).toBe(1);
        expect(jump).toBeLessThan(0.5);
        expect(vec3.distance(landedHere, real!.position as vec3)).toBeLessThan(0.02);
    });
});
