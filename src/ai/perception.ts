/**
 * What an agent can see, and what it remembers seeing.
 *
 * Wraps Yuka's `Vision` and `MemorySystem`. **The raycast stays out** — this module takes a
 * line-of-sight callback and never learns what a physics world is, exactly the rule
 * `steering.avoidObstacles` follows with caller-measured probes. The geometry of deciding whether a
 * point is in a cone is testable in three lines; the query that answers "is anything between these
 * two points" needs a scene, a broadphase and a body to ignore, and keeping them apart is what lets
 * the interesting half be tested without standing up a world.
 *
 * ## What Yuka is actually doing here
 *
 * `Vision.visible(point)` rejects in a specific and useful order, verified against the real runtime:
 * **range first, then the cone, then obstacles.** A target out of range or outside the cone costs
 * ZERO line-of-sight calls; a visible one costs exactly one. So the raycast budget is proportional to
 * what is genuinely in front of the agent rather than to how many candidates exist — which is the
 * difference between perception being free and being the frame.
 *
 * `MemorySystem` holds the record model: when something became visible, when it was last sensed,
 * where it was, and whether a record is still within `memorySpan`. That is precisely the state an
 * "investigate where I last saw you" behaviour needs, and precisely the state that is annoying to get
 * right by hand.
 *
 * ## Four Yuka behaviours this module is built around, all verified rather than assumed
 *
 *  1. **`fieldOfView` is the FULL cone, in radians.** A 90 degree setting is visible to exactly 45
 *     degrees off-axis. Authored here in DEGREES because every other angle in the engine is.
 *  2. **The boundary is exclusive.** A target at exactly `fieldOfView / 2` is not visible.
 *  3. **Nothing in Yuka updates a `MemorySystem`.** There is no `update()`; the sense loop is ours.
 *  4. **`createRecord` returns `this`, not the record.** Fetch it with `getRecord` afterwards.
 *
 * And one hazard: `Vision.removeObstacle` does an unguarded `splice(-1, 1)`, so calling it with
 * something not in the list silently deletes the LAST obstacle instead. This module adds exactly one
 * obstacle, at construction, and never removes it.
 *
 * ## Orientation
 *
 * The observer is placed with a yaw only. Yuka's yaw and Cleo's agree exactly — an entity rotated by
 * +90 degrees reports a world direction of `(1, 0, 0)`, which is Cleo's `forward = (sin, 0, cos)` —
 * so no sign flip or axis remap is involved. A yaw-only facing means the cone is symmetric about the
 * horizontal, which is what a ground agent wants; an agent that should not see over a balcony is
 * served by the line-of-sight callback, not by a pitch.
 */

import { vec3 } from "gl-matrix";
import { clamp, DEG2RAD } from "../core/math";
import { GameEntity, MemorySystem, Vector3, Vision } from "./yuka";
import { toYuka, yawToYukaRotation } from "./interop";
import type { Vec3Like } from "./interop";

export interface PerceptionTuning {
    /** Full cone width in DEGREES. 360 sees everything within range. */
    fieldOfView: number;
    /** How far the agent can see, in world units. */
    range: number;
    /**
     * Seconds a target stays remembered after it was last seen. This is what makes an agent walk to
     * where you were rather than forgetting you the instant you break line of sight.
     */
    memorySpan: number;
    /**
     * Seconds of continuous visibility before a target counts as NOTICED.
     *
     * Without it an agent reacts on the exact frame a pixel of you clears a doorway, which reads as
     * clairvoyance. Backed by Yuka's `timeBecameVisible`, which exists for this.
     */
    reactionTime: number;
}

export const PERCEPTION_DEFAULTS: PerceptionTuning = {
    fieldOfView: 120,
    range: 20,
    memorySpan: 5,
    reactionTime: 0.25,
};

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Every field defaulted and clamped, so a partial or junk record passes. Mirrors `steeringTuning`. */
export function perceptionTuning(over?: Partial<PerceptionTuning> | null): PerceptionTuning {
    const o = (over ?? {}) as Partial<PerceptionTuning>;
    const d = PERCEPTION_DEFAULTS;
    return {
        fieldOfView: clamp(num(o.fieldOfView, d.fieldOfView), 0, 360),
        range: Math.max(0, num(o.range, d.range)),
        memorySpan: Math.max(0, num(o.memorySpan, d.memorySpan)),
        reactionTime: Math.max(0, num(o.reactionTime, d.reactionTime)),
    };
}

/** Something that might be seen. The caller decides what is worth offering. */
export interface PerceptionCandidate {
    id: string;
    position: Vec3Like;
}

/**
 * "Is anything solid between these two points?"
 *
 * Writes the blocking point into `hit` and returns true when the view is blocked. Zero-allocation by
 * contract, because it runs once per candidate that survives the range and cone tests.
 */
export type LineOfSightTest = (from: vec3, to: vec3, hit: vec3) => boolean;

/** What perception knows about one candidate, as plain data a behaviour machine can read. */
export interface Sighting {
    id: string;
    /** Visible RIGHT NOW: in range, in the cone, and unobstructed. */
    visible: boolean;
    /**
     * Visible for at least `reactionTime`. This is the one a behaviour should gate on — `visible` is
     * true on the first frame a target clears a corner, which is sooner than anything should react.
     */
    noticed: boolean;
    /** Seconds since last seen. `Infinity` if never seen, 0 while visible. */
    timeSinceSeen: number;
    /** Where it was when last seen. Meaningless while `timeSinceSeen` is Infinity. */
    lastKnownPosition: vec3;
}

/**
 * A GameEntity whose line-of-sight test delegates to the caller's callback.
 *
 * ONE of these stands for the entire world, rather than one per obstacle. Yuka's own
 * `MeshGeometry.intersectRay` brute-forces triangles with no acceleration structure, whereas the
 * engine's physics world already has a broadphase and already knows which bodies are solid — so the
 * right move is to ask it once, not to teach Yuka about the level.
 */
class CallbackObstacle extends GameEntity {
    public test: LineOfSightTest | null = null;

    private readonly _from = vec3.create();
    private readonly _to = vec3.create();
    private readonly _hit = vec3.create();

    public lineOfSightTest(ray: { origin: Vector3; direction: Vector3 }, intersectionPoint: Vector3): Vector3 | null {
        if (!this.test) return null;
        vec3.set(this._from, ray.origin.x, ray.origin.y, ray.origin.z);
        // Yuka hands us a normalized direction and compares distances itself, so the segment end is
        // reconstructed from the range rather than passed in.
        vec3.set(this._to,
            ray.origin.x + ray.direction.x * this.reach,
            ray.origin.y + ray.direction.y * this.reach,
            ray.origin.z + ray.direction.z * this.reach);

        if (!this.test(this._from, this._to, this._hit)) return null;
        intersectionPoint.x = this._hit[0];
        intersectionPoint.y = this._hit[1];
        intersectionPoint.z = this._hit[2];
        return intersectionPoint;
    }

    /** How far along the ray to probe. Set to the distance to the candidate before each test. */
    public reach: number = 0;
}

/**
 * An agent's eyes and short-term memory. Caller-owned, one per controller.
 *
 * A class rather than the record-plus-pure-function shape the rest of the control layer uses, because
 * it caches Yuka objects: a `GameEntity` per tracked candidate, reused frame to frame. Allocating
 * those per frame is the only way this would become expensive.
 */
export class Perception {
    private readonly _owner = new GameEntity();
    private readonly _vision = new Vision(this._owner);
    private readonly _memory = new MemorySystem(this._owner);
    private readonly _obstacle = new CallbackObstacle();
    /** One entity per candidate id, kept because MemorySystem keys its records by entity. */
    private readonly _entities = new Map<string, GameEntity>();

    private _time = 0;
    private readonly _sightings = new Map<string, Sighting>();
    private readonly _point = new Vector3();
    private readonly _from = vec3.create();
    private readonly _to = vec3.create();

    constructor() {
        // Added once and never removed: removeObstacle's unguarded splice(-1, 1) would delete the
        // wrong entry if it were ever called with something absent.
        this._vision.addObstacle(this._obstacle);
    }

    /** Seconds of perceived time. Advanced by `step`. */
    public get time(): number { return this._time; }

    public get sightings(): IterableIterator<Sighting> { return this._sightings.values(); }

    public sightingOf(id: string): Sighting | null {
        return this._sightings.get(id) ?? null;
    }

    /** Forget everything. For a respawned brain, which must not resume mid-chase. */
    public clear(): void {
        this._memory.clear();
        this._entities.clear();
        this._sightings.clear();
        this._time = 0;
    }

    /**
     * Advance perception by one frame.
     *
     * `los` may be null, in which case nothing blocks the view — which is the honest behaviour for a
     * scene with no physics rather than a reason to see nothing.
     */
    public step(
        observerPosition: Vec3Like,
        observerYaw: number,
        candidates: readonly PerceptionCandidate[],
        tuning: PerceptionTuning,
        dt: number,
        los: LineOfSightTest | null,
    ): void {
        this._time += Number.isFinite(dt) && dt > 0 ? dt : 0;

        toYuka(this._owner.position, observerPosition);
        yawToYukaRotation(this._owner.rotation, observerYaw);
        // Degrees in, radians out, and it is the FULL cone: Yuka halves it internally.
        this._vision.fieldOfView = tuning.fieldOfView * DEG2RAD;
        this._vision.range = tuning.range;
        this._memory.memorySpan = tuning.memorySpan;
        this._obstacle.test = los;

        vec3.set(this._from, observerPosition[0], observerPosition[1], observerPosition[2]);

        const seen = new Set<string>();
        for (const candidate of candidates) {
            seen.add(candidate.id);
            const entity = this._entityFor(candidate.id);
            toYuka(this._point, candidate.position);

            // The obstacle needs to know how far to probe; Yuka normalizes the ray and keeps the
            // distance to itself. Into scratch, not a fresh array -- this runs per candidate per frame.
            vec3.set(this._to, this._point.x, this._point.y, this._point.z);
            this._obstacle.reach = vec3.distance(this._from, this._to);

            const visible = this._vision.visible(this._point);

            // createRecord returns `this`, not the record -- fetch it afterwards.
            if (!this._memory.getRecord(entity)) this._memory.createRecord(entity);
            const record = this._memory.getRecord(entity)!;

            if (visible) {
                // Only on the RISING edge, or a continuously visible target never accumulates reaction
                // time and is noticed on the frame it is lost.
                if (!record.visible) record.timeBecameVisible = this._time;
                record.visible = true;
                record.timeLastSensed = this._time;
                record.lastSensedPosition.copy(this._point);
            } else {
                record.visible = false;
            }

            this._publish(candidate.id, record, tuning);
        }

        // A candidate that stopped being offered (despawned, or filtered out) keeps its memory but is
        // no longer visible -- otherwise an agent chases something that has left the scene.
        for (const [id, sighting] of this._sightings) {
            if (seen.has(id)) continue;
            const entity = this._entities.get(id);
            const record = entity ? this._memory.getRecord(entity) : undefined;
            if (record) {
                record.visible = false;
                this._publish(id, record, tuning);
            } else {
                sighting.visible = false;
                sighting.noticed = false;
            }
        }
    }

    private _publish(id: string, record: {
        visible: boolean; timeBecameVisible: number; timeLastSensed: number; lastSensedPosition: Vector3;
    }, tuning: PerceptionTuning): void {
        let sighting = this._sightings.get(id);
        if (!sighting) {
            sighting = { id, visible: false, noticed: false, timeSinceSeen: Infinity, lastKnownPosition: vec3.create() };
            this._sightings.set(id, sighting);
        }
        sighting.visible = record.visible;
        sighting.noticed = record.visible && (this._time - record.timeBecameVisible) >= tuning.reactionTime;
        // -Infinity is Yuka's "never sensed"; subtracting it would give Infinity anyway, but the
        // explicit test keeps the intent readable and survives a record we did not create.
        sighting.timeSinceSeen = Number.isFinite(record.timeLastSensed)
            ? Math.max(0, this._time - record.timeLastSensed)
            : Infinity;
        if (Number.isFinite(record.timeLastSensed)) {
            vec3.set(sighting.lastKnownPosition,
                record.lastSensedPosition.x, record.lastSensedPosition.y, record.lastSensedPosition.z);
        }
    }

    /** Whether a target is still within memory span — Yuka's own validity rule. */
    public remembers(id: string, tuning: PerceptionTuning): boolean {
        const sighting = this._sightings.get(id);
        if (!sighting || !Number.isFinite(sighting.timeSinceSeen)) return false;
        return sighting.timeSinceSeen <= tuning.memorySpan;
    }

    private _entityFor(id: string): GameEntity {
        let entity = this._entities.get(id);
        if (!entity) {
            entity = new GameEntity();
            this._entities.set(id, entity);
        }
        return entity;
    }
}
