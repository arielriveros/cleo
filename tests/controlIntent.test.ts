import { describe, it, expect } from 'vitest';
import { vec3 } from 'gl-matrix';
import {
    INTENT_REQUESTS, applyPlayerReading, clearIntent, consumeRequest, createIntent, decayRequests,
    forwardFromYaw, isRequested, moveWorldDirection, raiseRequest, rightFromYaw, setMoveWorld,
    shortestAngle,
} from '../src/core/control/intent';

// ControlIntent is the seam the whole control layer exists for: a driver writes it, a character reads it,
// and neither knows about the other. Two things in it are easy to get wrong and invisible when you do —
// the handedness (a mirrored strafe looks almost right) and the exactly-once guarantee on a latched
// request (a double jump that only happens at certain frame rates).

describe('latched requests', () => {
    it('is consumable exactly once per raise', () => {
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.15);
        expect(consumeRequest(intent, 'jump')).toBe(true);
        expect(consumeRequest(intent, 'jump')).toBe(false);
        expect(consumeRequest(intent, 'jump')).toBe(false);
    });

    it('reports pending without consuming', () => {
        const intent = createIntent();
        raiseRequest(intent, 'interact', 0.2);
        expect(isRequested(intent, 'interact')).toBe(true);
        expect(isRequested(intent, 'interact')).toBe(true);
        expect(consumeRequest(intent, 'interact')).toBe(true);
        expect(isRequested(intent, 'interact')).toBe(false);
    });

    it('stays pending across the buffer window and expires past it', () => {
        // This IS jump buffering: a press 30 ms before landing has to survive to the landing frame.
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.15);
        decayRequests(intent, 0.14);
        expect(isRequested(intent, 'jump')).toBe(true);
        decayRequests(intent, 0.02);
        expect(isRequested(intent, 'jump')).toBe(false);
    });

    it('survives a realistic run of 60fps frames inside the window', () => {
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.15);
        for (let i = 0; i < 8; i++) decayRequests(intent, 1 / 60);   // 0.133s
        expect(isRequested(intent, 'jump')).toBe(true);
        for (let i = 0; i < 2; i++) decayRequests(intent, 1 / 60);   // 0.167s
        expect(isRequested(intent, 'jump')).toBe(false);
    });

    it('restarts the window on a re-raise rather than stacking', () => {
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.1);
        decayRequests(intent, 0.09);
        raiseRequest(intent, 'jump', 0.1);
        decayRequests(intent, 0.09);
        expect(isRequested(intent, 'jump')).toBe(true);
    });

    it('still raises for one frame when asked for no buffer at all', () => {
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0);
        expect(isRequested(intent, 'jump')).toBe(true);
        raiseRequest(intent, 'primary', NaN);
        expect(isRequested(intent, 'primary')).toBe(true);
    });

    it('does not age on a zero, negative or non-finite dt', () => {
        // A paused frame must not expire a pending request.
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.05);
        decayRequests(intent, 0);
        decayRequests(intent, -1);
        decayRequests(intent, NaN);
        expect(isRequested(intent, 'jump')).toBe(true);
    });

    it('keeps every request independent', () => {
        const intent = createIntent();
        for (const kind of INTENT_REQUESTS) raiseRequest(intent, kind, 0.1);
        expect(consumeRequest(intent, 'jump')).toBe(true);
        for (const kind of INTENT_REQUESTS)
            expect(isRequested(intent, kind)).toBe(kind !== 'jump');
    });
});

describe('clearIntent', () => {
    it('zeroes the continuous channels', () => {
        const intent = createIntent();
        intent.move = [1, 1];
        intent.look = [5, 5];
        intent.sprint = true;
        intent.crouch = true;
        intent.speedScale = 0.2;
        clearIntent(intent);
        expect(intent.move).toEqual([0, 0]);
        expect(intent.look).toEqual([0, 0]);
        expect(intent.sprint).toBe(false);
        expect(intent.crouch).toBe(false);
        expect(intent.speedScale).toBe(1);
    });

    it('does NOT clear a pending request', () => {
        // The whole point of buffering: a jump raised during a hitch must survive frames in which
        // nothing writes intent at all.
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.15);
        clearIntent(intent);
        expect(isRequested(intent, 'jump')).toBe(true);
    });
});

describe('handedness', () => {
    it('puts forward on +Z and right on -X at yaw 0', () => {
        // The single most re-derived fact in the controller this replaces. RIGHT is `forward x up`,
        // which is -X — not +X.
        const f = forwardFromYaw(vec3.create(), 0);
        const r = rightFromYaw(vec3.create(), 0);
        expect(f[0]).toBeCloseTo(0, 6);
        expect(f[2]).toBeCloseTo(1, 6);
        expect(r[0]).toBeCloseTo(-1, 6);
        expect(r[2]).toBeCloseTo(0, 6);
    });

    it('swings forward toward +X as yaw rises', () => {
        const f = forwardFromYaw(vec3.create(), 90);
        expect(f[0]).toBeCloseTo(1, 6);
        expect(f[2]).toBeCloseTo(0, 6);
    });

    it('keeps forward and right perpendicular at every yaw', () => {
        const f = vec3.create();
        const r = vec3.create();
        for (let yaw = -180; yaw <= 180; yaw += 15) {
            forwardFromYaw(f, yaw);
            rightFromYaw(r, yaw);
            expect(vec3.dot(f, r)).toBeCloseTo(0, 6);
        }
    });

    it('round-trips a world direction through setMoveWorld / moveWorldDirection', () => {
        const intent = createIntent();
        const out = vec3.create();
        for (const [x, z] of [[1, 0], [0, 1], [-1, 0], [0, -1], [0.6, -0.8]] as const) {
            setMoveWorld(intent, x, z);
            moveWorldDirection(out, intent);
            expect(out[0]).toBeCloseTo(x, 6);
            expect(out[2]).toBeCloseTo(z, 6);
        }
    });

    it('writes a world +X push as move = [-1, 0]', () => {
        // The one sign worth asserting rather than commenting: it follows from right being -X.
        const intent = setMoveWorld(createIntent(), 1, 0);
        expect(intent.move).toEqual([-1, 0]);
        expect(intent.basisYaw).toBe(0);
    });

    it('rotates the move by the basis', () => {
        const intent = createIntent();
        intent.move = [0, 1];          // "forward"
        intent.basisYaw = 90;          // ...in a basis facing +X
        const out = moveWorldDirection(vec3.create(), intent);
        expect(out[0]).toBeCloseTo(1, 6);
        expect(out[2]).toBeCloseTo(0, 6);
    });

    it('preserves the analog magnitude rather than normalizing it', () => {
        // The direction carries the throttle through to the character, which scales SPEED by it. A
        // normalize here is what turns a gentle stick push into a sprint.
        const intent = createIntent();
        intent.move = [0, 0.3];
        const out = moveWorldDirection(vec3.create(), intent);
        expect(vec3.length(out)).toBeCloseTo(0.3, 6);
    });

    it('gives a zero move a zero direction, never NaN', () => {
        const out = moveWorldDirection(vec3.create(), createIntent());
        expect(out).toEqual(new Float32Array([0, 0, 0]));
    });
});

describe('shortestAngle', () => {
    it('wraps into (-180, 180]', () => {
        expect(shortestAngle(0)).toBe(0);
        expect(shortestAngle(190)).toBeCloseTo(-170, 10);
        expect(shortestAngle(-190)).toBeCloseTo(170, 10);
        expect(shortestAngle(540)).toBeCloseTo(180, 10);
        expect(shortestAngle(-180)).toBeCloseTo(180, 10);
        expect(shortestAngle(180)).toBeCloseTo(180, 10);
    });

    it('takes the two-degree step across the seam, not the 358-degree one', () => {
        expect(shortestAngle(179 - -179)).toBeCloseTo(-2, 10);
    });
});

describe('applyPlayerReading', () => {
    const reading = {
        move: [0.5, 1] as [number, number],
        look: [3, -2] as [number, number],
        jump: false, sprint: true, crouch: false,
    };

    it('copies the continuous channels and adopts the camera basis', () => {
        const intent = applyPlayerReading(createIntent(), reading, 45, 0.15);
        expect(intent.move).toEqual([0.5, 1]);
        expect(intent.look).toEqual([3, -2]);
        expect(intent.sprint).toBe(true);
        expect(intent.basisYaw).toBe(45);
        // Face where the camera faces: the default for a strafe character.
        expect(intent.aimYaw).toBe(45);
    });

    it('raises a jump only on the press EDGE', () => {
        // The reading carries `Input.started`, not `pressed` — a held button must not re-raise every
        // frame, which would make the buffer meaningless.
        const held = applyPlayerReading(createIntent(), reading, 0, 0.15);
        expect(isRequested(held, 'jump')).toBe(false);
        const pressed = applyPlayerReading(createIntent(), { ...reading, jump: true }, 0, 0.15);
        expect(isRequested(pressed, 'jump')).toBe(true);
    });

    it('clears last frame\'s channels, so a driver that stops writing stops the pawn', () => {
        const intent = createIntent();
        applyPlayerReading(intent, { ...reading, jump: true }, 0, 0.15);
        applyPlayerReading(intent, { move: [0, 0], look: [0, 0], jump: false, sprint: false, crouch: false }, 0, 0.15);
        expect(intent.move).toEqual([0, 0]);
        expect(intent.sprint).toBe(false);
        // ...but the pending jump still survives, per clearIntent's contract.
        expect(isRequested(intent, 'jump')).toBe(true);
    });

    it('does not alias the reading it was given', () => {
        const source = { ...reading, move: [1, 1] as [number, number] };
        const intent = applyPlayerReading(createIntent(), source, 0, 0.15);
        intent.move[0] = 99;
        expect(source.move[0]).toBe(1);
    });
});
