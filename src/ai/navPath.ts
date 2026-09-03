/**
 * Following a navmesh path, as a steering behaviour like any other.
 *
 * A LEAF: no Node, no scene, no physics, and — deliberately — **no Yuka**. A path is a list of world
 * points by the time it reaches here, so everything below is ordinary vector math against the same
 * conventions `core/control/steering.ts` uses, and it is testable in three lines.
 *
 * That is also why Yuka's own `FollowPathBehavior` and `Path` are not used. Both are welded to
 * `Vehicle`, and `Path.current()` hands out a reference to a waypoint that may itself alias a navmesh
 * vertex. The engine's version is smaller than the adapter would have been.
 *
 * ## The shape of the thing
 *
 * `followPath` answers the same question every other steer answers — "which way should I be moving
 * right now?" — as a world-space DESIRED VELOCITY, so it feeds `intentFromDesired` and a character
 * cannot tell it apart from a player. Everything is PLANAR relative to `up`, never to +Y, matching
 * the rest of the control layer. (The navmesh underneath is XZ-planar because Yuka's is; the
 * *following* need not be, and keeping it gravity-relative costs nothing.)
 *
 * ## Two decisions worth reading
 *
 *   * **Intermediate waypoints are sought, the last one is arrived at.** Easing into every corner
 *     produces an agent that stutters down a corridor; easing into none produces one that overshoots
 *     its destination and orbits it.
 *   * **Repathing is a policy, not a per-frame call.** `findPath` allocates and walks a graph. An
 *     agent chasing a moving target repaths on an interval OR when the target has moved far enough to
 *     invalidate the route, whichever comes first — never every frame.
 */

import { vec3 } from "gl-matrix";
import { arrive, seek } from "../core/control/steering";
import type { SteeringTuning } from "../core/control/steering";

/**
 * A path being walked. The caller owns it — same contract as `SteeringState` and `LocomotionState`.
 *
 * Never serialized: a half-walked route is not authored data.
 */
export interface NavPath {
    /** World-space waypoints. Owned by this record; `setNavPath` copies into it. */
    points: vec3[];
    /** Index of the waypoint currently being steered toward. */
    index: number;
}

const _tmp = vec3.create();

/** Drop the component along `up`, so distances are measured on the ground plane. */
function planar(out: vec3, v: vec3, up: vec3): vec3 {
    const dot = vec3.dot(v, up);
    return vec3.set(out, v[0] - up[0] * dot, v[1] - up[1] * dot, v[2] - up[2] * dot);
}

export function createNavPath(): NavPath {
    return { points: [], index: 0 };
}

/** Replace the route. Copies, so the caller may reuse its own array. */
export function setNavPath(path: NavPath, points: readonly vec3[]): NavPath {
    path.points.length = 0;
    for (const p of points) path.points.push(vec3.clone(p));
    path.index = 0;
    return path;
}

/**
 * Push each interior waypoint off the corner it hugs, by `radius`, along the bisector.
 *
 * **This is where agent radius is applied**, and it is applied here rather than at bake time on
 * purpose. Eroding the navmesh by the agent's radius was built first and abandoned: a wall gives you
 * a half-space, clipping a convex region by it pulls back the whole region including its *shared*
 * edges, and the mesh comes apart into islands. See the `navBake` header for the measurement.
 *
 * A funnelled path is exact — it runs through the corner vertex — so an agent following it literally
 * scrapes the wall. The corner is convex by construction (the funnel only turns around a region
 * boundary), so the interior bisector of the incoming and outgoing legs points into open space, and
 * stepping along it is the correct local fix.
 *
 * Endpoints are left alone: the start is wherever the agent already is, and moving the destination is
 * how an agent ends up standing next to the thing it was sent to rather than at it.
 *
 * Doing this per path rather than per mesh is also what lets a child and an ogre share one navmesh.
 */
export function insetCorners(path: NavPath, radius: number, up: vec3): NavPath {
    if (!(radius > 0) || path.points.length < 3) return path;

    const inA = vec3.create();
    const inB = vec3.create();
    const bisector = vec3.create();
    // Read from a snapshot: each corner must be measured against the ORIGINAL legs, or the second
    // corner is bent around a vertex the first one already moved.
    const original = path.points.map(p => vec3.clone(p));

    for (let i = 1; i < original.length - 1; i++) {
        planar(inA, vec3.subtract(inA, original[i - 1], original[i]), up);
        planar(inB, vec3.subtract(inB, original[i + 1], original[i]), up);
        const lengthA = vec3.length(inA);
        const lengthB = vec3.length(inB);
        if (lengthA <= 1e-6 || lengthB <= 1e-6) continue;

        vec3.scale(inA, inA, 1 / lengthA);
        vec3.scale(inB, inB, 1 / lengthB);
        vec3.add(bisector, inA, inB);

        const length = vec3.length(bisector);
        // A straight-through waypoint has opposing legs that cancel: there is no corner to round, and
        // normalizing here would be a division by ~0.
        if (length <= 1e-4) continue;

        // Never step further than half the shorter leg, or a tight zig-zag turns inside out.
        const step = Math.min(radius, Math.min(lengthA, lengthB) * 0.5);
        vec3.scaleAndAdd(path.points[i], original[i], bisector, step / length);
    }
    return path;
}

export function clearNavPath(path: NavPath): NavPath {
    path.points.length = 0;
    path.index = 0;
    return path;
}

/** Whether there is anything left to walk. */
export function hasPath(path: Readonly<NavPath>): boolean {
    return path.index < path.points.length;
}

/** The waypoint being steered toward, or null when the route is spent. */
export function currentWaypoint(path: Readonly<NavPath>): vec3 | null {
    return path.index < path.points.length ? path.points[path.index] : null;
}

/** Whether the CURRENT waypoint is the destination. */
export function onFinalWaypoint(path: Readonly<NavPath>): boolean {
    return path.index >= path.points.length - 1;
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

/** Planar distance from `from` to `point`. */
function planarDistance(from: vec3, point: vec3, up: vec3): number {
    vec3.subtract(_tmp, point, from);
    planar(_tmp, _tmp, up);
    return vec3.length(_tmp);
}

// ---------------------------------------------------------------------------------------------------
// Walking
// ---------------------------------------------------------------------------------------------------

/**
 * Consume every waypoint the agent is already close enough to.
 *
 * A LOOP rather than a single step: one physics frame can cover several waypoints where a funnel
 * produced a tight cluster of corners, and advancing one per frame there makes an agent visibly
 * hesitate. Returns true if anything was consumed.
 *
 * The final waypoint is NOT consumed by proximity — `arrive` eases into it and the caller decides
 * when the goal is met, because "close enough to turn the corner" and "close enough to have arrived"
 * are different distances.
 */
export function advancePath(path: NavPath, from: vec3, waypointRadius: number, up: vec3): boolean {
    const radius = Math.max(0, waypointRadius);
    let advanced = false;
    while (path.index < path.points.length - 1) {
        if (planarDistance(from, path.points[path.index], up) > radius) break;
        path.index++;
        advanced = true;
    }
    return advanced;
}

/**
 * Planar distance still to walk: to the current waypoint, then along the remaining legs.
 *
 * Feeds a `pathRemaining` sense — "am I nearly there" is a question a behaviour machine wants to ask
 * without knowing what a waypoint is.
 */
export function remainingDistance(path: Readonly<NavPath>, from: vec3, up: vec3): number {
    if (path.index >= path.points.length) return 0;
    let total = planarDistance(from, path.points[path.index], up);
    for (let i = path.index; i < path.points.length - 1; i++) {
        total += planarDistance(path.points[i], path.points[i + 1], up);
    }
    return total;
}

/**
 * The desired velocity that walks this path.
 *
 * Seeks intermediate waypoints at full speed; `arrive`s at the last one so the agent eases to a stop
 * rather than overshooting and orbiting. A spent path asks for nothing, which reads as "stand still",
 * not as "walk to the origin".
 */
export function followPath(
    out: vec3, from: vec3, path: Readonly<NavPath>, tuning: SteeringTuning, up: vec3,
): vec3 {
    const waypoint = currentWaypoint(path);
    if (!waypoint) return vec3.set(out, 0, 0, 0);
    return onFinalWaypoint(path)
        ? arrive(out, from, waypoint, tuning, up)
        : seek(out, from, waypoint, tuning.maxSpeed, up);
}

// ---------------------------------------------------------------------------------------------------
// Repath policy
// ---------------------------------------------------------------------------------------------------

export interface RepathPolicy {
    /** Seconds between forced repaths. 0 disables the timer, leaving only the distance trigger. */
    interval: number;
    /**
     * How far the destination may drift from where it was when the route was computed before that
     * route is considered stale. 0 disables the distance trigger.
     */
    targetDrift: number;
}

export const REPATH_DEFAULTS: RepathPolicy = { interval: 0.5, targetDrift: 1.5 };

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Every field defaulted and clamped, so a partial or junk record passes. Mirrors `steeringTuning`. */
export function repathPolicy(over?: Partial<RepathPolicy> | null): RepathPolicy {
    const o = (over ?? {}) as Partial<RepathPolicy>;
    return {
        interval: Math.max(0, num(o.interval, REPATH_DEFAULTS.interval)),
        targetDrift: Math.max(0, num(o.targetDrift, REPATH_DEFAULTS.targetDrift)),
    };
}

/** Caller-owned, like every other state record here. */
export interface RepathState {
    /** Seconds since the last repath. */
    elapsed: number;
    /** Where the destination was when the current route was computed. */
    lastTarget: vec3;
    /** False until a route has been computed at least once. */
    planned: boolean;
}

export function createRepathState(): RepathState {
    return { elapsed: 0, lastTarget: vec3.create(), planned: false };
}

/**
 * Advance the timer and answer whether the route should be recomputed.
 *
 * True on the first call (nothing has been planned yet), then when the interval elapses or the
 * destination has drifted too far — whichever comes first. Does NOT reset the state; the caller calls
 * {@link markRepathed} once it has actually computed a route, so a failed path query is retried
 * rather than silently swallowing the trigger.
 */
export function shouldRepath(
    state: RepathState, dt: number, target: vec3, policy: RepathPolicy,
): boolean {
    state.elapsed += Number.isFinite(dt) && dt > 0 ? dt : 0;
    if (!state.planned) return true;
    if (policy.interval > 0 && state.elapsed >= policy.interval) return true;
    if (policy.targetDrift > 0 && vec3.distance(state.lastTarget, target) >= policy.targetDrift) return true;
    return false;
}

/** Record that a route to `target` has just been computed. */
export function markRepathed(state: RepathState, target: vec3): void {
    state.elapsed = 0;
    state.planned = true;
    vec3.copy(state.lastTarget, target);
}
