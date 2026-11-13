import { consumeRequest } from '../core/control/intent';
import type { ControlIntent } from '../core/control/intent';
import { createMoveResult, moveAndSlide, wallTouching } from './collide2d';
import type { Body2DShape, MoveResult } from './collide2d';
import { integrateGravity2D, stepLocomotion2D, tickLocomotion2D } from './locomotion2d';
import type { Contacts2D, Locomotion2DEvents, Locomotion2DState, Locomotion2DTuning } from './locomotion2d';
import type { Box2D, CollisionWorld2D } from './types';

// One frame of a 2D body, as a pure function of the collision world: substeps of at most 1/120 s, each
// running the script's hook, the generic locomotion, gravity and move-and-slide. Pure so the 2D physics
// pass (World2D) and the 2D navigation bake share it: a jump the bake links is flown by exactly the code
// that will fly it in the game.

/** The longest substep, seconds: short enough that a jump's arc is the same at any frame rate. */
export const MAX_SUBSTEP_2D = 1 / 120;

/** A body as the step sees it. `velocity`, `contacts`, `state` and `events` are updated in place. */
export interface Body2DSim {
    /** Feet-centred position. */
    x: number;
    y: number;
    halfWidth: number;
    height: number;
    velocity: [number, number];
    contacts: Contacts2D;
    state: Locomotion2DState;
    events: Locomotion2DEvents;
    /** The most it climbs walking: a step, a slope's rise. */
    stepHeight: number;
    /** One-way platforms hold it up; off, it passes through them (a flier). */
    oneWayPlatforms: boolean;
    /** The 2D collider it stands on, after the step, or null. */
    groundBox: Box2D | null;
}

/**
 * A script's per-substep say in the movement (the body's `onMove2D`). Returning `true` OWNS the substep:
 * the engine's steering and jump are skipped and the hook's velocity stands, while gravity (times
 * `gravityScale`) and collision still run. Called after the landing bookkeeping, before the steering.
 */
export type Body2DStepHook = (dt: number, substep: number) => boolean | void;

/**
 * Move `sim` for `dt` seconds. `intent` null leaves it undriven: no steering, it keeps its velocity under
 * gravity (a flier just drifts), its facing following its motion. `tuning` is read every substep, so a
 * hook that changes it (a wall slide's fall speed) takes effect at once.
 */
export function stepBody2D(world: CollisionWorld2D, sim: Body2DSim, intent: ControlIntent | null,
                           tuning: Locomotion2DTuning, dt: number, hook?: Body2DStepHook | null,
                           moved: MoveResult = createMoveResult()): void {
    const ev = sim.events;
    ev.jumped = ev.landed = ev.droppedThrough = false;
    if (!(dt > 0)) return;
    const shape: Body2DShape = _shape;
    shape.x = sim.x; shape.y = sim.y; shape.halfWidth = sim.halfWidth; shape.height = sim.height;
    const { contacts, state, velocity } = sim;

    const steps = Math.max(1, Math.ceil(dt / MAX_SUBSTEP_2D - 1e-6));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
        tickLocomotion2D(state, contacts, velocity, tuning, h, ev);
        const owned = hook ? hook(h, i) === true : false;
        if (!owned && intent && stepLocomotion2D(state, intent, contacts, tuning, h, velocity, ev))
            consumeRequest(intent, 'jump');
        integrateGravity2D(state, contacts, tuning, h, velocity);

        const vx = velocity[0], vy = velocity[1];
        // The average of the vertical speed before and after this substep's gravity: exact under constant
        // gravity, so the arc of a jump does not depend on the frame rate.
        const fall = (state.vyStart + vy) * 0.5;
        moveAndSlide(world, shape, vx * h, fall * h, {
            dropThrough: state.dropLeft > 0 || !sim.oneWayPlatforms,
            stepUp: sim.stepHeight,
            snapDown: tuning.movement === 'fly' ? 0 : sim.stepHeight,
            grounded: contacts.grounded && vy <= 0,
        }, moved);
        shape.x = moved.x; shape.y = moved.y;
        contacts.grounded = moved.grounded;
        contacts.onSlope = moved.onSlope;
        contacts.ceiling = moved.hitCeiling;
        contacts.wallLeft = wallTouching(world, shape, -1);
        contacts.wallRight = wallTouching(world, shape, 1);
        sim.groundBox = moved.groundBox;
        // What a wall, a floor or a ceiling stopped stops the velocity too.
        if ((moved.hitLeft && vx < 0) || (moved.hitRight && vx > 0)) velocity[0] = 0;
        if ((moved.grounded && vy < 0) || (moved.hitCeiling && vy > 0)) velocity[1] = 0;
    }
    // An undriven body faces the way it moves; a driven one the way its intent steered.
    if (!intent && velocity[0] !== 0) state.facing = velocity[0] < 0 ? -1 : 1;
    sim.x = shape.x; sim.y = shape.y;
}

const _shape: Body2DShape = { x: 0, y: 0, halfWidth: 0, height: 0 };
