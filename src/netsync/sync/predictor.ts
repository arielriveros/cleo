// Client-side prediction for a peer's own character (docs/design/netsync.md §6.5).
//
// The peer simulates its own character locally, in ticks numbered like the host's and run AHEAD of it — tick T is
// simulated when the command for T is sent, about half a round trip before the host plays T — so the character
// answers its player at once instead of a round trip later. Every predicted tick is remembered: the state the
// character reached and the intent that got it there.
//
// When the host's state for the character at tick H arrives, it is compared with what was predicted for H. Close
// (under `threshold`) is the usual case and costs nothing. Otherwise the difference is the error the prediction has
// carried since H, and the present is corrected by it: the velocity at once, the position blended in over a few
// ticks (`blend` of what is left, each tick) so a small correction is not a visible jump — or snapped, past
// `snapDistance`. Every prediction still to be checked (after H) is shifted by the same amount, so one error is
// corrected once.
//
// Rather than rewinding and re-simulating the ticks since H (which would mean stepping the peer's whole physics
// world again — see the plan), the correction carries the host's answer forward as an offset: what the character did
// since H, it would have done from the corrected position too, give or take what it touched. The bodies it could
// touch differently are the props, which on a peer are followers that do not collide with it (followerSceneJson);
// walls and floors are the same on both sides.
//
// The character's facing (its Character node's rotation; the Collider's is upright) is predicted and corrected the
// same way: compared with the host's for the same tick, and past `rotationThreshold` the difference is turned into
// the present at once and into every later prediction. It drifts only when something the host alone ran turned the
// character (a script, a knock-back), so the correction is rare, and a turn reads as one where a jump would not.

import { quat, vec3 } from 'gl-matrix';
import type { Node } from '../../core/scene/nodes/node';
import type { ControllerNode } from '../../core/scene/nodes/controllerNode';
import type { PeerSession } from '../session/peerSession';
import type { PeerCommands } from './commands';
import type { SyncPeer } from './syncPeer';
import { POSITION_SCALE, VELOCITY_SCALE, unpackQuaternion, type QState } from './quantize';

export interface PredictorOptions {
    /** Error (m) under which a prediction counts as right. Default 0.02. */
    threshold?: number;
    /** Error (m) past which the character is moved at once instead of blended. Default 1.5. */
    snapDistance?: number;
    /** Share of the remaining position correction applied each tick. Default 0.3 (most of it in ~5 ticks). */
    blend?: number;
    /** Predicted ticks kept for comparison. Default 90 (3 s at 30 Hz). */
    historyTicks?: number;
    /** Facing error (degrees) under which a prediction counts as right. Default 3 (a quantized row is within 0.23). */
    rotationThreshold?: number;
}

interface Predicted { pos: vec3; vel: vec3; }

export interface PredictionStats {
    /** Host states compared with a prediction. */
    checked: number;
    /** Of those, ones past the threshold (corrected). */
    corrections: number;
    snaps: number;
    /** Host facings compared with a prediction, and of those, ones corrected. */
    rotationChecked: number;
    rotationCorrections: number;
    /** Largest error seen, m. */
    maxError: number;
    /** Every error seen, m (recent ones), for percentiles. */
    errors: number[];
}

export class Predictor {
    public readonly threshold: number;
    public readonly snapDistance: number;
    public readonly blend: number;
    public readonly stats: PredictionStats = { checked: 0, corrections: 0, snaps: 0, rotationChecked: 0, rotationCorrections: 0, maxError: 0, errors: [] };

    public readonly rotationThreshold: number;
    private readonly _history = new Map<number, Predicted>();
    /** The character's predicted facing per tick (its own map: the Character's row arrives apart from the Collider's). */
    private readonly _facing = new Map<number, quat>();
    private readonly _hostRot = quat.create();
    private readonly _unpack = [0, 0, 0, 1];
    private readonly _historyTicks: number;
    private readonly _pending = vec3.create();
    private _lastTick = -1;
    /** Whether the character has been put where the host has it at least once (it spawns at its template's origin). */
    private _placed = false;
    private _adopted = false;

    constructor(
        private readonly _session: PeerSession,
        private readonly _sync: SyncPeer,
        private readonly _commands: PeerCommands,
        options: PredictorOptions = {},
    ) {
        this.threshold = options.threshold ?? 0.02;
        this.snapDistance = options.snapDistance ?? 1.5;
        this.blend = options.blend ?? 0.3;
        this._historyTicks = options.historyTicks ?? 90;
        this.rotationThreshold = options.rotationThreshold ?? 3;
        // The character and its Collider are this peer's to simulate: sync leaves them alone and hands their
        // host states here.
        _sync.isOwn = (id) => id === _commands.pawnId || (!!_commands.pawnId && id === this.pawn?.parent?.id);
        _sync.onOwnState = (id, tick, state) => this._onHostState(id, tick, state);
    }

    /** This peer's character, in its scene, once the host has said which. */
    public get pawn(): Node | null {
        return this._commands.pawnId ? this._sync.scene.getNodeById(this._commands.pawnId) ?? null : null;
    }

    /** The controller driving it here (it reads this peer's input). */
    public get controller(): ControllerNode | null {
        return this._commands.controllerId ? (this._sync.scene.getNodeById(this._commands.controllerId) as ControllerNode) ?? null : null;
    }

    /** The node whose body is the character's (its Collider), which prediction moves. */
    private get _bodyNode(): Node | null { return this.pawn?.parent ?? null; }

    /**
     * The tick this peer should have simulated by now: the one whose command, sent now, reaches the host in time.
     * Step the local simulation until {@link lastTick} reaches it, calling {@link afterTick} after each.
     */
    public dueTick(): number { return this._commands.targetTick(); }
    public get lastTick(): number { return this._lastTick; }

    /**
     * After the peer stepped tick `tick` (its controller thought, its physics ran): remember where the character
     * got to, send the intent that got it there as the command for `tick`, and blend in any pending correction.
     */
    public afterTick(tick: number): void {
        this._lastTick = tick;
        this._adopt();
        const node = this._bodyNode;
        const body = (node as any)?.body;
        const controller = this.controller;
        if (!node || !body || !controller) return;
        this._commands.send(tick, controller.publishedIntent);

        // Carry part of the pending correction into the body now.
        if (vec3.squaredLength(this._pending) > 1e-10) {
            const step = vec3.scale(vec3.create(), this._pending, this.blend);
            if (vec3.length(this._pending) < 0.001) vec3.copy(step, this._pending);
            this._moveBody(body, step);
            vec3.subtract(this._pending, this._pending, step);
        }
        const p = body.position.toArray();
        const v = body.velocity.toArray();
        // Recorded where it will be once the rest of the pending correction is in: that is what the host will say.
        this._history.set(tick, {
            pos: vec3.fromValues(p[0] + this._pending[0], p[1] + this._pending[1], p[2] + this._pending[2]),
            vel: vec3.fromValues(v[0], v[1], v[2]),
        });
        this._history.delete(tick - this._historyTicks);
        const pawn = this.pawn;
        if (pawn && this._placed) this._facing.set(tick, quat.clone(pawn.quaternion as quat));
        this._facing.delete(tick - this._historyTicks);
    }

    /** The host's facing for the character at `tick`: compared with the one predicted for it, and corrected past the threshold. */
    private _onHostFacing(pawn: Node, tick: number, state: QState): void {
        unpackQuaternion(state.rot, this._unpack);
        const host = quat.set(this._hostRot, this._unpack[0], this._unpack[1], this._unpack[2], this._unpack[3]);
        const predicted = this._facing.get(tick);
        if (!predicted) return;
        for (const t of this._facing.keys()) if (t <= tick) this._facing.delete(t);
        this.stats.rotationChecked++;
        const degrees = quat.getAngle(host, predicted) * 180 / Math.PI;
        if (!(degrees > this.rotationThreshold)) return;
        this.stats.rotationCorrections++;
        // The turn that takes the prediction to the host's, applied to the present and to every later prediction.
        const delta = quat.multiply(quat.create(), host, quat.invert(quat.create(), predicted));
        const now = quat.multiply(quat.create(), delta, pawn.quaternion as quat);
        pawn.setQuaternion(quat.normalize(now, now));
        for (const q of this._facing.values()) quat.normalize(q, quat.multiply(q, delta, q));
    }

    /**
     * Once the character is known: if the level placed it (it was parsed as a follower, like everything the host
     * simulates), take it back — its body dynamic again, its controller this peer's.
     */
    private _adopt(): void {
        if (this._adopted) return;
        const node = this._bodyNode, controller = this.controller;
        if (!node || !controller) return;
        this._adopted = true;
        this._sync.adopt(node);
        this._sync.adopt(controller);
    }

    private _onHostState(nodeId: string, tick: number, state: QState): void {
        this._adopt();
        const node = this._bodyNode;
        if (!node) return;
        if (nodeId !== node.id) {
            // The Character node's own row: its facing.
            const pawn = this.pawn;
            if (pawn && nodeId === pawn.id && this._placed) this._onHostFacing(pawn, tick, state);
            return;
        }
        const body = (node as any).body;
        if (!body) return;
        if (!this._placed) {
            // The first word from the host: start from there. Nothing predicted before it means anything.
            this._placed = true;
            body.position.set(state.px / POSITION_SCALE, state.py / POSITION_SCALE, state.pz / POSITION_SCALE);
            if (state.vx !== undefined) body.velocity.set(state.vx / VELOCITY_SCALE, state.vy! / VELOCITY_SCALE, state.vz! / VELOCITY_SCALE);
            // Awake: physics writes a body's pose back to its node only while it is (one that settled where it
            // spawned would leave the character drawn at the template's origin).
            body.wakeUp?.();
            this._history.clear();
            this._facing.clear();
            vec3.zero(this._pending);
            return;
        }
        const predicted = this._history.get(tick);
        if (!predicted) return;
        this._history.delete(tick); // a state for an older tick is never compared again
        for (const t of this._history.keys()) if (t < tick) this._history.delete(t);

        const err = vec3.fromValues(
            state.px / POSITION_SCALE - predicted.pos[0],
            state.py / POSITION_SCALE - predicted.pos[1],
            state.pz / POSITION_SCALE - predicted.pos[2],
        );
        const size = vec3.length(err);
        this.stats.checked++;
        this.stats.maxError = Math.max(this.stats.maxError, size);
        this.stats.errors.push(size);
        if (this.stats.errors.length > 4096) this.stats.errors.shift();
        if (size < this.threshold) return;

        this.stats.corrections++;
        const velErr = state.vx === undefined ? vec3.create() : vec3.fromValues(
            state.vx / VELOCITY_SCALE - predicted.vel[0],
            state.vy! / VELOCITY_SCALE - predicted.vel[1],
            state.vz! / VELOCITY_SCALE - predicted.vel[2],
        );
        // The velocity is corrected at once: it decides where every coming tick goes.
        const v = body.velocity.toArray();
        body.velocity.set(v[0] + velErr[0], v[1] + velErr[1], v[2] + velErr[2]);
        if (size > this.snapDistance) {
            this.stats.snaps++;
            this._moveBody(body, vec3.add(vec3.create(), err, this._pending));
            vec3.zero(this._pending);
        } else {
            vec3.add(this._pending, this._pending, err);
        }
        // Every later prediction carried the same error: it is corrected now, so they must not report it again.
        for (const [t, h] of this._history) {
            if (t <= tick) continue;
            vec3.add(h.pos, h.pos, err);
            vec3.add(h.vel, h.vel, velErr);
        }
    }

    private _moveBody(body: any, by: ArrayLike<number>): void {
        const p = body.position.toArray();
        body.position.set(p[0] + by[0], p[1] + by[1], p[2] + by[2]);
        body.wakeUp?.();
    }

    public dispose(): void {
        this._sync.isOwn = null;
        this._sync.onOwnState = null;
    }
}
