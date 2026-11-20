// Carrying props (docs/design/netsync.md §6.4.2): picking up, carrying, throwing and dropping must feel local,
// which host-only simulation cannot give a round trip away.
//
// While a peer carries a prop, the PEER moves it — at once, on its own screen — and sends its pose every tick. The
// host drives its copy toward that pose (by velocity, so it still pushes other props), within reach of the
// carrier's character and under a speed cap: co-op trust validates loosely, `versus` tightly. Everyone else follows
// the prop as usual. A throw gives the host the prop back with the thrower's velocity (capped); the thrower keeps
// flying it on its own screen for a moment and then blends to the host's states, so the hand-over shows no jump.
//
//   peer → host  grab {netId} · throw {netId, velocity} · drop {netId}   control lane
//   peer → host  pose {netId, tick, position, rotation}                  pulse lane, every tick
//   host → all   carry {netId, peerId} (peerId 0: put down)               control lane

import { quat, vec3 } from 'gl-matrix';
import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';
import type { Node } from '../../core/scene/nodes/node';
import type { HostPeer, HostSession } from '../session/hostSession';
import type { PeerSession } from '../session/peerSession';
import { packQuaternion, unpackQuaternion } from './quantize';
import type { SyncHost } from './syncHost';
import type { SyncPeer } from './syncPeer';

export const CARRY_GRAB = FIRST_APP_TYPE + 4;
export const CARRY_THROW = FIRST_APP_TYPE + 5;
export const CARRY_DROP = FIRST_APP_TYPE + 6;
export const CARRY_STATE = FIRST_APP_TYPE + 7;
/** Pulse lane. */
export const CARRY_POSE = FIRST_APP_TYPE + 3;

export type Trust = 'coop' | 'versus';

// ----- wire -----------------------------------------------------------------------------------------------

const netIdMsg = (type: number, netId: number) => new ByteWriter(6).u8(type).varUint(netId).finish();

function vec(w: ByteWriter, v: ArrayLike<number>): ByteWriter {
    const f = new Float32Array([v[0], v[1], v[2]]);
    return w.raw(new Uint8Array(f.buffer));
}

function readVec(r: ByteReader): vec3 {
    const b = r.raw(12).slice();
    const f = new Float32Array(b.buffer);
    return vec3.fromValues(f[0], f[1], f[2]);
}

// ----- host ---------------------------------------------------------------------------------------------------

export interface CarryHostOptions {
    /** The character a peer drives (RemoteControl.controllerOf(id)?.possessed). Carrying needs one. */
    pawnOf: (peerId: number) => Node | null;
    /** Metres from the character a prop can be grabbed and held. Default 2.5. */
    reach?: number;
    /** Fastest throw accepted, m/s. Default 25. */
    maxThrowSpeed?: number;
    /** Ticks without a pose before a carry ends on its own (the carrier went quiet). Default 15. */
    timeoutTicks?: number;
    /** `coop` (default) allows 1.5 × the reach, `versus` exactly the reach. */
    trust?: Trust;
    /** World gravity, to hold a carried prop against it. Default [0, -9.81, 0]. */
    gravity?: () => ArrayLike<number>;
}

interface Carry { peerId: number; node: Node; pose: { pos: vec3; rot: quat } | null; lastTick: number; }

export interface CarryHostStats { grabs: number; refused: number; throws: number; clamped: number; }

export class CarryHost {
    public readonly stats: CarryHostStats = { grabs: 0, refused: 0, throws: 0, clamped: 0 };
    private readonly _carries = new Map<number, Carry>();
    private readonly _reach: number;
    private readonly _maxThrow: number;
    private readonly _timeout: number;
    private _tick = 0;

    constructor(private readonly _session: HostSession, private readonly _sync: SyncHost, private readonly _options: CarryHostOptions) {
        const trust = _options.trust ?? 'coop';
        this._reach = (_options.reach ?? 2.5) * (trust === 'coop' ? 1.5 : 1);
        this._maxThrow = _options.maxThrowSpeed ?? 25;
        this._timeout = _options.timeoutTicks ?? 15;
        _session.route('control', CARRY_GRAB, (peer, m) => this._grab(peer, new ByteReader(m, 1).varUint()));
        _session.route('control', CARRY_DROP, (peer, m) => this._end(new ByteReader(m, 1).varUint(), peer.id, null));
        _session.route('control', CARRY_THROW, (peer, m) => {
            const r = new ByteReader(m, 1);
            const netId = r.varUint();
            this._end(netId, peer.id, readVec(r));
        });
        _session.route('pulse', CARRY_POSE, (peer, m) => this._pose(peer, m));
        _session.on('leave', this._onGone);
        _session.on('drop', this._onGone);
    }

    /** Which peer carries a prop, or 0. */
    public carrierOf(netId: number): number { return this._carries.get(netId)?.peerId ?? 0; }

    /** Drive every carried prop toward its carrier's pose. Call before the host steps tick `tick`. */
    public beforeTick(tick: number, dt: number): void {
        this._tick = tick;
        const g = this._options.gravity?.() ?? [0, -9.81, 0];
        for (const [netId, c] of this._carries) {
            if (!c.node.scene) { this._carries.delete(netId); continue; }
            if (tick - c.lastTick > this._timeout) { this._end(netId, c.peerId, null); continue; }
            const body = (c.node as any).body;
            if (!c.pose || !body) continue;
            // By velocity, not a teleport: on the way it pushes what it meets, as a held crate should. Less the
            // gravity the step will add, so it arrives rather than sagging.
            const at = body.position.toArray();
            body.velocity.set(
                (c.pose.pos[0] - at[0]) / dt - g[0] * dt,
                (c.pose.pos[1] - at[1]) / dt - g[1] * dt,
                (c.pose.pos[2] - at[2]) / dt - g[2] * dt,
            );
            body.angularVelocity.set(0, 0, 0);
            body.setQuaternion(c.pose.rot);
            body.wakeUp?.();
        }
    }

    public dispose(): void {
        for (const t of [CARRY_GRAB, CARRY_DROP, CARRY_THROW]) this._session.route('control', t, null);
        this._session.route('pulse', CARRY_POSE, null);
        this._session.off('leave', this._onGone);
        this._session.off('drop', this._onGone);
    }

    private _grab(peer: HostPeer, netId: number): void {
        const node = this._sync.nodeOf(netId);
        const pawn = this._options.pawnOf(peer.id);
        const body = (node as any)?.body;
        const ok = !!node && !!pawn && !!body?.isDynamic && !this._carries.has(netId)
            && vec3.distance(node.worldPosition, pawn.worldPosition) <= this._reach + 1;
        if (!ok) {
            this.stats.refused++;
            // Tell the peer it does not hold it (it may already be carrying it on its own screen).
            peer.sendControl(this._state(netId, this.carrierOf(netId)));
            return;
        }
        this.stats.grabs++;
        this._carries.set(netId, { peerId: peer.id, node: node!, pose: null, lastTick: this._tick });
        this._broadcast(this._state(netId, peer.id));
    }

    private _pose(peer: HostPeer, m: Uint8Array): void {
        const r = new ByteReader(m, 1);
        let netId: number, tick: number, pos: vec3, packed: number;
        try { netId = r.varUint(); tick = r.u32(); pos = readVec(r); packed = r.u32(); } catch { return; }
        const c = this._carries.get(netId);
        if (!c || c.peerId !== peer.id) return;
        // Within reach of the carrier, wherever it says.
        const pawn = this._options.pawnOf(peer.id);
        if (pawn) {
            const from = pawn.worldPosition;
            const d = vec3.subtract(vec3.create(), pos, from);
            const len = vec3.length(d);
            if (len > this._reach) {
                this.stats.clamped++;
                vec3.scaleAndAdd(pos, from, d, this._reach / len);
            }
        }
        const rot = unpackQuaternion(packed) as number[];
        c.pose = { pos, rot: quat.fromValues(rot[0], rot[1], rot[2], rot[3]) };
        c.lastTick = Math.max(c.lastTick, Math.min(tick, this._tick + 30));
    }

    private _end(netId: number, peerId: number, velocity: vec3 | null): void {
        const c = this._carries.get(netId);
        if (!c || c.peerId !== peerId) return;
        this._carries.delete(netId);
        const body = (c.node as any).body;
        if (body) {
            const v = velocity ?? vec3.create();
            const speed = vec3.length(v);
            if (speed > this._maxThrow) vec3.scale(v, v, this._maxThrow / speed);
            body.velocity.set(v[0], v[1], v[2]);
            body.wakeUp?.();
            if (velocity) this.stats.throws++;
        }
        this._broadcast(this._state(netId, 0));
    }

    private readonly _onGone = (e: { peer: HostPeer }): void => {
        for (const [netId, c] of [...this._carries]) if (c.peerId === e.peer.id) this._end(netId, c.peerId, null);
    };

    private _state(netId: number, peerId: number): Uint8Array {
        return new ByteWriter(8).u8(CARRY_STATE).varUint(netId).u16(peerId).finish();
    }

    private _broadcast(m: Uint8Array): void {
        for (const p of this._session.peers.values()) p.sendControl(m);
    }
}

// ----- peer ---------------------------------------------------------------------------------------------------

export interface CarryPeerOptions {
    /** How long a thrown prop keeps flying on this peer's screen before the host's states take over, ms. Default: the round trip plus the follow delay plus 50 ms. */
    flyMs?: number;
    /** Blend from this peer's flight to the host's states, ms. Default 200. */
    blendMs?: number;
    gravity?: ArrayLike<number>;
}

export class CarryPeer {
    /** The prop this peer carries, or null. */
    public carried: Node | null = null;
    /** Called when the host takes a prop away (refused the grab, or the carry timed out). */
    public onRefused: ((node: Node) => void) | null = null;

    private _netId = 0;
    private readonly _flying = new Map<string, { node: Node; vel: vec3; until: number }>();

    constructor(private readonly _session: PeerSession, private readonly _sync: SyncPeer, private readonly _options: CarryPeerOptions = {}) {
        _session.route('control', CARRY_STATE, (m) => {
            const r = new ByteReader(m, 1);
            const netId = r.varUint();
            const peerId = r.u16();
            if (netId === this._netId && peerId !== _session.peerId && this.carried) {
                // The host says it is not ours: let go, back to following.
                const node = this.carried;
                this.carried = null;
                this._netId = 0;
                this._sync.release(node.id, this._options.blendMs ?? 200);
                this.onRefused?.(node);
            }
        });
    }

    /** Pick `node` up: it is this peer's to move from now on (until the host says otherwise). */
    public grab(node: Node): boolean {
        const netId = this._sync.netIdOf(node);
        if (!netId || this.carried) return false;
        this.carried = node;
        this._netId = netId;
        this._sync.hold(node.id);
        this._session.sendControl(netIdMsg(CARRY_GRAB, netId));
        return true;
    }

    /**
     * Each tick while carrying: put the prop where it is held (`position`, `rotation`, in the prop's parent's space —
     * the scene root for a loose prop) and tell the host. Also flies props thrown a moment ago.
     */
    public update(tick: number, position: ArrayLike<number> | null, rotation: ArrayLike<number> | null, dt: number = 1 / this._session.tickRate): void {
        const node = this.carried;
        if (node && position && rotation) {
            node.setPosition(vec3.fromValues(position[0], position[1], position[2]));
            node.setQuaternion(quat.fromValues(rotation[0], rotation[1], rotation[2], rotation[3]));
            const w = new ByteWriter(32).u8(CARRY_POSE).varUint(this._netId).u32(tick);
            vec(w, position).u32(packQuaternion(rotation));
            this._session.sendPulse(w.finish());
        }
        const g = this._options.gravity ?? [0, -9.81, 0];
        const now = this._session.hostTimeNow();
        for (const [id, f] of this._flying) {
            if (now >= f.until || !f.node.scene) {
                this._flying.delete(id);
                this._sync.release(id, this._options.blendMs ?? 200);
                continue;
            }
            // A plain ballistic arc until the host's states take over (it touches nothing on the way).
            const p = vec3.scaleAndAdd(vec3.create(), f.node.position as vec3, f.vel, dt);
            vec3.scaleAndAdd(f.vel, f.vel, g as vec3, dt);
            f.node.setPosition(p);
        }
    }

    /** Throw the carried prop with `velocity` (m/s, world). */
    public throw(velocity: ArrayLike<number>): void {
        const node = this.carried;
        if (!node) return;
        const w = new ByteWriter(20).u8(CARRY_THROW).varUint(this._netId);
        this._session.sendControl(vec(w, velocity).finish());
        const tickMs = 1000 / this._session.tickRate;
        const fly = this._options.flyMs ?? this._session.clock.rttMs + this._sync.delayTicks * tickMs + 50;
        this._flying.set(node.id, { node, vel: vec3.fromValues(velocity[0], velocity[1], velocity[2]), until: this._session.hostTimeNow() + fly });
        this.carried = null;
        this._netId = 0;
    }

    /** Put the carried prop down where it is. */
    public drop(): void {
        const node = this.carried;
        if (!node) return;
        this._session.sendControl(netIdMsg(CARRY_DROP, this._netId));
        this.carried = null;
        this._netId = 0;
        this._sync.release(node.id, this._options.blendMs ?? 200);
    }

    public dispose(): void { this._session.route('control', CARRY_STATE, null); }
}
