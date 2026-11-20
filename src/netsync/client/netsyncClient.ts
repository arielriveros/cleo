// A game joining a NetSync host (docs/design/netsync.md §6.5, phase 9): the browser side of everything the host
// runs. One call joins the session and loads the game's scene as followers of the host — every body the host
// simulates static here, every controller off — except this player's own character, which the peer predicts
// frame by frame (PeerFrames) and corrects to the host. Animation, carried props, shots and scripts follow too.
//
//   const client = await NetSyncClient.join({ endpoint, contentHash, loadScene, physics: engine.physics });
//   client.carry.grab(node); client.weapons.fire(...); client.session.leave();
//
// The player app (applications/editor/src/player) calls it when a game is opened with a host to join.

import type { Scene } from '../../core/scene/scene';
import type { Node } from '../../core/scene/nodes/node';
import { connect, type ConnectOptions, type HostEndpoint } from '../link/connect';
import { ConditionedLink, type LinkConditions } from '../link/conditionedLink';
import { PeerSession } from '../session/peerSession';
import { PeerCommands } from '../sync/commands';
import { Predictor } from '../sync/predictor';
import { SyncPeer, followerSceneJson, type FollowerOriginals } from '../sync/syncPeer';
import { AnimPeer } from '../sync/animSync';
import { CarryPeer } from '../sync/carry';
import { WeaponPeer } from '../sync/weapons';
import { ScriptPeer } from '../sync/scriptSync';
import { PeerFrames } from './peerFrames';

export interface NetSyncJoinOptions {
    endpoint: HostEndpoint;
    /** The game's fingerprint (its manifest's `contentHash`): the host refuses a peer running another build. */
    contentHash: string;
    name?: string;
    /** From the allocator, when the host asks for one. */
    token?: string;
    connectOptions?: ConnectOptions;
    /**
     * A worse network than the real one, simulated on this player's side of the link (Play › Multiplayer's
     * per-player lag, jitter and loss): its own messages are held and dropped as if the network did it.
     */
    conditions?: LinkConditions;
    /**
     * Build the game scene named `sceneName` (the entry scene when null), passing its JSON through `prepare` before
     * it is parsed, and make it the engine's scene — WITHOUT starting it. The client makes it a follower scene that
     * way, attaches the network to it (so every script's onStart sees `this.net`), then calls `start`.
     */
    loadScene: (sceneName: string | null, prepare: (json: any) => void) => Promise<{ scene: Scene; start: () => void }>;
    /** The engine's physics: put on this thread (prediction reads the character's body as each frame leaves it). */
    physics: { setWorkerMode(mode: 'off'): void };
}

export class NetSyncClient {
    public readonly frames: PeerFrames;
    public readonly predictor: Predictor;
    public readonly anim: AnimPeer;
    public readonly carry: CarryPeer;
    public readonly weapons: WeaponPeer;
    public readonly scripts: ScriptPeer;
    private _offFrame: (() => void) | null = null;

    private constructor(
        public readonly session: PeerSession,
        public readonly commands: PeerCommands,
        public readonly sync: SyncPeer,
        private _scene: Scene,
        physics: () => any,
    ) {
        this.predictor = new Predictor(session, sync, commands);
        this.anim = new AnimPeer(session, sync);
        this.carry = new CarryPeer(session, sync, { physics });
        this.weapons = new WeaponPeer(session, sync);
        this.scripts = new ScriptPeer(session, sync, { ownRoot: () => this.ownRoot });
        this.frames = new PeerFrames({ predictor: this.predictor, sync, anim: this.anim, carry: this.carry, weapons: this.weapons });
        this._attach(_scene);
        session.on('closed', () => this._detach());
    }

    /** Join the host at `options.endpoint` and start following its game. */
    public static async join(options: NetSyncJoinOptions): Promise<NetSyncClient> {
        options.physics.setWorkerMode('off');
        const session = await PeerSession.join({
            endpoint: options.endpoint, contentHash: options.contentHash, name: options.name, token: options.token,
            connectOptions: options.connectOptions,
            ...(options.conditions ? {
                connector: async (endpoint: HostEndpoint, connectOptions: ConnectOptions) => {
                    const c = await connect(endpoint, connectOptions);
                    return { ...c, link: new ConditionedLink(c.link, { ...options.conditions, tcp: c.link.kind === 'websocket' }) };
                },
            } : {}),
        });
        try {
            // Commands first: the host's word on which character is this player's must be read before that
            // character's spawn is applied (SyncPeer holds nothing back once it exists).
            const commands = new PeerCommands(session);
            const authored: FollowerOriginals = new Map();
            const { scene, start } = await options.loadScene(null, (json) => followerSceneJson(json, authored));
            const sync = new SyncPeer(session, scene, { simulated: true, authored, isOwn: (id) => id === commands.pawnId });
            const client = new NetSyncClient(session, commands, sync, scene, () => (scene as any).physics ?? null);
            // Only now: a script's onStart asks `this.net` whether this machine is the host.
            start();
            return client;
        } catch (e) {
            session.leave();
            throw e;
        }
    }

    public get scene(): Scene { return this._scene; }
    /** This player's character, once the host has given it one. */
    public get pawn(): Node | null { return this.predictor.pawn; }
    /** The top-level node this player's character stands in (its own tree: a script's `this.net.isOwner` there). */
    public get ownRoot(): Node | null {
        let n: Node | null = this.predictor.controller ?? this.pawn;
        while (n?.parent && n.parent !== this._scene.root) n = n.parent;
        return n;
    }

    /** Leave the session (the host frees this player's seat at once). */
    public leave(): void {
        this.session.leave();
        this._detach();
    }

    private _attach(scene: Scene): void {
        this._detach();
        // After every script and camera rig, before the frame is drawn: the ticks this frame passed, then the
        // followers placed where they are drawn; and the host's animation parameters for the next frame.
        this._offFrame = scene.addLateUpdate((_delta, unscaled) => {
            this.frames.afterFrame(unscaled);
            this.frames.beforeFrame();
            this._lookThroughOwn(scene);
        });
    }

    /**
     * Once this player has a character: see through the camera in its tree. A level built for one player has its
     * own camera marked active (which is another player's, or nobody's, here); the scene would pick that one.
     */
    private _lookThroughOwn(scene: Scene): void {
        if (this._looking) return;
        const root = this.ownRoot;
        if (!root) return;
        const stack: Node[] = [root];
        while (stack.length) {
            const n = stack.pop()!;
            if (n.nodeType === 'camera') { scene.setActiveCamera(n as any); this._looking = true; return; }
            stack.push(...n.children);
        }
        this._looking = true; // a character with no camera of its own: the scene's stays
    }
    private _looking = false;

    private _detach(): void {
        this._offFrame?.();
        this._offFrame = null;
    }
}
