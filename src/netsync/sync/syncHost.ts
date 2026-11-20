// The host's side of NetSync state (docs/design/netsync.md §6.1–6.4, §6.6): which nodes are synced and under what
// NetId, what the peers must be told when a template is spawned or a node removed, and — every tick, for every
// peer — which node states to send.
//
// What goes in a pulse. Rows are ABSOLUTE quantized state (sync/quantize.ts), so every datagram stands alone and
// a lost one costs nothing but freshness. A node is a candidate for a peer when its state differs from the last
// state that peer ACKNOWLEDGED; a candidate already sent with the same state within `resendTicks` is in flight and
// waits. Candidates are ranked by accumulated priority (a character counts more than a crate; waiting raises it)
// and packed until the per-peer byte budget is spent. A body at rest is sent once, acknowledged, and then costs
// nothing — in a sandbox, that is most props most of the time.
//
// Driven by the host: call `tick(n)` once per simulation tick, after the step.

import { ByteReader, ByteWriter } from '../bytes';
import { engineEventBus } from '../../core/eventBus';
import type { SceneChange } from '../../core/eventBus';
import type { Node } from '../../core/scene/nodes/node';
import type { Scene } from '../../core/scene/scene';
import type { HostPeer, HostSession } from '../session/hostSession';
import { quantizeState, rowSize, sameState, writeRow, type QState } from './quantize';
import {
    PULSE_HEADER_BYTES, SyncPulse, decodeAck, encodeDespawn, encodeSpawn, encodeTable, type SyncSpawn,
} from './syncMessages';

export interface SyncHostOptions {
    /** Pulse bytes per peer per tick. Default 1200 (≈36 KB/s at 30 Hz). */
    bytesPerTick?: number;
    /** Ticks an unacknowledged row is assumed in flight before it is sent again. Default 6 (200 ms at 30 Hz). */
    resendTicks?: number;
    /** Which nodes are synced. Default: dynamic colliders, characters, and nodes with a truthy `netSync` variable. */
    isSynced?: (node: Node) => boolean;
    /** A name for the scene peers should be in (the game's scene id). Default: empty. */
    sceneKey?: (scene: Scene) => string;
}

/** What a node weighs in the priority race (docs/design/netsync.md §6.6). */
function weightOf(node: Node): number {
    return node.nodeType === 'character' ? 4 : 1;
}

export function defaultIsSynced(node: Node): boolean {
    if (node.nodeType === 'character') return true;
    if (node.nodeType === 'collider' && ((node as any).mass ?? 0) > 0) return true;
    const flag = (node as any).getVariable?.('netSync');
    return flag === true || flag === 1 || flag === 'true';
}

/** Per-peer bookkeeping. */
class PeerSync {
    public ready = false;
    /** Newest state each NetId is known to have reached this peer, and the tick it was sent at. */
    public readonly acked = new Map<number, QState>();
    public readonly ackedTick = new Map<number, number>();
    public readonly lastSent = new Map<number, { state: QState; tick: number }>();
    /** What each recent pulse datagram carried (by sequence number) and the tick it was for, until acknowledged or too old. */
    public readonly sent = new Map<number, { tick: number; rows: [number, QState][] }>();
    public nextSeq = 1;
    public readonly priority = new Map<number, number>();
    public bytesLastTick = 0;
    public rowsLastTick = 0;
    public bytesTotal = 0;
    public maxBytesPerTick = 0;
}

export interface SyncPeerStats { bytesLastTick: number; rowsLastTick: number; bytesTotal: number; maxBytesPerTick: number; }

export class SyncHost {
    public readonly bytesPerTick: number;
    public readonly resendTicks: number;
    private readonly _isSynced: (node: Node) => boolean;
    private readonly _sceneKey: (scene: Scene) => string;

    private _scene: Scene | null = null;
    private _epoch = 0;
    private _nextNetId = 1;
    private readonly _nodeByNet = new Map<number, Node>();
    private readonly _netByNode = new Map<string, number>();
    /** Authored synced nodes and their NetIds, for the table a joining peer gets. */
    private readonly _authored = new Map<number, string>();
    /** Copies spawned this scene and still alive, by root node id: what a joining peer must instantiate. */
    private readonly _spawns = new Map<string, SyncSpawn>();
    /** Every node the scene had when it began (by id), to tell an authored node's removal from a transient one's. */
    private readonly _authoredIds = new Set<string>();
    /** Authored nodes removed this scene: a joining peer removes them too. */
    private readonly _removedAuthored = new Set<string>();
    private readonly _peers = new Map<number, PeerSync>();
    private _added: Node[] = [];
    private _removed: Node[] = [];

    constructor(private readonly _session: HostSession, private readonly _sceneOf: () => Scene | null, options: SyncHostOptions = {}) {
        this.bytesPerTick = options.bytesPerTick ?? 1200;
        this.resendTicks = options.resendTicks ?? 6;
        this._isSynced = options.isSynced ?? defaultIsSynced;
        this._sceneKey = options.sceneKey ?? (() => '');
        engineEventBus.on('SCENE_CHANGED', this._onSceneChanged);
        _session.on('join', this._onJoin);
        _session.on('resume', this._onJoin);
        _session.on('leave', this._onLeave);
        _session.onPulse = (peer, m) => this._onPulse(peer, m);
    }

    /** The NetId of a synced node, or undefined. */
    public netIdOf(node: Node): number | undefined { return this._netByNode.get(node.id); }
    /** How many nodes are synced now. */
    public get syncedCount(): number { return this._nodeByNet.size; }
    public get epoch(): number { return this._epoch; }

    public peerStats(peerId: number): SyncPeerStats | null {
        const p = this._peers.get(peerId);
        return p ? { bytesLastTick: p.bytesLastTick, rowsLastTick: p.rowsLastTick, bytesTotal: p.bytesTotal, maxBytesPerTick: p.maxBytesPerTick } : null;
    }

    /** Send this tick's spawns, removals and pulses. Call after every simulation tick. */
    public tick(tick: number): void {
        const scene = this._sceneOf();
        if (scene !== this._scene) this._beginScene(scene);
        if (!scene) return;
        this._flushStructure(scene);

        // Every synced node's state, once for all peers.
        const states = new Map<number, QState>();
        for (const [netId, node] of this._nodeByNet) states.set(netId, this._stateOf(node));

        for (const hostPeer of this._session.peers.values()) {
            const p = this._peers.get(hostPeer.id);
            if (!p || !p.ready || !hostPeer.connected) continue;
            this._pulse(hostPeer, p, tick, states);
        }
    }

    public dispose(): void {
        engineEventBus.off('SCENE_CHANGED', this._onSceneChanged);
        this._session.off('join', this._onJoin);
        this._session.off('resume', this._onJoin);
        this._session.off('leave', this._onLeave);
        this._session.onPulse = null;
    }

    // ----- scene and structure ---------------------------------------------------------------------------

    private _beginScene(scene: Scene | null): void {
        this._scene = scene;
        this._epoch++;
        this._nodeByNet.clear();
        this._netByNode.clear();
        this._authored.clear();
        this._spawns.clear();
        this._removedAuthored.clear();
        this._authoredIds.clear();
        this._added = [];
        this._removed = [];
        if (scene) {
            const walk = (node: Node) => {
                this._authoredIds.add(node.id);
                if (this._isSynced(node)) this._authored.set(this._register(node), node.id);
                for (const child of node.children) walk(child);
            };
            for (const child of scene.root.children) walk(child);
        }
        // Everyone gets the new scene's table; until then their old state is meaningless.
        for (const [peerId, p] of this._peers) {
            this._reset(p);
            const hostPeer = this._session.peers.get(peerId);
            if (hostPeer?.connected) this._sendBaseline(hostPeer, p);
        }
    }

    private _register(node: Node): number {
        const existing = this._netByNode.get(node.id);
        if (existing !== undefined) return existing;
        const netId = this._nextNetId++;
        this._nodeByNet.set(netId, node);
        this._netByNode.set(node.id, netId);
        return netId;
    }

    private readonly _onSceneChanged = (e: SceneChange): void => {
        if (e.kind !== 'structure' || !e.node || !this._scene || (e as any).scene !== this._scene) return;
        if (e.prop === 'add') this._added.push(e.node);
        else if (e.prop === 'remove') this._removed.push(e.node);
    };

    /** Turn this tick's structural events into spawn and despawn messages. */
    private _flushStructure(scene: Scene): void {
        const removed = this._removed;
        const added = this._added;
        this._removed = [];
        this._added = [];

        const spawns: SyncSpawn[] = [];
        for (const node of added) {
            // Only a template copy's root (instanceOf is set by Scene.instantiate), still in this scene.
            const template = node._saveInfo?.().instanceOf;
            if (!template || node.scene !== scene || this._spawns.has(node.id)) continue;
            const ids: string[] = [];
            const synced: SyncSpawn['synced'] = [];
            const walk = (n: Node) => {
                const index = ids.length;
                ids.push(n.id);
                if (this._isSynced(n)) synced.push({ index, netId: this._register(n) });
                for (const c of n.children) walk(c);
            };
            walk(node);
            const spawn: SyncSpawn = {
                epoch: this._epoch,
                netId: this._netByNode.get(node.id) ?? 0,
                template,
                parentId: node.parent && node.parent !== scene.root ? node.parent.id : '',
                ids,
                synced,
            };
            this._spawns.set(node.id, spawn);
            spawns.push(spawn);
        }

        const nodeIds: string[] = [];
        const netIds: number[] = [];
        for (const node of removed) {
            // Re-added elsewhere in the same tick (a reparent) is not a removal.
            if (node.scene === scene) continue;
            const wasSpawned = this._spawns.delete(node.id);
            const before = netIds.length;
            const walk = (n: Node) => {
                const netId = this._netByNode.get(n.id);
                if (netId !== undefined) {
                    netIds.push(netId);
                    this._netByNode.delete(n.id);
                    this._nodeByNet.delete(netId);
                    this._authored.delete(netId);
                }
                for (const c of n.children) walk(c);
            };
            walk(node);
            const authored = this._authoredIds.has(node.id);
            // A transient node (not authored, not a spawned copy, nothing synced in it) is the peer's own business.
            if (wasSpawned || authored || netIds.length > before) nodeIds.push(node.id);
            if (authored) this._removedAuthored.add(node.id);
        }

        for (const hostPeer of this._session.peers.values()) {
            const p = this._peers.get(hostPeer.id);
            if (!p?.ready || !hostPeer.connected) continue;
            for (const s of spawns) hostPeer.sendControl(encodeSpawn(s));
            if (nodeIds.length || netIds.length) hostPeer.sendControl(encodeDespawn({ epoch: this._epoch, nodeIds, netIds }));
            for (const id of netIds) this._forget(p, id);
        }
    }

    // ----- peers ------------------------------------------------------------------------------------------

    private readonly _onJoin = (hostPeer: HostPeer): void => {
        let p = this._peers.get(hostPeer.id);
        if (!p) { p = new PeerSync(); this._peers.set(hostPeer.id, p); }
        // A resumed peer may have missed anything while it was away: it starts over from a fresh baseline.
        this._reset(p);
        if (this._scene) this._sendBaseline(hostPeer, p);
    };

    private readonly _onLeave = (e: { peer: HostPeer }): void => {
        this._peers.delete(e.peer.id);
    };

    private _reset(p: PeerSync): void {
        p.ready = false;
        p.acked.clear();
        p.ackedTick.clear();
        p.lastSent.clear();
        p.sent.clear();
        p.priority.clear();
    }

    private _forget(p: PeerSync, netId: number): void {
        p.acked.delete(netId);
        p.ackedTick.delete(netId);
        p.lastSent.delete(netId);
        p.priority.delete(netId);
    }

    /** The table, every live spawn, and every removal so far: what a peer needs to match the scene now. */
    private _sendBaseline(hostPeer: HostPeer, p: PeerSync): void {
        const scene = this._scene!;
        hostPeer.sendControl(encodeTable({
            epoch: this._epoch,
            sceneId: this._sceneKey(scene),
            entries: [...this._authored].map(([netId, nodeId]) => ({ netId, nodeId })),
        }));
        if (this._removedAuthored.size) {
            hostPeer.sendControl(encodeDespawn({ epoch: this._epoch, nodeIds: [...this._removedAuthored], netIds: [] }));
        }
        for (const s of this._spawns.values()) hostPeer.sendControl(encodeSpawn({ ...s, epoch: this._epoch }));
        p.ready = true;
    }

    private _onPulse(hostPeer: HostPeer, m: Uint8Array): void {
        if (m[0] !== SyncPulse.ack) return;
        const p = this._peers.get(hostPeer.id);
        if (!p) return;
        let ack: { latestSeq: number; received: number };
        try { ack = decodeAck(new ByteReader(m, 1)); } catch { return; }
        const take = (seq: number) => {
            const pulse = p.sent.get(seq);
            if (!pulse) return;
            p.sent.delete(seq);
            for (const [netId, state] of pulse.rows) {
                if ((p.ackedTick.get(netId) ?? -1) >= pulse.tick) continue;
                p.acked.set(netId, state);
                p.ackedTick.set(netId, pulse.tick);
            }
        };
        take(ack.latestSeq);
        for (let i = 0; i < 32; i++) if (ack.received & (1 << i)) take(ack.latestSeq - 1 - i);
        for (const seq of p.sent.keys()) if (seq < ack.latestSeq - 64) p.sent.delete(seq);
    }

    // ----- pulses -----------------------------------------------------------------------------------------

    private _stateOf(node: Node): QState {
        const body = node.nodeType === 'collider' ? (node as any).body : null;
        const dynamic = !!body?.isDynamic;
        return quantizeState(
            node.position, node.quaternion,
            dynamic ? body.velocity.toArray() : null,
            dynamic ? !!body.isSleeping : false,
        );
    }

    private _pulse(hostPeer: HostPeer, p: PeerSync, tick: number, states: Map<number, QState>): void {
        const candidates: number[] = [];
        for (const [netId, state] of states) {
            if (sameState(p.acked.get(netId), state)) { p.priority.delete(netId); continue; }
            const last = p.lastSent.get(netId);
            if (last && sameState(last.state, state) && tick - last.tick < this.resendTicks) continue;
            p.priority.set(netId, (p.priority.get(netId) ?? 0) + weightOf(this._nodeByNet.get(netId)!));
            candidates.push(netId);
        }
        candidates.sort((a, b) => p.priority.get(b)! - p.priority.get(a)!);

        const budget = hostPeer.link?.pulseBudget ?? 1000;
        let spent = 0;
        let rowsSent = 0;
        let i = 0;
        while (i < candidates.length && spent + PULSE_HEADER_BYTES < this.bytesPerTick) {
            const room = Math.min(budget, this.bytesPerTick - spent);
            const rows: [number, QState][] = [];
            let size = PULSE_HEADER_BYTES;
            while (i < candidates.length) {
                const netId = candidates[i];
                const state = states.get(netId)!;
                const bytes = rowSize(netId, state);
                if (size + bytes > room) break;
                rows.push([netId, state]);
                size += bytes;
                i++;
            }
            if (!rows.length) break;
            const seq = p.nextSeq;
            const w = new ByteWriter(size).u8(SyncPulse.pulse).varUint(this._epoch).u32(tick).u32(seq).varUint(rows.length);
            for (const [netId, state] of rows) writeRow(w, netId, state);
            // A link with a backlog (the WebSocket fallback) skips the pulse: nothing is recorded as sent, so
            // the same rows compete again next tick with fresher state.
            if (!hostPeer.sendPulse(w.finish())) break;
            p.nextSeq = (seq + 1) >>> 0;
            spent += size;
            rowsSent += rows.length;
            p.sent.set(seq, { tick, rows });
            for (const [netId, state] of rows) {
                p.lastSent.set(netId, { state, tick });
                p.priority.delete(netId);
            }
        }
        p.bytesLastTick = spent;
        p.rowsLastTick = rowsSent;
        p.bytesTotal += spent;
        p.maxBytesPerTick = Math.max(p.maxBytesPerTick, spent);
    }
}
