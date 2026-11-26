// The whole stack over real sockets, in real time: cleo-host's listener, the Sandbox ticking on its own clock, and
// two Node peers — one on WebTransport (the host library's client), one on the WebSocket fallback — each driving
// the character the host gave it and following the host's scene.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { vec3 } from 'gl-matrix';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import type { ControllerNode, Node, Scene } from 'cleo';
import { HostSession, PeerCommands, PeerSession, RemoteControl, SyncHost, SyncPeer } from '@engine/netsync';
import { HostRuntime } from '@host/hostRuntime';
import { HostListener } from '@host/hostListener';
import { generateCertificate } from '@host/devCertificate';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';
import { intent, peerScene } from '@host-tests/helpers/world';

let bin: Uint8Array;
let runtime: HostRuntime;
let session: HostSession;
let sync: SyncHost;
let remote: RemoteControl;
let listener: HostListener;
const characters = new Map<number, Node>();
const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Wait until `ready` holds, checking every 50 ms, for at most `ms`: real time on a busy machine is not a fixed sleep.
 * Throws, saying `what`, when it never does.
 */
async function until(what: string, ready: () => boolean, ms: number): Promise<void> {
    const end = performance.now() + ms; // wall-clock: a deadline in real time
    while (!ready()) {
        if (performance.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
        await wait(50);
    }
}

beforeAll(async () => {
    await quicheLoaded;
    bin = await packExampleGame(EXAMPLE);
    runtime = await HostRuntime.open({ bin });
    session = new HostSession({ contentHash: 'sandbox', tickRate: 30 });
    remote = new RemoteControl(session, {
        possess: (peer) => {
            const root = runtime.scene.instantiate('Player', { position: [30 + peer.id * 4, 0.05, -30] })!;
            characters.set(peer.id, root);
            return subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode;
        },
    });
    sync = new SyncHost(session, () => runtime.scene, {
        sceneKey: () => runtime.sceneName,
        focusOf: (id) => remote.controllerOf(id)?.possessed?.worldPosition ?? null,
    });
    runtime.onBeforeTick = (t) => remote.beforeTick(t);
    runtime.onTick = (t) => sync.tick(t);
    listener = await HostListener.start({ certificate: await generateCertificate(), webTransportPort: 0, webSocketPort: 0, onLink: (l) => session.accept(l) });
    runtime.start(performance.now() - session.timeMs());
}, 120_000);

afterAll(async () => {
    runtime.dispose();
    remote.dispose();
    sync.dispose();
    session.close();
    await wait(300);
    await listener.close();
});

describe('NetSync over real sockets', () => {
    it('lets a WebTransport peer and a WebSocket peer each drive their character in real time', async () => {
        const endpoint = listener.endpoint('127.0.0.1');
        // Both peers' copies of the Sandbox first, as NetSyncClient.join builds its scene before it contacts the host.
        // Built after joining, each held this process's event loop for seconds with a session live: past the host's
        // 5 s silence watchdog on a busy machine, the link dropped and the peer never saw its character (40 m off).
        const scenes = [await peerScene(bin), await peerScene(bin)];
        const peers: { session: PeerSession; sync: SyncPeer; commands: PeerCommands; scene: Scene; move: [number, number] }[] = [];
        const dropped: string[] = [];
        for (const [i, [only, move]] of ([[undefined, [0, 1]], ['websocket', [1, 0]]] as const).entries()) {
            const s = await PeerSession.join({
                endpoint, contentHash: 'sandbox',
                connectOptions: { WebTransportImpl: WebTransport as any, only },
            });
            s.on('reconnecting', (e: { reason?: string }) => dropped.push(`${s.linkKind} reconnecting: ${e?.reason ?? ''}`));
            s.on('closed', (e: { reason?: string }) => dropped.push(`${s.linkKind} closed: ${e?.reason ?? ''}`));
            peers.push({ session: s, scene: scenes[i], sync: new SyncPeer(s, scenes[i]), commands: new PeerCommands(s), move: [...move] });
        }
        expect(peers.map((p) => p.session.linkKind)).toEqual(['webtransport', 'websocket']);
        // How far a peer's view of its own character is from where the host has it, or Infinity before it sees it.
        const offset = (p: (typeof peers)[number]) => {
            const root = characters.get(p.session.peerId);
            const seen = root ? p.scene.getNodeById(root.id) : null;
            return root && seen ? vec3.distance(seen.position as vec3, root.position as vec3) : Infinity;
        };

        // Each peer's frame loop at ~60 fps: follow the host, send this frame's intent.
        let driving = false;
        const frame = setInterval(() => {
            for (const p of peers) {
                p.sync.apply();
                p.commands.update(driving ? intent(p.move) : intent([0, 0]));
            }
        }, 16);
        try {
            // Possessed, landed, followed: each peer has its character and sees it where the host has it.
            await until('both peers to possess and follow their characters',
                () => peers.every((p) => p.commands.pawnId !== '' && offset(p) < 0.05), 15_000);
            const before = runtime.stats();
            const start = peers.map((p) => vec3.clone(characters.get(p.session.peerId)!.position as vec3));
            driving = true;
            await wait(2000);
            driving = false;
            // Stopped, and caught up: the peers' views settle on the host's within a few ticks.
            await until('both peers to catch up with the host', () => peers.every((p) => offset(p) < 0.05), 5_000)
                .catch(() => { /* the assertions below say by how much */ });
            expect(dropped, 'no link dropped while driving').toEqual([]);
            for (const [i, p] of peers.entries()) {
                const root = characters.get(p.session.peerId)!;
                const moved = vec3.distance(start[i], root.position as vec3);
                // The peer's own view of its character, followed from the host.
                const seen = p.scene.getNodeById(root.id)!;
                const off = vec3.distance(seen.position as vec3, root.position as vec3);
                console.log(`${p.session.linkKind}: moved ${moved.toFixed(2)} m in 2 s; peer sees it ${(off * 100).toFixed(1)} cm away; rtt ${p.session.clock.rttMs.toFixed(1)} ms; commands ${p.commands.sent}`);
                expect(moved).toBeGreaterThan(3);
                expect(off).toBeLessThan(0.05);
            }
            // A real-time host on a busy machine (the suite runs files in parallel) may skip a few ticks rather than
            // fall behind; that is the ticker's design. Not many: none alone, ~8 % with the whole host suite (several
            // files run real hosts at once) beside it. Counted over the driving only: the Sandbox has grown, and
            // loading two more copies of it beside the host while it ticks cost ~40 skipped ticks before anyone moved.
            const st = runtime.stats();
            const ticks = st.ticks - before.ticks, skipped = st.skipped - before.skipped;
            expect(skipped).toBeLessThan(Math.max(5, ticks * 0.15));
        } finally {
            clearInterval(frame);
            for (const p of peers) p.session.leave();
        }
    }, 60_000); // about 3 s of real time, plus two copies of the Sandbox and the joins: deadlines inside say what is late
});
