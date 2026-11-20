// Weapons (docs/design/netsync.md §6.5.1): shots that register where the shooter aimed, and projectiles that leave
// the muzzle at once.
//
// HITSCAN. A peer draws everyone else a little in the past (SyncPeer follows `delayTicks` behind its estimate of
// the host clock), so what it aims at is where the target WAS. A shot carries that moment — the fractional host
// tick the shooter was drawing (`viewTick`) — and the host keeps a short history of every synced body
// (LagCompensator). To judge the shot it puts those bodies back where they were at `viewTick`, casts the ray, and
// puts them back. Under co-op trust a near miss on a target the shooter says it hit (`claimed`) is accepted within
// a tolerance (favour the shooter); under `versus` only the host's own ray counts, and a shot claiming an old view
// is refused.
//
// PROJECTILES. The shooter launches a stand-in at once and tells the host; the host spawns the real projectile,
// already advanced by the time the shot took to reach it, and names it to the shooter (by a key the shooter chose),
// which swaps its stand-in for it with a blend.
//
//   peer → host  shot {weapon, viewTick, origin, direction, claimed}   control
//   peer → host  fire {template, viewTick, origin, velocity, key}       control
//   host → all   hit {shooter, weapon, nodeId, point, normal}           control
//   host → peer  projectile {key, nodeId}                               control

import { quat, vec3 } from 'gl-matrix';
import { ByteReader, ByteWriter } from '../bytes';
import { FIRST_APP_TYPE } from '../session/messages';
import type { Node } from '../../core/scene/nodes/node';
import type { Scene } from '../../core/scene/scene';
import type { PhysicsSystem } from '../../physics/physicsSystem';
import type { HostPeer, HostSession } from '../session/hostSession';
import type { PeerSession } from '../session/peerSession';
import type { SyncHost } from './syncHost';
import type { SyncPeer } from './syncPeer';
import type { Trust } from './carry';

export const WEAPON_SHOT = FIRST_APP_TYPE + 8;
export const WEAPON_HIT = FIRST_APP_TYPE + 9;
export const WEAPON_FIRE = FIRST_APP_TYPE + 10;
export const WEAPON_PROJECTILE = FIRST_APP_TYPE + 11;

function writeVec(w: ByteWriter, v: ArrayLike<number>): ByteWriter {
    return w.raw(new Uint8Array(new Float32Array([v[0], v[1], v[2]]).buffer));
}
function readVec(r: ByteReader): vec3 {
    const f = new Float32Array(r.raw(12).slice().buffer);
    return vec3.fromValues(f[0], f[1], f[2]);
}

// ----- history ------------------------------------------------------------------------------------------------

/**
 * Where every synced body was, tick by tick, for the last `ticks` ticks (default 30: one second at 30 Hz) — and the
 * means to put them all back there for a moment.
 */
export class LagCompensator {
    private readonly _history = new Map<Node, Map<number, Float32Array>>();
    private _newest = -1;

    constructor(private readonly _sync: SyncHost, public readonly ticks: number = 30) {}

    public get newestTick(): number { return this._newest; }

    /** Record every synced body's pose after tick `tick`. */
    public record(tick: number): void {
        this._newest = tick;
        const seen = new Set<Node>();
        for (const node of this._sync.synced.values()) {
            const body = (node as any).body;
            if (!body || node.nodeType !== 'collider') continue;
            seen.add(node);
            let h = this._history.get(node);
            if (!h) { h = new Map(); this._history.set(node, h); }
            h.set(tick, body.getTransform(new Float32Array(7)));
            h.delete(tick - this.ticks);
        }
        for (const node of this._history.keys()) if (!seen.has(node)) this._history.delete(node);
    }

    /** A node's pose (position[3] + rotation[4]) at fractional tick `at`, or null when it is outside the history. */
    public poseAt(node: Node, at: number): Float32Array | null {
        const h = this._history.get(node);
        if (!h) return null;
        const a = h.get(Math.floor(at)), b = h.get(Math.ceil(at));
        if (!a && !b) return null;
        if (!a || !b || a === b) return (a ?? b)!.slice();
        const t = at - Math.floor(at);
        const out = new Float32Array(7);
        for (let i = 0; i < 3; i++) out[i] = a[i] + (b[i] - a[i]) * t;
        const q = quat.slerp(quat.create(), a.subarray(3, 7) as unknown as quat, b.subarray(3, 7) as unknown as quat, t);
        out.set(q, 3);
        return out;
    }

    /** Run `fn` with every recorded body where it was at fractional tick `at`, then put them all back. */
    public rewound<T>(at: number, fn: () => T): T {
        const moved: { body: any; was: Float32Array }[] = [];
        for (const node of this._history.keys()) {
            const pose = this.poseAt(node, at);
            const body = (node as any).body;
            if (!pose || !body) continue;
            moved.push({ body, was: body.getTransform(new Float32Array(7)) });
            body.setTransform(pose.subarray(0, 3), pose.subarray(3, 7));
        }
        try { return fn(); }
        finally { for (const m of moved) m.body.setTransform(m.was.subarray(0, 3), m.was.subarray(3, 7)); }
    }
}

// ----- host ---------------------------------------------------------------------------------------------------

export interface HitReport {
    peer: HostPeer;
    weapon: string;
    node: Node;
    point: vec3;
    normal: vec3;
    /** True when the host's own ray missed and the shooter's claim was accepted (co-op). */
    claimed: boolean;
}

export interface WeaponHostOptions {
    pawnOf: (peerId: number) => Node | null;
    physics: () => PhysicsSystem;
    /** The host tick just played. */
    currentTick: () => number;
    trust?: Trust;
    /** Furthest back a shot may look, in ticks. Default 10 (333 ms at 30 Hz) under co-op, 8 under versus. */
    maxRewindTicks?: number;
    /** Ray length, m. Default 200. */
    range?: number;
    /** Co-op: how far (m) a claimed target may be from the ray. Default 0.6. */
    claimTolerance?: number;
    /** How far (m) the muzzle may be from the shooter's character. Default 3. */
    maxMuzzleOffset?: number;
    /** Templates a peer may fire as projectiles (empty: any). */
    projectiles?: readonly string[];
    /** Fastest projectile accepted, m/s. Default 80. */
    maxProjectileSpeed?: number;
    /** The game's say on a hit (damage, score). Peers are told regardless. */
    onHit?: (hit: HitReport) => void;
    gravity?: () => ArrayLike<number>;
}

export interface WeaponHostStats {
    shots: number; hits: number; claimsAccepted: number; refused: number; fired: number;
    /** Hits that the same ray, cast at the host's present instead of the shooter's view, would have missed. */
    savedByRewind: number;
    /** Why the last refused shot or projectile was refused. */
    lastRefusal: string;
}

export class WeaponHost {
    public readonly stats: WeaponHostStats = { shots: 0, hits: 0, claimsAccepted: 0, refused: 0, fired: 0, savedByRewind: 0, lastRefusal: '' };
    private readonly _trust: Trust;
    private readonly _maxRewind: number;

    constructor(
        private readonly _session: HostSession,
        private readonly _sync: SyncHost,
        private readonly _history: LagCompensator,
        private readonly _scene: () => Scene,
        private readonly _options: WeaponHostOptions,
    ) {
        this._trust = _options.trust ?? 'coop';
        this._maxRewind = _options.maxRewindTicks ?? (this._trust === 'coop' ? 10 : 8);
        _session.route('control', WEAPON_SHOT, (peer, m) => this._shot(peer, m));
        _session.route('control', WEAPON_FIRE, (peer, m) => this._fire(peer, m));
    }

    public dispose(): void {
        this._session.route('control', WEAPON_SHOT, null);
        this._session.route('control', WEAPON_FIRE, null);
    }

    /** The view a shot may be judged at, or null when it is refused (see the trust rules above). */
    private _viewTick(viewTick: number): number | null {
        const now = this._options.currentTick();
        if (!Number.isFinite(viewTick)) return null;
        if (viewTick > now + 1 || viewTick < now - this._maxRewind) {
            if (this._trust === 'versus') return null;
            return Math.max(now - this._maxRewind, Math.min(now, viewTick));
        }
        return Math.min(now, viewTick);
    }

    private _muzzleOk(peerId: number, origin: vec3): boolean {
        const pawn = this._options.pawnOf(peerId);
        return !!pawn && vec3.distance(pawn.worldPosition, origin) <= (this._options.maxMuzzleOffset ?? 3);
    }

    private _refuse(why: string): void {
        this.stats.refused++;
        this.stats.lastRefusal = why;
    }

    private _shot(peer: HostPeer, m: Uint8Array): void {
        this.stats.shots++;
        let weapon: string, viewTick: number, origin: vec3, dir: vec3, claimedId: string;
        try {
            const r = new ByteReader(m, 1);
            weapon = r.string(); viewTick = r.f64(); origin = readVec(r); dir = readVec(r); claimedId = r.string();
        } catch { this._refuse('malformed shot'); return; }
        const at = this._viewTick(viewTick);
        if (at === null) { this._refuse('view out of range'); return; }
        if (!this._muzzleOk(peer.id, origin)) { this._refuse('muzzle away from the shooter'); return; }
        if (vec3.length(dir) < 1e-6) { this._refuse('no direction'); return; }
        vec3.normalize(dir, dir);
        const range = this._options.range ?? 200;
        const to = vec3.scaleAndAdd(vec3.create(), origin, dir, range);
        const own = (this._options.pawnOf(peer.id) as any)?.body ?? null;

        const result = this._history.rewound(at, () => {
            const hit = this._options.physics().raycast(origin, to, { ignore: own });
            if (hit?.node) return { node: hit.node, point: vec3.clone(hit.point), normal: vec3.clone(hit.normal), claimed: false };
            // Co-op: the shooter says it hit `claimed`. Accept a near miss on it, where it was at that view: a ray
            // passing within `claimTolerance` of the sphere bounding its colliders (centred on their frame, which for
            // a character is its middle, not the feet its node stands on).
            if (this._trust !== 'coop' || !claimedId) return null;
            const node = this._scene().getNodeById(claimedId);
            const body = (node as any)?.body;
            if (!node || !body?.world) return null;
            const frame = new Float64Array(7);
            const radius: number = body.world.getColliderFrame(body.handle, frame);
            const centre = vec3.fromValues(frame[0], frame[1], frame[2]);
            const t = Math.max(0, vec3.dot(vec3.subtract(vec3.create(), centre, origin), dir));
            const closest = vec3.scaleAndAdd(vec3.create(), origin, dir, t);
            if (t > range || vec3.distance(closest, centre) > radius + (this._options.claimTolerance ?? 0.6)) return null;
            return { node, point: closest, normal: vec3.negate(vec3.create(), dir), claimed: true };
        });
        if (!result) return;
        this.stats.hits++;
        if (!result.claimed) {
            const present = this._options.physics().raycast(origin, to, { ignore: own });
            if (present?.node !== result.node) this.stats.savedByRewind++;
        }
        if (result.claimed) this.stats.claimsAccepted++;
        this._options.onHit?.({ peer, weapon, ...result });
        const w = new ByteWriter(64).u8(WEAPON_HIT).u16(peer.id).string(weapon).string(result.node.id);
        writeVec(writeVec(w, result.point), result.normal);
        const msg = w.finish();
        for (const p of this._session.peers.values()) p.sendControl(msg);
    }

    private _fire(peer: HostPeer, m: Uint8Array): void {
        let template: string, viewTick: number, origin: vec3, velocity: vec3, key: number;
        try {
            const r = new ByteReader(m, 1);
            template = r.string(); viewTick = r.f64(); origin = readVec(r); velocity = readVec(r); key = r.u32();
        } catch { this._refuse('malformed fire'); return; }
        const allowed = this._options.projectiles;
        const at = this._viewTick(viewTick);
        if (allowed?.length && !allowed.includes(template)) { this._refuse(`template ${template} not allowed`); return; }
        if (at === null) { this._refuse('view out of range'); return; }
        if (!this._muzzleOk(peer.id, origin)) { this._refuse('muzzle away from the shooter'); return; }
        if (vec3.length(velocity) > (this._options.maxProjectileSpeed ?? 80)) { this._refuse('too fast'); return; }
        // The projectile has been in flight, on the shooter's screen, since the shot: start it that far along.
        const seconds = Math.max(0, this._options.currentTick() - at) / this._session.tickRate;
        const g = vec3.clone((this._options.gravity?.() ?? [0, -9.81, 0]) as vec3);
        const position = vec3.scaleAndAdd(vec3.create(), origin, velocity, seconds);
        vec3.scaleAndAdd(position, position, g, 0.5 * seconds * seconds);
        const node = this._scene().instantiate(template, { position: [position[0], position[1], position[2]] });
        if (!node) { this._refuse(`no template ${template}`); return; }
        const body = (node as any).body;
        if (body) body.velocity.set(velocity[0] + g[0] * seconds, velocity[1] + g[1] * seconds, velocity[2] + g[2] * seconds);
        this.stats.fired++;
        peer.sendControl(new ByteWriter(48).u8(WEAPON_PROJECTILE).u32(key).string(node.id).finish());
    }
}

// ----- peer ---------------------------------------------------------------------------------------------------

export interface HitEvent { shooter: number; weapon: string; nodeId: string; point: vec3; normal: vec3; }

export class WeaponPeer {
    /** Every hit the host reports (anyone's), for effects: sparks, a hit marker, a sound. */
    public onHit: ((hit: HitEvent) => void) | null = null;
    private _nextKey = 1;
    private readonly _standIns = new Map<number, Node>();
    private readonly _swaps = new Map<string, Node>();

    constructor(private readonly _session: PeerSession, private readonly _sync: SyncPeer, private readonly _blendMs: number = 200) {
        _session.route('control', WEAPON_HIT, (m) => {
            const r = new ByteReader(m, 1);
            const shooter = r.u16(), weapon = r.string(), nodeId = r.string();
            this.onHit?.({ shooter, weapon, nodeId, point: readVec(r), normal: readVec(r) });
        });
        _session.route('control', WEAPON_PROJECTILE, (m) => {
            const r = new ByteReader(m, 1);
            const key = r.u32();
            const nodeId = r.string();
            const standIn = this._standIns.get(key);
            this._standIns.delete(key);
            if (standIn) this._swaps.set(nodeId, standIn);
        });
    }

    /** The view a shot fired now was aimed at. */
    public viewTick(): number { return this._sync.renderTick(); }

    /** A hitscan shot from `origin` along `direction`; `claimed` is the node this peer saw it hit, if any. */
    public shoot(weapon: string, origin: ArrayLike<number>, direction: ArrayLike<number>, claimed: Node | null = null): void {
        const w = new ByteWriter(96).u8(WEAPON_SHOT).string(weapon).f64(this.viewTick());
        writeVec(writeVec(w, origin), direction).string(claimed?.id ?? '');
        this._session.sendControl(w.finish());
    }

    /**
     * Launch a projectile: `standIn` (made by the caller — usually an instantiate of the same template, moving under
     * this peer's physics) flies at once; it is swapped for the host's projectile when that arrives.
     */
    public fire(template: string, origin: ArrayLike<number>, velocity: ArrayLike<number>, standIn: Node | null): number {
        const key = this._nextKey++;
        if (standIn) this._standIns.set(key, standIn);
        const w = new ByteWriter(96).u8(WEAPON_FIRE).string(template).f64(this.viewTick());
        writeVec(writeVec(w, origin), velocity).u32(key);
        this._session.sendControl(w.finish());
        return key;
    }

    /**
     * Each frame, after the sync has applied: swap stand-ins whose real projectile is here — the host's copy takes
     * over from where the stand-in is, blended, and the stand-in goes.
     */
    public update(): void {
        for (const [nodeId, standIn] of this._swaps) {
            const real = this._sync.scene.getNodeById(nodeId);
            if (!real) continue; // its spawn is still on the way
            this._swaps.delete(nodeId);
            real.setPosition(vec3.clone(standIn.position as vec3));
            real.setQuaternion(quat.clone(standIn.quaternion as quat));
            this._sync.release(nodeId, this._blendMs);
            if (standIn.scene) standIn.scene.removeNode(standIn);
        }
    }

    public dispose(): void {
        this._session.route('control', WEAPON_HIT, null);
        this._session.route('control', WEAPON_PROJECTILE, null);
    }
}
