// What an animator's graph and a character's reactions (physics/reactive/) say to each other, without the animation
// module importing physics: the reaction controller implements AnimatorReactionLink, and the animator finds it
// through its model (ModelNode.reactions, made on first ask). Read structurally.

/** What entering a Ragdoll state does to a character on its feet (see AnimationRagdollState). */
export type AnimationRagdollStart = 'fall' | 'trip' | 'limp';

/** A character's reactions, as its animator graph sees them. */
export interface AnimatorReactionLink {
    /** Off its feet and the physics': falling, tumbling, lying, dead. False once a get-up starts. */
    readonly ragdolled: boolean;
    /** Lying, alive and ready to rise (still long enough, not out cold), or asked to by a script (`getUp()`). */
    readonly canGetUp: boolean;
    /** Lying on its back (the hips and the chest facing up together). */
    readonly faceUp: boolean;
    /** Any reaction has the body (anything but plain animation). */
    readonly reacting: boolean;
    /** The character keeps its control: on its feet, flinching or staggering. */
    readonly hasControl: boolean;
    /** Shoved back on its feet, walking it out. */
    readonly staggering: boolean;
    /** Hits taken so far: rises by one with each (a shot, a blow, a car), whether the body reacts or not. */
    readonly hitCount: number;
    /**
     * The last hit's side, degrees, counter-clockwise like `planarAngle`: where it came FROM against the way the
     * character faces. From the front 0, from its right -90, its left +90, behind ±180.
     */
    readonly hitAngle: number;
    /** Where the last hit landed up the body, 0 (the feet) to 1 (the top of the head), on the skeleton at rest. */
    readonly hitHeight: number;
    /** How hard the last hit was, 0..1 (its impulse against the set's fall threshold). */
    readonly hitStrength: number;
    /** The rig's own get-up clips (its reaction set's): what a Get Up state naming none plays. */
    readonly getUpClips: { faceUp?: string; faceDown?: string };
    /** The graph entered a Ragdoll state: on its feet the body falls (`start`); off them it is only held. */
    graphRagdoll(start: AnimationRagdollStart): void;
    /** The graph entered a Get Up state: lying and ready, the body rises on it now (else when it is). */
    graphGetUp(): void;
}

/**
 * A get-up's clock, as the reaction controller follows it: a Get Up state's clip on the base layer, or an action
 * in the Reaction slot (an AnimationActionHandle has the same surface). Real seconds.
 */
export interface GetUpClock {
    readonly time: number;
    readonly duration: number;
    /** Over: the clip played out, or the graph left the state. */
    readonly done: boolean;
    seek(seconds: number): void;
    /** The get-up cut short (a hit knocked it down again). */
    stop(blendOut?: number): void;
}

/** Per-state reaction effects (AnimationState.reactions), merged over the base state and the layers'. */
export interface AnimationReactionEffects {
    /**
     * How the body takes hits, shoves and impacts in this state. `full` (default): as its reaction set says. `flinch`:
     * flinches only, never staggered or knocked down. `none`: the body does not react (the hit still counts: its Hit
     * event and the graph's hit parameters).
     */
    react?: 'full' | 'flinch' | 'none';
    /**
     * Hands that stay where they are (on a weapon, a wheel) rather than reach for a wound. `auto` (default): both while
     * the animator's support-hand IK holds a weapon, neither otherwise.
     */
    busyHands?: 'auto' | 'both' | 'left' | 'right' | 'none';
    /** Hits land this many times as hard (default 1): a braced crouch 0.6. */
    force?: number;
    /** Shoves carry it this many times as far (default 1). */
    shove?: number;
}

/** The effects in force now (Animator.reactionEffects). */
export interface ReactionEffectsNow {
    react: 'full' | 'flinch' | 'none';
    /** Null: no state says (auto). */
    busyHands: { L: boolean; R: boolean } | null;
    force: number;
    shove: number;
}

export const NO_REACTION_EFFECTS: Readonly<ReactionEffectsNow> = Object.freeze({ react: 'full', busyHands: null, force: 1, shove: 1 });
