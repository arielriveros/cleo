import type { ColliderDesc, Q4, V3 } from './types';

// A ragdoll PLANNED with a backend's own ragdoll tools before it is built (PhysicsWorld.planRagdoll, where
// `capabilities.ragdollPlanning`: Jolt's RagdollSettings): what each part should weigh and resist turning for the
// chain to stay stable, which pairs of parts must not collide (each with its parent, and the ones already touching
// in the pose it is planned in), and the order its joints are solved in. The engine then builds the ragdoll from
// its own bodies and joints, as on any backend (so they copy into the physics worker like every other), with these.

/** One part of a ragdoll to plan, in one frame for all (the bind pose, in model space). */
export interface RagdollPlanPart {
    /** Its parent part's index, -1 for the root. Parents come before their children. */
    parent: number;
    /** Its shape, as the body will have it (from its origin). */
    colliders: readonly ColliderDesc[];
    position: V3;
    rotation: Q4;
    /** kg, as the profile gives it. */
    mass: number;
}

export interface RagdollPlanInput {
    parts: readonly RagdollPlanPart[];
    /** Parts closer than this (m) count as touching: they must not collide (default 0.03). */
    minSeparation?: number;
    /** The lowest priority its joints take (default 0). */
    basePriority?: number;
    /**
     * Keep each part's mass as given (an anatomical one: a hand of 0.4 kg, a chest of 15), taking from the
     * stabilisation only how much it raised each part's inertia over its shape's: Jolt's Stabilize evens the masses
     * of a chain out (a hand of 3 kg), which a body that reacts must not have. Default false: its masses too.
     */
    keepMasses?: boolean;
}

export interface RagdollPlan {
    /** kg per part, stabilised and scaled back to the input's total. */
    masses: number[];
    /** Per part, its inertia about its centre of mass in its frame, [Ixx Iyy Izz Ixy Ixz Iyz]. */
    inertia: number[][];
    /** Per part, a bit per part it must not collide with (symmetric; the part's own bit clear). */
    ignore: number[];
    /** Per part, the priority of its joint to its parent (higher is solved later); the root's is unused. */
    priority: number[];
}

/**
 * The priority of each part's joint to its parent: the height of the chain below it (the longest run of joints down
 * to a hand or a foot), so a joint carrying more of the body is solved after the ones it carries and holds best (a
 * pelvis-to-spine joint carries the whole upper body, a wrist only a hand). Jolt's
 * RagdollSettings::CalculateConstraintPriorities, ported (tests/pal/joltRagdoll.test.ts holds it to the native one).
 */
export function ragdollJointPriorities(parents: readonly number[], base = 0): number[] {
    const height = parents.map(() => 0);
    // Parents come before their children: from the last part up, each gives its parent its height plus one.
    for (let i = parents.length - 1; i >= 0; i--) {
        const p = parents[i];
        if (p >= 0 && p < i) height[p] = Math.max(height[p], height[i] + 1);
    }
    return height.map(h => base + h);
}
