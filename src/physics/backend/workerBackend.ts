import { Body, Constraint, World } from 'cannon-es';
import { physicsStats } from '../physicsStats';
import type { WaterSpec } from '../waterSurface';
import { encodeConfig, encodeConstraint, readState, shapeBuffers } from '../worker/bodyCodec';
import type { PhysicsPort } from '../worker/ports';
import type { FromWorker, Op, Snapshot, StepMessage } from '../worker/protocol';
import { BODY_ROW, CONTACT_ROW, STATE_STRIDE, WRITE_ANGVEL, WRITE_FORCE, WRITE_POSE, WRITE_SLEEP, WRITE_TORQUE, WRITE_VEL } from '../worker/protocol';
import type { ContactLike, PhysicsBackend, StepResult } from './physicsBackend';

// The physics step in a Web Worker.
//
// The main thread keeps its cannon World — every body, constraint and shape exactly where the engine puts
// them — as a MIRROR that never steps. Every query (raycasts, overlaps, sweeps, the ground probe, the
// camera boom) and every `node.body` read and write works on it unchanged: no proxy, no API to learn.
// Once per frame, after scripts have run (PhysicsSystem.endFrame), the mirror is DIFFED against what the
// worker was last told — bodies added or removed, a body reconfigured, a pose, a velocity, a force, a
// sleep state written — and only that is posted, with the frame's step. The worker steps while this
// thread renders; at the start of the next frame (physics.update) its snapshot is written back into the
// mirror, with the contacts, trigger events, first-contact events and buoyancy the step produced.
//
// TIME. A step has to be posted before the frame it is drawn in has started, so before anyone knows how
// long that frame will be. Stepping by the frame that just ENDED (what this backend first did) draws every
// frame one frame late, by the wrong amount: on uneven frames a body visibly speeds up and slows down
// against everything stepped by the frame's own delta (the animator, the camera, scripts). So:
//   - each step reaches one PREDICTED frame past now (the lead, an average of recent frame deltas), so the
//     state scripts read is the state at this frame's time, as inline;
//   - the step's time span is kept, and a node is DRAWN at this frame's actual time: its body's pose at the
//     step's start and end, interpolated — or the end extrapolated a little along its velocity when the
//     frame ran longer than predicted, or the step has not come back (see visualPose);
//   - the body keeps the latest simulated pose. Node._showSimulatedPose remembers the gap, so a script that
//     moves or turns the node moves the body by the same amount (root motion, a character's turn).
// This is how engines that step physics off the game thread draw it (Unreal's async Chaos, Godot's
// threaded physics with physics interpolation): decoupled ticks, interpolated presentation.
//
// One step is in flight at a time, with no SharedArrayBuffer (no cross-origin isolation is needed
// anywhere the engine runs). A step that is late is not waited for: the frame applies nothing, draws its
// bodies extrapolated, and the time it should have simulated rides along with the next step (capped like
// the engine's frame delta). A body written here AFTER the diff and before the snapshot lands (a DOM input
// handler between frames, or a frame whose diff was skipped while a step ran) keeps that write: a moved or
// turned body is moved or turned by the same amount from where the step left it, a written velocity
// component replaces the step's.

/** What the backend needs from PhysicsSystem. */
export interface WorkerBackendHost {
    readonly world: World;
    /** A trigger overlap starting or ending, as cannon reported it in the worker. */
    onContact(a: Body, b: Body, begin: boolean): void;
    /** The water volumes buoying bodies this frame, and where to report what each buoyed. */
    water(): { spec: WaterSpec; record: (body: Body, fraction: number) => void }[];
    substepsFor(dt: number): number;
    profileStep(): boolean;
    /** The worker failed: PhysicsSystem falls back to stepping inline, on the same world. */
    onFailure(error: unknown): void;
}

/** Most simulated time one step may carry: the engine's own frame-delta cap. */
const MAX_PENDING = 0.1;
/**
 * How far the drawn clock may run faster or slower than the frames to settle one frame behind: 2%, below what
 * an eye picks out as a change of speed.
 */
const DRAWN_DRIFT = 0.02;
/** How quickly the drawn clock learns how often results arrive: about twenty results. */
const APPLY_GAP_RATE = 0.05;
/** How quickly the drawn clock's idea of a frame follows the frame rate: about a hundred frames. */
const DRAWN_LEAD_RATE = 0.01;
/** How quickly "one frame behind" follows a lasting change of time scale (per real second): seconds, so a hit-stop barely moves it. */
const DRAWN_SCALE_RATE = 0.2;
/** How quickly the frame-time estimate (the lead) follows a changing frame rate: about ten frames. */
const LEAD_RATE = 0.1;
// [type mass inertia3 invInertia3 linDamp angDamp linFactor3 angFactor3 fixedRot allowSleep sleepSpeed
//  sleepTime response group mask trigger character wantsCollide shapeCount] + per shape [id offset3 orient4 response group mask]
const CFG_BASE = 25, CFG_SHAPE = 11;

interface Slot {
    body: Body;
    /** What the worker last knew of this body's state (STATE_STRIDE values; force/torque always 0). */
    shadow: Float64Array;
    cfg: Float64Array;
    material: unknown;
    seen: number;
    /** The pose [px py pz qx qy qz qw] the step in flight started this body from. */
    start: Float64Array;
    /** The applied step, for drawing: the pose it started from, and the pose + velocity + spin it ended with. */
    from: Float64Array;
    to: Float64Array;
    /**
     * What the body is drawn from: its pose [px py pz qx qy qz qw] at the ends of its last KEYS steps, with
     * their game-clock times, in a ring (`keyHead` is the next to write). Whatever is written to the body
     * between two steps moves this whole history with it, so a script's nudge or a teleport is drawn at once.
     */
    keys: Float64Array;
    keyTimes: Float64Array;
    keyCount: number;
    keyHead: number;
    /** Whether `from`/`to` hold a step yet; whether they say the body did not move (nothing to draw). */
    tracked: boolean;
    settled: boolean;
}

export class WorkerBackend implements PhysicsBackend {
    public readonly kind = 'worker' as const;
    private _epoch = 0;
    private _seq = 0;
    private _inFlight = false;
    private _latest: Snapshot | null = null;
    private _failed = false;
    private _ready = false;
    private readonly _slotOf = new Map<Body, number>();
    private readonly _slots: (Slot | undefined)[] = [];
    private readonly _freeSlots: number[] = [];
    private readonly _constraintIds = new Map<Constraint, number>();
    private _nextConstraint = 1;
    private readonly _knownShapes = new Set<number>();
    private _frame = 0;
    private _recycle: ArrayBuffer[] = [];
    /** The water volumes the in-flight step was sent, so its buoyancy report finds them. */
    private _sentWater: { record: (body: Body, fraction: number) => void }[] = [];
    private readonly _contacts: ContactLike[] = [];
    private readonly _scratch = new Float64Array(STATE_STRIDE);
    private _cfgScratch = new Float64Array(64);

    // ---- the clock (see the header) ----
    /** Every frame delta step() was given: the game's clock, which the drawn poses follow. */
    private _now = 0;
    /**
     * The frame delta expected next, an average of recent ones, in REAL seconds: how far past now each step
     * reaches, once multiplied by the time scale the next frame runs at. Kept in real time so a hit-stop
     * (the time scale dropping for a few frames) is a known change of speed, not a misprediction.
     */
    private _lead = 0;
    /** This frame's time scale (CleoEngine's), which game-time deltas are divided by to get real time. */
    private _scale = 1;
    /** The lead the last step was posted with, in game time. */
    private _leadSent = 0;
    /** How far frames stray from the lead, on average (real seconds). The drawn time trails the clock by about this. */
    private _jitter = 0;
    /** Frame time since the last post. */
    private _sincePost = 0;
    /** Simulated time owed to the worker: how far the target is past the end of the last step sent. */
    private _owed = 0;
    private _started = false;
    /** The game-clock span the step in flight covers, and the span of the step last applied. */
    private _flightFrom = 0;
    private _flightTo = 0;
    private _from = 0;
    private _to = 0;
    /**
     * The DRAWN clock: the game time bodies are drawn at, about one frame behind the clock. It advances by
     * each frame's own delta (so motion is drawn exactly as smoothly as the frames are paced, like inline)
     * and drifts toward `now − lead` by at most DRAWN_DRIFT of a frame per frame. Behind the clock because the
     * step that just arrived reaches a frame AHEAD: one frame back, the drawn time falls inside the steps
     * already applied, however long the frame was, and nothing has to be extrapolated.
     */
    private _vis = 0;
    private _visReady = false;
    /** A slow average of the time scale: how much game time "one frame behind" is (see _advance). */
    private _scaleAvg = 1;
    /**
     * A slow average of the frame time, for the drawn clock's target. The lead itself follows the frame rate
     * within ten frames, which is right for how far a step reaches but would make the drawn time wander a
     * little with every uneven frame.
     */
    private _visLead = 0;
    /**
     * How often results arrive, in real seconds (a slow average), and the game time the last one was applied
     * at. Every frame on a fast round trip; every second or third frame when the reply takes longer than a
     * frame (a high refresh rate, a busy main thread). The drawn clock stays far enough behind to cover it.
     */
    private _applyGap = 0;
    private _appliedAt = NaN;
    /** When the step in flight was posted, and when the last result arrived (performance.now()), for the HUD. */
    private _postedAt = 0;
    private _arrivedAt = 0;

    /** Frames whose step had not come back in time, out of frames posted — the auto mode reads these. */
    public lateFrames = 0;
    public postedFrames = 0;

    constructor(private readonly _host: WorkerBackendHost, private readonly _port: PhysicsPort) {
        _port.onMessage = (msg) => this._receive(msg);
        _port.onError = (error) => this._fail(error);
        _port.post({ kind: 'reset', epoch: this._epoch }, []);
    }

    // ---- warm-up ----

    /**
     * Send the world as it stands, as a step of no time, while the main thread goes on stepping it. The
     * worker is {@link poll ready} once it has answered: its module has loaded and it has built every
     * collider, so the first frame it steps is not spent waiting for either.
     */
    public prime(): void {
        if (this._inFlight || this._failed) return;
        this._post(0);
    }

    /** Deliver what has arrived; whether the worker has answered at least once (see prime). */
    public poll(): boolean {
        this._port.poll();
        return this._ready && !this._failed;
    }

    /**
     * Take over from the main thread's step. The warm-up's answer is stale — that thread has stepped on
     * since — so it is dropped unapplied, and the next diff sends every body that moved meanwhile.
     * `frameDt` is the delta of the frame taking over (already stepped there), which starts the clock.
     */
    public adopt(frameDt: number, timeScale = 1): void {
        this._latest = null;
        this._scale = timeScale;
        this._advance(frameDt);
        // The frame before was drawn at the clock (inline): start there, and fall back to a frame behind gently.
        this._vis = this._now;
        this._visReady = true;
        this._sincePost = 0;
        physicsStats.workerStepsPosted = this.postedFrames;
        physicsStats.workerFramesLate = this.lateFrames;
    }

    // ---- start of frame: apply what the worker finished ----

    public step(dt: number, timeScale = 1): StepResult {
        this._scale = timeScale;
        this._advance(dt);
        this._port.poll();
        const snap = this._latest;
        this._latest = null;
        if (!snap || this._failed) return { dt: 0, contacts: [] };
        if (this._appliedAt === this._appliedAt && this._now > this._appliedAt) {
            const realGap = (this._now - this._appliedAt) / (this._scaleAvg > 0 ? this._scaleAvg : 1);
            this._applyGap = this._applyGap === 0 ? realGap : this._applyGap + (realGap - this._applyGap) * APPLY_GAP_RATE;
        }
        this._appliedAt = this._now;
        const start = performance.now();
        physicsStats.workerReadyMs = start - this._arrivedAt;
        physicsStats.workerBytesDown = (snap.bodyCount * BODY_ROW + snap.contactCount * CONTACT_ROW) * 8
            + snap.overlaps.byteLength + snap.collides.byteLength + snap.submerged.byteLength;
        this._apply(snap);
        physicsStats.syncMs += performance.now() - start;
        return { dt: snap.dt, contacts: this._contacts };
    }

    /** The frame clock, and the frame-time estimate each step's reach is predicted with. */
    private _advance(dt: number): void {
        if (!(dt > 0)) return;
        this._now += dt;
        this._sincePost += dt;
        if (!(this._scale > 0)) return;
        const real = dt / this._scale;
        if (this._lead === 0) this._lead = real;
        else {
            this._jitter += (Math.abs(real - this._lead) - this._jitter) * LEAD_RATE;
            this._lead += (real - this._lead) * LEAD_RATE;
        }
        physicsStats.workerLeadMs = this._lead * 1000;
        physicsStats.workerJitterMs = this._jitter * 1000;
        // The drawn clock (see _vis): this frame's delta exactly, nudged toward one frame behind. "One frame"
        // in game time follows the time scale slowly, so a hit-stop does not yank the drawn time forward.
        this._scaleAvg += (this._scale - this._scaleAvg) * Math.min(1, DRAWN_SCALE_RATE * real);
        this._visLead = this._visLead === 0 ? this._lead : this._visLead + (real - this._visLead) * DRAWN_LEAD_RATE;
        // One frame behind when results arrive every frame. When they arrive every k frames, each step still
        // reaches one frame past its post, so the drawn time must trail by 2k − 1 frames to stay inside it.
        const gap = this._applyGap > this._visLead ? this._applyGap : this._visLead;
        const lag = 2 * gap - this._visLead;
        const target = this._now - lag * this._scaleAvg;
        if (!this._visReady) { this._vis = target; this._visReady = true; return; }
        this._vis += dt;
        const err = target - this._vis, limit = DRAWN_DRIFT * dt;
        this._vis += err > limit ? limit : err < -limit ? -limit : err;
        if (this._vis > this._now) this._vis = this._now;
        else if (this._vis < this._now - MAX_PENDING) this._vis = this._now - MAX_PENDING;
    }

    private _receive(msg: FromWorker): void {
        if (msg.epoch !== this._epoch) return;   // from before a reset: stale
        if (msg.kind === 'error') { this._fail(new Error(msg.message)); return; }
        this._arrivedAt = performance.now();
        physicsStats.workerRoundTripMs = this._arrivedAt - this._postedAt;
        this._inFlight = false;
        this._ready = true;
        this._latest = msg;
    }

    private _fail(error: unknown): void {
        if (this._failed) return;
        this._failed = true;
        this._host.onFailure(error);
    }

    private _apply(s: Snapshot): void {
        const world = this._host.world;
        const scratch = this._scratch;
        const b = s.bodies;
        for (let r = 0; r < s.bodyCount; r++) {
            const o = r * BODY_ROW;
            const slot = this._slots[b[o]];
            if (!slot) continue;                          // removed since the step was posted
            const body = slot.body, sh = slot.shadow;
            readState(body, scratch, 0);
            // Anything written here since the diff is kept (see the header). The shadow becomes what the
            // worker now holds either way, so the next diff sends exactly what differs from it.
            if (same(scratch, sh, 0, 3)) body.position.set(b[o + 1], b[o + 2], b[o + 3]);
            else body.position.set(b[o + 1] + scratch[0] - sh[0], b[o + 2] + scratch[1] - sh[1], b[o + 3] + scratch[2] - sh[2]);
            if (same(scratch, sh, 3, 4)) body.quaternion.set(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
            else rebaseRotation(body.quaternion, scratch, sh, b, o + 4);
            body.aabbNeedsUpdate = true;
            for (let i = 0; i < 7; i++) sh[i] = b[o + 1 + i];
            // Velocities by component: a script steering with `velocity.x = …` keeps the step's fall.
            const v = body.velocity, w = body.angularVelocity;
            if (scratch[7] === sh[7]) v.x = b[o + 8];
            if (scratch[8] === sh[8]) v.y = b[o + 9];
            if (scratch[9] === sh[9]) v.z = b[o + 10];
            if (scratch[10] === sh[10]) w.x = b[o + 11];
            if (scratch[11] === sh[11]) w.y = b[o + 12];
            if (scratch[12] === sh[12]) w.z = b[o + 13];
            for (let i = 7; i < 13; i++) sh[i] = b[o + 1 + i];
            if (scratch[19] === sh[19]) body.sleepState = b[o + 14] as any;
            sh[19] = b[o + 14];
            this._track(slot);
        }
        this._from = this._flightFrom;
        this._to = this._flightTo;
        // The last substep's contacts, for ground stamping.
        this._contacts.length = s.contactCount;
        for (let i = 0; i < s.contactCount; i++) {
            const o = i * CONTACT_ROW;
            const bi = this._slots[s.contacts[o]]?.body, bj = this._slots[s.contacts[o + 1]]?.body;
            let c = this._contacts[i];
            if (!c) c = this._contacts[i] = { bi: null as any, bj: null as any, ni: { x: 0, y: 0, z: 0 } };
            c.bi = bi as Body; c.bj = bj as Body;
            c.ni.x = s.contacts[o + 2]; c.ni.y = s.contacts[o + 3]; c.ni.z = s.contacts[o + 4];
        }
        // Drop contacts with a body removed since (both sides are needed to stamp).
        let w = 0;
        for (let i = 0; i < this._contacts.length; i++) if (this._contacts[i].bi && this._contacts[i].bj) this._contacts[w++] = this._contacts[i];
        this._contacts.length = w;
        // Trigger overlaps, in the order cannon raised them.
        for (let i = 0; i < s.overlaps.length; i += 3) {
            const a = this._slots[s.overlaps[i + 1]]?.body, b = this._slots[s.overlaps[i + 2]]?.body;
            if (a && b) this._host.onContact(a, b, s.overlaps[i] === 1);
        }
        // First contacts, for the bodies that listen.
        for (let i = 0; i < s.collides.length; i += 2) {
            const a = this._slots[s.collides[i]]?.body, b = this._slots[s.collides[i + 1]]?.body;
            if (a && b) a.dispatchEvent({ type: 'collide', body: b, target: a, contact: null } as any);
        }
        for (let i = 0; i < s.submerged.length; i += 3) {
            const body = this._slots[s.submerged[i + 1]]?.body;
            if (body) this._sentWater[s.submerged[i]]?.record(body, s.submerged[i + 2]);
        }
        (world as any).time = s.time;
        physicsStats.workerStepMs = s.stats.stepMs;
        physicsStats.broadphaseMs += s.stats.broadphaseMs;
        physicsStats.narrowphaseMs += s.stats.narrowphaseMs;
        physicsStats.solveMs += s.stats.solveMs;
        physicsStats.integrateMs += s.stats.integrateMs;
        this._recycle.push(s.bodies.buffer as ArrayBuffer, s.contacts.buffer as ArrayBuffer);
    }

    /** Record the step a body just took, for {@link visualPose}: where it started, where it is now. */
    private _track(slot: Slot): void {
        const body = slot.body, from = slot.from, to = slot.to, start = slot.start;
        const keys = slot.keys;
        if (slot.keyCount > 0) {
            // Carry the history along with whatever was written since the last step ended (start − its end).
            const last = ((slot.keyHead + KEYS - 1) % KEYS) * KEY_STRIDE;
            if (!same(start, keys, 0, 7, last)) {
                const dx = start[0] - keys[last], dy = start[1] - keys[last + 1], dz = start[2] - keys[last + 2];
                // The turn written since: start · conj(end), applied to every pose before it.
                const ax = start[3], ay = start[4], az = start[5], aw = start[6];
                const bx = -keys[last + 3], by = -keys[last + 4], bz = -keys[last + 5], bw = keys[last + 6];
                const qx = aw * bx + ax * bw + ay * bz - az * by;
                const qy = aw * by - ax * bz + ay * bw + az * bx;
                const qz = aw * bz + ax * by - ay * bx + az * bw;
                const qw = aw * bw - ax * bx - ay * by - az * bz;
                for (let k = 0; k < slot.keyCount; k++) {
                    const o = ((slot.keyHead + KEYS - 1 - k) % KEYS) * KEY_STRIDE;
                    keys[o] += dx; keys[o + 1] += dy; keys[o + 2] += dz;
                    const sx = keys[o + 3], sy = keys[o + 4], sz = keys[o + 5], sw = keys[o + 6];
                    const x = qw * sx + qx * sw + qy * sz - qz * sy;
                    const y = qw * sy - qx * sz + qy * sw + qz * sx;
                    const z = qw * sz + qx * sy - qy * sx + qz * sw;
                    const w = qw * sw - qx * sx - qy * sy - qz * sz;
                    const n = 1 / Math.hypot(x, y, z, w);
                    keys[o + 3] = x * n; keys[o + 4] = y * n; keys[o + 5] = z * n; keys[o + 6] = w * n;
                }
            }
        }
        // Where this step started, when that is not where the last one ended (the first step, or a gap).
        const lastTime = slot.keyCount > 0 ? slot.keyTimes[(slot.keyHead + KEYS - 1) % KEYS] : NaN;
        const v = body.velocity;
        if (!(Math.abs(lastTime - this._flightFrom) < 1e-9)) pushKey(slot, start, this._flightFrom, v.x, v.y, v.z);
        from.set(start);
        const p = body.position, q = body.quaternion, w = body.angularVelocity;
        to[0] = p.x; to[1] = p.y; to[2] = p.z; to[3] = q.x; to[4] = q.y; to[5] = q.z; to[6] = q.w;
        to[7] = v.x; to[8] = v.y; to[9] = v.z; to[10] = w.x; to[11] = w.y; to[12] = w.z;
        pushKey(slot, to, this._flightTo, v.x, v.y, v.z);
        slot.tracked = true;
        let still = body.sleepState === Body.SLEEPING || (to[7] === 0 && to[8] === 0 && to[9] === 0 && to[10] === 0 && to[11] === 0 && to[12] === 0);
        for (let k = 0; still && k < slot.keyCount; k++) still = same(to, keys, 0, 7, k * KEY_STRIDE);
        slot.settled = still;
    }

    // ---- drawing ----

    /**
     * The pose to DRAW `body` with this frame, [px py pz qx qy qz qw] (centre of mass, like body.position),
     * written into `out`. Its last step's two ends interpolated at the frame's time — slightly behind the
     * clock, by the typical misprediction, so it is nearly always an interpolation — or the end carried on
     * along the body's velocity for a frame that outran the step (a long frame, a late worker), at most
     * a few frames' worth. False when there is nothing to draw but the body's own pose: no step taken yet,
     * or the body did not move.
     */
    public visualPose(body: Body, out: Float64Array): boolean {
        const index = this._slotOf.get(body);
        const slot = index === undefined ? undefined : this._slots[index];
        if (!slot || !slot.tracked || slot.settled) return false;
        const b = slot.to;
        const s = this._scale;
        const time = this._vis;
        const keys = slot.keys, times = slot.keyTimes, n = slot.keyCount;
        const newest = (slot.keyHead + KEYS - 1) % KEYS;
        if (time >= times[newest]) {
            // Past the last step's end: carry on along its velocity (a long frame, a late step), a little.
            const e = Math.min(time - times[newest], Math.min(MAX_PENDING, 2.5 * this._lead * s));
            if (e <= 0 || body.sleepState === Body.SLEEPING) {
                for (let i = 0; i < 7; i++) out[i] = b[i];
            } else {
                physicsStats.workerExtrapolated++;
                out[0] = b[0] + b[7] * e; out[1] = b[1] + b[8] * e; out[2] = b[2] + b[9] * e;
                // dq/dt = ½ ω q, as cannon integrates it.
                const qx = b[3], qy = b[4], qz = b[5], qw = b[6], wx = b[10], wy = b[11], wz = b[12], h = 0.5 * e;
                const x = qx + h * (wx * qw + wy * qz - wz * qy);
                const y = qy + h * (wy * qw + wz * qx - wx * qz);
                const z = qz + h * (wz * qw + wx * qy - wy * qx);
                const w = qw + h * (-wx * qx - wy * qy - wz * qz);
                const n = 1 / Math.hypot(x, y, z, w);
                out[3] = x * n; out[4] = y * n; out[5] = z * n; out[6] = w * n;
            }
        } else {
            // Inside the history: the two step ends either side of the drawn time.
            let newer = newest, k = 1;
            for (; k < n; k++) {
                const older = (newest + KEYS - k) % KEYS;
                if (times[older] <= time) {
                    const span = times[newer] - times[older];
                    // The keys either side of this pair, for the curve's tangents (the pair itself where there are none).
                    const before = k + 1 < n ? (newest + KEYS - k - 1) % KEYS : older;
                    const after = newer !== newest ? (newer + 1) % KEYS : newer;
                    hermitePose(keys, times, before, older, newer, after, span > 0 ? (time - times[older]) / span : 1, out);
                    break;
                }
                newer = older;
            }
            // Older than all of it (a body that has only just started moving): its first pose.
            if (k >= n) for (let i = 0; i < 7; i++) out[i] = keys[newer * KEY_STRIDE + i];
        }
        physicsStats.workerDrawn++;
        return true;
    }

    // ---- end of frame: tell the worker what changed, and step ----

    /** `nextTimeScale`: the time scale the next frame starts at, which the step's reach is predicted with. */
    public endFrame(_dt: number, nextTimeScale = 1): void {
        if (this._failed) return;
        if (this._inFlight) {
            // The last step has not come back: its time, and this frame's, go out with the next one.
            // Nothing is diffed meanwhile, so no slot can change under the step still running.
            this.lateFrames++;
            physicsStats.workerFramesLate = this.lateFrames;
            return;
        }
        // How far this step reaches: one predicted frame past now. Kept as a running debt rather than
        // `now + lead − end`, so a steady frame rate posts steps of exactly its delta, bit for bit.
        const lead = this._lead * (nextTimeScale > 0 ? nextTimeScale : 0);
        if (!this._started) { this._started = true; this._owed = lead; }
        else this._owed += this._sincePost + (lead - this._leadSent);
        this._sincePost = 0;
        this._leadSent = lead;
        let span = this._owed > MAX_PENDING ? MAX_PENDING : this._owed;
        if (!(span > 0)) span = 0;
        this._owed -= span;
        if (this._owed > 0) this._owed = 0;        // past the cap: dropped, as the engine drops a frame past MAX_DELTA
        this._flightTo = this._now + lead - this._owed;
        this._flightFrom = this._flightTo - span;
        this.postedFrames++;
        physicsStats.workerStepsPosted = this.postedFrames;
        this._post(span);
    }

    private _post(stepDt: number): void {
        const start = performance.now();
        const msg = this._diff(stepDt);
        const payload: ArrayBuffer[] = [msg.writes.buffer as ArrayBuffer];
        for (const op of msg.ops) if (op.op === 'addBody' || op.op === 'config') {
            for (const s of op.config.shapes) payload.push(...shapeBuffers(s.def));
            if (op.op === 'addBody') payload.push(op.state.buffer as ArrayBuffer);
        }
        const transfer = uniqueBuffers([...payload, ...this._recycle]);
        // Measured before posting: a transferred buffer reads as empty afterwards.
        let bytes = 0;
        for (const buffer of uniqueBuffers(payload)) bytes += buffer.byteLength;
        physicsStats.workerBytesUp = bytes;
        physicsStats.workerWrites = msg.writeCount;
        physicsStats.workerOps = msg.ops.length;
        msg.recycle = this._recycle;
        this._recycle = [];
        this._inFlight = true;
        this._postedAt = performance.now();
        try {
            this._port.post(msg, transfer);
        } catch (e) {
            this._inFlight = false;
            this._fail(e);
        }
        physicsStats.syncMs += performance.now() - start;
    }

    private _diff(dt: number): StepMessage {
        const world = this._host.world;
        const frame = ++this._frame;
        const removes: Op[] = [], adds: Op[] = [], configs: Op[] = [];
        const writes: number[] = [];
        const scratch = this._scratch;

        for (const body of world.bodies) {
            let index = this._slotOf.get(body);
            const wantsCollide = body.hasAnyEventListener('collide');
            if (index === undefined) {
                index = this._freeSlots.pop() ?? this._slots.length;
                const shadow = new Float64Array(STATE_STRIDE);
                readState(body, shadow, 0);
                const state = new Float64Array(shadow);
                // Force and torque applied before the body arrived are consumed by this step, like inline.
                shadow[13] = shadow[14] = shadow[15] = shadow[16] = shadow[17] = shadow[18] = 0;
                body.force.set(0, 0, 0); body.torque.set(0, 0, 0);
                const cfg = this._configNumbers(body, wantsCollide).slice();
                this._slots[index] = {
                    body, shadow, cfg, material: body.material, seen: frame,
                    start: shadow.slice(0, 7), from: new Float64Array(7), to: new Float64Array(13),
                    keys: new Float64Array(KEYS * KEY_STRIDE), keyTimes: new Float64Array(KEYS), keyCount: 0, keyHead: 0,
                    tracked: false, settled: false,
                };
                this._slotOf.set(body, index);
                adds.push({ op: 'addBody', slot: index, config: encodeConfig(body, this._knownShapes, wantsCollide), state });
                continue;
            }
            const slot = this._slots[index]!;
            slot.seen = frame;
            const cfg = this._configNumbers(body, wantsCollide);
            if (cfg.length !== slot.cfg.length || !same(cfg, slot.cfg, 0, cfg.length) || body.material !== slot.material) {
                slot.cfg = cfg.slice();
                slot.material = body.material;
                configs.push({ op: 'config', slot: index, config: encodeConfig(body, this._knownShapes, wantsCollide) });
            }
            readState(body, scratch, 0);
            const sh = slot.shadow;
            let mask = 0;
            if (!same(scratch, sh, 0, 7)) mask |= WRITE_POSE;
            if (!same(scratch, sh, 7, 3)) mask |= WRITE_VEL;
            if (!same(scratch, sh, 10, 3)) mask |= WRITE_ANGVEL;
            if (scratch[13] !== 0 || scratch[14] !== 0 || scratch[15] !== 0) mask |= WRITE_FORCE;
            if (scratch[16] !== 0 || scratch[17] !== 0 || scratch[18] !== 0) mask |= WRITE_TORQUE;
            if (scratch[19] !== sh[19]) mask |= WRITE_SLEEP;
            if (mask) {
                writes.push(index, mask);
                for (let i = 0; i < STATE_STRIDE; i++) writes.push(scratch[i]);
                for (let i = 0; i < STATE_STRIDE; i++) sh[i] = scratch[i];
                // A force is consumed by the step it goes out with, as cannon clears it after stepping inline.
                if (mask & (WRITE_FORCE | WRITE_TORQUE)) { body.force.set(0, 0, 0); body.torque.set(0, 0, 0); }
                sh[13] = sh[14] = sh[15] = sh[16] = sh[17] = sh[18] = 0;
            }
            // The pose this step starts the body from: what the worker holds once the writes are applied.
            for (let i = 0; i < 7; i++) slot.start[i] = sh[i];
        }
        for (let i = 0; i < this._slots.length; i++) {
            const slot = this._slots[i];
            if (!slot || slot.seen === frame) continue;
            removes.push({ op: 'removeBody', slot: i });
            this._slotOf.delete(slot.body);
            this._slots[i] = undefined;
            this._freeSlots.push(i);
        }

        // Constraints: by identity. Removed ones go first, new ones after the bodies they join.
        const constraintRemoves: Op[] = [], constraintAdds: Op[] = [];
        const live = new Set(world.constraints);
        for (const [c, id] of this._constraintIds) if (!live.has(c)) { constraintRemoves.push({ op: 'removeConstraint', id }); this._constraintIds.delete(c); }
        for (const c of world.constraints) {
            if (this._constraintIds.has(c)) continue;
            const def = encodeConstraint(c, b => this._slotOf.get(b));
            if (!def) continue;
            const id = this._nextConstraint++;
            this._constraintIds.set(c, id);
            constraintAdds.push({ op: 'addConstraint', id, def });
        }

        const water = this._host.water();
        this._sentWater = water;
        const g = world.gravity;
        const solver = world.solver as unknown as { iterations?: number };
        return {
            kind: 'step', epoch: this._epoch, seq: ++this._seq, dt, substeps: this._host.substepsFor(dt),
            profile: this._host.profileStep(),
            ops: [...constraintRemoves, ...removes, ...adds, ...configs, ...constraintAdds],
            writes: Float64Array.from(writes), writeCount: writes.length / (STATE_STRIDE + 2),
            gravity: [g.x, g.y, g.z], iterations: solver.iterations ?? 0, time: (world as any).time ?? 0,
            water: water.map(w => w.spec), recycle: [],
        };
    }

    /** The numbers a body's configuration is compared by (see CFG_BASE). */
    private _configNumbers(body: Body, wantsCollide: boolean): Float64Array {
        const n = CFG_BASE + body.shapes.length * CFG_SHAPE;
        if (this._cfgScratch.length < n) this._cfgScratch = new Float64Array(n * 2);
        const c = this._cfgScratch;
        c[0] = body.type; c[1] = body.mass;
        c[2] = body.inertia.x; c[3] = body.inertia.y; c[4] = body.inertia.z;
        c[5] = body.invInertia.x; c[6] = body.invInertia.y; c[7] = body.invInertia.z;
        c[8] = body.linearDamping; c[9] = body.angularDamping;
        c[10] = body.linearFactor.x; c[11] = body.linearFactor.y; c[12] = body.linearFactor.z;
        c[13] = body.angularFactor.x; c[14] = body.angularFactor.y; c[15] = body.angularFactor.z;
        c[16] = body.fixedRotation ? 1 : 0; c[17] = body.allowSleep ? 1 : 0;
        c[18] = body.sleepSpeedLimit; c[19] = body.sleepTimeLimit;
        c[20] = body.collisionResponse ? 1 : 0; c[21] = body.collisionFilterGroup; c[22] = body.collisionFilterMask;
        c[23] = (body.isTrigger ? 1 : 0) + ((body as any).owner?.nodeType === 'character' ? 2 : 0) + (wantsCollide ? 4 : 0);
        c[24] = body.shapes.length;
        for (let i = 0; i < body.shapes.length; i++) {
            const o = CFG_BASE + i * CFG_SHAPE, s = body.shapes[i], off = body.shapeOffsets[i], q = body.shapeOrientations[i];
            c[o] = s.id; c[o + 1] = off.x; c[o + 2] = off.y; c[o + 3] = off.z;
            c[o + 4] = q.x; c[o + 5] = q.y; c[o + 6] = q.z; c[o + 7] = q.w;
            c[o + 8] = s.collisionResponse ? 1 : 0; c[o + 9] = s.collisionFilterGroup; c[o + 10] = s.collisionFilterMask;
        }
        return c.subarray(0, n);
    }

    public reset(): void {
        this._epoch++;
        this._inFlight = false;
        this._latest = null;
        this._started = false;
        this._owed = 0;
        this._sincePost = 0;
        this._from = this._to = this._flightFrom = this._flightTo = 0;
        this._visReady = false;
        this._visLead = 0;
        this._applyGap = 0;
        this._appliedAt = NaN;
        this._slotOf.clear();
        this._slots.length = 0;
        this._freeSlots.length = 0;
        this._constraintIds.clear();
        this._knownShapes.clear();
        this._recycle = [];
        this._sentWater = [];
        this._port.post({ kind: 'reset', epoch: this._epoch }, []);
        // Still warming up: the answer it was waiting for belongs to the old epoch, so ask again.
        if (!this._ready) this.prime();
    }

    public dispose(): void {
        this._port.onMessage = null;
        this._port.onError = null;
        this._port.dispose();
    }
}

/** Steps of history kept per body for drawing: enough for "one frame behind" even at a twentieth of real time. */
const KEYS = 32;

/** One history entry: the pose [px py pz qx qy qz qw] and the velocity [vx vy vz] at a step's end. */
const KEY_STRIDE = 10;

/** Append a step end (pose and velocity at `time`) to a slot's drawing history. */
function pushKey(slot: Slot, pose: ArrayLike<number>, time: number, vx: number, vy: number, vz: number): void {
    const o = slot.keyHead * KEY_STRIDE;
    for (let i = 0; i < 7; i++) slot.keys[o + i] = pose[i];
    slot.keys[o + 7] = vx; slot.keys[o + 8] = vy; slot.keys[o + 9] = vz;
    slot.keyTimes[slot.keyHead] = time;
    slot.keyHead = (slot.keyHead + 1) % KEYS;
    if (slot.keyCount < KEYS) slot.keyCount++;
}

/**
 * `out` = the pose a fraction `t` of the way from key `a` to key `b` (ring indices), with `p` the key before
 * `a` and `n` the one after `b`. The position follows a cubic Hermite curve whose tangents come from the
 * neighbouring keys (non-uniform Catmull-Rom): exact for steady motion, and smooth where one step meets the
 * next, which matters when results arrive every few frames and each step spans several. Rotation is nlerped.
 */
function hermitePose(keys: Float64Array, times: Float64Array, p: number, a: number, b: number, n: number, t: number, out: Float64Array): void {
    const ta = times[a], tb = times[b], span = tb - ta;
    const A = a * KEY_STRIDE, B = b * KEY_STRIDE, P = p * KEY_STRIDE, N = n * KEY_STRIDE;
    const dtA = times[b] - times[p], dtB = times[n] - times[a];
    const t2 = t * t, t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1, h10 = (t3 - 2 * t2 + t) * span, h01 = -2 * t3 + 3 * t2, h11 = (t3 - t2) * span;
    for (let i = 0; i < 3; i++) {
        const ma = dtA > 0 ? (keys[B + i] - keys[P + i]) / dtA : 0;
        const mb = dtB > 0 ? (keys[N + i] - keys[A + i]) / dtB : 0;
        out[i] = h00 * keys[A + i] + h10 * ma + h01 * keys[B + i] + h11 * mb;
    }
    const s = keys[A + 3] * keys[B + 3] + keys[A + 4] * keys[B + 4] + keys[A + 5] * keys[B + 5] + keys[A + 6] * keys[B + 6] < 0 ? -1 : 1;
    const x = keys[A + 3] + (s * keys[B + 3] - keys[A + 3]) * t, y = keys[A + 4] + (s * keys[B + 4] - keys[A + 4]) * t;
    const z = keys[A + 5] + (s * keys[B + 5] - keys[A + 5]) * t, w = keys[A + 6] + (s * keys[B + 6] - keys[A + 6]) * t;
    const len = 1 / Math.hypot(x, y, z, w);
    out[3] = x * len; out[4] = y * len; out[5] = z * len; out[6] = w * len;
}

/** `out` = a pose between `a` and `b` ([px py pz qx qy qz qw]): position lerped, rotation nlerped the short way. */
function lerpPose(a: ArrayLike<number>, b: ArrayLike<number>, t: number, out: Float64Array): void {
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
    // nlerp along the short way: a step turns a body by a few degrees at most.
    const s = a[3] * b[3] + a[4] * b[4] + a[5] * b[5] + a[6] * b[6] < 0 ? -1 : 1;
    const x = a[3] + (s * b[3] - a[3]) * t, y = a[4] + (s * b[4] - a[4]) * t;
    const z = a[5] + (s * b[5] - a[5]) * t, w = a[6] + (s * b[6] - a[6]) * t;
    const n = 1 / Math.hypot(x, y, z, w);
    out[3] = x * n; out[4] = y * n; out[5] = z * n; out[6] = w * n;
}

/** Whether a[from..from+count) equals b[bFrom..] (NaN equal to NaN). `bFrom` defaults to `from`. */
function same(a: ArrayLike<number>, b: ArrayLike<number>, from: number, count: number, bFrom: number = from): boolean {
    for (let i = 0; i < count; i++) {
        const x = a[from + i], y = b[bFrom + i];
        if (x !== y && !(x !== x && y !== y)) return false;
    }
    return true;
}

/**
 * A body turned here since the diff, turned by the same amount from where the step left it:
 * `(now · was⁻¹) · stepped`, with `now` at scratch[3..6], `was` at shadow[3..6], `stepped` at row[at..].
 */
function rebaseRotation(out: { x: number; y: number; z: number; w: number; set(x: number, y: number, z: number, w: number): unknown }, now: ArrayLike<number>, was: ArrayLike<number>, row: ArrayLike<number>, at: number): void {
    const ax = now[3], ay = now[4], az = now[5], aw = now[6];
    const bx = -was[3], by = -was[4], bz = -was[5], bw = was[6];
    // d = now · conj(was)
    const dx = aw * bx + ax * bw + ay * bz - az * by;
    const dy = aw * by - ax * bz + ay * bw + az * bx;
    const dz = aw * bz + ax * by - ay * bx + az * bw;
    const dw = aw * bw - ax * bx - ay * by - az * bz;
    const sx = row[at], sy = row[at + 1], sz = row[at + 2], sw = row[at + 3];
    const x = dw * sx + dx * sw + dy * sz - dz * sy;
    const y = dw * sy - dx * sz + dy * sw + dz * sx;
    const z = dw * sz + dx * sy - dy * sx + dz * sw;
    const w = dw * sw - dx * sx - dy * sy - dz * sz;
    const n = 1 / Math.hypot(x, y, z, w);
    out.set(x * n, y * n, z * n, w * n);
}

function uniqueBuffers(list: ArrayBuffer[]): ArrayBuffer[] {
    return [...new Set(list)].filter(b => b && b.byteLength > 0);
}
