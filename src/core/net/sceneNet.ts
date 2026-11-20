// What a script knows about the network (docs/design/netsync.md §6.9): `this.net` on every node, and the
// `@netcall` routing behind it. The engine side only — an interface a NetSync session fills in (src/netsync/sync/
// scriptSync.ts) by setting `scene.net`. A scene with none is OFFLINE: a single-player game, which is its own
// host, so code guarded with `if (!this.net.isHost) return` runs there as it always did.

import type { Node } from '../scene/nodes/node';

/** Where a `@netcall` runs: on the host; on the host and every peer; or on the peer that owns the node. */
export type NetCallTarget = 'host' | 'all' | 'owner';

export interface NetCallOptions {
    to: NetCallTarget;
    /** Delivered for sure, in order (default), or as fast as possible and maybe not at all (a muzzle flash). */
    reliable: boolean;
    /** A `to: 'host'` call a peer may make on a node it does not own. Default false. */
    anyone: boolean;
}

/** Who may hear a {@link SceneNet.emit}: the host, every peer, or everyone (host and peers). */
export type NetEventTarget = 'host' | 'peers' | 'all';

/** The network as one scene sees it. Set on `scene.net` by NetSync; absent offline. */
export interface SceneNet {
    readonly role: 'host' | 'peer';
    /** This machine's PeerId (0 on the host). */
    readonly peerId: number;
    /** The peer that owns `node` (drives the character it belongs to), or 0 for the host. */
    ownerOf(node: Node): number;
    /** The peer whose `@netcall` is running right now on the host, else 0. */
    readonly caller: number;
    /** Route a `@netcall`: run `original` here, send it on, or both, as `options` say. */
    call(node: Node, method: string, original: (...args: unknown[]) => unknown, args: unknown[], options: NetCallOptions): unknown;
    /** Raise a game event (`@onEvent`, GameEvents) on other machines. */
    emit(name: string, payload: unknown, to: NetEventTarget): void;
}

/**
 * `this.net`: what one node's script asks about the network. Cheap to read every frame.
 *
 *   onTriggerEnter(other) {
 *     if (!this.net.isHost) return;     // the host decides pickups (offline, this machine is the host)
 *     ...
 *   }
 */
export class NodeNet {
    constructor(private readonly _node: Node) {}

    private get _net(): SceneNet | null { return this._node.scene?.net ?? null; }

    /** In a NetSync session (as host or peer). False in a single-player game. */
    public get online(): boolean { return !!this._net; }
    /** This machine decides the game: the NetSync host, or any offline game. */
    public get isHost(): boolean { return this._net ? this._net.role === 'host' : true; }
    /** A player's machine in a session: it follows the host and predicts its own character. */
    public get isPeer(): boolean { return this._net?.role === 'peer'; }
    /** This machine's PeerId: 0 on the host and offline. */
    public get peerId(): number { return this._net?.peerId ?? 0; }
    /** The peer that owns this node (drives the character it belongs to), 0 for the host's own. */
    public get owner(): number { return this._net ? this._net.ownerOf(this._node) : 0; }
    /** This machine controls this node: its player's character (on a peer), or anything not a player's (on the host). */
    public get isOwner(): boolean { return this.owner === this.peerId; }
    /** On the host, inside a `@netcall` a peer made: that peer's id. Otherwise 0. */
    public get caller(): number { return this._net?.caller ?? 0; }

    /** Raise game event `name` with `payload` on other machines (offline: nothing — there are none). */
    public emit(name: string, payload?: unknown, to: NetEventTarget = 'all'): void {
        this._net?.emit(name, payload, to);
    }
}
