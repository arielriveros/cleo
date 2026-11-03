import { World, Broadphase, SAPBroadphase } from 'cannon-es';

// ---------------------------------------------------------------------------
// Emptying a cannon World between play sessions. A leaf module on purpose: PhysicsSystem imports the
// engine barrel and cannot be loaded headlessly, and this is the one piece of its teardown that is worth
// driving from a test against a real World.
// ---------------------------------------------------------------------------

/**
 * Whether a broadphase keeps its own body list that `World.bodies` alone does not describe.
 *
 * `SAPBroadphase` is the only one in cannon-es that does, and it is what this engine runs
 * (`PhysicsSystem.initialize`), so the check is a type guard rather than a feature test.
 */
function hasOwnBodyList(broadphase: Broadphase | null | undefined): broadphase is SAPBroadphase {
    return broadphase instanceof SAPBroadphase;
}

/**
 * Remove every body from `world`, leaving it as empty as a freshly constructed one.
 *
 * TWO TRAPS, both of which stranded bodies in the broadphase for the lifetime of the page:
 *
 * 1. `World.removeBody` SPLICES `world.bodies`, so removing while iterating that same array — with
 *    `forEach` or an index loop — skips every other body. Iterate a copy.
 * 2. Assigning `world.bodies = []` empties the array without dispatching a single `removeBody` event.
 *    `SAPBroadphase` maintains its `axisList` purely from those events and `collisionPairs` iterates
 *    THAT, not `world.bodies` — so a truncated world still sorts, broadphases, narrowphases and solves
 *    every body it thinks it lost, and those ghosts still collide with the next session's live bodies.
 *
 * The broadphase resync at the end is not redundant with (1): it also heals a world whose `axisList`
 * was already corrupted earlier in the session, which is what makes this safe to ship into a running
 * editor rather than only into a fresh one.
 */
export function clearWorld(world: World): void {
    for (const body of [...world.bodies]) {
        body.velocity.set(0, 0, 0);
        body.angularVelocity.set(0, 0, 0);
        body.force.set(0, 0, 0);
        body.torque.set(0, 0, 0);
        world.removeBody(body);
    }

    // Rebuilds axisList from the (now empty) world.bodies and re-registers the add/remove handlers
    // without duplicating them — cannon removes the old pair first.
    if (hasOwnBodyList(world.broadphase)) world.broadphase.setWorld(world);

    world.clearForces();
}

/**
 * How many bodies the broadphase will actually iterate next step. Equal to `world.bodies.length` in a
 * healthy world; larger when something was removed without an event. Surfaced through `physicsStats` so
 * the divergence is visible in the HUD instead of only as a slow frame.
 */
export function broadphaseBodyCount(world: World): number {
    return hasOwnBodyList(world.broadphase) ? world.broadphase.axisList.length : world.bodies.length;
}
