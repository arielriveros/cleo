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
        const peers: { session: PeerSession; sync: SyncPeer; commands: PeerCommands; scene: Scene; move: [number, number] }[] = [];
        for (const [only, move] of [[undefined, [0, 1]], ['websocket', [1, 0]]] as const) {
            const s = await PeerSession.join({
                endpoint, contentHash: 'sandbox',
                connectOptions: { WebTransportImpl: WebTransport as any, only },
            });
            const scene = await peerScene(bin);
            peers.push({ session: s, scene, sync: new SyncPeer(s, scene), commands: new PeerCommands(s), move: [...move] });
        }
        expect(peers.map((p) => p.session.linkKind)).toEqual(['webtransport', 'websocket']);

        // Each peer's frame loop at ~60 fps: follow the host, send this frame's intent.
        let driving = false;
        const frame = setInterval(() => {
            for (const p of peers) {
                p.sync.apply();
                p.commands.update(driving ? intent(p.move) : intent([0, 0]));
            }
        }, 16);
        try {
            await wait(1500); // possessed, landed, clocks synced
            // The steadiness below is measured from here: the joins before it load each peer's copy of the Sandbox in
            // this same process, which stalls the host's clock for whole seconds -- the test's doing, not the host's.
            const before = runtime.stats();
            for (const p of peers) expect(p.commands.pawnId).not.toBe('');
            const start = peers.map((p) => vec3.clone(characters.get(p.session.peerId)!.position as vec3));
            driving = true;
            await wait(2000);
            driving = false;
            await wait(1000);
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
    }, 20_000); // 4.5 s of real time by design, plus the joins: past vitest's default 5 s on a busy machine
});
