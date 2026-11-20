// A NetSync world in one process, for the host's tests: a game on a HostRuntime, its session and sync, optional
// remote control, and peers that each hold their own copy of the scene (parsed from the same game.bin, not
// simulated) on loopback links with chosen conditions. Everything runs on one ManualScheduler: `run(n)` plays n
// host ticks, 1/30 s of simulated time each, and lets every peer follow and send its commands.
import { quat, vec3 } from 'gl-matrix';
import type { Node, Scene } from 'cleo';
import { createIntent, type ControlIntent } from '../../../../src/core/control/intent';
import {
    ConditionedLink, HostSession, ManualScheduler, PeerCommands, PeerSession, RemoteControl, SyncHost, SyncPeer,
    createLoopbackPair, type LinkConditions, type RemoteControlOptions,
} from '../../../../src/netsync';
import { HostRuntime } from '../../src/hostRuntime';
import { bufferSource } from '../../../editor/src/player/gameSource';
import { readGameHeader } from '../../../editor/src/player/unpack';
import { buildGameScene } from '../../../editor/src/player/gameContent';

export const TICK_MS = 1000 / 30;
export const LOSSY: LinkConditions = { latencyMs: 75, jitterMs: 15, loss: 0.05, seed: 3 };
export const TCP: LinkConditions = { latencyMs: 75, jitterMs: 15, loss: 0.05, tcp: true, seed: 4 };

/** The game's manifest (templates, scenes), read from game.bin. */
export async function manifestOf(bin: Uint8Array): Promise<any> {
    return (await readGameHeader(bufferSource(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer))).manifest;
}

/** The same game's entry scene, parsed but not started: what a peer draws. */
export async function peerScene(bin: Uint8Array): Promise<Scene> {
    const source = bufferSource(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
    const header = await readGameHeader(source);
    const built = await buildGameScene({ source, header, claimed: new Set() }, (header.manifest as any).entry);
    return built!.scene;
}

export interface TestPeer {
    session: PeerSession;
    sync: SyncPeer;
    scene: Scene;
    commands: PeerCommands | null;
    /** What this peer's player is doing: called each tick for the intent to send (null sends nothing). */
    drive: ((tick: number) => ControlIntent | null) | null;
}

export async function world(bin: Uint8Array, options: { remote?: RemoteControlOptions | ((runtime: HostRuntime) => RemoteControlOptions) } = {}) {
    const s = new ManualScheduler();
    const runtime = await HostRuntime.open({ bin });
    const session = new HostSession({ contentHash: 'test', scheduler: s, tickRate: 30 });
    const remoteOptions = typeof options.remote === 'function' ? options.remote(runtime) : options.remote;
    const remote = remoteOptions ? new RemoteControl(session, remoteOptions) : null;
    const sync = new SyncHost(session, () => runtime.scene, {
        sceneKey: () => runtime.sceneName,
        focusOf: (peerId) => remote?.controllerOf(peerId)?.possessed?.worldPosition ?? null,
    });
    if (remote) runtime.onBeforeTick = (t) => remote.beforeTick(t);
    const peers: TestPeer[] = [];
    let tick = 0;
    /** ms spent in SyncHost.tick, per tick (the sync layer's own cost on the host). */
    const syncMs: number[] = [];
    /** Host history of chosen nodes, by tick: where they were, to measure how closely a peer follows. */
    const history = new Map<string, Map<number, vec3>>();

    const run = async (ticks: number, each?: (tick: number) => void) => {
        for (let i = 0; i < ticks; i++) {
            each?.(tick);
            runtime.step(1);
            for (const [id, h] of history) {
                const n = runtime.scene.getNodeById(id);
                if (n) h.set(tick, vec3.clone(n.position as vec3));
            }
            const t0 = performance.now();
            sync.tick(tick);
            syncMs.push(performance.now() - t0);
            tick++;
            await s.advance(TICK_MS);
            for (const p of peers) {
                p.sync.apply();
                const intent = p.drive?.(tick);
                if (intent && p.commands) p.commands.update(intent);
            }
        }
    };

    const join = async (conditions: LinkConditions): Promise<TestPeer> => {
        const scene = await peerScene(bin);
        const joining = PeerSession.join({
            endpoint: {}, contentHash: 'test', scheduler: s, reconnect: false,
            connector: async () => {
                const [peerEnd, hostEnd] = createLoopbackPair(s);
                session.accept(hostEnd);
                return { link: new ConditionedLink(peerEnd, conditions, s), fallbackReason: null };
            },
        });
        await run(15);
        const peerSession = await joining;
        const peer: TestPeer = {
            session: peerSession, sync: new SyncPeer(peerSession, scene), scene,
            commands: remote ? new PeerCommands(peerSession) : null, drive: null,
        };
        peers.push(peer);
        return peer;
    };

    return {
        runtime, session, sync, remote, peers, run, join, history, s, syncMs,
        get tick() { return tick; },
        dispose: () => { remote?.dispose(); sync.dispose(); session.close(); runtime.dispose(); },
    };
}

export type World = Awaited<ReturnType<typeof world>>;

/** An intent moving along `move` ([right, forward]) in a world-fixed basis, with optional requests. */
export function intent(move: [number, number], edit: (i: ControlIntent) => void = () => {}): ControlIntent {
    const i = createIntent();
    i.move[0] = move[0];
    i.move[1] = move[1];
    edit(i);
    return i;
}

/**
 * Largest position (m) and rotation (deg) difference between the host's synced nodes and a peer's copies, over
 * the nodes at rest on the host: a peer draws `delayTicks` in the past, so a moving one is behind by design.
 */
export function divergence(host: HostRuntime, sync: SyncHost, peer: { scene: Scene }) {
    let pos = 0, rot = 0, missing = 0, compared = 0, moving = 0;
    for (const node of host.scene.nodes as Set<Node>) {
        if (sync.netIdOf(node) === undefined) continue;
        const body = (node as any).nodeType === 'collider' ? (node as any).body : null;
        if (body && body.velocity.length() > 0.01) { moving++; continue; }
        const copy = peer.scene.getNodeById(node.id);
        if (!copy) { missing++; continue; }
        compared++;
        pos = Math.max(pos, vec3.distance(node.position as vec3, copy.position as vec3));
        const dot = Math.min(1, Math.abs(quat.dot(node.quaternion as quat, copy.quaternion as quat)));
        rot = Math.max(rot, 2 * Math.acos(dot) * 180 / Math.PI);
    }
    return { pos, rot, missing, compared, moving };
}
