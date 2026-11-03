import { physicsStats } from '../physicsStats';
import type { WaterSpec } from '../waterSurface';
import { createWorldMirror } from '../pal/createWorld';
import type { WorldMirror } from '../pal/replication';
import type { BodyHandle } from '../pal/types';
import type { PhysicsWorld } from '../pal/world';
import type { PhysicsPort } from '../worker/ports';
import type { FromWorker, Snapshot, StepMessage } from '../worker/protocol';
import { CONTACT_ROW } from '../worker/protocol';
import { NO_CONTACTS, type ContactSource, type PhysicsExecutor, type StepResult } from './physicsExecutor';

// The physics step in a Web Worker.
//
// The main thread keeps its world — every body and joint exactly where the engine puts them — and does not
// step it: every query (raycasts, overlaps, sweeps, the ground probe, the camera boom) and every `node.body`
// read and write works on it unchanged. Once per frame, after scripts have run (PhysicsSystem.endFrame),
// what changed in it since the worker was last told is posted with the frame's step. The worker steps its
// copy while this thread renders; at the start of the next frame (physics.update) the step is written back
// into the world, with the contacts, trigger events, first contacts and buoyancy it produced. How the world
// is copied, both ways, is its backend's business (pal/replication.ts: the WorldMirror here, a WorldReplica
// in the worker); this executor is the same on every backend.
//
// TIME. A step has to be posted before the frame it is drawn in has started, so before anyone knows how
// long that frame will be. Stepping by the frame that just ENDED (what this executor first did) draws every
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
// the engine's frame delta). A body written here AFTER the diff and before the step lands (a DOM input
// handler between frames, or a frame whose diff was skipped while a step ran) keeps that write: the mirror
// carries it along from where the step left the body.

/** What the executor needs from PhysicsSystem. */
export interface WorkerExecutorHost {
    /** The engine's world. A step's trigger overlaps and first contacts come out of its drainEvents. */
    readonly world: PhysicsWorld;
    /** The water volumes buoying bodies this frame, and where to report what each buoyed. */
    water(): { spec: WaterSpec; record: (body: BodyHandle, fraction: number) => void }[];
    substepsFor(dt: number): number;
    profileStep(): boolean;
    /** The worker failed: PhysicsSystem falls back to stepping inline, on the same world. */
    onFailure(error: unknown): void;
}

/** The engine's own frame-delta cap: how far a body is ever carried along its velocity past its last step. */
const MAX_PENDING = 0.1;
/**
 * Most simulated time one step may carry: eight substeps of 1/60 s, the most PhysicsSystem.substepsFor gives a
 * step. A reply that missed several frames leaves more owed than that; the rest goes out with the next steps.
 */
const MAX_STEP = 8 / 60;
/**
 * Most simulated time the worker may owe before the excess is dropped (as the engine drops a frame past its
 * delta cap). Not one frame's cap: a reply that missed three or four 30 ms frames owes over 0.1 s of frames
 * that each ran normally, and dropping that drew every body standing still for the dropped time, then moving on.
 */
const MAX_OWED = 0.25;
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
/** What a body is drawn from, per slot (see visualPose). */
interface Track {
    /** The applied step's end, for drawing: pose + velocity + spin. */
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
    /** Whether `to` holds a step yet; whether the body did not move (nothing to draw). */
    tracked: boolean;
    settled: boolean;
}

export class WorkerExecutor implements PhysicsExecutor {
    public readonly kind = 'worker' as const;
    private _epoch = 0;
    private _seq = 0;
    private _inFlight = false;
    private _latest: Snapshot | null = null;
    private _failed = false;
    private _ready = false;
    /** The world's copying, this end (see pal/replication.ts). */
    private readonly _mirror: WorldMirror;
    private readonly _tracks: (Track | undefined)[] = [];
    private _recycle: ArrayBuffer[] = [];
    /** The water volumes the in-flight step was sent, so its buoyancy report finds them. */
    private _sentWater: { record: (body: BodyHandle, fraction: number) => void }[] = [];
    private readonly _contacts = new ContactRows();

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

    constructor(private readonly _host: WorkerExecutorHost, private readonly _port: PhysicsPort) {
        this._mirror = createWorldMirror(_host.world);
        _port.onMessage = (msg) => this._receive(msg);
        _port.onError = (error) => this._fail(error);
        _port.post({ kind: 'reset', epoch: this._epoch, backend: _host.world.backend }, []);
    }

    /** Whether results are read from shared memory (WorkerPort.shared) instead of waiting for their message. */
    public get sharedReplies(): boolean { return (this._port as { shared?: boolean }).shared === true; }

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
        if (!snap || this._failed) return { dt: 0, contacts: NO_CONTACTS };
        if (this._appliedAt === this._appliedAt && this._now > this._appliedAt) {
            const realGap = (this._now - this._appliedAt) / (this._scaleAvg > 0 ? this._scaleAvg : 1);
            this._applyGap = this._applyGap === 0 ? realGap : this._applyGap + (realGap - this._applyGap) * APPLY_GAP_RATE;
        }
        this._appliedAt = this._now;
        const start = performance.now();
        physicsStats.workerReadyMs = start - this._arrivedAt;
        physicsStats.workerBytesDown = snap.bodies.byteLength + snap.contacts.byteLength
            + snap.events.byteLength + snap.submerged.byteLength;
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
        else if (this._vis < this._now - MAX_OWED) this._vis = this._now - MAX_OWED;
    }

    private _receive(msg: FromWorker): void {
        if (msg.kind === 'channel') return;      // the port's own business
        if (msg.epoch !== this._epoch) return;   // from before a reset: stale
        if (msg.kind === 'error') { this._fail(new Error(msg.message)); return; }
        // Read from shared memory: when the worker finished, not when this thread got round to looking.
        this._arrivedAt = msg.doneAt ?? performance.now();
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
        // The bodies, and the events the step raised (out of the world's drainEvents next).
        this._mirror.apply(s, this._track);
        this._from = this._flightFrom;
        this._to = this._flightTo;
        // The last substep's contacts, for ground stamping, minus any with a body removed since (both sides
        // are needed to stamp).
        const contacts = this._contacts;
        contacts.count = 0;
        for (let i = 0; i < s.contactCount; i++) {
            const o = i * CONTACT_ROW;
            const a = this._mirror.handleOf(s.contacts[o]), b = this._mirror.handleOf(s.contacts[o + 1]);
            if (a !== undefined && b !== undefined) contacts.push(a, b, s.contacts[o + 2], s.contacts[o + 3], s.contacts[o + 4]);
        }
        for (let i = 0; i < s.submerged.length; i += 3) {
            const body = this._mirror.handleOf(s.submerged[i + 1]);
            if (body !== undefined) this._sentWater[s.submerged[i]]?.record(body, s.submerged[i + 2]);
        }
        physicsStats.workerStepMs = s.stats.stepMs;
        physicsStats.broadphaseMs += s.stats.broadphaseMs;
        physicsStats.narrowphaseMs += s.stats.narrowphaseMs;
        physicsStats.solveMs += s.stats.solveMs;
        physicsStats.integrateMs += s.stats.integrateMs;
        this._recycle.push(s.bodies.buffer as ArrayBuffer, s.contacts.buffer as ArrayBuffer);
    }

    /**
     * Record the step a body just took (the mirror's LandedBody), for {@link visualPose}: where it started,
     * `start`, and the pose, velocity and spin it ended with, `end`.
     */
    private _track = (index: number, _body: BodyHandle, start: ArrayLike<number>, end: ArrayLike<number>, sleeping: boolean): void => {
        const slot = this._tracks[index] ??= {
            to: new Float64Array(13), keys: new Float64Array(KEYS * KEY_STRIDE), keyTimes: new Float64Array(KEYS),
            keyCount: 0, keyHead: 0, tracked: false, settled: false,
        };
        const to = slot.to, keys = slot.keys;
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
        const vx = end[7], vy = end[8], vz = end[9];
        if (!(Math.abs(lastTime - this._flightFrom) < 1e-9)) pushKey(slot, start, this._flightFrom, vx, vy, vz);
        for (let i = 0; i < 13; i++) to[i] = end[i];
        pushKey(slot, to, this._flightTo, vx, vy, vz);
        slot.tracked = true;
        let still = sleeping || (to[7] === 0 && to[8] === 0 && to[9] === 0 && to[10] === 0 && to[11] === 0 && to[12] === 0);
        for (let k = 0; still && k < slot.keyCount; k++) still = same(to, keys, 0, 7, k * KEY_STRIDE);
        slot.settled = still;
    };

    // ---- drawing ----

    /**
     * The pose to DRAW `body` with this frame, [px py pz qx qy qz qw] (in the frame colliderFrameToOrigin
     * takes), written into `out`. Its last step's two ends interpolated at the frame's time — slightly behind the
     * clock, by the typical misprediction, so it is nearly always an interpolation — or the end carried on
     * along the body's velocity for a frame that outran the step (a long frame, a late worker), at most
     * a few frames' worth. False when there is nothing to draw but the body's own pose: no step taken yet,
     * or the body did not move.
     */
    public visualPose(body: BodyHandle, out: Float64Array): boolean {
        const index = this._mirror.slotOf(body);
        const slot = index === undefined ? undefined : this._tracks[index];
        if (!slot || !slot.tracked || slot.settled) return false;
        const b = slot.to;
        const s = this._scale;
        const time = this._vis;
        const keys = slot.keys, times = slot.keyTimes, n = slot.keyCount;
        const newest = (slot.keyHead + KEYS - 1) % KEYS;
        if (time >= times[newest]) {
            // Past the last step's end: carry on along its velocity (a long frame, a late step), a little.
            const e = Math.min(time - times[newest], Math.min(MAX_PENDING, 2.5 * this._lead * s));
            if (e <= 0 || this._host.world.isSleeping(body)) {
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
        if (this._owed > MAX_OWED) this._owed = MAX_OWED;   // past the cap: dropped, as the engine drops a frame past MAX_DELTA
        let span = this._owed > MAX_STEP ? MAX_STEP : this._owed;
        if (!(span > 0)) span = 0;
        this._owed -= span;                        // a step's worth at most: the rest goes with the next ones
        this._flightTo = this._now + lead - this._owed;
        this._flightFrom = this._flightTo - span;
        this.postedFrames++;
        physicsStats.workerStepsPosted = this.postedFrames;
        this._post(span);
    }

    private _post(stepDt: number): void {
        const start = performance.now();
        const world = this._host.world;
        const diff = this._mirror.diff();
        for (const slot of diff.released) this._tracks[slot] = undefined;
        const water = this._host.water();
        this._sentWater = water;
        const msg: StepMessage = {
            kind: 'step', epoch: this._epoch, seq: ++this._seq, dt: stepDt, substeps: this._host.substepsFor(stepDt),
            profile: this._host.profileStep(), changes: diff.changes,
            gravity: world.gravity, iterations: world.solverIterations, time: world.time,
            water: water.map(w => w.spec), recycle: this._recycle,
        };
        const transfer = uniqueBuffers([...diff.transfer, ...this._recycle]);
        // Measured before posting: a transferred buffer reads as empty afterwards.
        let bytes = 0;
        for (const buffer of uniqueBuffers(diff.transfer)) bytes += buffer.byteLength;
        physicsStats.workerBytesUp = bytes;
        physicsStats.workerWrites = diff.writes;
        physicsStats.workerOps = diff.ops;
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
        this._mirror.clear();
        this._tracks.length = 0;
        this._recycle = [];
        this._sentWater = [];
        this._port.post({ kind: 'reset', epoch: this._epoch, backend: this._host.world.backend }, []);
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
function pushKey(slot: Track, pose: ArrayLike<number>, time: number, vx: number, vy: number, vz: number): void {
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

/** Whether a[from..from+count) equals b[bFrom..] (NaN equal to NaN). `bFrom` defaults to `from`. */
function same(a: ArrayLike<number>, b: ArrayLike<number>, from: number, count: number, bFrom: number = from): boolean {
    for (let i = 0; i < count; i++) {
        const x = a[from + i], y = b[bFrom + i];
        if (x !== y && !(x !== x && y !== y)) return false;
    }
    return true;
}

function uniqueBuffers(list: ArrayBuffer[]): ArrayBuffer[] {
    return [...new Set(list)].filter(b => b && b.byteLength > 0);
}

/** The applied step's contacts, as handles: rows of [a, b, nx, ny, nz]. */
class ContactRows implements ContactSource {
    private readonly _rows: number[] = [];
    public count = 0;

    public get contactCount(): number { return this.count; }

    public push(a: number, b: number, nx: number, ny: number, nz: number): void {
        const o = this.count++ * 5, r = this._rows;
        r[o] = a; r[o + 1] = b; r[o + 2] = nx; r[o + 3] = ny; r[o + 4] = nz;
    }

    public forEachContact(visit: (a: BodyHandle, b: BodyHandle, nx: number, ny: number, nz: number) => void): void {
        const r = this._rows;
        for (let i = 0; i < this.count; i++) {
            const o = i * 5;
            visit(r[o] as BodyHandle, r[o + 1] as BodyHandle, r[o + 2], r[o + 3], r[o + 4]);
        }
    }
}
