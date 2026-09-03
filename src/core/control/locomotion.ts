/**
 * `stepLocomotion` — intent in, velocity and facing out. The whole character controller, as one pure
 * function.
 *
 * This is the body of `examples/scripts/ThirdPersonPlayable.ts` moved into the engine. It was ~150 lines
 * of user script documented by ~40 lines of comment and pinned by nothing, duplicated as a string in
 * three generated fixtures. Every sign convention it re-derived at each use is now derived once, here,
 * and asserted in `tests/locomotion.test.ts`.
 *
 * A LEAF: no Node, no physics, no scene, no gl-matrix. Everything the world can say arrives in
 * {@link LocomotionSense} as plain numbers, and everything that must survive to the next frame rides in
 * {@link LocomotionState}, which the caller owns and gets back — the same shape as `resolveFrame` and
 * `stepTouchGestures`. That is what makes a jump-buffer window or a slope projection something a test can
 * drive in three lines instead of something you verify by playing the game.
 *
 * ## The handedness
 *
 * Defined once in `intent.ts` and repeated here only as a reminder: forward at yaw θ is
 * `(sin θ, 0, cos θ)`, and RIGHT is `forward × up` = `(-cos θ, 0, sin θ)` — that is -X at yaw 0, not +X.
 *
 * ## The two angle conventions, which have opposite signs on purpose
 *
 *   * `moveDir` is an ANGLE, counter-clockwise like the engine's yaw: ahead 0, strafe RIGHT **-90**,
 *     strafe LEFT +90, back ±180. It agrees exactly with `Node.planarAngle`, so a blend space can bind to
 *     either without its strafes mirroring.
 *   * `turnRequest` is a CLIP SELECTOR whose contract is +1/+2 right, -1/-2 left.
 *
 * A positive `aim - body` therefore asks for a NEGATIVE `turnRequest`: raising yaw swings forward toward
 * +X, and +X is the character's LEFT. Getting that backwards does not merely play the wrong clip — the
 * turn clip's root motion then drives the body AWAY from the aim, so the release angle is never reached
 * and the machine ping-pongs on one side of centre only.
 *
 * ## Gravity
 *
 * Nothing here assumes +Y. The vertical channel is the component along `sense.up`, so a game with
 * inverted or sideways gravity keeps working — which the script it replaces did not, having hard-coded
 * `moveY = -n[1] * into`.
 */

import { shortestAngle } from "./intent";
import type { ControlIntent } from "./intent";

const RAD2DEG = 180 / Math.PI;

/** How the body decides where to face. */
export const FACING_MODES = ['aim', 'velocity', 'none'] as const;
export type FacingMode = typeof FACING_MODES[number];

export interface LocomotionTuning {
    walkSpeed: number;
    runSpeed: number;
    /** Speed written into the vertical channel on take-off. */
    jumpSpeed: number;
    /** Degrees per second the body swings toward the aim WHILE MOVING. */
    turnSpeed: number;
    /** Degrees the aim may swing off the body before an idle turn-in-place fires. */
    turnThreshold: number;
    /** Degrees at which an in-progress turn-in-place clears. The release half of the hysteresis pair. */
    turnReleaseAngle: number;
    /** Time constant, seconds, smoothing `moveDir` so a blend probe glides between strafes. */
    directionSmoothing: number;
    /** Units/s² the planar speed ramps at. **0 snaps**, reproducing the original script exactly. */
    acceleration: number;
    /** 0..1 of steering authority while airborne. 1 is full control, matching the original script. */
    airControl: number;
    /** Seconds after leaving the ground during which a jump still launches. */
    coyoteSeconds: number;
    /**
     * Seconds after take-off during which the slope projection is suppressed. Without it the projection
     * flattens the jump's vertical velocity on the very frame it was written.
     */
    jumpLockoutSeconds: number;
    facingMode: FacingMode;
}

export const LOCOMOTION_DEFAULTS: LocomotionTuning = {
    walkSpeed: 1.5,
    runSpeed: 4,
    jumpSpeed: 4,
    turnSpeed: 540,
    turnThreshold: 90,
    turnReleaseAngle: 10,
    directionSmoothing: 0.12,
    acceleration: 0,
    airControl: 1,
    coyoteSeconds: 0.12,
    jumpLockoutSeconds: 0.15,
    facingMode: 'aim',
};

function num(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
    return v < min ? min : v > max ? max : v;
}

/** Every field defaulted and clamped, so a partial, stale or junk record passes. Mirrors `motionConfig`. */
export function locomotionTuning(over?: Partial<LocomotionTuning> | null): LocomotionTuning {
    const o = (over ?? {}) as Partial<LocomotionTuning>;
    const d = LOCOMOTION_DEFAULTS;
    const turnThreshold = clamp(num(o.turnThreshold, d.turnThreshold), 1, 180);
    return {
        walkSpeed: Math.max(0, num(o.walkSpeed, d.walkSpeed)),
        runSpeed: Math.max(0, num(o.runSpeed, d.runSpeed)),
        jumpSpeed: Math.max(0, num(o.jumpSpeed, d.jumpSpeed)),
        turnSpeed: Math.max(0, num(o.turnSpeed, d.turnSpeed)),
        turnThreshold,
        // Strictly below the threshold, or a turn releases on the frame it engages and nothing ever turns.
        turnReleaseAngle: clamp(num(o.turnReleaseAngle, d.turnReleaseAngle), 0, turnThreshold - 0.5),
        directionSmoothing: Math.max(0, num(o.directionSmoothing, d.directionSmoothing)),
        acceleration: Math.max(0, num(o.acceleration, d.acceleration)),
        airControl: clamp(num(o.airControl, d.airControl), 0, 1),
        coyoteSeconds: clamp(num(o.coyoteSeconds, d.coyoteSeconds), 0, 1),
        jumpLockoutSeconds: clamp(num(o.jumpLockoutSeconds, d.jumpLockoutSeconds), 0, 2),
        facingMode: (FACING_MODES as readonly string[]).includes(o.facingMode as string)
            ? o.facingMode as FacingMode : d.facingMode,
    };
}

/** Everything the step reads about the world. Plain numbers: no Node, no physics, no scene. */
export interface LocomotionSense {
    dt: number;
    /** The body's world yaw in DEGREES, read from `worldForward` — never from `rotation[1]`, which folds
     *  past a quarter turn. */
    bodyYaw: number;
    velocity: readonly [number, number, number];
    grounded: boolean;
    groundNormal: readonly [number, number, number];
    /** Gravity-reversed up. NOT assumed to be +Y. */
    up: readonly [number, number, number];
}

/** Carried between frames. The caller owns it and gets the next one back. */
export interface LocomotionState {
    /** The smoothed `moveDir`, so the blend probe glides rather than snapping between strafes. */
    smoothDir: number;
    /** Seconds of coyote time left. */
    coyote: number;
    /** Seconds of slope-projection lockout left after a take-off. */
    jumpLockout: number;
    /** A turn-in-place is in progress. */
    turning: boolean;
    /**
     * The clip code the in-progress turn is holding (+1/+2 right, -1/-2 left; 0 when not turning).
     *
     * Carried rather than recomputed: it is chosen ONCE, at the moment the turn engages, from the angle
     * as it was then. Re-deriving it each frame from the current angle would let a clip flip from a 180
     * to a 90 halfway through, mid-animation.
     */
    turnCode: number;
    /** Airborne from a jump, as opposed to having walked off something. */
    jumping: boolean;
}

export function createLocomotionState(): LocomotionState {
    return { smoothDir: 0, coyote: 0, jumpLockout: 0, turning: false, turnCode: 0, jumping: false };
}

export interface LocomotionOutput {
    velocity: [number, number, number];
    /** The yaw to write, or null to leave the rotation alone (idle, or `facingMode: 'none'`). */
    yaw: number | null;
    moveDir: number;
    isJumping: boolean;
    turnRequest: number;
    /** True on exactly the frame a jump launched. The CALLER consumes the request. */
    jumped: boolean;
    next: LocomotionState;
}

/**
 * Advance one frame.
 *
 * READS `intent` and never writes it — a jump request is consumed by the caller when `out.jumped` comes
 * back true, which keeps this function honest about owning no state.
 *
 * Total: any finite input produces finite output, including `dt = 0`, a zero move, a degenerate ground
 * normal and a zero-length `up`.
 */
export function stepLocomotion(
    intent: Readonly<ControlIntent>,
    sense: Readonly<LocomotionSense>,
    tuning: Readonly<LocomotionTuning>,
    state: Readonly<LocomotionState>,
): LocomotionOutput {
    const dt = Number.isFinite(sense.dt) && sense.dt > 0 ? sense.dt : 0;
    const next: LocomotionState = { ...state };

    // ----- vertical basis ------------------------------------------------------------------------
    // Normalized once; a zero-length `up` degrades to +Y rather than producing NaN everywhere below.
    let [ux, uy, uz] = sense.up;
    const upLen = Math.hypot(ux, uy, uz);
    if (upLen > 1e-6) { ux /= upLen; uy /= upLen; uz /= upLen; } else { ux = 0; uy = 1; uz = 0; }

    const [vx, vy, vz] = sense.velocity;
    // Split the incoming velocity into "along up" (preserved through everything but a jump or a slope)
    // and "planar" (what steering owns).
    const alongUp = vx * ux + vy * uy + vz * uz;
    const planarX = vx - ux * alongUp;
    const planarY = vy - uy * alongUp;
    const planarZ = vz - uz * alongUp;

    // ----- timers --------------------------------------------------------------------------------
    // Coyote refills while grounded, so it is always full the instant the ground disappears.
    next.coyote = sense.grounded ? tuning.coyoteSeconds : Math.max(0, state.coyote - dt);
    next.jumpLockout = Math.max(0, state.jumpLockout - dt);

    // ----- the desired planar velocity -----------------------------------------------------------
    const moveRight = intent.move[0];
    const moveForward = intent.move[1];
    // The analog throttle. Clamped at 1 so a driver cannot overspeed by writing a long vector.
    const magnitude = Math.min(1, Math.hypot(moveRight, moveForward));
    const moving = magnitude > 1e-3;

    // World direction, from the basis the driver named. See the handedness note in the module header.
    const basis = intent.basisYaw * Math.PI / 180;
    const sinB = Math.sin(basis);
    const cosB = Math.cos(basis);
    let dirX = sinB * moveForward - cosB * moveRight;
    let dirZ = cosB * moveForward + sinB * moveRight;
    // GUARDED, and it matters twice over. Standing still makes the length zero, and the unguarded
    // division this replaces produced a NaN velocity. And with an analog stick the length IS the stick's
    // deflection, so dividing by it would stretch a gentle push to full sprint — the analog range comes
    // back through `magnitude` on the SPEED below, never through the direction.
    const dirLen = Math.hypot(dirX, dirZ);
    if (dirLen > 1e-6) { dirX /= dirLen; dirZ /= dirLen; }

    const speedScale = clamp(num(intent.speedScale, 1), 0, 1);
    const baseSpeed = intent.sprint ? tuning.runSpeed : tuning.walkSpeed;
    const speed = moving ? baseSpeed * magnitude * speedScale : 0;

    let targetX = dirX * speed;
    let targetZ = dirZ * speed;
    let targetY = 0;

    // Airborne steering authority. At 1 this is the original script's behaviour (full control in the
    // air); at 0 the character keeps whatever planar velocity it launched with.
    if (!sense.grounded && tuning.airControl < 1) {
        const t = tuning.airControl;
        targetX = planarX + (targetX - planarX) * t;
        targetY = planarY + (targetY - planarY) * t;
        targetZ = planarZ + (targetZ - planarZ) * t;
    }

    // Acceleration ramp. 0 snaps, which reproduces the original exactly; above 0 it makes the engine's
    // existing `planarAcceleration` / `isAccelerating` builtins mean something for start/stop states.
    if (tuning.acceleration > 0 && dt > 0) {
        const maxStep = tuning.acceleration * dt;
        const dx = targetX - planarX;
        const dy = targetY - planarY;
        const dz = targetZ - planarZ;
        const gap = Math.hypot(dx, dy, dz);
        if (gap > maxStep && gap > 1e-9) {
            const t = maxStep / gap;
            targetX = planarX + dx * t;
            targetY = planarY + dy * t;
            targetZ = planarZ + dz * t;
        }
    }

    // ----- slope projection ----------------------------------------------------------------------
    // Travel ALONG the ground rather than horizontally through it. Suppressed for `jumpLockoutSeconds`
    // after a take-off: on the launch frame the projection would flatten the vertical velocity that was
    // just written. In the script this replaces, one `_jumpCooldown` field did this job AND gated the
    // `isJumping` animator flag, which is why its 0.2 was load-bearing in two unrelated places.
    const projecting = sense.grounded && next.jumpLockout <= 0;
    // Whether the projection actually RAN and produced something. Not the same as `projecting`: a
    // grounded character standing still has no direction to project, and must keep its vertical velocity
    // (gravity is not the controller's to cancel). A grounded character that IS moving deliberately
    // replaces the whole vector, which is what glues it to a downhill slope.
    let projected = false;
    if (projecting) {
        const [nx, ny, nz] = sense.groundNormal;
        const nLen = Math.hypot(nx, ny, nz);
        const targetSpeed = Math.hypot(targetX, targetY, targetZ);
        if (nLen > 1e-6 && targetSpeed > 1e-9) {
            const inx = nx / nLen;
            const iny = ny / nLen;
            const inz = nz / nLen;
            const into = targetX * inx + targetY * iny + targetZ * inz;
            let px = targetX - inx * into;
            let py = targetY - iny * into;
            let pz = targetZ - inz * into;
            const pLen = Math.hypot(px, py, pz);
            // Renormalized to the commanded speed, so walking up a slope is not slower than walking on
            // the flat — the projection changes DIRECTION, not pace.
            if (pLen > 1e-9) {
                const s = targetSpeed / pLen;
                px *= s; py *= s; pz *= s;
                targetX = px; targetY = py; targetZ = pz;
                projected = true;
            }
        }
    }

    // ----- the vertical channel ------------------------------------------------------------------
    // Preserved through everything above: gravity, falling and a jump in flight all live here. A frame
    // that actually projected already carries its own slope component in target*, so `up` is re-added
    // everywhere else — including a grounded character standing still, which would otherwise have its
    // gravity silently zeroed.
    let outX = targetX;
    let outY = targetY;
    let outZ = targetZ;
    if (!projected) {
        outX += ux * alongUp;
        outY += uy * alongUp;
        outZ += uz * alongUp;
    }

    // ----- jump ----------------------------------------------------------------------------------
    // Coyote OR grounded, and never during the lockout, which is what stops a buffered request from
    // firing twice on consecutive frames.
    const canJump = (sense.grounded || next.coyote > 0) && next.jumpLockout <= 0;
    const jumped = canJump && intent.requests.jump > 0;
    if (jumped) {
        // Replace the vertical component outright rather than adding to it: adding would make a jump
        // taken while already rising go higher, which reads as an inconsistent jump height.
        const current = outX * ux + outY * uy + outZ * uz;
        const delta = tuning.jumpSpeed - current;
        outX += ux * delta;
        outY += uy * delta;
        outZ += uz * delta;
        next.jumpLockout = tuning.jumpLockoutSeconds;
        next.jumping = true;
        next.coyote = 0;
    } else if (state.jumping && next.jumpLockout <= 0 && sense.grounded) {
        // The feet are back down and the lockout has expired — the jump is over. Two conditions, not
        // one: landing during the lockout is the frame the take-off itself is still resolving.
        next.jumping = false;
    }

    // ----- moveDir -------------------------------------------------------------------------------
    // Travel relative to the BODY's current facing, which may still be catching up to the aim. Held at
    // its last value while idle, so an idle blend probe does not snap to zero and back.
    let moveDir = state.smoothDir;
    if (moving) {
        // Intent relative to the basis, then offset by basis→body to make it relative to the body.
        // NEGATED because these angles are counter-clockwise: moving right is a clockwise offset from
        // forward and so reads negative. Verify with W → 0, D → -90, A → +90, S → ±180.
        const relative = Math.atan2(-moveRight, moveForward) * RAD2DEG;
        const target = shortestAngle(relative + shortestAngle(intent.basisYaw - sense.bodyYaw));
        const a = tuning.directionSmoothing > 0 && dt > 0
            ? 1 - Math.exp(-dt / tuning.directionSmoothing)
            : 1;
        moveDir = shortestAngle(state.smoothDir + shortestAngle(target - state.smoothDir) * a);
        next.smoothDir = moveDir;
    }

    // ----- facing and turn-in-place ---------------------------------------------------------------
    let yaw: number | null = null;
    // A turn already under way keeps the code it engaged with until it releases.
    let turnRequest = state.turning ? state.turnCode : 0;

    if (moving) {
        // Moving cancels any turn-in-place: the body is about to face the aim under the moving turn.
        next.turning = false;
        next.turnCode = 0;
        turnRequest = 0;
        if (tuning.facingMode !== 'none') {
            const targetYaw = tuning.facingMode === 'velocity'
                ? Math.atan2(dirX, dirZ) * RAD2DEG
                : intent.aimYaw;
            const diff = shortestAngle(targetYaw - sense.bodyYaw);
            const maxStep = tuning.turnSpeed * dt;
            const step = Math.abs(diff) > maxStep ? Math.sign(diff) * maxStep : diff;
            yaw = shortestAngle(sense.bodyYaw + step);
        }
    } else if (tuning.facingMode === 'aim') {
        // Idle: the body does not rotate here at all. A turn-in-place CLIP's root motion rotates it, and
        // this only decides which clip and holds its code until the body has caught up.
        const diff = shortestAngle(intent.aimYaw - sense.bodyYaw);
        if (!next.turning) {
            if (Math.abs(diff) >= tuning.turnThreshold) {
                next.turning = true;
                // A POSITIVE diff needs a LEFT turn — see the module header for why. `turnRequest` is a
                // clip selector (+right / -left), not an angle, so its sign is the opposite of moveDir's.
                const side = diff > 0 ? -1 : 1;
                next.turnCode = side * (Math.abs(diff) >= 135 ? 2 : 1);
                turnRequest = next.turnCode;
            }
        } else if (Math.abs(diff) < tuning.turnReleaseAngle) {
            next.turning = false;
            next.turnCode = 0;
            turnRequest = 0;
        }
    } else {
        next.turning = false;
        next.turnCode = 0;
        turnRequest = 0;
    }

    return {
        velocity: [outX, outY, outZ],
        yaw,
        moveDir,
        isJumping: next.jumping,
        turnRequest,
        jumped,
        next,
    };
}
