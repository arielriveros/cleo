// The scripting surface over the network (docs/design/netsync.md §6.9): what `this.net`, `@synced` and `@netcall`
// do when a scene runs in a NetSync session. ScriptHost and ScriptPeer each give their scene a `scene.net`
// (core/net/sceneNet.ts) and carry three things:
//
//   fields   host → peers, control lane: a synced node's `@synced` fields that changed this tick (and all of them
//            to a peer that joins). A peer sets them and calls the field's `onChange` with the old value.
//   calls    `@netcall`s: peer → host for `to: 'host'` (if the peer owns the node, or the call allows anyone);
//            host → peers for `'all'` and `'owner'`. Reliable on the control lane, or not on the pulse lane.
//   events   `this.net.emit` / `Net.emit`: a game event raised on other machines (`@onEvent`, GameEvents). A peer's
//            event goes to the host, which raises it and passes it on as asked. The event system's own sends
//            (`@eventDispatch({ to })`, `Events.send(name, args, { to })`) ride the same message as a hub envelope
//            `{ $hub: args, $target: node }`, and arrive dispatched at the receiving machine's copy of that node.
//
// Values travel as JSON, with node references by id (host and peers share node ids) and typed arrays as arrays.

import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';
import { GameEvents } from '../../core/scripting/scriptEvents';
import { receiveRemoteEvent, splitEventName } from '../../core/events/hub';
import type { RemoteEventTarget } from '../../core/events/broker';
import { NETCALL_ORIGINAL, membersOfNode } from '../../core/scripting/decorators';
import { Logger } from '../../core/logger';
import type { NetCallOptions, NetEventTarget, SceneNet } from '../../core/net/sceneNet';
import type { Node } from '../../core/scene/nodes/node';
import type { Scene } from '../../core/scene/scene';
import type { HostPeer, HostSession } from '../session/hostSession';
import type { PeerSession } from '../session/peerSession';
import type { SyncHost } from './syncHost';
import type { SyncPeer } from './syncPeer';
import type { LagCompensator } from './weapons';

export const SCRIPT_FIELDS = FIRST_APP_TYPE + 12;
export const SCRIPT_CALL = FIRST_APP_TYPE + 13;
export const SCRIPT_EVENT = FIRST_APP_TYPE + 14;
/** The same call, on the pulse lane (a `reliable: false` netcall). */
export const SCRIPT_CALL_FAST = FIRST_APP_TYPE + 4;

// ----- values ---------------------------------------------------------------------------------------------------

const isNode = (v: any): v is Node => !!v && typeof v === 'object' && typeof v.nodeType === 'string' && typeof v.id === 'string' && Array.isArray(v.children);

/** A script value as JSON: node references by id, typed arrays as plain arrays. */
export function encodeValue(value: unknown): string {
    return JSON.stringify(value === undefined ? null : value, (_key, v) => {
        if (isNode(v)) return { $node: v.id };
        if (ArrayBuffer.isView(v) && !(v instanceof DataView)) return Array.from(v as unknown as ArrayLike<number>);
        return v;
    });
}

export function decodeValue(json: string, scene: Scene | null): unknown {
    return JSON.parse(json, (_key, v) => (v && typeof v === 'object' && typeof v.$node === 'string' ? scene?.getNodeById(v.$node) ?? null : v));
}

/** The `@synced` fields of a node's script, and their onChange methods. */
function syncedFields(node: Node): { field: string; onChange?: string }[] {
    const out: { field: string; onChange?: string }[] = [];
    for (const m of membersOfNode(node)) if (m.kind === 'synced') out.push({ field: m.field, onChange: m.onChange });
    return out;
}

/** The method a `@netcall` wrapper stands for (what runs when the call arrives). */
function originalOf(node: Node, method: string): ((...args: unknown[]) => unknown) | null {
    const fn = (node as any)[method];
    return typeof fn === 'function' ? (fn[NETCALL_ORIGINAL] ?? null) : null;
}

function callMessage(type: number, netId: number, method: string, args: unknown[]): Uint8Array {
    return new ByteWriter(64).u8(type).varUint(netId).string(method).string(encodeValue(args)).finish();
}

function eventMessage(name: string, payload: unknown, to: NetEventTarget): Uint8Array {
    return new ByteWriter(64).u8(SCRIPT_EVENT).string(name).string(encodeValue(payload)).string(to).finish();
}

/** An event-system send, as it travels: its arguments, and the node it was dispatched at. */
interface HubEnvelope { $hub: unknown[]; $target?: Node | null }

function isHubEnvelope(payload: unknown): payload is HubEnvelope {
    return !!payload && typeof payload === 'object' && Array.isArray((payload as HubEnvelope).$hub);
}

/** The SCRIPT_EVENT message for an event-system send: its qualified name, and the envelope. */
function hubMessage(channel: string, name: string, args: unknown[], to: RemoteEventTarget, target: object | null): Uint8Array {
    const envelope: HubEnvelope = { $hub: args };
    if (target && isNode(target)) envelope.$target = target;
    return eventMessage(`${channel}:${name}`, envelope, to);
}

/** Raise an event that arrived on this machine: an event-system send at its node (or broadcast), else a game event. */
function deliverNetEvent(name: string, payload: unknown): void {
    if (isHubEnvelope(payload)) {
        const [channel, plain] = splitEventName(name);
        receiveRemoteEvent(channel, plain, payload.$hub, payload.$target ?? null);
        return;
    }
    GameEvents.emit(name, payload);
}

const warned = new Set<string>();
function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    Logger.warn(message, 'NetSync');
}

// ----- host -----------------------------------------------------------------------------------------------------

export interface ScriptHostOptions {
    /** The peer that owns a node (drives the character it belongs to), or 0. RemoteControl.ownerOf, usually. */
    ownerOf?: (node: Node) => number;
    /** The session's game mode, for scripts (`this.net.mode`). */
    mode?: () => string;
    /** Every synced body's recent poses (recorded each tick), for `this.net.rewound`: lag-compensated script shots. */
    history?: LagCompensator;
}

export interface ScriptHostStats { calls: number; refused: number; fieldsSent: number; events: number; }

export class ScriptHost {
    public readonly stats: ScriptHostStats = { calls: 0, refused: 0, fieldsSent: 0, events: 0 };
    private _scene: Scene | null = null;
    /** Each synced node's fields as last sent, encoded. */
    private readonly _sent = new Map<Node, Map<string, string>>();
    private _caller = 0;
    private readonly _net: SceneNet;

    constructor(private readonly _session: HostSession, private readonly _sync: SyncHost, private readonly _sceneOf: () => Scene | null, private readonly _options: ScriptHostOptions = {}) {
        const self = this;
        this._net = {
            role: 'host',
            peerId: 0,
            ownerOf: (node) => self._options.ownerOf?.(node) ?? 0,
            get caller() { return self._caller; },
            get mode() { return self._options.mode?.() ?? ''; },
            rewound: <T>(tick: number, fn: () => T): T => {
                const h = self._options.history;
                if (!h || h.newestTick < 0) return fn();
                // Never ahead of the present, never further back than the history holds.
                const at = Math.max(h.newestTick - h.ticks + 1, Math.min(h.newestTick, tick));
                return h.rewound(at, fn);
            },
            call: (node, method, original, args, options) => self._call(node, method, original, args, options),
            emit: (name, payload, to) => self._emit(name, payload, to, null),
            // The event system's sends with `to`: out to the peers as asked; this machine hears 'all' and 'host'.
            sendEvent: (channel, name, args, to, target) => {
                if (to === 'all' || to === 'peers') {
                    const msg = hubMessage(channel, name, args, 'peers', target);
                    for (const peer of self._session.peers.values()) if (peer.connected) peer.sendControl(msg);
                }
                return { local: to === 'all' || to === 'host' };
            },
        };
        _session.route('control', SCRIPT_CALL, (peer, m) => this._onCall(peer, m));
        _session.route('pulse', SCRIPT_CALL_FAST, (peer, m) => this._onCall(peer, m));
        _session.route('control', SCRIPT_EVENT, (peer, m) => this._onEvent(peer, m));
        _session.on('join', this._onJoin);
        _session.on('resume', this._onJoin);
    }

    /** Send this tick's field changes. Call every tick, after SyncHost.tick (a spawn's fields follow its spawn). */
    public tick(): void {
        const scene = this._sceneOf();
        if (scene !== this._scene) {
            if (this._scene?.net === this._net) this._scene.net = null;
            this._scene = scene;
            this._sent.clear();
            if (scene) scene.net = this._net;
        }
        if (!scene) return;
        for (const node of this._sync.synced.values()) {
            const fields = syncedFields(node);
            if (!fields.length) continue;
            let sent = this._sent.get(node);
            if (!sent) { sent = new Map(); this._sent.set(node, sent); }
            const changed: [string, string][] = [];
            for (const { field } of fields) {
                const value = encodeValue((node as any)[field]);
                if (sent.get(field) === value) continue;
                sent.set(field, value);
                changed.push([field, value]);
            }
            if (!changed.length) continue;
            const msg = this._fields(node, changed);
            if (!msg) continue;
            for (const peer of this._session.peers.values()) if (peer.connected) peer.sendControl(msg);
            this.stats.fieldsSent += changed.length;
        }
        for (const node of [...this._sent.keys()]) if (!node.scene) this._sent.delete(node);
    }

    public dispose(): void {
        if (this._scene?.net === this._net) this._scene.net = null;
        this._session.route('control', SCRIPT_CALL, null);
        this._session.route('pulse', SCRIPT_CALL_FAST, null);
        this._session.route('control', SCRIPT_EVENT, null);
        this._session.off('join', this._onJoin);
        this._session.off('resume', this._onJoin);
    }

    private _fields(node: Node, entries: [string, string][]): Uint8Array | null {
        const netId = this._sync.netIdOf(node);
        if (netId === undefined) return null;
        const w = new ByteWriter(64).u8(SCRIPT_FIELDS).varUint(this._sync.epoch).varUint(netId).varUint(entries.length);
        for (const [field, value] of entries) w.string(field).string(value);
        return w.finish();
    }

    /** A joining (or returning) peer gets every synced field as it is now, after SyncHost's baseline. */
    private readonly _onJoin = (peer: HostPeer): void => {
        if (!this._scene) return;
        for (const node of this._sync.synced.values()) {
            const fields = syncedFields(node);
            if (!fields.length) continue;
            const msg = this._fields(node, fields.map(({ field }) => [field, encodeValue((node as any)[field])]));
            if (msg) peer.sendControl(msg);
        }
    };

    private _call(node: Node, method: string, original: (...args: unknown[]) => unknown, args: unknown[], options: NetCallOptions): unknown {
        if (options.to === 'host') return original.apply(node, args);
        const netId = this._sync.netIdOf(node);
        if (netId === undefined) {
            warnOnce(`unsynced:${node.id}:${method}`, `@netcall ${method} on '${node.name}': the node is not synced, so it runs on the host only (give it a @synced field or a netSync variable).`);
            return original.apply(node, args);
        }
        const msg = callMessage(options.reliable ? SCRIPT_CALL : SCRIPT_CALL_FAST, netId, method, args);
        const send = (peer: HostPeer) => (options.reliable ? peer.sendControl(msg) : peer.sendPulse(msg));
        if (options.to === 'all') {
            for (const peer of this._session.peers.values()) if (peer.connected) send(peer);
            return original.apply(node, args);
        }
        // 'owner': the node's player, or the host itself for a node no player owns.
        const owner = this._net.ownerOf(node);
        const peer = owner ? this._session.peers.get(owner) : undefined;
        if (!peer) return original.apply(node, args);
        send(peer);
        return undefined;
    }

    private _onCall(peer: HostPeer, m: Uint8Array): void {
        let netId: number, method: string, argsJson: string;
        try { const r = new ByteReader(m, 1); netId = r.varUint(); method = r.string(); argsJson = r.string(); } catch { this.stats.refused++; return; }
        const node = this._sync.nodeOf(netId);
        const member = node ? membersOfNode(node).find((x) => x.kind === 'netcall' && x.method === method) : undefined;
        const original = node ? originalOf(node, method) : null;
        if (!node || !member || member.kind !== 'netcall' || member.to !== 'host' || !original) { this.stats.refused++; return; }
        if (!member.anyone && this._net.ownerOf(node) !== peer.id) { this.stats.refused++; return; }
        let args: unknown;
        try { args = decodeValue(argsJson, this._scene); } catch { this.stats.refused++; return; }
        this.stats.calls++;
        const was = this._caller;
        this._caller = peer.id;
        try { original.apply(node, Array.isArray(args) ? args : []); }
        catch (e) { Logger.error(`@netcall ${method} on '${node.name}' from peer ${peer.id}: ${(e as Error)?.message ?? e}`, 'NetSync'); }
        finally { this._caller = was; }
    }

    private _emit(name: string, payload: unknown, to: NetEventTarget, from: HostPeer | null): void {
        if (to === 'all' || to === 'peers') {
            const msg = eventMessage(name, payload, 'peers');
            for (const peer of this._session.peers.values()) if (peer.connected && peer !== from) peer.sendControl(msg);
        }
        if (to === 'all' || to === 'host') deliverNetEvent(name, payload);
    }

    private _onEvent(peer: HostPeer, m: Uint8Array): void {
        let name: string, json: string, to: string;
        try { const r = new ByteReader(m, 1); name = r.string(); json = r.string(); to = r.string(); } catch { return; }
        this.stats.events++;
        const payload = decodeValue(json, this._scene);
        this._emit(name, payload, to === 'host' || to === 'peers' ? to : 'all', peer);
    }
}

// ----- peer -----------------------------------------------------------------------------------------------------

export interface ScriptPeerOptions {
    /** The root of this peer's own character (its Collider, usually): what `this.net.isOwner` is true under. */
    ownRoot?: () => Node | null;
}

export class ScriptPeer {
    private readonly _net: SceneNet;
    private _epoch = -1;

    constructor(private readonly _session: PeerSession, private readonly _sync: SyncPeer, private readonly _options: ScriptPeerOptions = {}) {
        const self = this;
        this._net = {
            role: 'peer',
            get peerId() { return self._session.peerId; },
            get viewTick() { return self._sync.renderTick(); },
            ownerOf: (node) => self._owns(node) ? self._session.peerId : 0,
            caller: 0,
            call: (node, method, _original, args, options) => self._call(node, method, args, options),
            emit: (name, payload, to) => self._session.sendControl(eventMessage(name, payload, to)),
            // The event system's sends with `to`: to the host, which passes them on; this machine is one of the 'peers'.
            sendEvent: (channel, name, args, to, target) => {
                self._session.sendControl(hubMessage(channel, name, args, to, target));
                return { local: to === 'all' || to === 'peers' };
            },
        };
        _sync.scene.net = this._net;
        // Fields arrive on the control lane after the table and spawns they belong to.
        _session.route('control', [SCRIPT_FIELDS, SCRIPT_CALL, SCRIPT_EVENT], (m) => this._onControl(m));
        _session.route('pulse', SCRIPT_CALL_FAST, (m) => this._onCall(m));
    }

    public dispose(): void {
        if (this._sync.scene.net === this._net) this._sync.scene.net = null;
        this._session.route('control', [SCRIPT_FIELDS, SCRIPT_CALL, SCRIPT_EVENT], null);
        this._session.route('pulse', SCRIPT_CALL_FAST, null);
    }

    private _owns(node: Node): boolean {
        const root = this._options.ownRoot?.();
        for (let n: Node | null = node; n && root; n = n.parent) if (n === root) return true;
        return false;
    }

    private _call(node: Node, method: string, args: unknown[], options: NetCallOptions): unknown {
        if (options.to !== 'host') {
            warnOnce(`peer:${method}`, `@netcall ${method}: only the host may call a netcall meant for '${options.to}'; ignored on this peer.`);
            return undefined;
        }
        const netId = this._sync.netIdOf(node);
        if (netId === undefined) {
            warnOnce(`peer-unsynced:${node.id}:${method}`, `@netcall ${method} on '${node.name}': the node is not synced, so the host cannot be asked.`);
            return undefined;
        }
        const msg = callMessage(options.reliable ? SCRIPT_CALL : SCRIPT_CALL_FAST, netId, method, args);
        if (options.reliable) this._session.sendControl(msg); else this._session.sendPulse(msg);
        return undefined;
    }

    private _onControl(m: Uint8Array): void {
        if (m[0] === SCRIPT_CALL) { this._onCall(m); return; }
        const r = new ByteReader(m, 1);
        if (m[0] === SCRIPT_EVENT) {
            const name = r.string(), json = r.string();
            deliverNetEvent(name, decodeValue(json, this._sync.scene));
            return;
        }
        // Fields.
        const epoch = r.varUint();
        if (epoch < this._epoch) return; // from a scene the host has left
        this._epoch = epoch;
        const node = this._sync.nodeOf(r.varUint());
        const count = r.varUint();
        for (let i = 0; i < count; i++) {
            const field = r.string(), json = r.string();
            if (!node) continue;
            const prev = (node as any)[field];
            // Unchanged (a join's baseline repeating what the scene was built with): nothing to apply or announce.
            if (encodeValue(prev) === json) continue;
            const value = decodeValue(json, this._sync.scene);
            (node as any)[field] = value;
            const onChange = syncedFields(node).find((f) => f.field === field)?.onChange;
            const handler = onChange ? (node as any)[onChange] : null;
            if (typeof handler === 'function') {
                try { handler.call(node, prev); }
                catch (e) { Logger.error(`@synced ${field} onChange ${onChange} on '${node.name}': ${(e as Error)?.message ?? e}`, 'NetSync'); }
            }
        }
    }

    private _onCall(m: Uint8Array): void {
        let netId: number, method: string, argsJson: string;
        try { const r = new ByteReader(m, 1); netId = r.varUint(); method = r.string(); argsJson = r.string(); } catch { return; }
        const node = this._sync.nodeOf(netId);
        const original = node ? originalOf(node, method) : null;
        if (!node || !original) return;
        const args = decodeValue(argsJson, this._sync.scene);
        try { original.apply(node, Array.isArray(args) ? args : []); }
        catch (e) { Logger.error(`@netcall ${method} on '${node.name}': ${(e as Error)?.message ?? e}`, 'NetSync'); }
    }
}
