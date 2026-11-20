// NetSync phase 3 end to end, in one process: the Sandbox runs on a HostRuntime; peers hold their own copy of the
// same scene (parsed from the same game.bin, not simulated) and follow the host's over loopback links with a
// 150 ms round trip, jitter and 5 % loss — or a TCP-like link standing in for the WebSocket fallback.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import type { Node } from 'cleo';
import { packExampleGame } from '../src/exampleGame';
import { LOSSY, TCP, TICK_MS, divergence, manifestOf, world as makeWorld } from './helpers/world';

let bin: Uint8Array;
let crateTemplate: string;
const world = () => makeWorld(bin);

beforeAll(async () => {
    bin = await packExampleGame(path.resolve(__dirname, '../../editor/public/examples/sandbox'));
    const manifest = await manifestOf(bin);
    // A prop: a template whose root is a dynamic collider with no character in it (the Sandbox's crates).
    const types = (n: any): string[] => [n.type, ...(n.children ?? []).flatMap(types)];
    crateTemplate = manifest.templates.find((t: any) => t.node.type === 'collider' && t.node.collider?.mass > 0 && !types(t.node).includes('character')).name;
}, 120_000);

describe('NetSync phase 3: a peer follows the host', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => { w = await world(); }, 120_000);
    afterAll(() => w.dispose());

    it('gives a joining peer the synced nodes and brings them to the host state', async () => {
        const peer = await w.join(LOSSY);
        expect(w.sync.syncedCount).toBeGreaterThan(15);
        expect(peer.sync.followedCount).toBe(w.sync.syncedCount);
        await w.run(90);
        const d = divergence(w.runtime, w.sync, peer);
        expect(d.missing).toBe(0);
        expect(d.pos).toBeLessThan(0.002);
        expect(d.rot).toBeLessThan(0.5);
    });

    it('spawns a template copy on the peer with the host’s node ids, and follows it as it falls', async () => {
        const peer = w.peers[0];
        let made: Node | null = null;
        await w.run(1, () => { made = w.runtime.scene.instantiate(crateTemplate, { position: [3, 6, 3] }); });
        expect(made).toBeTruthy();
        const id = made!.id;
        await w.run(10);
        const copy = peer.scene.getNodeById(id);
        expect(copy).toBeTruthy();
        // Every node of the copy carries the host's id.
        const ids = (n: Node): string[] => [n.id, ...n.children.flatMap(ids)];
        expect(ids(copy!)).toEqual(ids(made!));
        await w.run(120);
        expect(divergence(w.runtime, w.sync, peer).pos).toBeLessThan(0.002);
    });

    it('removes on the peer what the host removes', async () => {
        const peer = w.peers[0];
        const victim = [...w.runtime.scene.nodes].find((n: any) => n.nodeType === 'collider' && n.mass > 0 && w.sync.netIdOf(n) !== undefined) as Node;
        const id = victim.id;
        expect(peer.scene.getNodeById(id)).toBeTruthy();
        await w.run(1, () => w.runtime.scene.removeNode(victim));
        await w.run(15);
        expect(peer.scene.getNodeById(id)).toBeFalsy();
    });

    it('brings a late joiner to the same scene: spawns, removals and state', async () => {
        const late = await w.join(LOSSY);
        await w.run(60);
        const d = divergence(w.runtime, w.sync, late);
        expect(d.missing).toBe(0);
        expect(d.pos).toBeLessThan(0.002);
        expect(late.sync.followedCount).toBe(w.sync.syncedCount);
    });
});

describe('NetSync phase 3: a 200-prop sandbox under load', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => { w = await world(); }, 120_000);
    afterAll(() => w.dispose());

    it('holds 200 props, an explosion and two peers (one on a TCP-like link) within the budget', async () => {
        const lossy = await w.join(LOSSY);
        const tcp = await w.join(TCP);
        // Fill the course with props, a few a tick, and let them land.
        const existing = [...w.runtime.scene.nodes].filter((n: any) => n.nodeType === 'collider' && n.mass > 0).length;
        const toAdd = 200 - existing;
        let added = 0;
        await w.run(toAdd / 4 + 1, () => {
            for (let k = 0; k < 4 && added < toAdd; k++, added++) {
                w.runtime.scene.instantiate(crateTemplate, { position: [-20 + (added % 20) * 2, 3 + Math.floor(added / 20) * 1.5, 20 + (added % 7)] });
            }
        });
        await w.run(240);
        const props = [...w.runtime.scene.nodes].filter((n: any) => n.nodeType === 'collider' && n.mass > 0).length;
        expect(props).toBeGreaterThanOrEqual(200);

        // At rest: what arrived matches, and settling costs (almost) nothing.
        for (const peer of [lossy, tcp]) expect(divergence(w.runtime, w.sync, peer).pos).toBeLessThan(0.002);
        const restBytes: number[] = [];
        await w.run(30, () => restBytes.push(w.sync.peerStats(lossy.session.peerId)!.bytesLastTick));

        // The explosion: every prop thrown up and out at once.
        const centre = [-2, 0, 25];
        await w.run(1, () => {
            for (const n of w.runtime.scene.nodes as Set<any>) {
                if (n.nodeType !== 'collider' || !(n.mass > 0) || !n.body) continue;
                const d = vec3.subtract(vec3.create(), n.position, centre as vec3);
                d[1] = 0;
                vec3.normalize(d, d);
                n.body.wakeUp();
                n.body.velocity.set(d[0] * 6, 8, d[2] * 6);
            }
        });
        // Follow one prop in flight, and measure how far behind the host the lossy peer draws it.
        const flier = [...w.runtime.scene.nodes].find((n: any) => n.nodeType === 'collider' && n.mass > 0 && n.position[1] > 0.5) as Node;
        w.history.set(flier.id, new Map());
        const errors: number[] = [];
        await w.run(90, () => {
            // Where the host had it at the moment the peer draws: the same fractional tick, interpolated.
            const renderTick = lossy.sync.renderTick();
            const h = w.history.get(flier.id)!;
            const a = h.get(Math.floor(renderTick)), b = h.get(Math.floor(renderTick) + 1);
            const copy = lossy.scene.getNodeById(flier.id);
            if (a && b && copy) errors.push(vec3.distance(vec3.lerp(vec3.create(), a, b, renderTick - Math.floor(renderTick)), copy.position as vec3));
        });
        await w.run(300);

        const stats = w.sync.peerStats(lossy.session.peerId)!;
        const tcpStats = w.sync.peerStats(tcp.session.peerId)!;
        errors.sort((a, b) => a - b);
        const p50 = errors[Math.floor(errors.length / 2)];
        const p95 = errors[Math.floor(errors.length * 0.95)];
        console.log(`200 props: ${props}; at rest ${Math.max(...restBytes)} B/tick; budget peak lossy ${stats.maxBytesPerTick} B, tcp ${tcpStats.maxBytesPerTick} B; ` +
            `total ${(stats.bytesTotal / 1024).toFixed(0)} KB lossy, ${(tcpStats.bytesTotal / 1024).toFixed(0)} KB tcp; ` +
            `follow error in flight p50 ${(p50 * 100).toFixed(1)} cm, p95 ${(p95 * 100).toFixed(1)} cm; host tick ${JSON.stringify(w.runtime.stats())}`);

        expect(crateTemplate).toBe('Small Crate');
        // The host's own cost for 200 props (docs/design/netsync.md §7: 25 ms of one core at 30 Hz).
        expect(w.runtime.stats().meanMs).toBeLessThan(25);
        expect(stats.maxBytesPerTick).toBeLessThanOrEqual(w.sync.bytesPerTick);
        expect(tcpStats.maxBytesPerTick).toBeLessThanOrEqual(w.sync.bytesPerTick);
        expect(Math.max(...restBytes)).toBeLessThan(200);
        // Everyone converges once the props land again.
        for (const peer of [lossy, tcp]) {
            const d = divergence(w.runtime, w.sync, peer);
            console.log(`after the explosion: ${d.compared} at rest compared, ${d.moving} still moving`);
            expect(d.compared).toBeGreaterThan(180);
            expect(d.missing).toBe(0);
            expect(d.pos).toBeLessThan(0.002);
        }
        expect(p50).toBeLessThan(0.05);
    });
});

describe('NetSync phase 3: sixteen peers', () => {
    let w: Awaited<ReturnType<typeof world>>;
    beforeAll(async () => { w = await world(); }, 120_000);
    afterAll(() => w.dispose());

    it('serves 16 peers 200 props through an explosion, each within its budget, and all converge', async () => {
        for (let i = 0; i < 16; i++) await w.join({ ...LOSSY, seed: 100 + i });
        expect(w.session.peers.size).toBe(16);
        let added = 0;
        const existing = [...w.runtime.scene.nodes].filter((n: any) => n.nodeType === 'collider' && n.mass > 0).length;
        await w.run(60, () => {
            for (let k = 0; k < 4 && added < 200 - existing; k++, added++) {
                w.runtime.scene.instantiate(crateTemplate, { position: [-20 + (added % 20) * 2, 3 + Math.floor(added / 20) * 1.5, 20 + (added % 7)] });
            }
        });
        await w.run(200);
        w.syncMs.length = 0;
        await w.run(1, () => {
            for (const n of w.runtime.scene.nodes as Set<any>) {
                if (n.nodeType !== 'collider' || !(n.mass > 0) || !n.body) continue;
                n.body.wakeUp();
                n.body.velocity.set((n.position[0] + 2) * 0.3, 8, (n.position[2] - 25) * 0.3);
            }
        });
        await w.run(120);
        const busy = [...w.syncMs].sort((a, b) => a - b);
        await w.run(240);
        const peak = Math.max(...w.peers.map((p) => w.sync.peerStats(p.session.peerId)!.maxBytesPerTick));
        console.log(`16 peers: sync ${(busy.reduce((a, b) => a + b, 0) / busy.length).toFixed(2)} ms mean, ` +
            `${busy[Math.floor(busy.length * 0.95)].toFixed(2)} p95 per tick while 200 props fly; peak ${peak} B/tick/peer; host ${JSON.stringify(w.runtime.stats())}`);
        expect(peak).toBeLessThanOrEqual(w.sync.bytesPerTick);
        expect(busy[Math.floor(busy.length * 0.95)]).toBeLessThan(10);
        for (const peer of w.peers) {
            const d = divergence(w.runtime, w.sync, peer);
            expect(d.missing).toBe(0);
            expect(d.pos).toBeLessThan(0.002);
        }
    });
});
