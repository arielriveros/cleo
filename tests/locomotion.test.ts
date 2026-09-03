import { describe, it, expect } from 'vitest';
import {
    LOCOMOTION_DEFAULTS, createLocomotionState, locomotionTuning, stepLocomotion,
} from '../src/core/control/locomotion';
import type { LocomotionSense, LocomotionState, LocomotionTuning } from '../src/core/control/locomotion';
import { createIntent, raiseRequest, setMoveWorld } from '../src/core/control/intent';
import type { ControlIntent } from '../src/core/control/intent';

// This is the character controller that used to live in a user script, documented by forty lines of
// comment and pinned by nothing. Every sign convention below was previously re-derived at each use site,
// and each one of them fails SILENTLY when wrong: a mirrored strafe looks almost right, a jump eaten by
// the slope projection looks like a physics glitch, and a turn-in-place with the wrong sign drives the
// body away from the camera until the state machine ping-pongs.
//
// The contract shared with `Node.planarAngle` and the example README — ahead 0, right -90, left +90,
// back ±180 — is the single most important thing here: a blend space binds to either, and if they
// disagree the character plays the opposite strafe.

const FRAME = 1 / 60;

function tuning(over: Partial<LocomotionTuning> = {}): LocomotionTuning {
    return locomotionTuning(over);
}

function sense(over: Partial<LocomotionSense> = {}): LocomotionSense {
    return {
        dt: FRAME,
        bodyYaw: 0,
        velocity: [0, 0, 0],
        grounded: true,
        groundNormal: [0, 1, 0],
        up: [0, 1, 0],
        ...over,
    };
}

/** An intent moving toward a WORLD direction, in the world basis. */
function moving(x: number, z: number, over: Partial<ControlIntent> = {}): ControlIntent {
    const intent = setMoveWorld(createIntent(), x, z);
    return Object.assign(intent, over);
}

/**
 * An intent as a DRIVER writes it: `[right, forward]` in the basis. Distinct from `moving`, which names
 * a world direction — and the distinction is the whole handedness question, since right is -X at yaw 0,
 * so "press D" (`stick(1, 0)`) travels toward world -X.
 */
function stick(right: number, forward: number, over: Partial<ControlIntent> = {}): ControlIntent {
    const intent = createIntent();
    intent.move = [right, forward];
    return Object.assign(intent, over);
}

/** Run `frames` steps, feeding state forward the way the character node does. */
function run(
    frames: number,
    intent: ControlIntent,
    senseFor: (i: number, state: LocomotionState) => LocomotionSense,
    t: LocomotionTuning = tuning(),
    from: LocomotionState = createLocomotionState(),
) {
    let state = from;
    let out = stepLocomotion(intent, senseFor(0, state), t, state);
    for (let i = 1; i < frames; i++) {
        state = out.next;
        out = stepLocomotion(intent, senseFor(i, state), t, state);
    }
    return out;
}

describe('moveDir — the contract shared with planarAngle', () => {
    // Smoothing off, so each case reads the angle it asked for rather than a ramp toward it.
    const t = tuning({ directionSmoothing: 0 });

    it('reads ahead as 0, right as -90, left as +90 and back as ±180', () => {
        const cases: [string, number, number, number][] = [
            ['forward (W)', 0, 1, 0],
            ['right (D)', 1, 0, -90],
            ['left (A)', -1, 0, 90],
            ['back (S)', 0, -1, 180],
        ];
        for (const [label, right, forward, expected] of cases) {
            const out = stepLocomotion(stick(right, forward), sense(), t, createLocomotionState());
            expect(Math.abs(out.moveDir), label).toBeCloseTo(Math.abs(expected), 4);
            if (expected !== 180) expect(Math.sign(out.moveDir), label).toBe(Math.sign(expected));
        }
    });

    it('is relative to the BODY, not the basis', () => {
        // The body lags the aim mid-turn, and the blend space wants what the character is doing relative
        // to where it is pointing — not relative to the camera. Pushing "forward" in the world basis
        // while the body faces +X is, to the body, a strafe to its right.
        const out = stepLocomotion(stick(0, 1), sense({ bodyYaw: 90 }), t, createLocomotionState());
        expect(out.moveDir).toBeCloseTo(-90, 4);
    });

    it('holds its last value while idle rather than snapping to zero', () => {
        const walked = stepLocomotion(stick(1, 0), sense(), t, createLocomotionState());
        const idle = stepLocomotion(createIntent(), sense(), t, walked.next);
        expect(idle.moveDir).toBeCloseTo(walked.moveDir, 10);
    });

    it('glides between strafes when smoothing is on', () => {
        const smooth = tuning({ directionSmoothing: 0.12 });
        const first = stepLocomotion(stick(1, 0), sense(), smooth, createLocomotionState());
        // One frame of a 0.12s time constant covers ~13% of the way to -90.
        expect(first.moveDir).toBeGreaterThan(-30);
        expect(first.moveDir).toBeLessThan(0);
        const settled = run(120, stick(1, 0), () => sense(), smooth);
        expect(settled.moveDir).toBeCloseTo(-90, 3);
    });

    it('takes the short way across the ±180 seam', () => {
        // Smoothing from +170 toward -170 must be a 20-degree step, not a 340-degree sweep back through 0.
        const smooth = tuning({ directionSmoothing: 0.05 });
        const from = { ...createLocomotionState(), smoothDir: 170 };
        const out = stepLocomotion(stick(0, -1, { basisYaw: 20 }), sense(), smooth, from);
        expect(out.moveDir).toBeGreaterThan(150);
    });
});

describe('speed', () => {
    it('uses walk normally and run while sprinting', () => {
        const t = tuning({ walkSpeed: 2, runSpeed: 6 });
        const walk = stepLocomotion(moving(0, 1), sense(), t, createLocomotionState());
        const run_ = stepLocomotion(moving(0, 1, { sprint: true }), sense(), t, createLocomotionState());
        expect(Math.hypot(...walk.velocity)).toBeCloseTo(2, 5);
        expect(Math.hypot(...run_.velocity)).toBeCloseTo(6, 5);
    });

    it('scales SPEED by the analog magnitude, never the direction', () => {
        // The regression that turns a gentle stick push into a sprint when a keyboard controller is
        // ported to a pad: normalizing the move vector and calling the result the throttle.
        const t = tuning({ walkSpeed: 4 });
        const gentle = stepLocomotion(moving(0, 0.25), sense(), t, createLocomotionState());
        expect(Math.hypot(...gentle.velocity)).toBeCloseTo(1, 5);
        // ...and the DIRECTION is unchanged by the throttle.
        expect(gentle.velocity[0]).toBeCloseTo(0, 5);
        expect(gentle.velocity[2]).toBeGreaterThan(0);
    });

    it('scales by speedScale, so an AI can approach gently without retuning the character', () => {
        const t = tuning({ walkSpeed: 4 });
        const out = stepLocomotion(moving(0, 1, { speedScale: 0.5 }), sense(), t, createLocomotionState());
        expect(Math.hypot(...out.velocity)).toBeCloseTo(2, 5);
    });

    it('cannot be overspeeded by a driver writing a long move vector', () => {
        const t = tuning({ walkSpeed: 3 });
        const out = stepLocomotion(moving(0, 5), sense(), t, createLocomotionState());
        expect(Math.hypot(...out.velocity)).toBeCloseTo(3, 5);
    });

    it('stops dead when idle, preserving the vertical channel', () => {
        const out = stepLocomotion(createIntent(), sense({ velocity: [3, -9, 2] }), tuning(), createLocomotionState());
        expect(out.velocity[0]).toBeCloseTo(0, 6);
        expect(out.velocity[2]).toBeCloseTo(0, 6);
        // Gravity is not the controller's to cancel.
        expect(out.velocity[1]).toBeCloseTo(-9, 6);
    });

    it('ramps rather than snapping when acceleration is set, and snaps at 0', () => {
        const ramped = tuning({ walkSpeed: 10, acceleration: 20 });
        const first = stepLocomotion(moving(0, 1), sense(), ramped, createLocomotionState());
        expect(Math.hypot(...first.velocity)).toBeCloseTo(20 * FRAME, 5);

        const snapped = tuning({ walkSpeed: 10, acceleration: 0 });
        const instant = stepLocomotion(moving(0, 1), sense(), snapped, createLocomotionState());
        expect(Math.hypot(...instant.velocity)).toBeCloseTo(10, 5);
    });

    it('decelerates to a stop under acceleration instead of cutting out', () => {
        const t = tuning({ walkSpeed: 4, acceleration: 20 });
        const out = stepLocomotion(createIntent(), sense({ velocity: [0, 0, 4] }), t, createLocomotionState());
        const speed = Math.hypot(...out.velocity);
        expect(speed).toBeGreaterThan(0);
        expect(speed).toBeLessThan(4);
    });
});

describe('slopes', () => {
    // A 30-degree ramp: the normal tilted off vertical.
    const ramp = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0] as [number, number, number];

    it('travels ALONG the ground, not horizontally through it', () => {
        const t = tuning({ walkSpeed: 4 });
        const out = stepLocomotion(moving(1, 0), sense({ groundNormal: ramp }), t, createLocomotionState());
        // Perpendicular to the surface normal is what "along the ground" means.
        const dot = out.velocity[0] * ramp[0] + out.velocity[1] * ramp[1] + out.velocity[2] * ramp[2];
        expect(dot).toBeCloseTo(0, 4);
    });

    it('keeps the commanded pace — the projection changes direction, not speed', () => {
        const t = tuning({ walkSpeed: 4 });
        const out = stepLocomotion(moving(1, 0), sense({ groundNormal: ramp }), t, createLocomotionState());
        expect(Math.hypot(...out.velocity)).toBeCloseTo(4, 4);
    });

    it('does nothing on flat ground', () => {
        const t = tuning({ walkSpeed: 4 });
        const out = stepLocomotion(moving(1, 0), sense(), t, createLocomotionState());
        expect(out.velocity[1]).toBeCloseTo(0, 6);
    });

    it('works under inverted gravity', () => {
        // The script this replaces hard-coded `moveY = -n[1] * into`, which only holds for +Y up.
        const t = tuning({ walkSpeed: 4 });
        const inverted = [-Math.sin(Math.PI / 6), -Math.cos(Math.PI / 6), 0] as [number, number, number];
        const out = stepLocomotion(
            moving(1, 0), sense({ groundNormal: inverted, up: [0, -1, 0] }), t, createLocomotionState());
        const dot = out.velocity[0] * inverted[0] + out.velocity[1] * inverted[1] + out.velocity[2] * inverted[2];
        expect(dot).toBeCloseTo(0, 4);
        expect(Math.hypot(...out.velocity)).toBeCloseTo(4, 4);
    });

    it('survives a degenerate ground normal', () => {
        const out = stepLocomotion(
            moving(1, 0), sense({ groundNormal: [0, 0, 0] }), tuning(), createLocomotionState());
        expect(out.velocity.every(Number.isFinite)).toBe(true);
    });

    it('is suppressed while airborne', () => {
        const t = tuning({ walkSpeed: 4 });
        const out = stepLocomotion(
            moving(1, 0), sense({ grounded: false, velocity: [0, -5, 0], groundNormal: ramp }),
            t, createLocomotionState());
        // The fall continues untouched; only the planar channel is steered.
        expect(out.velocity[1]).toBeCloseTo(-5, 5);
    });
});

describe('jumping', () => {
    const t = tuning({ jumpSpeed: 5, coyoteSeconds: 0.12, jumpLockoutSeconds: 0.15 });

    function jumpIntent(): ControlIntent {
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.15);
        return intent;
    }

    it('launches from the ground and reports the frame it did', () => {
        const out = stepLocomotion(jumpIntent(), sense(), t, createLocomotionState());
        expect(out.jumped).toBe(true);
        expect(out.velocity[1]).toBeCloseTo(5, 5);
        expect(out.isJumping).toBe(true);
    });

    it('replaces the vertical channel rather than adding to it', () => {
        // Adding would make a jump taken while already rising go higher, which reads as an inconsistent
        // jump height.
        const out = stepLocomotion(jumpIntent(), sense({ velocity: [0, 3, 0] }), t, createLocomotionState());
        expect(out.velocity[1]).toBeCloseTo(5, 5);
    });

    it('survives the slope projection on the launch frame', () => {
        // The single reason `jumpLockoutSeconds` exists: without it the projection flattens the vertical
        // velocity on the very frame it was written.
        const ramp = [Math.sin(Math.PI / 6), Math.cos(Math.PI / 6), 0] as [number, number, number];
        const walkingJump = moving(1, 0);
        raiseRequest(walkingJump, 'jump', 0.15);
        const out = stepLocomotion(walkingJump, sense({ groundNormal: ramp }), t, createLocomotionState());
        expect(out.velocity[1]).toBeCloseTo(5, 5);
    });

    it('does not fire twice from one buffered request during the lockout', () => {
        // The step never consumes the request — the caller does, on `jumped`. The lockout is what stops
        // a caller that forgot from launching every frame.
        const intent = jumpIntent();
        const first = stepLocomotion(intent, sense(), t, createLocomotionState());
        expect(first.jumped).toBe(true);
        const second = stepLocomotion(intent, sense(), t, first.next);
        expect(second.jumped).toBe(false);
    });

    it('fires within the coyote window after walking off an edge', () => {
        let state = stepLocomotion(createIntent(), sense(), t, createLocomotionState()).next;
        // Airborne for half the coyote window.
        for (let i = 0; i < 3; i++)                                   // 0.05s
            state = stepLocomotion(createIntent(), sense({ grounded: false }), t, state).next;
        const out = stepLocomotion(jumpIntent(), sense({ grounded: false }), t, state);
        expect(out.jumped).toBe(true);
    });

    it('does not fire past the coyote window', () => {
        let state = stepLocomotion(createIntent(), sense(), t, createLocomotionState()).next;
        for (let i = 0; i < 12; i++)                                  // 0.2s > 0.12s
            state = stepLocomotion(createIntent(), sense({ grounded: false }), t, state).next;
        const out = stepLocomotion(jumpIntent(), sense({ grounded: false }), t, state);
        expect(out.jumped).toBe(false);
    });

    it('refills coyote on every grounded frame', () => {
        let state = createLocomotionState();
        for (let i = 0; i < 30; i++) state = stepLocomotion(createIntent(), sense(), t, state).next;
        expect(state.coyote).toBeCloseTo(t.coyoteSeconds, 6);
    });

    it('clears isJumping only once grounded AND past the lockout', () => {
        const launch = stepLocomotion(jumpIntent(), sense(), t, createLocomotionState());
        // Landing during the lockout is still the take-off resolving.
        const early = stepLocomotion(createIntent(), sense(), t, launch.next);
        expect(early.isJumping).toBe(true);

        let state = launch.next;
        for (let i = 0; i < 12; i++)                                  // past 0.15s
            state = stepLocomotion(createIntent(), sense({ grounded: false }), t, state).next;
        const landed = stepLocomotion(createIntent(), sense(), t, state);
        expect(landed.isJumping).toBe(false);
    });
});

describe('facing and turn-in-place', () => {
    it('swings the body toward the aim while moving, capped by turnSpeed', () => {
        const t = tuning({ turnSpeed: 180 });
        const out = stepLocomotion(moving(0, 1, { aimYaw: 90 }), sense(), t, createLocomotionState());
        expect(out.yaw).toBeCloseTo(180 * FRAME, 5);
    });

    it('snaps to the aim once it is within a frame of it', () => {
        const t = tuning({ turnSpeed: 540 });
        const out = stepLocomotion(moving(0, 1, { aimYaw: 1 }), sense(), t, createLocomotionState());
        expect(out.yaw).toBeCloseTo(1, 5);
    });

    it('faces the travel direction under facingMode velocity', () => {
        const t = tuning({ facingMode: 'velocity', turnSpeed: 100000 });
        const out = stepLocomotion(moving(1, 0, { aimYaw: 0 }), sense(), t, createLocomotionState());
        expect(out.yaw).toBeCloseTo(90, 3);
    });

    it('leaves the rotation alone under facingMode none', () => {
        const t = tuning({ facingMode: 'none' });
        expect(stepLocomotion(moving(0, 1, { aimYaw: 90 }), sense(), t, createLocomotionState()).yaw).toBeNull();
    });

    it('never rotates the body while idle — the turn CLIP does that', () => {
        const intent = createIntent();
        intent.aimYaw = 170;
        expect(stepLocomotion(intent, sense(), tuning(), createLocomotionState()).yaw).toBeNull();
    });

    it('asks for a NEGATIVE turnRequest when the aim is to positive yaw', () => {
        // Raising yaw swings forward toward +X, and +X is the character's LEFT. Backwards, the turn
        // clip's root motion drives the body AWAY from the aim and the release angle is never reached.
        const intent = createIntent();
        intent.aimYaw = 100;
        const out = stepLocomotion(intent, sense(), tuning({ turnThreshold: 90 }), createLocomotionState());
        expect(out.turnRequest).toBeLessThan(0);
    });

    it('picks the 180 clip past 135 degrees and the 90 clip below it', () => {
        const t = tuning({ turnThreshold: 90 });
        const near = createIntent(); near.aimYaw = -100;
        const far = createIntent(); far.aimYaw = -170;
        expect(stepLocomotion(near, sense(), t, createLocomotionState()).turnRequest).toBe(1);
        expect(stepLocomotion(far, sense(), t, createLocomotionState()).turnRequest).toBe(2);
    });

    it('does not fire below the threshold', () => {
        const intent = createIntent();
        intent.aimYaw = 80;
        expect(stepLocomotion(intent, sense(), tuning({ turnThreshold: 90 }), createLocomotionState()).turnRequest)
            .toBe(0);
    });

    it('holds the turn until the release angle, not until the threshold', () => {
        // The hysteresis pair. With one number the turn would chatter whenever the camera hovered at it.
        const t = tuning({ turnThreshold: 90, turnReleaseAngle: 10 });
        const intent = createIntent();
        intent.aimYaw = 120;
        const engaged = stepLocomotion(intent, sense(), t, createLocomotionState());
        expect(engaged.turnRequest).not.toBe(0);

        // The root motion has brought the body most of the way round — still holding at 30 degrees out.
        const holding = stepLocomotion(intent, sense({ bodyYaw: 90 }), t, engaged.next);
        expect(holding.turnRequest).toBe(engaged.turnRequest);

        const released = stepLocomotion(intent, sense({ bodyYaw: 115 }), t, holding.next);
        expect(released.turnRequest).toBe(0);
    });

    it('keeps the clip it engaged with, even as the angle shrinks past 135', () => {
        // Re-deriving the code each frame would flip a 180 clip into a 90 halfway through the animation.
        const t = tuning({ turnThreshold: 90, turnReleaseAngle: 10 });
        const intent = createIntent();
        intent.aimYaw = 170;
        const engaged = stepLocomotion(intent, sense(), t, createLocomotionState());
        expect(Math.abs(engaged.turnRequest)).toBe(2);
        const midway = stepLocomotion(intent, sense({ bodyYaw: 80 }), t, engaged.next);
        expect(midway.turnRequest).toBe(engaged.turnRequest);
    });

    it('cancels a turn the moment the character starts moving', () => {
        const t = tuning({ turnThreshold: 90 });
        const intent = createIntent();
        intent.aimYaw = 170;
        const engaged = stepLocomotion(intent, sense(), t, createLocomotionState());
        expect(engaged.turnRequest).not.toBe(0);
        const walked = stepLocomotion(moving(0, 1, { aimYaw: 170 }), sense(), t, engaged.next);
        expect(walked.turnRequest).toBe(0);
        expect(walked.next.turning).toBe(false);
    });
});

describe('tuning', () => {
    it('fills a partial, junk or missing record from the defaults', () => {
        expect(locomotionTuning()).toEqual(LOCOMOTION_DEFAULTS);
        expect(locomotionTuning(null)).toEqual(LOCOMOTION_DEFAULTS);
        expect(locomotionTuning({ walkSpeed: NaN }).walkSpeed).toBe(LOCOMOTION_DEFAULTS.walkSpeed);
        expect(locomotionTuning({ facingMode: 'sideways' as never }).facingMode).toBe('aim');
    });

    it('keeps the release angle strictly below the threshold', () => {
        // Otherwise a turn releases on the frame it engages and nothing ever turns.
        const t = locomotionTuning({ turnThreshold: 30, turnReleaseAngle: 90 });
        expect(t.turnReleaseAngle).toBeLessThan(t.turnThreshold);
    });

    it('clamps the rest into ranges that mean something', () => {
        const t = locomotionTuning({ walkSpeed: -5, airControl: 4, coyoteSeconds: -1, acceleration: -2 });
        expect(t.walkSpeed).toBe(0);
        expect(t.airControl).toBe(1);
        expect(t.coyoteSeconds).toBe(0);
        expect(t.acceleration).toBe(0);
    });
});

describe('air control', () => {
    it('gives full authority at 1, matching the script this replaces', () => {
        const t = tuning({ walkSpeed: 4, airControl: 1 });
        const out = stepLocomotion(
            moving(0, 1), sense({ grounded: false, velocity: [3, -5, 0] }), t, createLocomotionState());
        expect(out.velocity[0]).toBeCloseTo(0, 5);
        expect(out.velocity[2]).toBeCloseTo(4, 5);
        expect(out.velocity[1]).toBeCloseTo(-5, 5);
    });

    it('keeps the launch velocity at 0', () => {
        const t = tuning({ walkSpeed: 4, airControl: 0 });
        const out = stepLocomotion(
            moving(0, 1), sense({ grounded: false, velocity: [3, -5, 0] }), t, createLocomotionState());
        expect(out.velocity[0]).toBeCloseTo(3, 5);
        expect(out.velocity[2]).toBeCloseTo(0, 5);
    });
});

describe('totality and purity', () => {
    it('never mutates the intent or the state it was given', () => {
        const intent = moving(1, 0, { sprint: true });
        raiseRequest(intent, 'jump', 0.15);
        const state = createLocomotionState();
        const intentBefore = JSON.stringify(intent);
        const stateBefore = JSON.stringify(state);
        stepLocomotion(intent, sense(), tuning(), state);
        expect(JSON.stringify(intent)).toBe(intentBefore);
        expect(JSON.stringify(state)).toBe(stateBefore);
    });

    it('gives the same output twice for the same input', () => {
        const intent = moving(0.5, 0.5);
        const state = createLocomotionState();
        const a = stepLocomotion(intent, sense(), tuning(), state);
        const b = stepLocomotion(intent, sense(), tuning(), state);
        expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    });

    it('stays finite at dt = 0 and at an enormous dt', () => {
        for (const dt of [0, -1, NaN, 100]) {
            const out = stepLocomotion(moving(1, 1), sense({ dt }), tuning(), createLocomotionState());
            expect(out.velocity.every(Number.isFinite), `dt=${dt}`).toBe(true);
            expect(Number.isFinite(out.moveDir), `dt=${dt}`).toBe(true);
            expect(out.yaw === null || Number.isFinite(out.yaw), `dt=${dt}`).toBe(true);
        }
    });

    it('never produces NaN from a zero move, a zero up or a junk speedScale', () => {
        const odd = createIntent();
        odd.speedScale = NaN;
        const out = stepLocomotion(odd, sense({ up: [0, 0, 0], velocity: [1, 2, 3] }), tuning(), createLocomotionState());
        expect(out.velocity.every(Number.isFinite)).toBe(true);
    });
});
