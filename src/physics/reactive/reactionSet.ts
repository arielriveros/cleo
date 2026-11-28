import type { AnimationPose } from '../../animation/animationPose';

// Reaction sets: how a skeleton reacts when it is hit, pushed, trips, falls or is thrown from a vehicle — the
// data a ReactionController (reactionController.ts) runs. Authored on the rig in the editor's Reactions tab
// and carried on the skin (Skin.reactionSets), like the ragdoll profile; a skeleton can hold several (a soldier
// and a civilian on the same rig) and a placed model picks one.
//
// Euphoria's model, in plain numbers: every joint is a MUSCLE (a spring toward the pose it is asked for, as
// stiff as its frequency, as damped as its damping ratio, no stronger than its torque), muscles are set per
// region of the body, and BEHAVIOURS (protect the head, brace for the ground, clutch a wound, take a step to
// keep balance...) each own some regions for a while and tell their muscles where to go. Every number here has
// a spec below — default, range, unit, what it does — which the editor's cards, the tolerant reader and the
// docs all read, so a parameter exists in one place.

/** Where a set's muscles are tuned. */
export type MuscleRegion = 'neck' | 'spine' | 'arms' | 'hands' | 'legs' | 'feet';
export const MUSCLE_REGIONS: readonly MuscleRegion[] = ['neck', 'spine', 'arms', 'hands', 'legs', 'feet'];

/** A region's muscles: see JointDrive (physics/pal/types.ts) for what each number does. */
export interface MuscleSettings {
    /** Hz: how stiffly it holds the pose it is asked for. */
    frequency: number;
    /** Damping ratio: 1 critical. */
    damping: number;
    /** N·m for a 70 kg body (scaled by the body's mass). */
    maxTorque: number;
    /** 0..1: how much of its own load it holds up without being asked. */
    gravityCompensation: number;
}

/** What a behaviour can be: the reflexes a reaction is made of. */
export type BehaviourId =
    | 'hitReact' | 'stepBalance' | 'catchFall' | 'protectHead' | 'landing' | 'airborne' | 'tumble' | 'vehicleBail'
    | 'struck' | 'writhe' | 'relax' | 'rollOver' | 'getUp';

/** A pose a behaviour reaches for (a slot): a pose asset in the editor, its bones embedded for the game. */
export interface ReactionPoseSlot {
    /** The pose asset it came from (editor only). */
    poseRef?: { assetId: string; poseId: string };
    /** Its bones, resolved: what the runtime reads. */
    pose?: AnimationPose;
}

export interface BehaviourConfig {
    enabled: boolean;
    params: Record<string, number>;
    /** Poses it reaches for, by slot (BEHAVIOUR_SPECS lists each behaviour's). */
    poses?: Record<string, ReactionPoseSlot>;
    /** Clips it plays, by slot: names of the rig's clips. */
    clips?: Record<string, string>;
}

export interface ReactionSet {
    id: string;
    name: string;
    /** Multiplies every muscle's torque and stiffness: a tough character, a weak one. */
    strength: number;
    muscles: Record<MuscleRegion, MuscleSettings>;
    /** The puppet strings that keep a hit character on its animation (see BodyPin). */
    pins: Record<string, number>;
    /** When a reaction moves from one stage to the next. */
    thresholds: Record<string, number>;
    behaviours: Record<BehaviourId, BehaviourConfig>;
}

export interface ReactionSets {
    version: 1;
    /** The set a model uses when it names none (else the first). */
    defaultSet?: string;
    sets: ReactionSet[];
}

/** One tunable number. */
export interface ReactionParamSpec {
    key: string;
    label: string;
    default: number;
    min: number;
    max: number;
    step: number;
    unit?: string;
    /** One sentence: what it does (the editor's tooltip and the docs' table). */
    doc: string;
}

/** A behaviour as the editor lists it: its numbers, and the poses and clips it can be given. */
export interface BehaviourSpec {
    id: BehaviourId;
    label: string;
    doc: string;
    params: ReactionParamSpec[];
    poses: { slot: string; label: string; doc: string }[];
    clips: { slot: string; label: string; doc: string }[];
}

const p = (key: string, label: string, def: number, min: number, max: number, step: number, unit: string | undefined, doc: string): ReactionParamSpec =>
    ({ key, label, default: def, min, max, step, ...(unit ? { unit } : {}), doc });

export const MUSCLE_SPECS: readonly ReactionParamSpec[] = [
    p('frequency', 'Stiffness', 2, 0, 20, 0.05, 'Hz', 'How firmly the muscles hold the pose they are asked for: about 1 is a relaxed limb, 4 a tense one, 10 rigid.'),
    p('damping', 'Damping', 1, 0, 3, 0.05, undefined, 'Damping ratio: 1 reaches the pose without overshooting, less swings past it, more is sluggish.'),
    p('maxTorque', 'Strength', 120, 0, 2000, 1, 'N·m', 'The most the muscles can push with (for a 70 kg body): what a fall or a hit overpowers.'),
    p('gravityCompensation', 'Hold up', 1, 0, 1, 0.05, undefined, 'How much of their own weight the muscles hold up without sagging toward the ground.'),
];

/** Euphoria's stiffness defaults (rad/s) as frequencies (Hz = rad/s ÷ 2π). */
export const MUSCLE_DEFAULTS: Record<MuscleRegion, MuscleSettings> = {
    neck: { frequency: 2.23, damping: 1, maxTorque: 40, gravityCompensation: 1 },
    spine: { frequency: 1.75, damping: 1, maxTorque: 250, gravityCompensation: 1 },
    arms: { frequency: 1.59, damping: 1, maxTorque: 80, gravityCompensation: 0.8 },
    hands: { frequency: 1.43, damping: 1, maxTorque: 12, gravityCompensation: 0.5 },
    legs: { frequency: 2.07, damping: 1, maxTorque: 250, gravityCompensation: 1 },
    feet: { frequency: 1.91, damping: 1, maxTorque: 120, gravityCompensation: 1 },
};

export const PIN_SPECS: readonly ReactionParamSpec[] = [
    p('frequency', 'Pull', 5, 0, 20, 0.1, 'Hz', 'How firmly the strings pull a hit character back onto its animation.'),
    p('damping', 'Damping', 1, 0, 3, 0.05, undefined, 'Damping ratio of the pull.'),
    p('maxForce', 'Force', 3000, 0, 20000, 10, 'N', 'The most each part may be pulled with (for a 70 kg body).'),
    p('maxTorque', 'Turn', 300, 0, 5000, 5, 'N·m', 'The most each part may be turned with.'),
    p('regain', 'Regain', 1, 0, 10, 0.05, '/s', 'How fast a hit part takes its strings back (1 = all of them in a second).'),
    p('legs', 'Legs', 1, 0, 1, 0.05, undefined, 'How firmly the legs stay on the animation while the upper body takes a hit.'),
];

export const THRESHOLD_SPECS: readonly ReactionParamSpec[] = [
    p('minHitImpulse', 'Smallest hit', 2, 0, 100, 0.5, 'N·s', 'A hit softer than this is ignored.'),
    p('staggerImpulse', 'Stagger at', 60, 0, 1000, 1, 'N·s', 'A hit at least this hard knocks the character back on its feet: it is shoved, its legs carrying it, and keeps its control.'),
    p('stumbleImpulse', 'Stumble at', 30, 0, 1000, 0.5, 'N·s', 'A hit on the trunk at least this hard (a heavy round) rocks the body back: a short shove it walks out of.'),
    p('stumbleSpeed', 'Stumble speed', 0.9, 0, 5, 0.05, 'm/s', 'How fast a stumbling hit shoves the character back.'),
    p('fallImpulse', 'Fall at', 150, 0, 2000, 5, 'N·s', 'A hit at least this hard knocks it straight down.'),
    p('fallUprightness', 'Fallen', 0.55, 0, 1, 0.01, undefined, 'Below this uprightness (1 standing, 0 lying) a character that is off balance counts as falling.'),
    p('highFallHeight', 'High fall', 1.5, 0, 50, 0.1, 'm', 'A drop at least this high is a fall from height: arms and legs flail on the way down.'),
    p('tumbleAngularSpeed', 'Tumbling', 3, 0, 30, 0.1, 'rad/s', 'Turning faster than this on the ground counts as tumbling (stairs, a slope, a bail at speed).'),
    p('downSpeed', 'Lying still', 0.6, 0, 5, 0.05, 'm/s', 'Slower than this, a fallen body is down.'),
    p('settleSpeed', 'Settled', 0.25, 0, 2, 0.01, 'm/s', 'Slower than this for Settle time, a body lying down has come to rest.'),
    p('settleTime', 'Settle time', 0.6, 0, 10, 0.05, 's', 'How long a body must stay still to count as at rest.'),
    p('maxReactionSeconds', 'Give up after', 15, 1, 120, 1, 's', 'A reaction that has not ended by then ends: the body lies where it is or gets up.'),
];

export const BEHAVIOUR_SPECS: readonly BehaviourSpec[] = [
    {
        id: 'hitReact', label: 'Hit reaction', doc: 'A hit staying on its feet: the struck part goes weak and snaps away, the head turns to it and the free hand reaches for the wound.',
        params: [
            p('weakness', 'Weakness', 0.5, 0, 1, 0.05, undefined, 'How much strength the struck part keeps at first (1 = none lost).'),
            p('weaknessTime', 'Recover in', 0.25, 0, 5, 0.05, 's', 'How long the struck part takes to get its strength back.'),
            p('trackStiffness', 'Tracking', 6, 0, 30, 0.1, 'Hz', 'How firmly the upper body follows the animation while the character stands: a hit is a sway on what it is doing, not a pull away from it.'),
            p('trackStrength', 'Tracking strength', 3, 0, 10, 0.05, undefined, 'The muscles\' strength while it stands, as a multiple of the set\'s.'),
            p('maxKick', 'Kick', 6, 0, 100, 0.5, 'N·s', 'The most of a hit\'s impulse the struck part takes while the character stands (the whole hit still decides whether it stumbles or falls).'),
            p('snap', 'Snap', 0.4, 0, 3, 0.05, undefined, 'An extra jolt to the spine and neck, away from the hit.'),
            p('reachDelay', 'Reach after', 0.1, 0, 2, 0.05, 's', 'How long before a hand goes to the wound.'),
            p('holdTime', 'Hold for', 1.2, 0, 10, 0.1, 's', 'How long a free hand holds the wound (a hand on a weapon does not leave it).'),
            p('maxReach', 'Reach', 0.65, 0, 1.5, 0.01, 'm', 'The farthest a hand reaches for a wound (beyond, it does not try).'),
            p('reachStiffness', 'Reach stiffness', 3, 0, 20, 0.1, 'Hz', 'How firmly the reaching arm holds the wound.'),
            p('reachPull', 'Reach pull', 0.5, 0, 1, 0.05, undefined, 'How firmly a string draws the hand onto the wound, as a share of the strings (0: the muscles of the arm alone).'),
            p('lookTime', 'Look for', 1, 0, 5, 0.05, 's', 'How long the head turns toward the wound.'),
            p('duration', 'Lasts', 1.4, 0.1, 10, 0.05, 's', 'How long a hit reaction runs before the character is back on its animation.'),
        ],
        poses: [{ slot: 'flinch', label: 'Flinch', doc: 'The body\'s recoil from a hit, blended in for a moment (spine, neck, arms).' }],
        clips: [],
    },
    {
        id: 'stepBalance', label: 'Stagger', doc: 'Knocked back but on its feet: it steps to stay up, short quick steps aimed a moment ahead on legs of its own (the physics\', not the animation\'s), tiring step by step, the upper body swaying after the hit. It keeps its control; past what its steps can catch, it falls.',
        params: [
            p('knockTime', 'Shove lasts', 0.35, 0.05, 2, 0.01, 's', 'How long the upper body\'s lean after the shove takes to fade by half.'),
            p('leanInto', 'Lean', 0.15, 0, 1, 0.01, 'rad', 'How far the upper body leans back the way it is shoved.'),
            p('prediction', 'Looks ahead', 0.2, 0, 1, 0.01, 's', 'How far ahead of the body each step is aimed: more makes fewer, longer steps.'),
            p('stepTime', 'Step time', 0.25, 0.1, 1, 0.01, 's', 'How long a foot takes from lifting to landing.'),
            p('stepHeight', 'Step height', 0.1, 0, 0.4, 0.01, 'm', 'How high a foot lifts on the way.'),
            p('stepLength', 'Step length', 0.4, 0.1, 1.2, 0.01, 'm', 'The longest step it takes from the planted foot.'),
            p('widthMin', 'Feet apart', 0.12, 0, 0.5, 0.01, 'm', 'The least it steps out to its own side of the planted foot: it never crosses its feet.'),
            p('widthMax', 'Widest step', 0.4, 0.1, 1, 0.01, 'm', 'The most it steps out to the side.'),
            p('maxSteps', 'Steps', 4, 1, 12, 1, undefined, 'How many steps it takes before it gives up and falls, if they have not caught it.'),
            p('tire', 'Tires to', 0.7, 0.1, 1, 0.01, undefined, 'The strength its legs keep with each step after the second.'),
            p('assist', 'Help', 1, 0, 2, 0.05, undefined, 'A hand keeping the trunk upright and the hips from sinking while it steps (0: its legs alone).'),
            p('maxShove', 'Falls above', 3, 0.5, 10, 0.1, 'm/s', 'A shove faster than this knocks it straight down: no step could catch it.'),
            p('giveUpTilt', 'Falls past', 0.6, 0.1, 1.5, 0.01, 'rad', 'How far the trunk may lean from upright before it falls.'),
            p('giveUpTime', 'For', 0.15, 0, 1, 0.01, 's', 'How long it must lean that far to fall.'),
            p('recoverTime', 'Recovered after', 0.4, 0, 3, 0.05, 's', 'How long it must stand over its feet, slow, before it is back on its animation.'),
        ],
        poses: [], clips: [],
    },
    {
        id: 'catchFall', label: 'Catch the fall', doc: 'Falling toward the ground: the hands reach for where the body will land, one after the other, the elbows give on impact and the knees bend.',
        params: [
            p('predictionTime', 'Sees ahead', 0.5, 0, 2, 0.05, 's', 'How far ahead it looks for the ground it will hit.'),
            p('handDelay', 'Second hand', 0.15, 0, 1, 0.01, 's', 'How long after the first hand the second reaches.'),
            p('armStiffness', 'Arm stiffness', 2.4, 0, 20, 0.05, 'Hz', 'How firmly the arms brace.'),
            p('absorbTime', 'Give for', 0.2, 0, 1, 0.01, 's', 'How long the arms give after the hands touch down.'),
            p('absorb', 'Give', 0.3, 0, 1, 0.05, undefined, 'Arm stiffness kept while they give.'),
            p('armForward', 'Reach ahead', 0.4, 0, 1, 0.01, 'm', 'How far ahead of the shoulders the hands go.'),
            p('kneeBend', 'Knee bend', 0.5, 0, 2, 0.05, 'rad', 'How far the knees bend to meet the ground.'),
        ],
        poses: [{ slot: 'brace', label: 'Brace', doc: 'Arms and legs readied for the ground; the hands still go where the fall lands.' }],
        clips: [],
    },
    {
        id: 'protectHead', label: 'Protect the head', doc: 'Falling head first, tumbling or rolling down stairs: the arms come up round the head and the chin tucks in.',
        params: [
            p('chinTuck', 'Chin tuck', 0.4, 0, 1.2, 0.05, 'rad', 'How far the head bends forward.'),
            p('neckStiffness', 'Neck stiffness', 3, 0, 20, 0.05, 'Hz', 'How firmly the neck holds it.'),
            p('armStiffness', 'Arm stiffness', 2.2, 0, 20, 0.05, 'Hz', 'How firmly the arms hold round the head.'),
            p('handSpread', 'Hands apart', 0.13, 0, 0.5, 0.01, 'm', 'How far beside the head the hands go.'),
            p('fadeTime', 'Fade', 0.15, 0, 1, 0.01, 's', 'How fast it comes and goes.'),
        ],
        poses: [{ slot: 'protect', label: 'Protect head', doc: 'Arms round the head (when set, instead of the hands going beside it).' }],
        clips: [],
    },
    {
        id: 'landing', label: 'Land', doc: 'Coming down feet first and upright: the knees and hips bend just before touchdown and soften to take the impact.',
        params: [
            p('leadTime', 'Ready', 0.3, 0, 1, 0.01, 's', 'How long before touchdown the legs get ready.'),
            p('uprightness', 'Upright enough', 0.85, 0, 1, 0.01, undefined, 'Less upright than this, it does not try to land on its feet.'),
            p('kneeBend', 'Knee bend', 1, 0, 2.2, 0.05, 'rad', 'How far the knees bend.'),
            p('hipBend', 'Hip bend', 0.6, 0, 1.6, 0.05, 'rad', 'How far the hips bend.'),
            p('absorbTime', 'Soften for', 0.25, 0, 1, 0.01, 's', 'How long the legs soften after touchdown.'),
            p('maxSpeed', 'Survivable', 12, 0, 50, 0.5, 'm/s', 'Landing faster than this, the legs give way.'),
        ],
        poses: [{ slot: 'landing', label: 'Landing', doc: 'The bent-knee pose to land in (when set, instead of the knee and hip bend).' }],
        clips: [],
    },
    {
        id: 'airborne', label: 'Fall from height', doc: 'A long drop: the arms windmill and the legs pedal on the way down (or play a clip).',
        params: [
            p('minTime', 'After', 0.35, 0, 3, 0.05, 's', 'How long the body must have been falling first.'),
            p('armSpeed', 'Arm speed', 7.9, 0, 30, 0.1, 'rad/s', 'How fast the arms circle.'),
            p('armAmplitude', 'Arm swing', 1.2, 0, 3, 0.05, 'rad', 'How wide the arms circle.'),
            p('legSpeed', 'Leg speed', 7.9, 0, 30, 0.1, 'rad/s', 'How fast the legs pedal.'),
            p('legAmplitude', 'Leg swing', 0.6, 0, 2, 0.05, 'rad', 'How wide the legs pedal.'),
            p('stiffness', 'Stiffness', 1.75, 0, 20, 0.05, 'Hz', 'How firmly the body moves while it flails.'),
        ],
        poses: [],
        clips: [{ slot: 'fall', label: 'Falling', doc: 'A falling clip played instead of the windmill (looped).' }],
    },
    {
        id: 'tumble', label: 'Tumble', doc: 'Rolling down stairs or a slope: the body curls up, keeps rolling rather than sliding, and the arms spread to slow it once it has slowed.',
        params: [
            p('stiffness', 'Stiffness', 1.75, 0, 20, 0.05, 'Hz', 'How firmly it holds the curl.'),
            p('damping', 'Damping', 1.4, 0, 3, 0.05, undefined, 'Damping ratio while curled.'),
            p('curl', 'Curl', 0.9, 0, 1.6, 0.05, 'rad', 'How far the spine, hips and knees fold.'),
            p('rollTorque', 'Roll', 0.6, 0, 3, 0.05, undefined, 'How much it is helped to keep rolling down the slope.'),
            p('slowDownSpeed', 'Spread below', 1.2, 0, 10, 0.05, 'm/s', 'Below this speed the arms spread to stop it.'),
        ],
        poses: [{ slot: 'curl', label: 'Curl pose', doc: 'The tucked pose to tumble in (when set, instead of the curl).' }],
        clips: [],
    },
    {
        id: 'vehicleBail', label: 'Bail out', doc: 'Thrown from a moving vehicle: it leaves with the vehicle\'s speed, clear of it for a moment, tucks into a ball in the air, puts its hands to the ground (or round its head, coming down fast) and rolls.',
        params: [
            p('inherit', 'Keeps speed', 1, 0, 1.5, 0.05, undefined, 'How much of the vehicle\'s velocity it leaves with.'),
            p('ejectSpeed', 'Thrown out', 2, 0, 15, 0.1, 'm/s', 'How fast it is thrown out through the door.'),
            p('ejectUp', 'Thrown up', 1, 0, 10, 0.1, 'm/s', 'How fast it is thrown upward.'),
            p('clearTime', 'Clear for', 0.35, 0, 3, 0.05, 's', 'How long it passes through the vehicle it left.'),
            p('kneeTuck', 'Knee tuck', 1.25, 0, 2.4, 0.05, 'rad', 'How far the knees fold in the air.'),
            p('hipTuck', 'Hip tuck', 1, 0, 2, 0.05, 'rad', 'How far the thighs come up toward the chest.'),
            p('curl', 'Trunk curl', 0.25, 0, 1, 0.01, 'rad', 'How far each part of the spine curls forward.'),
            p('chinTuck', 'Chin in', 0.5, 0, 1.2, 0.05, 'rad', 'How far the head bends to the chest.'),
            p('armsIn', 'Arms in', 0.8, 0, 2, 0.05, 'rad', 'How far the upper arms come in front of the chest, the elbows folded.'),
            p('stiffness', 'Tuck stiffness', 3, 0, 20, 0.05, 'Hz', 'How firmly it holds the tuck.'),
            p('catchTime', 'Hands down', 0.3, 0, 1, 0.01, 's', 'How long before it reaches the ground the hands go to meet it.'),
            p('catchSpeed', 'Too fast to catch', 7, 0, 30, 0.5, 'm/s', 'Coming down faster than this, the arms go round the head instead.'),
            p('rollSpeed', 'Rolls above', 2.5, 0, 20, 0.1, 'm/s', 'Moving along the ground faster than this when it lands, it rolls (a tumble).'),
        ],
        poses: [], clips: [],
    },
    {
        id: 'struck', label: 'Struck', doc: 'Hit by a vehicle: the legs are taken out and the body pivots over it. It braces as it goes: knees and hips bend, the trunk curls, the arms come up round the head.',
        params: [
            p('kneeBend', 'Knee bend', 1.1, 0, 2.2, 0.05, 'rad', 'How far the knees bend.'),
            p('hipBend', 'Hip bend', 0.8, 0, 1.6, 0.05, 'rad', 'How far the hips bend (and the trunk curls a third of that).'),
            p('stiffness', 'Stiffness', 3, 0, 20, 0.05, 'Hz', 'How firmly it holds the brace.'),
            p('duration', 'Lasts', 0.7, 0, 3, 0.05, 's', 'How long it braces (the head stays protected a little longer).'),
            p('legShare', 'Legs taken', 1, 0, 1.5, 0.05, undefined, 'How much of the vehicle\'s speed the legs take.'),
            p('trunkShare', 'Trunk thrown', 0.45, 0, 1.5, 0.05, undefined, 'How much of it the trunk takes: less than the legs, so the body pivots over.'),
            p('lift', 'Thrown up', 0.3, 0, 2, 0.05, undefined, 'Upward speed given, as a share of the vehicle\'s.'),
        ],
        poses: [], clips: [],
    },
    {
        id: 'writhe', label: 'Writhe', doc: 'Lying hurt: slow, weak movement, a hand on the wound (or a clip played softly).',
        params: [
            p('stiffness', 'Stiffness', 1.2, 0, 20, 0.05, 'Hz', 'How firmly it moves.'),
            p('damping', 'Damping', 0.5, 0, 3, 0.05, undefined, 'Damping ratio.'),
            p('period', 'Period', 1.6, 0.1, 10, 0.05, 's', 'How long one roll of the body takes.'),
            p('amplitude', 'Amplitude', 0.35, 0, 1.5, 0.05, 'rad', 'How far it rolls and bends.'),
            p('duration', 'Lasts', 4, 0, 60, 0.5, 's', 'How long it writhes before lying still (or getting up).'),
        ],
        poses: [],
        clips: [{ slot: 'writhe', label: 'Writhing', doc: 'A clip played as its movement, softly (looped).' }],
    },
    {
        id: 'relax', label: 'Relax', doc: 'Unconscious or dead: the muscles let go, a little friction in the joints.',
        params: [
            p('strength', 'Strength', 0.05, 0, 1, 0.01, undefined, 'Muscle strength kept.'),
            p('friction', 'Friction', 2, 0, 50, 0.5, 'N·m', 'Joint friction: how fast a limp limb stops swinging.'),
        ],
        poses: [], clips: [],
    },
    {
        id: 'rollOver', label: 'Roll over', doc: 'Lying on its front or its side when it is time to get up: it rolls onto its back first, the top leg crossing over and the top arm reaching over, then gets up with the clip for its back.',
        params: [
            p('twist', 'Twist', 0.35, 0, 1.2, 0.01, 'rad', 'How far the chest and the head lead the roll.'),
            p('speed', 'Roll speed', 2.5, 0, 10, 0.1, 'rad/s', 'How fast it turns over (slowing as it gets onto its back).'),
            p('giveUp', 'Tries for', 4, 0.5, 15, 0.5, 's', 'How long it tries before it gets up as it lies.'),
        ],
        poses: [], clips: [],
    },
    {
        id: 'getUp', label: 'Get up', doc: 'At rest on the ground and still able: it plays a get-up clip from where it lies, face up or face down, the body following the clip until it stands.',
        params: [
            p('delay', 'After', 1, 0, 10, 0.1, 's', 'How long it lies still first.'),
            p('strength', 'Strength', 1.5, 0, 5, 0.05, undefined, 'Muscle strength while it gets up.'),
            p('regainTime', 'Regain', 0.8, 0, 5, 0.05, 's', 'How long its strings take to pull it fully onto the clip.'),
            p('blendTime', 'Blend', 0.25, 0, 2, 0.01, 's', 'How long the skin takes to go from the body to the animation at the end.'),
        ],
        poses: [],
        clips: [
            { slot: 'faceUp', label: 'From the back', doc: 'The clip to get up with lying face up.' },
            { slot: 'faceDown', label: 'From the front', doc: 'The clip to get up with lying face down.' },
        ],
    },
];

export const BEHAVIOUR_IDS: readonly BehaviourId[] = BEHAVIOUR_SPECS.map(b => b.id);

const specDefaults = (specs: readonly ReactionParamSpec[]): Record<string, number> =>
    Object.fromEntries(specs.map(s => [s.key, s.default]));

/** A set with every number at its default. */
export function defaultReactionSet(name = 'Default', id = 'default'): ReactionSet {
    const behaviours = {} as Record<BehaviourId, BehaviourConfig>;
    for (const b of BEHAVIOUR_SPECS) behaviours[b.id] = { enabled: true, params: specDefaults(b.params) };
    const muscles = {} as Record<MuscleRegion, MuscleSettings>;
    for (const r of MUSCLE_REGIONS) muscles[r] = { ...MUSCLE_DEFAULTS[r] };
    return { id, name, strength: 1, muscles, pins: specDefaults(PIN_SPECS), thresholds: specDefaults(THRESHOLD_SPECS), behaviours };
}

/** Ready-made sets to start from: how a body built a certain way reacts. */
export const REACTION_PRESETS: { name: string; doc: string; make(): ReactionSet }[] = [
    { name: 'Default', doc: 'An ordinary adult.', make: () => defaultReactionSet('Default', 'default') },
    {
        name: 'Tough', doc: 'Strong and hard to topple: shrugs off small hits, steps more, falls later.', make: () => tune(defaultReactionSet('Tough', 'tough'), s => {
            s.strength = 1.5;
            s.thresholds.staggerImpulse = 100; s.thresholds.fallImpulse = 260;
            s.thresholds.stumbleImpulse = 45; s.thresholds.stumbleSpeed = 0.6;
            s.behaviours.stepBalance.params.giveUpTilt = 0.8; s.behaviours.stepBalance.params.knockTime = 0.25;
            s.behaviours.stepBalance.params.maxSteps = 6; s.behaviours.stepBalance.params.tire = 0.85;
            s.behaviours.hitReact.params.weakness = 0.75;
        }),
    },
    {
        name: 'Wounded', doc: 'Already hurt: weak, topples easily and writhes when down.', make: () => tune(defaultReactionSet('Wounded', 'wounded'), s => {
            s.strength = 0.6;
            s.thresholds.staggerImpulse = 30; s.thresholds.fallImpulse = 70; s.thresholds.stumbleImpulse = 12;
            s.behaviours.stepBalance.params.giveUpTilt = 0.4;
            s.behaviours.stepBalance.params.maxSteps = 2; s.behaviours.stepBalance.params.tire = 0.5;
            s.behaviours.hitReact.params.trackStiffness = 4;
            s.behaviours.writhe.params.duration = 10;
            s.behaviours.getUp.params.delay = 3;
        }),
    },
    {
        name: 'Drunk', doc: 'Loose and unsteady: big staggers, slow arms, a long time to get up.', make: () => tune(defaultReactionSet('Drunk', 'drunk'), s => {
            s.strength = 0.8;
            for (const r of MUSCLE_REGIONS) { s.muscles[r].frequency *= 0.6; s.muscles[r].damping = 0.6; }
            s.thresholds.staggerImpulse = 20; s.thresholds.stumbleImpulse = 15;
            s.behaviours.stepBalance.params.knockTime = 0.6; s.behaviours.stepBalance.params.leanInto = 0.3;
            s.behaviours.stepBalance.params.stepTime = 0.35; s.behaviours.stepBalance.params.stepLength = 0.5;
            s.behaviours.stepBalance.params.assist = 0.7;
            s.behaviours.hitReact.params.trackStiffness = 3;
            s.behaviours.catchFall.params.predictionTime = 0.2;
            s.behaviours.getUp.params.delay = 2.5;
        }),
    },
    {
        name: 'Stiff', doc: 'Tense and rigid: a soldier, a robot.', make: () => tune(defaultReactionSet('Stiff', 'stiff'), s => {
            for (const r of MUSCLE_REGIONS) s.muscles[r].frequency *= 1.8;
            s.pins.frequency = 8;
            s.behaviours.hitReact.params.trackStiffness = 10;
        }),
    },
    {
        name: 'Loose', doc: 'Soft and floppy: a child\'s toy, a body barely conscious.', make: () => tune(defaultReactionSet('Loose', 'loose'), s => {
            s.strength = 0.5;
            for (const r of MUSCLE_REGIONS) { s.muscles[r].frequency *= 0.5; s.muscles[r].gravityCompensation *= 0.5; }
            s.behaviours.getUp.params.delay = 2;
        }),
    },
];

function tune(s: ReactionSet, f: (s: ReactionSet) => void): ReactionSet { f(s); return s; }

/** A spec's value from untrusted input: clamped into range, the default for anything not a number. */
function specValue(spec: ReactionParamSpec, v: unknown): number {
    if (typeof v !== 'number' || !Number.isFinite(v)) return spec.default;
    return Math.min(spec.max, Math.max(spec.min, v));
}

function readParams(specs: readonly ReactionParamSpec[], raw: unknown): Record<string, number> {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    return Object.fromEntries(specs.map(s => [s.key, specValue(s, r[s.key])]));
}

/** Tolerant reader for one stored set: every number clamped, every missing one its default, unknown keys dropped. */
export function parseReactionSet(raw: unknown, index = 0): ReactionSet {
    const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<ReactionSet> & Record<string, unknown>;
    const base = defaultReactionSet();
    const muscles = {} as Record<MuscleRegion, MuscleSettings>;
    const rm = (r.muscles && typeof r.muscles === 'object' ? r.muscles : {}) as Record<string, unknown>;
    for (const region of MUSCLE_REGIONS) {
        const m = (rm[region] && typeof rm[region] === 'object' ? rm[region] : {}) as Record<string, unknown>;
        const d = MUSCLE_DEFAULTS[region];
        muscles[region] = Object.fromEntries(MUSCLE_SPECS.map(s => [s.key, specValue({ ...s, default: d[s.key as keyof MuscleSettings] }, m[s.key])])) as unknown as MuscleSettings;
    }
    const behaviours = {} as Record<BehaviourId, BehaviourConfig>;
    const rb = (r.behaviours && typeof r.behaviours === 'object' ? r.behaviours : {}) as Record<string, unknown>;
    for (const spec of BEHAVIOUR_SPECS) {
        const b = (rb[spec.id] && typeof rb[spec.id] === 'object' ? rb[spec.id] : {}) as Partial<BehaviourConfig>;
        const config: BehaviourConfig = { enabled: b.enabled !== false, params: readParams(spec.params, b.params) };
        const poses: Record<string, ReactionPoseSlot> = {};
        for (const slot of spec.poses) {
            const s = (b.poses as Record<string, ReactionPoseSlot> | undefined)?.[slot.slot];
            if (!s || typeof s !== 'object') continue;
            const kept: ReactionPoseSlot = {};
            if (s.poseRef && typeof s.poseRef.assetId === 'string' && typeof s.poseRef.poseId === 'string') kept.poseRef = { assetId: s.poseRef.assetId, poseId: s.poseRef.poseId };
            if (s.pose && Array.isArray(s.pose.bones)) kept.pose = s.pose;
            if (kept.poseRef || kept.pose) poses[slot.slot] = kept;
        }
        if (Object.keys(poses).length) config.poses = poses;
        const clips: Record<string, string> = {};
        for (const slot of spec.clips) {
            const c = (b.clips as Record<string, unknown> | undefined)?.[slot.slot];
            if (typeof c === 'string' && c) clips[slot.slot] = c;
        }
        if (Object.keys(clips).length) config.clips = clips;
        behaviours[spec.id] = config;
    }
    return {
        id: typeof r.id === 'string' && r.id ? r.id : `set${index}`,
        name: typeof r.name === 'string' && r.name ? r.name : base.name,
        strength: specValue(p('strength', '', 1, 0, 5, 0.05, undefined, ''), r.strength),
        muscles,
        pins: readParams(PIN_SPECS, r.pins),
        thresholds: readParams(THRESHOLD_SPECS, r.thresholds),
        behaviours,
    };
}

/** Tolerant reader for a skeleton's sets; undefined for anything that is not one. */
export function parseReactionSets(raw: unknown): ReactionSets | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const r = raw as Partial<ReactionSets>;
    if (!Array.isArray(r.sets)) return undefined;
    const sets = r.sets.map((s, i) => parseReactionSet(s, i));
    return { version: 1, ...(typeof r.defaultSet === 'string' && sets.some(s => s.id === r.defaultSet || s.name === r.defaultSet) ? { defaultSet: r.defaultSet } : {}), sets };
}

/** The set named `name` (by id or name), else the default one, else the first, else the built-in default. */
export function pickReactionSet(sets: ReactionSets | undefined | null, name?: string | null): ReactionSet {
    const list = sets?.sets ?? [];
    const by = (n: string | undefined | null) => (n ? list.find(s => s.id === n || s.name === n) : undefined);
    return by(name) ?? by(sets?.defaultSet) ?? list[0] ?? defaultReactionSet();
}

/** Every tunable number of a set, flattened ('muscles.arms.frequency', 'behaviours.hitReact.weakness'...): what the docs list. */
export function reactionParamKeys(): string[] {
    const keys: string[] = ['strength'];
    for (const r of MUSCLE_REGIONS) for (const s of MUSCLE_SPECS) keys.push(`muscles.${r}.${s.key}`);
    for (const s of PIN_SPECS) keys.push(`pins.${s.key}`);
    for (const s of THRESHOLD_SPECS) keys.push(`thresholds.${s.key}`);
    for (const b of BEHAVIOUR_SPECS) for (const s of b.params) keys.push(`behaviours.${b.id}.${s.key}`);
    return keys;
}
