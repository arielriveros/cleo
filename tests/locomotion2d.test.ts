import { describe, it, expect } from 'vitest';
import {
    LOCOMOTION_2D_DEFAULTS, createContacts2D, createLocomotion2DEvents, createLocomotion2DState, integrateGravity2D,
    jumpPhysics, locomotion2DTuning, stepLocomotion2D, tickLocomotion2D,
} from '../src/physics2d/locomotion2d';
import type { Contacts2D, Locomotion2DTuning } from '../src/physics2d/locomotion2d';
import { createIntent, raiseRequest } from '../src/core/control/intent';

// A 2D body's generic movement as pure steps -- what the engine owns, mirroring a 3D Character's
// locomotion: walking and running, easing, a jump with coyote time and a buffer, dropping through a one-way
// platform, a fall faster than the rise, flying. A game's own moves are its script's (duskPlayerAbilities).

const tuning = (o: Partial<Locomotion2DTuning> = {}): Locomotion2DTuning => ({ ...LOCOMOTION_2D_DEFAULTS, ...o });
const air = (): Contacts2D => createContacts2D();
const ground = (): Contacts2D => ({ ...createContacts2D(), grounded: true });

/** Run `seconds` of substeps of 1/120 s with fixed contacts: tick, steer, gravity, as the body step does. */
function steps(seconds: number, contacts: Contacts2D, t: Locomotion2DTuning, intent = createIntent(),
               velocity: [number, number] = [0, 0], state = createLocomotion2DState()) {
    const ev = createLocomotion2DEvents();
    const events = { jumped: 0, landed: 0, droppedThrough: 0 };
    for (let s = 0; s < seconds - 1e-9; s += 1 / 120) {
        ev.jumped = ev.landed = ev.droppedThrough = false;
        tickLocomotion2D(state, contacts, velocity, t, 1 / 120, ev);
        if (stepLocomotion2D(state, intent, contacts, t, 1 / 120, velocity, ev)) intent.requests.jump = 0;
        integrateGravity2D(state, contacts, t, 1 / 120, velocity);
        events.jumped += +ev.jumped; events.landed += +ev.landed; events.droppedThrough += +ev.droppedThrough;
    }
    return { velocity, state, events, intent };
}

describe('2D locomotion', () => {
    it('derives gravity and the launch speed from the jump height and time', () => {
        const { gravity, jumpSpeed } = jumpPhysics({ jumpHeight: 3, jumpTimeToApex: 0.5 });
        expect(gravity).toBeCloseTo(24, 6);
        expect(jumpSpeed).toBeCloseTo(12, 6);
    });

    it('walks at walk speed and runs when sprinting, throttled by the stick and speed scale', () => {
        const intent = createIntent();
        intent.move[0] = 1;
        expect(steps(0.5, ground(), tuning(), intent).velocity[0]).toBeCloseTo(8, 6);
        intent.sprint = true;
        expect(steps(0.5, ground(), tuning(), intent).velocity[0]).toBeCloseTo(12, 6);
        intent.sprint = false;
        intent.move[0] = -0.5;
        intent.speedScale = 0.5;
        expect(steps(0.5, ground(), tuning(), intent).velocity[0]).toBeCloseTo(-2, 6);
    });

    it('eases with acceleration and deceleration, and steers less in the air', () => {
        const intent = createIntent();
        intent.move[0] = 1;
        expect(steps(0.05, ground(), tuning(), intent).velocity[0]).toBeCloseTo(80 * 0.05, 4);
        expect(steps(0.05, air(), tuning(), intent).velocity[0]).toBeCloseTo(80 * 0.7 * 0.05, 4);
        intent.move[0] = 0;
        expect(steps(0.02, ground(), tuning(), intent, [8, 0]).velocity[0]).toBeCloseTo(8 - 100 * 0.02, 4);
    });

    it('jumps within coyote time after leaving a ledge, not after', () => {
        const t = tuning();
        const near = steps(0.05, ground(), t);
        steps(0.05, air(), t, createIntent(), near.velocity, near.state);
        const press = createIntent();
        raiseRequest(press, 'jump', 0.12);
        expect(steps(1 / 120, air(), t, press, near.velocity, near.state).events.jumped).toBe(1);
        const late = steps(0.05, ground(), t);
        steps(0.2, air(), t, createIntent(), late.velocity, late.state);
        const again = createIntent();
        raiseRequest(again, 'jump', 0.12);
        expect(steps(1 / 120, air(), t, again, late.velocity, late.state).events.jumped).toBe(0);
    });

    it('keeps a jump request until it can launch', () => {
        const t = tuning();
        const intent = createIntent();
        raiseRequest(intent, 'jump', 0.12);
        const run = steps(0.05, air(), t, intent);
        expect(run.events.jumped).toBe(0);
        expect(intent.requests.jump).toBeGreaterThan(0);
        expect(steps(1 / 120, ground(), t, intent, run.velocity, run.state).events.jumped).toBe(1);
        expect(intent.requests.jump).toBe(0);
    });

    it('drops through a one-way platform on down + jump instead of jumping', () => {
        const intent = createIntent();
        intent.move[1] = -1;
        raiseRequest(intent, 'jump', 0.12);
        const r = steps(1 / 120, ground(), tuning(), intent);
        expect(r.events.droppedThrough).toBe(1);
        expect(r.events.jumped).toBe(0);
        expect(r.state.dropLeft).toBeGreaterThan(0);
    });

    it('falls faster than it rises, never past its max fall speed, and holds still on the ground', () => {
        const t = tuning();
        const { gravity } = jumpPhysics(t);
        expect(steps(0.1, air(), t, createIntent(), [0, 10]).velocity[1]).toBeCloseTo(10 - gravity * 0.1, 3);
        expect(steps(0.05, air(), t).velocity[1]).toBeCloseTo(-gravity * t.fallGravityMultiplier * 0.05, 3);
        expect(steps(3, air(), t).velocity[1]).toBe(-t.maxFallSpeed);
        expect(steps(0.5, ground(), t).velocity[1]).toBe(0);
        // A script's gravity scale: 0 holds the height.
        expect(steps(0.5, air(), tuning({ gravityScale: 0 })).velocity[1]).toBe(0);
    });

    it('flies on both axes toward the stick, with no gravity and no jump', () => {
        const intent = createIntent();
        intent.move[0] = 0.6; intent.move[1] = 0.8;
        raiseRequest(intent, 'jump', 0.12);
        const r = steps(1, air(), tuning({ movement: 'fly' }), intent);
        expect(r.velocity[0]).toBeCloseTo(0.6 * 8, 4);
        expect(r.velocity[1]).toBeCloseTo(0.8 * 8, 4);
        expect(r.events.jumped).toBe(0);
        expect(r.state.facing).toBe(1);
    });

    it('lands once, and counts air and ground time', () => {
        const t = tuning();
        const r = steps(0.25, air(), t);
        expect(r.state.airTime).toBeCloseTo(0.25, 3);
        const g = steps(0.1, ground(), t, createIntent(), r.velocity, r.state);
        expect(g.events.landed).toBe(1);
        expect(g.state.groundedTime).toBeCloseTo(0.1, 3);
        expect(g.state.airTime).toBe(0);
    });

    it('reads tuning tolerantly', () => {
        const t = locomotion2DTuning({ movement: 'sideways', walkSpeed: -3, airControl: 4, jumpHeight: Number.NaN } as any);
        expect(t.movement).toBe('walk');
        expect(t.walkSpeed).toBe(0);
        expect(t.airControl).toBe(1);
        expect(t.jumpHeight).toBe(LOCOMOTION_2D_DEFAULTS.jumpHeight);
    });
});
