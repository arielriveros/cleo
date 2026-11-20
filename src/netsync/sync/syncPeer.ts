// A peer's side of NetSync state (docs/design/netsync.md §6.1–6.4): it makes its scene match the host's — the
// same spawned copies under the same ids, the same removals — and moves every synced node to where the host had it.
//
// FOLLOW. Pulses are buffered per node by host tick. Every frame, `apply()` draws each followed node a little in
// the past (`delayTicks` behind the host clock this peer estimates), interpolating between the two states around
// that moment. When pulses are late it extrapolates a moving body along its velocity for up to `extrapolateMs`,
// then holds. The delay is the price of smoothness: it is what lets a lost pulse go unnoticed.
//
// This peer only follows: it does not simulate the nodes it moves (the host does). Whether its scene runs scripts
// and physics for anything else is the game's business (docs/design/netsync.md §6.9, phase 7).

import { quat, vec3 } from 'gl-matrix';
import { ByteReader } from '../bytes';
import type { Node } from '../../core/scene/nodes/node';
import type { Scene } from '../../core/scene/scene';
import type { PeerSession } from '../session/peerSession';
import { POSITION_SCALE, VELOCITY_SCALE, readRow, unpackQuaternion, type QState } from './quantize';
import { SyncControl, SyncPulse, decodeDespawn, decodeSpawn, decodeTable, encodeAck, type SyncSpawn } from './syncMessages';

export interface SyncPeerOptions {
    /** How far behind the host clock nodes are drawn, in ticks. Default 2 (plus the link's jitter is absorbed by it). */
    delayTicks?: number;
    /** Longest extrapolation past the newest state, ms. Default 100. */
    extrapolateMs?: number;
}

interface Sample { tick: number; state: QState; }

const BUFFER = 32;

export class SyncPeer {
    public readonly delayTicks: number;
    public readonly extrapolateMs: number;
    /** Pulses and rows received, for the debugger and tests. */
    public pulses = 0;
    public rows = 0;
    public bytes = 0;
    /** Rows naming a NetId this peer does not know (yet): a spawn still on its way, or a stale epoch. */
    public unknownRows = 0;

    private _epoch = -1;
    private _sceneId = '';
    private readonly _nodeByNet = new Map<number, Node>();
    private readonly _samples = new Map<number, Sample[]>();
    private _latestSeq = -1;
    private _received = 0; // bit i: pulse latest-1-i arrived

    private readonly _pos = vec3.create();
    private readonly _rot = quat.create();
    private readonly _rotB = quat.create();
    private readonly _unpack: number[] = [0, 0, 0, 1];

    constructor(private readonly _session: PeerSession, private _scene: Scene, options: SyncPeerOptions = {}) {
        this.delayTicks = options.delayTicks ?? 2;
        this.extrapolateMs = options.extrapolateMs ?? 100;
        _session.onControl = (m) => this._onControl(m);
        _session.onPulse = (m) => this._onPulse(m);
    }

    public get scene(): Scene { return this._scene; }
    /** The host's name for the scene it is running (its table's). */
    public get sceneId(): string { return this._sceneId; }
    /** The node a NetId stands for here. */
    public nodeOf(netId: number): Node | undefined { return this._nodeByNet.get(netId); }
    public get followedCount(): number { return this._nodeByNet.size; }

    /** Move every followed node to where the host had it `delayTicks` ago. Call once per frame, before drawing. */
    public apply(): void {
        const tickMs = 1000 / this._session.tickRate;
        const renderTick = this._session.hostTimeNow() / tickMs - this.delayTicks;
        for (const [netId, samples] of this._samples) {
            const node = this._nodeByNet.get(netId);
            if (!node || samples.length === 0) continue;
            this._sample(samples, renderTick, tickMs);
            node.setPosition(this._pos);
            node.setQuaternion(this._rot);
        }
    }

    public dispose(): void {
        this._session.onControl = null;
        this._session.onPulse = null;
    }

    // ----- control --------------------------------------------------------------------------------------------

    private _onControl(m: Uint8Array): void {
        const r = new ByteReader(m, 1);
        switch (m[0]) {
            case SyncControl.table: {
                const t = decodeTable(r);
                this._epoch = t.epoch;
                this._sceneId = t.sceneId;
                this._nodeByNet.clear();
                this._samples.clear();
                // A new baseline restarts the host's numbering for this peer.
                this._latestSeq = -1;
                this._received = 0;
                for (const e of t.entries) {
                    const node = this._scene.getNodeById(e.nodeId);
                    if (node) this._nodeByNet.set(e.netId, node);
                }
                break;
            }
            case SyncControl.spawn: {
                const s = decodeSpawn(r);
                if (s.epoch === this._epoch) this._spawn(s);
                break;
            }
            case SyncControl.despawn: {
                const d = decodeDespawn(r);
                if (d.epoch !== this._epoch) break;
                for (const id of d.netIds) { this._nodeByNet.delete(id); this._samples.delete(id); }
                for (const id of d.nodeIds) {
                    const node = this._scene.getNodeById(id);
                    if (node) this._scene.removeNode(node);
                }
                break;
            }
        }
    }

    /** Make the host's copy of a template here, with the very same node ids. */
    private _spawn(s: SyncSpawn): void {
        if (this._scene.getNodeById(s.ids[0])) return; // already here (a baseline after a resume)
        const parent = s.parentId ? this._scene.getNodeById(s.parentId) ?? undefined : undefined;
        const made = this._scene.instantiate(s.template, parent ? { parent } : {}, (json) => {
            let i = 0;
            const walk = (n: any) => {
                if (i < s.ids.length) n.id = s.ids[i++];
                for (const c of n.children ?? []) walk(c);
            };
            walk(json);
        });
        if (!made) return;
        for (const { index, netId } of s.synced) {
            const node = this._scene.getNodeById(s.ids[index]);
            if (node) this._nodeByNet.set(netId, node);
        }
    }

    // ----- pulses ---------------------------------------------------------------------------------------------

    private _onPulse(m: Uint8Array): void {
        if (m[0] !== SyncPulse.pulse) return;
        const r = new ByteReader(m, 1);
        let epoch: number, tick: number, seq: number, count: number;
        try { epoch = r.varUint(); tick = r.u32(); seq = r.u32(); count = r.varUint(); } catch { return; }
        if (epoch !== this._epoch) return;
        this.pulses++;
        this.bytes += m.length;
        try {
            for (let i = 0; i < count; i++) {
                const { netId, state } = readRow(r);
                this.rows++;
                if (!this._nodeByNet.has(netId)) { this.unknownRows++; continue; }
                this._store(netId, tick, state);
            }
        } catch { /* a truncated pulse: keep what was read */ }
        this._acknowledge(seq);
    }

    private _store(netId: number, tick: number, state: QState): void {
        let samples = this._samples.get(netId);
        if (!samples) { samples = []; this._samples.set(netId, samples); }
        // Pulses can arrive out of order: keep the buffer sorted by tick, newest last.
        let at = samples.length;
        while (at > 0 && samples[at - 1].tick > tick) at--;
        if (at > 0 && samples[at - 1].tick === tick) { samples[at - 1].state = state; return; }
        samples.splice(at, 0, { tick, state });
        if (samples.length > BUFFER) samples.shift();
    }

    /** Acknowledge pulse `seq`, with the 32 before the newest as a bit field (a lost ack is covered by the next). */
    private _acknowledge(seq: number): void {
        if (seq > this._latestSeq) {
            const shift = this._latestSeq < 0 ? 33 : seq - this._latestSeq;
            this._received = shift >= 32 ? 0 : (this._received << shift) >>> 0;
            if (this._latestSeq >= 0 && shift <= 32) this._received = (this._received | (1 << (shift - 1))) >>> 0;
            this._latestSeq = seq;
        } else if (seq < this._latestSeq && this._latestSeq - seq <= 32) {
            this._received = (this._received | (1 << (this._latestSeq - seq - 1))) >>> 0;
        }
        this._session.sendPulse(encodeAck(this._latestSeq, this._received));
    }

    /** The state at `renderTick` into `_pos` / `_rot`: interpolated, extrapolated a little, or held. */
    private _sample(samples: Sample[], renderTick: number, tickMs: number): void {
        let i = samples.length - 1;
        while (i > 0 && samples[i].tick > renderTick) i--;
        const a = samples[i];
        const b = samples[i + 1];
        this._read(a.state, this._pos, this._rot);
        if (a.tick > renderTick) return; // before the oldest kept state: hold it
        if (b) {
            const t = (renderTick - a.tick) / (b.tick - a.tick);
            const bp = vec3.fromValues(b.state.px / POSITION_SCALE, b.state.py / POSITION_SCALE, b.state.pz / POSITION_SCALE);
            vec3.lerp(this._pos, this._pos, bp, t);
            unpackQuaternion(b.state.rot, this._unpack);
            quat.set(this._rotB, this._unpack[0], this._unpack[1], this._unpack[2], this._unpack[3]);
            quat.slerp(this._rot, this._rot, this._rotB, t);
            return;
        }
        // Past the newest state: carry a moving body on along its velocity, briefly.
        const s = a.state;
        if (s.vx === undefined || s.sleeping) return;
        const seconds = Math.min((renderTick - a.tick) * tickMs, this.extrapolateMs) / 1000;
        this._pos[0] += (s.vx / VELOCITY_SCALE) * seconds;
        this._pos[1] += (s.vy! / VELOCITY_SCALE) * seconds;
        this._pos[2] += (s.vz! / VELOCITY_SCALE) * seconds;
    }

    private _read(s: QState, pos: vec3, rot: quat): void {
        vec3.set(pos, s.px / POSITION_SCALE, s.py / POSITION_SCALE, s.pz / POSITION_SCALE);
        unpackQuaternion(s.rot, this._unpack);
        quat.set(rot, this._unpack[0], this._unpack[1], this._unpack[2], this._unpack[3]);
    }
}
