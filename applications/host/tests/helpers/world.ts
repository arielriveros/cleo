// A NetSync world in one process, for the host's tests: a game on a HostRuntime, its session and sync, optional
// remote control, and peers that each hold their own copy of the scene (parsed from the same game.bin, not
// simulated) on loopback links with chosen conditions. Everything runs on one ManualScheduler: `run(n)` plays n
// host ticks, 1/30 s of simulated time each, and lets every peer follow and send its commands.
import { quat, vec3 } from 'gl-matrix';
import { PhysicsSystem, type ControllerNode, type Node, type Scene } from 'cleo';
import { createIntent, type ControlIntent } from '../../../../src/core/control/intent';
import {
    AnimHost, AnimPeer, CarryHost, CarryPeer, ConditionedLink, HostSession, LagCompensator, ManualScheduler, PeerCommands, PeerSession, Predictor,
    RemoteControl, ScriptHost, ScriptPeer, SyncHost, SyncPeer, WeaponHost, WeaponPeer, createLoopbackPair, followerSceneJson,
    type LinkConditions, type RemoteControlOptions, type Trust, type WeaponHostOptions,
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
export async function peerScene(bin: Uint8Array, prepare?: (json: any) => void): Promise<Scene> {
    const source = bufferSource(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer);
    const header = await readGameHeader(source);
    const built = await buildGameScene({ source, header, claimed: new Set() }, (header.manifest as any).entry, undefined, prepare);
    return built!.scene;
}

/**
 * A peer's scene that RUNS: the host's bodies made followers, its own physics world (Jolt, as the host), started.
 * What a predicting peer simulates its own character in.
 */
export async function simulatedPeerScene(bin: Uint8Array): Promise<{ scene: Scene; physics: PhysicsSystem }> {
    const scene = await peerScene(bin, followerSceneJson);
    const physics = new PhysicsSystem({ gravity: [0, -9.81, 0], backend: 'jolt' } as any);
    await physics.load();
    physics.initialize();
    physics.scene = scene;
    scene.start();
    return { scene, physics };
}

export interface TestPeer {
    session: PeerSession;
    sync: SyncPeer;
    scene: Scene;
    commands: PeerCommands | null;
    /** What this peer's player is doing: called each tick for the intent to send (null sends nothing). */
    drive: ((tick: number) => ControlIntent | null) | null;
    /** A predicting peer: its own physics, and the predictor over it. */
    predictor?: Predictor;
    physics?: PhysicsSystem;
    /** Local ticks a predicting peer has simulated. */
    simulatedTicks?: number;
    carry?: CarryPeer;
    weapons?: WeaponPeer;
    script?: ScriptPeer;
    anim?: AnimPeer;
    /** Where this peer holds its carried prop this tick (in its scene), or null. */
    hold?: ((tick: number) => { pos: ArrayLike<number>; rot: ArrayLike<number> } | null) | null;
}

export interface WorldOptions {
    remote?: RemoteControlOptions | ((runtime: HostRuntime) => RemoteControlOptions);
    /** Carrying and weapons, at this trust level (needs `remote`: both work through each peer's character). */
    play?: { trust?: Trust; weapons?: Partial<WeaponHostOptions> };
    /** `this.net`, `@synced` and `@netcall` on the host and every peer. */
    scripts?: boolean;
    /** Animation: followed characters' animators driven by the host's parameters and events. */
    anim?: boolean;
}

export async function world(bin: Uint8Array, options: WorldOptions = {}) {
    const s = new ManualScheduler();
    const runtime = await HostRuntime.open({ bin });
    const session = new HostSession({ contentHash: 'test', scheduler: s, tickRate: 30 });
    const remoteOptions = typeof options.remote === 'function' ? options.remote(runtime) : options.remote;
    const remote = remoteOptions ? new RemoteControl(session, remoteOptions) : null;
    const sync = new SyncHost(session, () => runtime.scene, {
        sceneKey: () => runtime.sceneName,
        focusOf: (peerId) => remote?.controllerOf(peerId)?.possessed?.worldPosition ?? null,
    });
    const pawnOf = (peerId: number) => remote?.controllerOf(peerId)?.possessed ?? null;
    const carry = remote && options.play ? new CarryHost(session, sync, { pawnOf, trust: options.play.trust }) : null;
    const history = options.play ? new LagCompensator(sync) : null;
    const weapons = remote && options.play && history ? new WeaponHost(session, sync, history, () => runtime.scene, {
        pawnOf, trust: options.play.trust, physics: () => runtime.engine.physics, currentTick: () => tick - 1, ...options.play.weapons,
    }) : null;
    runtime.onBeforeTick = (t) => { remote?.beforeTick(t); carry?.beforeTick(t, 1 / 30); };
    const anim = options.anim ? new AnimHost(session, sync) : null;
    const scripts = options.scripts ? new ScriptHost(session, sync, () => runtime.scene, { ownerOf: (n) => remote?.ownerOf(n) ?? 0 }) : null;
    const peers: TestPeer[] = [];
    let tick = 0;
    /** ms spent in SyncHost.tick, per tick (the sync layer's own cost on the host). */
    const syncMs: number[] = [];
    /** Host history of chosen nodes, by tick: where they were, to measure how closely a peer follows. */
    const traces = new Map<string, Map<number, vec3>>();

    const run = async (ticks: number, each?: (tick: number) => void) => {
        for (let i = 0; i < ticks; i++) {
            each?.(tick);
            runtime.step(1);
            history?.record(tick);
            for (const [id, h] of traces) {
                const n = runtime.scene.getNodeById(id);
                if (n) h.set(tick, vec3.clone(n.position as vec3));
            }
            const t0 = performance.now();
            sync.tick(tick);
            scripts?.tick();
            anim?.tick(tick);
            syncMs.push(performance.now() - t0);
            tick++;
            await s.advance(TICK_MS);
            for (const p of peers) {
                // Animation follows the frame (as a client applies it before drawing), and each tick simulated too.
                if (p.predictor) { p.anim?.apply(); simulate(p); p.sync.apply(); p.weapons?.update(); continue; }
                p.sync.apply();
                p.weapons?.update();
                const intent = p.drive?.(tick);
                if (intent && p.commands) p.commands.update(intent);
                if (p.carry) { const h = p.hold?.(tick) ?? null; p.carry.update(tick, h?.pos ?? null, h?.rot ?? null); }
            }
        }
    };

    /**
     * A predicting peer's frame: step its own simulation, a tick at a time, up to the tick it should have
     * simulated by now — its player's intent fed to its own controller (as a real client's controller would read
     * its input), its physics and scene stepped, the predictor told.
     */
    const simulate = (p: TestPeer) => {
        const pred = p.predictor!;
        const due = pred.dueTick();
        let t = pred.lastTick < 0 ? due : pred.lastTick + 1;
        for (; t <= due; t++) {
            const controller = pred.controller as ControllerNode | null;
            if (controller) {
                controller.controlSource = 'remote';
                controller.remoteIntent = p.drive?.(t) ?? null;
            }
            const dt = 1 / 30;
            p.anim?.apply();
            p.physics!.update(dt);
            p.scene.update(dt, t * TICK_MS, false, dt);
            p.physics!.endFrame(dt);
            pred.afterTick(t);
            if (p.carry) { const h = p.hold?.(t) ?? null; p.carry.update(t, h?.pos ?? null, h?.rot ?? null, dt); }
            p.simulatedTicks = (p.simulatedTicks ?? 0) + 1;
        }
    };

    const join = async (conditions: LinkConditions, mode: 'follow' | 'predict' = 'follow'): Promise<TestPeer> => {
        const simulated = mode === 'predict' ? await simulatedPeerScene(bin) : null;
        const scene = simulated?.scene ?? await peerScene(bin);
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
        // Commands first: the host's Possess (which character is ours) must be read before the spawn of it.
        const commands = remote ? new PeerCommands(peerSession) : null;
        const peer: TestPeer = {
            session: peerSession, scene, commands, drive: null,
            sync: new SyncPeer(peerSession, scene, { simulated: !!simulated, isOwn: commands ? (id) => id === commands.pawnId : undefined }),
        };
        if (simulated && peer.commands) {
            peer.physics = simulated.physics;
            peer.predictor = new Predictor(peerSession, peer.sync, peer.commands);
        }
        if (options.play) {
            peer.carry = new CarryPeer(peerSession, peer.sync);
            peer.weapons = new WeaponPeer(peerSession, peer.sync);
        }
        if (options.anim) peer.anim = new AnimPeer(peerSession, peer.sync);
        if (options.scripts) {
            // This peer's own tree: the top-level node its controller sits in.
            const ownRoot = () => {
                let n = commands?.controllerId ? scene.getNodeById(commands.controllerId) ?? null : null;
                while (n?.parent && n.parent !== scene.root) n = n.parent;
                return n;
            };
            peer.script = new ScriptPeer(peerSession, peer.sync, { ownRoot });
        }
        peers.push(peer);
        return peer;
    };

    return {
        runtime, session, sync, remote, carry, weapons, scripts, anim, lag: history, peers, run, join, history: traces, s, syncMs,
        get tick() { return tick; },
        dispose: () => {
            anim?.dispose(); scripts?.dispose(); weapons?.dispose(); carry?.dispose(); remote?.dispose(); sync.dispose(); session.close(); runtime.dispose();
            // A predicting peer's own physics world too: Jolt's heap is a fixed 128 MB, and a test file that
            // leaves its worlds behind cannot make new ones a few worlds later.
            for (const p of peers) { p.predictor?.dispose(); p.physics?.dispose(); }
        },
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
