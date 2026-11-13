import { moveToward } from '../core/math';

// A side-scroller's movement, as a pure step: run with acceleration and air control, a jump whose height
// follows how long the button is held, coyote time and a jump buffer, and the three abilities a
// metroidvania gates its world with -- a double jump, a dash, and a wall slide with a wall jump. It reads
// what the body touched last step and an intent (from the input, or from a script), and returns the
// velocity to move by; the body (CharacterBody2DNode) does the moving.
//
// Tuned in what a designer thinks in: how high a jump goes and how long it takes to get there, rather than
// a gravity and a launch speed.

export interface PlatformerSettings {
    /** Top running speed, units per second. */
    runSpeed: number;
    /** How fast the body gets up to speed on the ground, and slows to a stop, units per second squared. */
    acceleration: number;
    deceleration: number;
    /** The same in the air: usually less, so a jump commits. */
    airAcceleration: number;
    /** The apex of a full jump, units above the take-off. */
    jumpHeight: number;
    /** Seconds to that apex. Gravity and the launch speed follow from the two. */
    jumpTimeToApex: number;
    /** Gravity's multiplier on the way down: above 1 falls faster than it rose, which reads as weight. */
    fallGravityMultiplier: number;
    /** Letting go of jump while still rising keeps this share of the speed: a tap is a hop. */
    jumpCutMultiplier: number;
    /** The fastest fall, units per second. */
    maxFallSpeed: number;
    /** Seconds after walking off a ledge a jump still counts as from the ground. */
    coyoteTime: number;
    /** Seconds before landing a jump press is remembered for. */
    jumpBuffer: number;
    /** Jumps in the air before landing again, with the double jump. */
    airJumps: number;
    /** The double jump's height, as a share of the full jump's. */
    airJumpHeightMultiplier: number;
    /** The dash: its speed, how long it lasts, how long before the next. */
    dashSpeed: number;
    dashTime: number;
    dashCooldown: number;
    /** Dashes in the air before landing again. */
    airDashes: number;
    /** The fastest a body slides down a wall it presses into. */
    wallSlideSpeed: number;
    /** A wall jump's push away from the wall and up, units per second. */
    wallJumpSpeed: [number, number];
    /** Seconds after a wall jump the stick cannot steer back into the wall (it still can after). */
    wallJumpLock: number;
}

export const DEFAULT_PLATFORMER: Readonly<PlatformerSettings> = {
    runSpeed: 8,
    acceleration: 80,
    deceleration: 100,
    airAcceleration: 55,
    jumpHeight: 3.4,
    jumpTimeToApex: 0.36,
    fallGravityMultiplier: 1.7,
    jumpCutMultiplier: 0.45,
    maxFallSpeed: 24,
    coyoteTime: 0.1,
    jumpBuffer: 0.12,
    airJumps: 1,
    airJumpHeightMultiplier: 0.85,
    dashSpeed: 22,
    dashTime: 0.15,
    dashCooldown: 0.35,
    airDashes: 1,
    wallSlideSpeed: 3,
    wallJumpSpeed: [9, 12],
    wallJumpLock: 0.16,
};

/** Which movement abilities the body has: what a metroidvania hands out over the game. */
export interface PlatformerAbilities {
    doubleJump: boolean;
    dash: boolean;
    wallJump: boolean;
}

/** What the body wants to do this step: from the input, or from a script driving it. */
export interface PlatformerIntent {
    /** -1..1: left to right. */
    moveX: number;
    /** -1..1: down to up. Down with jump drops through a one-way platform. */
    moveY: number;
    /** Jump was pressed this step (an edge, consumed once). */
    jumpPressed: boolean;
    /** Jump is held: releasing it early cuts the jump short. */
    jumpHeld: boolean;
    /** Dash was pressed this step (an edge, consumed once). */
    dashPressed: boolean;
}

/** What the body touched at the end of the last step. */
export interface PlatformerContacts {
    grounded: boolean;
    wallLeft: boolean;
    wallRight: boolean;
    ceiling: boolean;
}

/** The controller's memory between steps. */
export interface PlatformerState {
    vx: number;
    vy: number;
    /** -1 facing left, 1 facing right. */
    facing: number;
    /** Seconds of coyote time left, jump buffer left. */
    coyote: number;
    buffer: number;
    airJumpsLeft: number;
    airDashesLeft: number;
    /** Seconds of the current dash left (0: not dashing), and its direction. */
    dashLeft: number;
    dashDir: number;
    dashCooldownLeft: number;
    /** Seconds the wall-jump steering lock has left, and which wall it pushed off (-1 left, 1 right). */
    wallLockLeft: number;
    wallLockDir: number;
    /** Rising from a jump the button still holds up (so a release can cut it). */
    jumpRising: boolean;
    /** Seconds left of dropping through one-way platforms. */
    dropLeft: number;
    wasGrounded: boolean;
    wallSliding: boolean;
    /**
     * The vertical speed before this step's gravity: the body moves by the average of it and `vy`, which is
     * exact under constant gravity, so a jump peaks at its height whatever the step.
     */
    vyStart: number;
}

export function createPlatformerState(): PlatformerState {
    return {
        vx: 0, vy: 0, facing: 1, coyote: 0, buffer: 0, airJumpsLeft: 0, airDashesLeft: 0, dashLeft: 0, dashDir: 1,
        dashCooldownLeft: 0, wallLockLeft: 0, wallLockDir: 0, jumpRising: false, dropLeft: 0, wasGrounded: false,
        wallSliding: false, vyStart: 0,
    };
}

/** What happened in a step, for sounds, effects and the animation. */
export interface PlatformerEvents {
    jumped: boolean;
    airJumped: boolean;
    wallJumped: boolean;
    dashed: boolean;
    landed: boolean;
    droppedThrough: boolean;
}

export function createPlatformerEvents(): PlatformerEvents {
    return { jumped: false, airJumped: false, wallJumped: false, dashed: false, landed: false, droppedThrough: false };
}

/** Gravity (units/s^2, positive down) and the launch speed of a full jump, from height and time to apex. */
export function jumpPhysics(s: Pick<PlatformerSettings, 'jumpHeight' | 'jumpTimeToApex'>): { gravity: number, jumpSpeed: number } {
    const t = Math.max(1e-3, s.jumpTimeToApex), h = Math.max(1e-3, s.jumpHeight);
    return { gravity: 2 * h / (t * t), jumpSpeed: 2 * h / t };
}

/**
 * One step of `dt` seconds: the velocity the body should move by now, written into `state.vx`/`vy`, and
 * what happened, into `events`. `contacts` is what the last move touched.
 */
export function stepPlatformer(state: PlatformerState, intent: PlatformerIntent, contacts: PlatformerContacts,
                               s: PlatformerSettings, abilities: PlatformerAbilities, dt: number,
                               events: PlatformerEvents): void {
    events.jumped = events.airJumped = events.wallJumped = events.dashed = events.landed = events.droppedThrough = false;
    const { gravity, jumpSpeed } = jumpPhysics(s);
    const grounded = contacts.grounded;

    // Landing refills everything the air spends.
    if (grounded) {
        if (!state.wasGrounded) events.landed = true;
        state.coyote = s.coyoteTime;
        state.airJumpsLeft = abilities.doubleJump ? Math.max(0, Math.floor(s.airJumps)) : 0;
        state.airDashesLeft = Math.max(0, Math.floor(s.airDashes));
        state.jumpRising = false;
    } else {
        state.coyote = Math.max(0, state.coyote - dt);
    }
    state.wasGrounded = grounded;
    state.dashCooldownLeft = Math.max(0, state.dashCooldownLeft - dt);
    state.wallLockLeft = Math.max(0, state.wallLockLeft - dt);
    state.dropLeft = Math.max(0, state.dropLeft - dt);

    if (intent.jumpPressed) state.buffer = s.jumpBuffer;
    else state.buffer = Math.max(0, state.buffer - dt);

    const moveX = Math.max(-1, Math.min(1, intent.moveX || 0));
    if (moveX > 0.2) state.facing = 1;
    else if (moveX < -0.2) state.facing = -1;

    // --- the dash: a straight burst, gravity off, that ends early on a wall ---------------------------
    if (intent.dashPressed && abilities.dash && state.dashLeft <= 0 && state.dashCooldownLeft <= 0
        && (grounded || state.airDashesLeft > 0)) {
        if (!grounded) state.airDashesLeft--;
        state.dashLeft = s.dashTime;
        state.dashDir = moveX > 0.2 ? 1 : moveX < -0.2 ? -1 : state.facing;
        state.facing = state.dashDir;
        state.dashCooldownLeft = s.dashCooldown;
        state.jumpRising = false;
        events.dashed = true;
    }
    if (state.dashLeft > 0) {
        state.dashLeft = Math.max(0, state.dashLeft - dt);
        const blocked = state.dashDir > 0 ? contacts.wallRight : contacts.wallLeft;
        if (blocked) state.dashLeft = 0;
        state.vx = state.dashLeft > 0 ? state.dashDir * s.dashSpeed : state.dashDir * s.runSpeed;
        state.vy = 0;
        state.vyStart = 0;
        state.wallSliding = false;
        return;
    }

    // --- running ---------------------------------------------------------------------------------------
    let steer = moveX;
    // Just after a wall jump, steering back into that wall is ignored: the push away has to land first.
    if (state.wallLockLeft > 0 && Math.sign(steer) === state.wallLockDir) steer = 0;
    const target = steer * s.runSpeed;
    const accel = grounded ? (Math.abs(target) > Math.abs(state.vx) || Math.sign(target) !== Math.sign(state.vx) ? s.acceleration : s.deceleration)
        : s.airAcceleration;
    state.vx = moveToward(state.vx, target, accel * dt);
    if (state.vx > 0 && contacts.wallRight) state.vx = 0;
    if (state.vx < 0 && contacts.wallLeft) state.vx = 0;

    // --- the wall slide: pressing into a wall while falling ----------------------------------------------
    const pressing = (moveX > 0.2 && contacts.wallRight) ? 1 : (moveX < -0.2 && contacts.wallLeft) ? -1 : 0;
    state.wallSliding = abilities.wallJump && !grounded && pressing !== 0 && state.vy <= 0;

    // --- jumps -------------------------------------------------------------------------------------------
    const wantJump = state.buffer > 0;
    if (wantJump) {
        if (grounded && intent.moveY < -0.5) {
            // Down + jump: drop through the one-way platform underfoot rather than jump.
            state.dropLeft = 0.25;
            state.buffer = 0;
            events.droppedThrough = true;
        } else if (grounded || state.coyote > 0) {
            state.vy = jumpSpeed;
            state.coyote = 0;
            state.buffer = 0;
            state.jumpRising = true;
            events.jumped = true;
        } else if (abilities.wallJump && (contacts.wallLeft || contacts.wallRight)) {
            const away = contacts.wallLeft ? 1 : -1;
            state.vx = away * s.wallJumpSpeed[0];
            state.vy = s.wallJumpSpeed[1];
            state.facing = away;
            state.wallLockLeft = s.wallJumpLock;
            state.wallLockDir = -away;
            state.buffer = 0;
            state.jumpRising = true;
            state.wallSliding = false;
            events.wallJumped = true;
        } else if (state.airJumpsLeft > 0) {
            state.airJumpsLeft--;
            state.vy = jumpSpeed * Math.sqrt(Math.max(0, s.airJumpHeightMultiplier));
            state.buffer = 0;
            state.jumpRising = true;
            events.airJumped = true;
        }
    }

    // Letting go while rising cuts the jump: the height follows how long it is held.
    if (state.jumpRising && !intent.jumpHeld && state.vy > 0) {
        state.vy *= s.jumpCutMultiplier;
        state.jumpRising = false;
    }
    if (state.vy <= 0) state.jumpRising = false;
    if (contacts.ceiling && state.vy > 0) { state.vy = 0; state.jumpRising = false; }

    // --- gravity -----------------------------------------------------------------------------------------
    state.vyStart = state.vy;
    if (!grounded || state.vy > 0) {
        const g = state.vy > 0 ? gravity : gravity * s.fallGravityMultiplier;
        state.vy -= g * dt;
        const floor = state.wallSliding ? -s.wallSlideSpeed : -s.maxFallSpeed;
        if (state.vy < floor) state.vy = floor;
    } else if (state.vy < 0) state.vy = 0;
}
