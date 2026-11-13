/**
 * Following a 2D platform path: the walk to a take-off, the jump, the drop off a ledge, the drop through
 * a one-way platform, the flight -- as a steering answer per frame. The 2D twin of navPath.followPath,
 * and the ONE place that decides how a path leg is flown: the controller calls it every frame, and the
 * 2D bake (navGraph2D.ts) flies every candidate jump and drop with it, through the same body step the game
 * uses (physics2d/body2d.ts), so an edge the bake keeps is an edge the agent can take.
 *
 * A LEAF: gl-matrix, the 2D physics' pure step and the intent helpers. No Node, no scene.
 */

import { vec3 } from "gl-matrix";
import { createIntent, decayRequests, raiseRequest } from "../core/control/intent";
import { intentFromDesired2D } from "../core/control/steering";
import { AXIS_Y, AXIS_Z } from "../core/control/control2D";
import { createMoveResult } from "../physics2d/collide2d";
import { stepBody2D } from "../physics2d/body2d";
import type { Body2DSim } from "../physics2d/body2d";
import {
    LOCOMOTION_2D_DEFAULTS, createContacts2D, createLocomotion2DEvents, createLocomotion2DState, jumpPhysics,
} from "../physics2d/locomotion2d";
import type { Body2DMovement, Locomotion2DTuning } from "../physics2d/locomotion2d";
import type { CollisionWorld2D } from "../physics2d/types";
import type { NavAction, NavPath } from "./navPath";

/** The agent a 2D path is planned and flown for: its box and how it moves. */
export interface NavAgent2D {
    movement: Body2DMovement;
    /** The box, world units. */
    width: number;
    height: number;
    walkSpeed: number;
    acceleration: number;
    airControl: number;
    jumpHeight: number;
    jumpTimeToApex: number;
    fallGravityMultiplier: number;
    maxFallSpeed: number;
    /** The most it climbs walking, and the furthest it will drop off a ledge. */
    stepHeight: number;
    maxDrop: number;
    /** Whether one-way platforms hold it up (a walker, yes; a flier usually not). */
    oneWayPlatforms: boolean;
}

export const NAV_AGENT_2D_DEFAULTS: Readonly<NavAgent2D> = {
    movement: 'walk', width: 0.8, height: 1.8,
    walkSpeed: LOCOMOTION_2D_DEFAULTS.walkSpeed, acceleration: LOCOMOTION_2D_DEFAULTS.acceleration,
    airControl: LOCOMOTION_2D_DEFAULTS.airControl, jumpHeight: LOCOMOTION_2D_DEFAULTS.jumpHeight,
    jumpTimeToApex: LOCOMOTION_2D_DEFAULTS.jumpTimeToApex, fallGravityMultiplier: LOCOMOTION_2D_DEFAULTS.fallGravityMultiplier,
    maxFallSpeed: LOCOMOTION_2D_DEFAULTS.maxFallSpeed, stepHeight: 0.5, maxDrop: 12, oneWayPlatforms: true,
};

/** A tolerant reader for a stored agent profile. */
export function navAgent2D(src: Partial<Record<keyof NavAgent2D, unknown>> | null | undefined): NavAgent2D {
    const d = NAV_AGENT_2D_DEFAULTS;
    const s = src ?? {};
    const num = (v: unknown, fallback: number, min = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback);
    return {
        movement: s.movement === 'fly' ? 'fly' : 'walk',
        width: num(s.width, d.width, 0.05), height: num(s.height, d.height, 0.05),
        walkSpeed: num(s.walkSpeed, d.walkSpeed, 0.01), acceleration: num(s.acceleration, d.acceleration, 0.01),
        airControl: Math.min(1, num(s.airControl, d.airControl)), jumpHeight: num(s.jumpHeight, d.jumpHeight, 0.01),
        jumpTimeToApex: num(s.jumpTimeToApex, d.jumpTimeToApex, 0.01),
        fallGravityMultiplier: num(s.fallGravityMultiplier, d.fallGravityMultiplier, 0.01),
        maxFallSpeed: num(s.maxFallSpeed, d.maxFallSpeed, 0.01), stepHeight: num(s.stepHeight, d.stepHeight),
        maxDrop: num(s.maxDrop, d.maxDrop), oneWayPlatforms: s.oneWayPlatforms !== false,
    };
}

/** The locomotion tuning a body with this profile moves by. */
export function agentTuning(agent: NavAgent2D): Locomotion2DTuning {
    return {
        ...LOCOMOTION_2D_DEFAULTS, movement: agent.movement, walkSpeed: agent.walkSpeed, runSpeed: agent.walkSpeed,
        acceleration: agent.acceleration, deceleration: agent.acceleration * 1.25, airControl: agent.airControl,
        jumpHeight: agent.jumpHeight, jumpTimeToApex: agent.jumpTimeToApex,
        fallGravityMultiplier: agent.fallGravityMultiplier, maxFallSpeed: agent.maxFallSpeed,
    };
}

/** The follower's memory of the leg it is on. Caller-owned, one per agent. */
export interface Follow2DState {
    /** The waypoint whose leg this is; a change resets the rest. */
    leg: number;
    /** It has pressed jump (or dropped) for this leg, and has been off the ground since. */
    launched: boolean;
    airborne: boolean;
    /** Seconds on this leg. */
    time: number;
}

export function createFollow2DState(): Follow2DState {
    return { leg: -1, launched: false, airborne: false, time: 0 };
}

/** What to do this frame. `desired` is a velocity in XY (a walker's y is 0). */
export interface Follow2DOut {
    desired: [number, number];
    /** Press jump now. */
    jump: boolean;
    /** Hold down (with a jump: drop through a one-way platform). */
    down: boolean;
    /** The leg went wrong (a missed landing, a fall, too long): plan again. */
    repath: boolean;
    /** The last waypoint is reached. */
    done: boolean;
}

export function createFollow2DOut(): Follow2DOut {
    return { desired: [0, 0], jump: false, down: false, repath: false, done: false };
}

/** Within this, horizontally, of a take-off point it jumps; of a landing point, the landing counts. */
const TAKEOFF_REACH = 0.3;
const LANDING_REACH = 0.75;

/**
 * One frame of following `path` from the feet (x, y) -- a flier's middle -- with the body's ground contact
 * and horizontal speed `vx`. `radius` is how close a walk waypoint has to be to count as reached.
 */
export function followPath2D(path: NavPath, x: number, y: number, grounded: boolean, vx: number, agent: NavAgent2D,
                             radius: number, state: Follow2DState, dt: number, out: Follow2DOut): Follow2DOut {
    out.desired[0] = 0; out.desired[1] = 0;
    out.jump = false; out.down = false; out.repath = false; out.done = false;
    for (let guard = 0; guard < 3; guard++) {
        const i = path.index;
        if (i >= path.points.length) { out.done = true; return out; }
        if (state.leg !== i) { state.leg = i; state.launched = false; state.airborne = false; state.time = 0; }
        state.time += guard === 0 ? dt : 0;
        const target = path.points[i];
        const action: NavAction = path.actions[i] ?? 'walk';
        const throttle = path.throttles[i] ?? 1;
        const last = i === path.points.length - 1;
        const dx = target[0] - x, dy = target[1] - y;
        const speed = agent.walkSpeed * Math.max(0.05, throttle);

        if (action === 'fly' || agent.movement === 'fly') {
            const d = Math.hypot(dx, dy);
            if (d <= radius) {
                if (last) { out.done = true; return out; }
                path.index++;
                continue;
            }
            const k = (last ? Math.min(1, d / Math.max(radius * 3, 1)) : 1) * speed / Math.max(d, 1e-9);
            out.desired[0] = dx * k; out.desired[1] = dy * k;
            return out;
        }

        // A leg taking far longer than it should is lost: plan again rather than push at it forever.
        if (state.time > Math.abs(dx) / Math.max(speed, 0.1) + 2.5) { out.repath = true; return out; }

        if (action === 'walk') {
            if (Math.abs(dx) <= radius && Math.abs(dy) < 1 && grounded) {
                if (last) { out.done = true; return out; }
                path.index++;
                continue;
            }
            // Ease into the last point, rather than overshoot it and turn back.
            const scale = last ? Math.min(1, Math.abs(dx) / 1) : 1;
            out.desired[0] = Math.sign(dx) * speed * Math.max(scale, 0.15);
            return out;
        }

        // A jump, a drop or a drop-through: the take-off is the waypoint before.
        const from = i > 0 ? path.points[i - 1] : null;
        if (!state.launched) {
            if (!grounded) { out.repath = true; return out; }
            if (action === 'jump' && from) {
                // Leave from the take-off at a run toward the landing: a standing jump falls short of the
                // arc the bake flew. Up to it first; then on through it until up to speed, or a little past.
                const dir = Math.sign(dx) || 1;
                const ahead = (x - from[0]) * dir;
                if (ahead < -TAKEOFF_REACH) {
                    const ddx = from[0] - x;
                    out.desired[0] = Math.sign(ddx) * speed * Math.min(1, Math.max(0.2, Math.abs(ddx) / 0.6));
                    return out;
                }
                if (vx * dir < 0.6 * speed && ahead < TAKEOFF_REACH && Math.abs(dx) > 0.5) {
                    out.desired[0] = dir * speed;
                    return out;
                }
            } else if (action === 'dropThrough' && from && Math.abs(from[0] - x) > TAKEOFF_REACH) {
                const ddx = from[0] - x;
                out.desired[0] = Math.sign(ddx) * speed * Math.min(1, Math.max(0.2, Math.abs(ddx) / 0.6));
                return out;
            }
            state.launched = true;
            if (action === 'jump') out.jump = true;
            if (action === 'dropThrough') { out.jump = true; out.down = true; out.desired[0] = 0; return out; }
        }
        if (!grounded) state.airborne = true;
        if (state.airborne && grounded) {
            // Down again: on the landing's surface (walk the rest of the way along it), or somewhere else.
            if (Math.abs(dy) < 0.4) {
                if (Math.abs(dx) <= LANDING_REACH) {
                    if (last) { out.done = true; return out; }
                    path.index++;
                    continue;
                }
                path.actions[i] = 'walk';
                state.leg = -1;
                continue;
            }
            out.repath = true;
            return out;
        }
        if (action === 'dropThrough' && !state.airborne) {
            // Still on the platform, the drop under way: hold down until the feet are through.
            out.down = true;
            return out;
        }
        // In the air (or about to leave): steer for the landing, easing in so as not to overshoot it.
        const steer = Math.max(-1, Math.min(1, dx / 0.8));
        out.desired[0] = steer * speed;
        return out;
    }
    return out;
}

/** Where a simulated leg ended. */
export interface LegResult {
    /** It reached the end of the path, standing. */
    ok: boolean;
    x: number;
    y: number;
    /** Seconds it took. */
    seconds: number;
    /** The feet, sampled each frame: the arc an overlay draws. */
    arc?: number[];
}

/**
 * Fly `path` from (x, y) -- standing, moving at `vx` -- with the follower and the body step the game uses,
 * at `fps`, until it reaches the end, goes wrong, falls below `floorY`, or `maxSeconds` pass.
 */
export function simulatePath2D(world: CollisionWorld2D, agent: NavAgent2D, path: NavPath, x: number, y: number,
                               vx: number, opts: { fps?: number, maxSeconds?: number, floorY?: number, radius?: number,
                                   arc?: boolean } = {}): LegResult {
    const fps = opts.fps ?? 60, dt = 1 / fps;
    const maxSeconds = opts.maxSeconds ?? 4;
    const floorY = opts.floorY ?? -Infinity;
    const radius = opts.radius ?? 0.25;
    const tuning = agentTuning(agent);
    const contacts = createContacts2D();
    contacts.grounded = agent.movement === 'walk';
    const state = createLocomotion2DState();
    state.wasGrounded = contacts.grounded;
    const sim: Body2DSim = {
        x, y, halfWidth: agent.width / 2, height: agent.height, velocity: [vx, 0], contacts, state,
        events: createLocomotion2DEvents(), stepHeight: agent.stepHeight, oneWayPlatforms: agent.oneWayPlatforms, groundBox: null,
    };
    const intent = createIntent();
    const follow = createFollow2DState();
    const out = createFollow2DOut();
    const moved = createMoveResult();
    const desired = vec3.create();
    const up = agent.movement === 'fly' ? AXIS_Z : AXIS_Y;
    const arc = opts.arc ? [x, y] : undefined;
    const lift = agent.movement === 'fly' ? agent.height / 2 : 0;
    for (let t = 0; t < maxSeconds; t += dt) {
        followPath2D(path, sim.x, sim.y + lift, sim.contacts.grounded, sim.velocity[0], agent, radius, follow, dt, out);
        if (out.done) return { ok: true, x: sim.x, y: sim.y, seconds: t, arc };
        if (out.repath) return { ok: false, x: sim.x, y: sim.y, seconds: t, arc };
        vec3.set(desired, out.desired[0], out.desired[1], 0);
        intentFromDesired2D(intent, desired, agent.walkSpeed, up);
        if (out.down) intent.move[1] = -1;
        if (out.jump) raiseRequest(intent, 'jump', 0.12);
        stepBody2D(world, sim, intent, tuning, dt, null, moved);
        decayRequests(intent, dt);
        arc?.push(sim.x, sim.y);
        if (sim.y < floorY) return { ok: false, x: sim.x, y: sim.y, seconds: t, arc };
    }
    return { ok: false, x: sim.x, y: sim.y, seconds: maxSeconds, arc };
}

/** The flight time of a jump that lands `dy` above its take-off (negative: below), or Infinity if it cannot. */
export function jumpFlightTime(agent: NavAgent2D, dy: number): number {
    const { gravity } = jumpPhysics(agent);
    if (dy > agent.jumpHeight) return Infinity;
    const down = gravity * agent.fallGravityMultiplier;
    return agent.jumpTimeToApex + Math.sqrt(2 * (agent.jumpHeight - dy) / down);
}
