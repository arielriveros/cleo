import { moveToward, moveToward2D } from '../core/math';
import type { ControlIntent } from '../core/control/intent';

// A 2D body's GENERIC movement, as pure steps: walking (run while sprinting) with acceleration and air
// control, a jump with coyote time, dropping through a one-way platform, gravity that falls faster than it
// rises -- or flying, on both axes with no gravity. The 2D twin of control/locomotion.ts.
//
// What it deliberately does not do is a genre's moves: a dash, a double jump, a wall jump, a jump cut, a
// knock-back. Those are the game's, written in its scripts with the body's per-substep hook
// (`onMove2D`), the way the 3D examples write a roll or a lunge over the engine's walking.
//
// Tuned the way a designer thinks: how high a jump goes and how long it takes to get there, rather than a
// gravity and a launch speed (`jumpPhysics` derives both).

export const BODY2D_MOVEMENTS = ['walk', 'fly'] as const;
export type Body2DMovement = typeof BODY2D_MOVEMENTS[number];

export interface Locomotion2DTuning {
    movement: Body2DMovement;
    /** Speed with the move stick fully over; `runSpeed` while the intent sprints. Units per second. */
    walkSpeed: number;
    runSpeed: number;
    /** Getting up to speed, and slowing to a stop, units per second squared. */
    acceleration: number;
    deceleration: number;
    /** The share of `acceleration` steering has in the air, 0..1: low commits a jump. */
    airControl: number;
    /** The apex of a jump, units above the take-off, and the seconds to reach it. */
    jumpHeight: number;
    jumpTimeToApex: number;
    /** Gravity's multiplier on the way down: above 1 falls faster than it rose, which reads as weight. */
    fallGravityMultiplier: number;
    /** The fastest fall, units per second. */
    maxFallSpeed: number;
    /** Seconds after walking off a ledge a jump still counts as from the ground. */
    coyoteSeconds: number;
    /** A multiplier on gravity, which scripts change at run time (0 while dashing). */
    gravityScale: number;
}

export const LOCOMOTION_2D_DEFAULTS: Readonly<Locomotion2DTuning> = {
    movement: 'walk',
    walkSpeed: 8,
    runSpeed: 12,
    acceleration: 80,
    deceleration: 100,
    airControl: 0.7,
    jumpHeight: 3.4,
    jumpTimeToApex: 0.36,
    fallGravityMultiplier: 1.7,
    maxFallSpeed: 24,
    coyoteSeconds: 0.1,
    gravityScale: 1,
};

/** Gravity (units/s^2, positive down) and the launch speed of a jump, from its height and time to apex. */
export function jumpPhysics(s: Pick<Locomotion2DTuning, 'jumpHeight' | 'jumpTimeToApex'>): { gravity: number, jumpSpeed: number } {
    const t = Math.max(1e-3, s.jumpTimeToApex), h = Math.max(1e-3, s.jumpHeight);
    return { gravity: 2 * h / (t * t), jumpSpeed: 2 * h / t };
}

/** What the body touched at the end of the last substep. */
export interface Contacts2D {
    grounded: boolean;
    wallLeft: boolean;
    wallRight: boolean;
    ceiling: boolean;
    onSlope: boolean;
}

export function createContacts2D(): Contacts2D {
    return { grounded: false, wallLeft: false, wallRight: false, ceiling: false, onSlope: false };
}

/** The body's movement memory between substeps. */
export interface Locomotion2DState {
    /** Seconds of coyote time left. */
    coyote: number;
    /** Seconds left of passing through one-way platforms (a drop-through). */
    dropLeft: number;
    wasGrounded: boolean;
    /** From a jump's take-off until the feet are back down. */
    jumping: boolean;
    /** -1 facing left, 1 facing right. */
    facing: number;
    /**
     * The vertical speed before this substep's gravity: the body moves by the average of it and the speed
     * after, which is exact under constant gravity, so a jump peaks at its height whatever the step.
     */
    vyStart: number;
    /** Seconds continuously in the air, and on the ground. */
    airTime: number;
    groundedTime: number;
}

export function createLocomotion2DState(): Locomotion2DState {
    return { coyote: 0, dropLeft: 0, wasGrounded: false, jumping: false, facing: 1, vyStart: 0, airTime: 0, groundedTime: 0 };
}

/** What happened in a step, for sounds, effects and the animation. */
export interface Locomotion2DEvents {
    jumped: boolean;
    landed: boolean;
    droppedThrough: boolean;
}

export function createLocomotion2DEvents(): Locomotion2DEvents {
    return { jumped: false, landed: false, droppedThrough: false };
}

/** A tolerant reader: every field finite and in range, missing ones from the defaults. */
export function locomotion2DTuning(src: Partial<Record<keyof Locomotion2DTuning, unknown>>,
                                   out: Locomotion2DTuning = { ...LOCOMOTION_2D_DEFAULTS }): Locomotion2DTuning {
    const d = LOCOMOTION_2D_DEFAULTS;
    const num = (v: unknown, fallback: number, min = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(min, v) : fallback);
    out.movement = src.movement === 'fly' ? 'fly' : 'walk';
    out.walkSpeed = num(src.walkSpeed, d.walkSpeed);
    out.runSpeed = num(src.runSpeed, d.runSpeed);
    out.acceleration = num(src.acceleration, d.acceleration);
    out.deceleration = num(src.deceleration, d.deceleration);
    out.airControl = Math.min(1, num(src.airControl, d.airControl));
    out.jumpHeight = num(src.jumpHeight, d.jumpHeight, 1e-3);
    out.jumpTimeToApex = num(src.jumpTimeToApex, d.jumpTimeToApex, 1e-3);
    out.fallGravityMultiplier = num(src.fallGravityMultiplier, d.fallGravityMultiplier);
    out.maxFallSpeed = num(src.maxFallSpeed, d.maxFallSpeed);
    out.coyoteSeconds = num(src.coyoteSeconds, d.coyoteSeconds);
    out.gravityScale = num(src.gravityScale, d.gravityScale);
    return out;
}

/**
 * The bookkeeping every substep gets, whoever moves the body: landing, coyote time, the drop-through
 * window, air and ground time. Before the hook, so a script reads this substep's `canJump`.
 */
export function tickLocomotion2D(state: Locomotion2DState, contacts: Readonly<Contacts2D>, velocity: Readonly<[number, number]>,
                                 tuning: Readonly<Locomotion2DTuning>, dt: number, events: Locomotion2DEvents): void {
    if (contacts.grounded) {
        if (!state.wasGrounded) events.landed = true;
        state.coyote = tuning.coyoteSeconds;
        if (velocity[1] <= 0) state.jumping = false;
        state.groundedTime += dt;
        state.airTime = 0;
    } else {
        state.coyote = Math.max(0, state.coyote - dt);
        state.airTime += dt;
        state.groundedTime = 0;
    }
    state.wasGrounded = contacts.grounded;
    state.dropLeft = Math.max(0, state.dropLeft - dt);
}

/**
 * Steer toward what the intent asks and take a pending jump, writing `velocity`. Skipped on a substep a
 * script's hook owns. Returns whether it used the jump request (the caller consumes it).
 *
 * The 2D intent is in WORLD axes: `move[0]` is +x right, `move[1]` +y up (a flier climbs, a walker presses
 * down to drop through). `speedScale` throttles the speed; `sprint` picks the run speed.
 */
export function stepLocomotion2D(state: Locomotion2DState, intent: Readonly<ControlIntent>, contacts: Readonly<Contacts2D>,
                                 tuning: Readonly<Locomotion2DTuning>, dt: number, velocity: [number, number],
                                 events: Locomotion2DEvents): boolean {
    const mx = clamp1(intent.move[0]), my = clamp1(intent.move[1]);
    const scale = Number.isFinite(intent.speedScale) ? Math.max(0, intent.speedScale) : 1;
    const speed = (intent.sprint ? tuning.runSpeed : tuning.walkSpeed) * scale;

    if (tuning.movement === 'fly') {
        moveToward2D(velocity, mx * speed, my * speed, tuning.acceleration * dt);
        if (Math.abs(mx) > 0.2) state.facing = mx > 0 ? 1 : -1;
        return false;
    }

    // --- walking -----------------------------------------------------------------------------------
    const target = mx * speed;
    const vx = velocity[0];
    const speeding = Math.abs(target) > Math.abs(vx) || Math.sign(target) !== Math.sign(vx);
    const accel = contacts.grounded ? (speeding ? tuning.acceleration : tuning.deceleration)
        : tuning.acceleration * tuning.airControl;
    velocity[0] = moveToward(vx, target, accel * dt);
    if (velocity[0] > 0 && contacts.wallRight) velocity[0] = 0;
    if (velocity[0] < 0 && contacts.wallLeft) velocity[0] = 0;
    if (mx > 0.2) state.facing = 1;
    else if (mx < -0.2) state.facing = -1;

    // --- the jump ----------------------------------------------------------------------------------
    let used = false;
    if (intent.requests.jump > 0) {
        if (contacts.grounded && my < -0.5) {
            // Down + jump: drop through the one-way platform underfoot rather than jump.
            state.dropLeft = 0.25;
            events.droppedThrough = true;
            used = true;
        } else if (contacts.grounded || state.coyote > 0) {
            velocity[1] = jumpPhysics(tuning).jumpSpeed;
            state.coyote = 0;
            state.jumping = true;
            events.jumped = true;
            used = true;
        }
    }
    if (contacts.ceiling && velocity[1] > 0) velocity[1] = 0;
    return used;
}

/**
 * This substep's gravity, after whoever steered: writes the pre-gravity speed into `state.vyStart` and
 * integrates. A flier has none; `gravityScale` 0 (a dash) holds the height.
 */
export function integrateGravity2D(state: Locomotion2DState, contacts: Readonly<Contacts2D>,
                                   tuning: Readonly<Locomotion2DTuning>, dt: number, velocity: [number, number]): void {
    state.vyStart = velocity[1];
    if (tuning.movement === 'fly') return;
    const g = jumpPhysics(tuning).gravity * tuning.gravityScale;
    if (!contacts.grounded || velocity[1] > 0) {
        if (g > 0) velocity[1] -= (velocity[1] > 0 ? g : g * tuning.fallGravityMultiplier) * dt;
        if (velocity[1] < -tuning.maxFallSpeed) velocity[1] = -tuning.maxFallSpeed;
    } else if (velocity[1] < 0) velocity[1] = 0;
}

function clamp1(v: number): number {
    return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
