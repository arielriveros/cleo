/**
 * Steering behaviours: the AI half of the control layer.
 *
 * Each function answers one question — "which way should I be moving right now?" — as a DESIRED VELOCITY
 * in world space. `intentFromDesired` turns that into the same {@link ControlIntent} a player produces,
 * which is the whole trick: a character cannot tell the difference, so an NPC gets the locomotion, the
 * slope handling and the animation the player character already has.
 *
 * A LEAF: no Node, no physics, no scene. In particular the RAYCASTS STAY OUT — `avoidObstacles` takes
 * hits the caller measured. The physics query needs a scene and a body to ignore; the geometry of
 * deciding what to do about a wall does not, and keeping them apart is what lets the interesting half be
 * tested without standing up a world.
 *
 * Everything is PLANAR relative to `up`, never to +Y, so a game with unusual gravity keeps working — the
 * same rule the rest of the engine's measured motion follows.
 *
 * `wander` is the only behaviour with state, and it is driven by `noise1` rather than `Math.random()`:
 * a crowd of wanderers must not move in unison (hence a per-instance seed) and a test must be able to
 * assert what one does (hence determinism).
 */

import { vec3 } from "gl-matrix";
import { clamp, noise1 } from "../math";
import { setMoveWorld } from "./intent";
import type { ControlIntent } from "./intent";

export interface SteeringTuning {
    /** The speed a full-throttle steer asks for. Scaled to 0..1 by `intentFromDesired`. */
    maxSpeed: number;
    /** Inside this, `arrive` is done and asks for nothing. */
    arriveRadius: number;
    /** Between `slowRadius` and `arriveRadius`, `arrive` eases off. Must exceed arriveRadius. */
    slowRadius: number;
    /** The ring `followTarget` settles on. Following to distance 0 is how a follower shoves its leader. */
    standoff: number;
    /** Radius of the circle `wander` steers toward a point on. Bigger is twitchier. */
    wanderRadius: number;
    /** How far ahead that circle sits. Bigger is straighter. */
    wanderDistance: number;
    /** Degrees per second the wander point drifts around its circle. */
    wanderJitter: number;
    /** Neighbours closer than this push back, in `separate`. */
    separationRadius: number;
    /** How far ahead obstacles are looked for. 0 disables avoidance entirely. */
    avoidDistance: number;
    /** How hard a detected obstacle pushes the desired velocity sideways. */
    avoidStrength: number;
}

export const STEERING_DEFAULTS: SteeringTuning = {
    maxSpeed: 3,
    arriveRadius: 0.4,
    slowRadius: 2.5,
    standoff: 2,
    wanderRadius: 1.2,
    wanderDistance: 2.5,
    wanderJitter: 90,
    separationRadius: 1.5,
    avoidDistance: 0,
    avoidStrength: 1.5,
};

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/** Every field defaulted and clamped, so a partial or junk record passes. Mirrors `locomotionTuning`. */
export function steeringTuning(over?: Partial<SteeringTuning> | null): SteeringTuning {
    const o = (over ?? {}) as Partial<SteeringTuning>;
    const d = STEERING_DEFAULTS;
    const arriveRadius = Math.max(0, num(o.arriveRadius, d.arriveRadius));
    return {
        maxSpeed: Math.max(0, num(o.maxSpeed, d.maxSpeed)),
        arriveRadius,
        // Strictly outside the arrive radius, or the easing band has zero width and arrive becomes a
        // hard stop — which reads as an NPC that slams to a halt at its destination.
        slowRadius: Math.max(arriveRadius + 0.01, num(o.slowRadius, d.slowRadius)),
        standoff: Math.max(0, num(o.standoff, d.standoff)),
        wanderRadius: Math.max(0.01, num(o.wanderRadius, d.wanderRadius)),
        wanderDistance: Math.max(0, num(o.wanderDistance, d.wanderDistance)),
        wanderJitter: clamp(num(o.wanderJitter, d.wanderJitter), 0, 3600),
        separationRadius: Math.max(0, num(o.separationRadius, d.separationRadius)),
        avoidDistance: Math.max(0, num(o.avoidDistance, d.avoidDistance)),
        avoidStrength: Math.max(0, num(o.avoidStrength, d.avoidStrength)),
    };
}

/**
 * The only state any of these need. Carried by the caller, and the `seed` is per-instance — a shared one
 * would make every wanderer in a crowd trace the same path, which is instantly obvious and looks broken.
 * Never serialized: a saved wander phase is not authored data.
 */
export interface SteeringState {
    wanderTime: number;
    seed: number;
}

export function createSteeringState(seed?: number): SteeringState {
    return { wanderTime: 0, seed: seed ?? ((Math.random() * 0x7fffffff) | 0) };
}

// ---------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------

const _tmp = vec3.create();

/** Drop the component along `up`, so every behaviour steers on the ground plane. */
function planar(out: vec3, v: vec3, up: vec3): vec3 {
    const dot = vec3.dot(v, up);
    return vec3.set(out, v[0] - up[0] * dot, v[1] - up[1] * dot, v[2] - up[2] * dot);
}

/** Scale to exactly `length`, or zero if there is no direction to scale. Never NaN. */
function withLength(out: vec3, v: vec3, length: number): vec3 {
    const magnitude = vec3.length(v);
    if (magnitude <= 1e-9) return vec3.set(out, 0, 0, 0);
    const s = length / magnitude;
    return vec3.set(out, v[0] * s, v[1] * s, v[2] * s);
}

// ---------------------------------------------------------------------------------------------------
// Behaviours
// ---------------------------------------------------------------------------------------------------

/** Straight at the target, flat out. */
export function seek(out: vec3, from: vec3, target: vec3, maxSpeed: number, up: vec3): vec3 {
    vec3.subtract(out, target, from);
    planar(out, out, up);
    return withLength(out, out, maxSpeed);
}

/** Directly away. The exact negative of {@link seek}. */
export function flee(out: vec3, from: vec3, threat: vec3, maxSpeed: number, up: vec3): vec3 {
    seek(out, from, threat, maxSpeed, up);
    return vec3.negate(out, out);
}

/**
 * Seek, easing to a stop. Zero inside `arriveRadius`, full speed outside `slowRadius`, and CONTINUOUS at
 * both — a discontinuity at the slow radius is a visible twitch as an NPC crosses it.
 */
export function arrive(out: vec3, from: vec3, target: vec3, t: SteeringTuning, up: vec3): vec3 {
    vec3.subtract(out, target, from);
    planar(out, out, up);
    const distance = vec3.length(out);
    if (distance <= t.arriveRadius) return vec3.set(out, 0, 0, 0);
    const ramp = Math.min(1, (distance - t.arriveRadius) / (t.slowRadius - t.arriveRadius));
    return withLength(out, out, t.maxSpeed * ramp);
}

/**
 * Seek where the target is GOING, not where it is. The lead time grows with distance, which is the
 * cheap approximation everyone uses and is indistinguishable from the exact solution at these speeds.
 */
export function pursue(
    out: vec3, from: vec3, target: vec3, targetVelocity: vec3, maxSpeed: number, up: vec3,
): vec3 {
    const distance = vec3.distance(from, target);
    const lead = maxSpeed > 1e-6 ? distance / maxSpeed : 0;
    vec3.scaleAndAdd(_tmp, target, targetVelocity, lead);
    return seek(out, from, _tmp, maxSpeed, up);
}

/**
 * Arrive at a RING around the target rather than at the target itself.
 *
 * Following to distance zero is how a companion ends up shoving whoever it is following, and then
 * oscillating as the two push each other. The standoff also gives the follower somewhere stable to stand
 * once the leader stops.
 */
export function followTarget(
    out: vec3, from: vec3, target: vec3, targetVelocity: vec3, t: SteeringTuning, up: vec3,
): vec3 {
    vec3.subtract(_tmp, from, target);
    planar(_tmp, _tmp, up);
    const distance = vec3.length(_tmp);
    // Already inside the ring: back off rather than push through the leader.
    if (distance < t.standoff * 0.5) return flee(out, from, target, t.maxSpeed * 0.5, up);
    // A point on the standoff ring, on the follower's own side of the target.
    withLength(_tmp, _tmp, t.standoff);
    vec3.add(_tmp, target, _tmp);
    // Lead the ring point by the target's own motion, so a moving leader is not chased from behind.
    vec3.scaleAndAdd(_tmp, _tmp, targetVelocity, 0.3);
    return arrive(out, from, _tmp, t, up);
}

/**
 * Aimless drift: a point on a circle ahead of the agent, drifting around it over time.
 *
 * Deterministic per `state.seed`, driven by `noise1` from core/math rather than `Math.random()`. Two
 * reasons, and both matter: a crowd sharing one random stream wanders in visible unison, and a test
 * cannot assert anything about a behaviour it cannot reproduce.
 */
export function wander(
    out: vec3, forward: vec3, state: SteeringState, t: SteeringTuning, dt: number, up: vec3,
): vec3 {
    state.wanderTime += Number.isFinite(dt) && dt > 0 ? dt : 0;
    // Two octaves of the same stream at different rates, so the path curves rather than zig-zagging.
    const angle = noise1(state.wanderTime * (t.wanderJitter / 360), state.seed) * Math.PI;

    planar(_tmp, forward, up);
    if (vec3.length(_tmp) <= 1e-9) vec3.set(_tmp, 0, 0, 1);
    withLength(_tmp, _tmp, 1);

    // Right = forward x up, matching the handedness the rest of the control layer uses.
    const right = vec3.cross(vec3.create(), _tmp, up);
    withLength(right, right, 1);

    // Centre of the circle, then a point on it.
    vec3.scale(out, _tmp, t.wanderDistance);
    vec3.scaleAndAdd(out, out, _tmp, Math.cos(angle) * t.wanderRadius);
    vec3.scaleAndAdd(out, out, right, Math.sin(angle) * t.wanderRadius);
    return withLength(out, out, t.maxSpeed);
}

/**
 * Push away from crowding neighbours, weighted by how close each one is.
 *
 * Inverse-distance weighting rather than a flat push: a neighbour at the very edge of the radius should
 * barely register, or a loose crowd jitters permanently.
 */
export function separate(
    out: vec3, from: vec3, neighbours: readonly vec3[], radius: number, maxSpeed: number, up: vec3,
): vec3 {
    vec3.set(out, 0, 0, 0);
    if (radius <= 1e-6) return out;
    let count = 0;
    for (const other of neighbours) {
        vec3.subtract(_tmp, from, other);
        planar(_tmp, _tmp, up);
        const distance = vec3.length(_tmp);
        if (distance <= 1e-6 || distance > radius) continue;
        // Weight 1 at touching, 0 at the radius.
        withLength(_tmp, _tmp, 1 - distance / radius);
        vec3.add(out, out, _tmp);
        count++;
    }
    if (count === 0) return vec3.set(out, 0, 0, 0);
    return withLength(out, out, maxSpeed);
}

/**
 * One whisker, as the CALLER measured it. The physics query stays outside this module — see the header.
 * `distance` is how far along `direction` the hit was; a negative distance means that whisker is clear.
 */
export interface ProbeHit {
    direction: readonly [number, number, number];
    distance: number;
    normal: readonly [number, number, number];
}

/**
 * Deflect a desired velocity around whatever the whiskers found.
 *
 * DEFLECTS rather than reverses: pushing along the surface normal steers past a wall, while braking or
 * turning back produces an agent that paces in front of every obstacle it meets. A clear fan returns
 * `desired` untouched, so avoidance costs nothing when nothing is in the way.
 */
export function avoidObstacles(
    out: vec3, desired: vec3, probes: readonly ProbeHit[], t: SteeringTuning, up: vec3,
): vec3 {
    vec3.copy(out, desired);
    if (t.avoidDistance <= 0 || probes.length === 0) return out;

    const speed = vec3.length(desired);
    if (speed <= 1e-9) return out;

    for (const probe of probes) {
        if (!(probe.distance >= 0) || probe.distance > t.avoidDistance) continue;
        // Nearer hits push harder, and one at the very edge of the range barely nudges.
        const urgency = 1 - probe.distance / t.avoidDistance;
        vec3.set(_tmp, probe.normal[0], probe.normal[1], probe.normal[2]);
        planar(_tmp, _tmp, up);
        if (vec3.length(_tmp) <= 1e-9) continue;
        withLength(_tmp, _tmp, speed * t.avoidStrength * urgency);
        vec3.add(out, out, _tmp);
    }
    planar(out, out, up);
    // Never faster than what was asked for: avoidance changes direction, not pace.
    return vec3.length(out) > speed ? withLength(out, out, speed) : out;
}

/** Weighted sum of several steers, clamped to `maxSpeed`. */
export function blendSteering(
    out: vec3, parts: readonly { force: vec3; weight: number }[], maxSpeed: number,
): vec3 {
    vec3.set(out, 0, 0, 0);
    for (const part of parts) {
        if (!Number.isFinite(part.weight) || part.weight === 0) continue;
        vec3.scaleAndAdd(out, out, part.force, part.weight);
    }
    return vec3.length(out) > maxSpeed ? withLength(out, out, maxSpeed) : out;
}

/**
 * The bridge back to the contract: a world desired velocity becomes an intent a Character can consume.
 *
 * World-space, so `basisYaw` stays 0 — every steering behaviour thinks in world terms, and only a
 * camera-relative source has a basis to name. `speedScale` carries the throttle, which is what lets an
 * `arrive` ease off without touching the character's authored walk and run speeds.
 */
export function intentFromDesired(
    out: ControlIntent, desired: vec3, maxSpeed: number, up: vec3,
): ControlIntent {
    planar(_tmp, desired, up);
    const speed = vec3.length(_tmp);
    if (speed <= 1e-9) {
        setMoveWorld(out, 0, 0);
        out.speedScale = 0;
        return out;
    }
    withLength(_tmp, _tmp, 1);
    setMoveWorld(out, _tmp[0], _tmp[2]);
    out.speedScale = maxSpeed > 1e-6 ? Math.min(1, speed / maxSpeed) : 1;
    // Face where you are going. A steering agent has no camera to aim with, and a body that walked
    // sideways forever would defeat the strafe blend space the animation is built on.
    out.aimYaw = Math.atan2(_tmp[0], _tmp[2]) * 180 / Math.PI;
    return out;
}
