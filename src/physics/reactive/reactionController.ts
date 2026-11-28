import { vec3 } from 'gl-matrix';
import type { BodyPin, JointDrive } from '../pal/types';
import type { ModelNode } from '../../core/scene/nodes/modelNode';
import type { Node } from '../../core/scene/nodes/node';
import type { AnimatedModel, Skin } from '../../animation/animatedModel';
import type { PhysicsSystem } from '../physicsSystem';
import type { PhysicsBody } from '../physicsBody';
import { LAYER } from '../collisionLayers';
import type { Ragdoll } from '../ragdoll';
import { resolveEvent } from '../../core/events/hub';
import { clamp, closestSegmentSegment, planarSignedAngle, quatConjugateTuple, quatMultiplyTuple, quatRotateTuple, quatToRotationVector, rotationVectorToQuat, yawFromDirection } from '../../core/math';
import { cachedRagdollLayout, ragdollPartPoseInto, skinRagdollProfile, type RagdollLayout } from '../ragdollProfile';
import { physicsStats } from '../physicsStats';
import type { mat4 } from 'gl-matrix';
import { BodySensors, classifyLying, type ContactList, type Raycaster, type SensorDetail } from './bodySensors';
import { clipRiseStart } from '../../animation/clipRiseStart';
import { ReactionBody } from './reactionBody';
import { BAILS, BEHAVIOURS, rollAngle, STRUCK, type HitZone, type ReactionBehaviour, type ReactionContext, type ReactionState, type ReactionWound } from './behaviours';
import { NO_REACTION_EFFECTS, type AnimationRagdollStart, type AnimatorReactionLink, type GetUpClock, type ReactionEffectsNow } from '../../animation/reactionLink';
import { pickReactionSet, parseReactionSets, type ReactionSet } from './reactionSet';
import { Balancer } from './balancer';
import { Nerves, reflexEnvelope, TONE_DELAY } from './nerves';

export type { HitZone, ReactionState, ReactionWound } from './behaviours';

// A character's reactions: Euphoria's reactive ragdoll for one skinned model. It owns a POWERED ragdoll while
// a reaction runs (physics/ragdoll.ts — the animation keeps playing underneath as the muscles' target) and
// moves it through a few states:
//
//   animated ─hit─► hitReact ─shoved─► stagger ─tipped over─► falling ─lands─► tumble ─► down ─► getUp ─► recover ─► animated
//                      └──────── recover ◄─ walked it out ◄──┘                (dead: no getting up)
//
// ON ITS FEET (hitReact, stagger and a recovery from them) a reaction is PHYSICAL ANIMATION, as Unreal's Physical
// Animation and PuppetMaster do it: the character keeps its Collider and its control, its legs and hips are
// kinematic on the animation (moved to where it has them every step), and its upper body is dynamic on firm muscles
// that follow the animation with its motion, so a hit is a sway on whatever the animation does and a stagger is a
// shove on the capsule (CharacterNode.knockback) the legs walk out of. OFF THEM (falling, tumble, down, getUp, dead)
// the body has every part, alive: its muscles brace and protect and tire on the ground; the Collider is out of the
// world and follows the hips, so cameras and AI follow the body; getting up puts it back.
//
// Each state lets some behaviours run (behaviours.ts: protect the head, catch the fall, lean into a shove...),
// which compose the muscles' targets and stiffness; the controller sends them on before every physics step and
// measures the body (bodySensors.ts) after it. It fires `reaction:*` events at the model node (they bubble to the
// Character): Hit, Started, Stagger, Fell, Landed, Down, Settled, GettingUp, GotUp, Recovered, Died.

/** A hit, as a script reports it (a bullet, a punch, a car). */
export interface ReactionHit {
    /** Where it landed (world). Default: the chest. */
    point?: ArrayLike<number>;
    /** Which way it pushed (world, normalised here). */
    direction?: ArrayLike<number>;
    /** How hard, N·s along `direction`. */
    impulse?: number;
    /** The part it hit, by index (Ragdoll.parts), name ("Forearm L") or role ('foreArm.L'). Default: nearest `point`. */
    part?: number | string;
    /** 0..1 of the character's health it takes; at 0 health it dies. */
    damage?: number;
}

/** The payload of every `reaction:*` event. */
export interface ReactionEventInfo {
    event: string;
    state: ReactionState;
    from: ReactionState | null;
    node: ModelNode;
    controller: ReactionController;
    part?: number;
    partName?: string;
    impulse?: number;
    point?: [number, number, number];
    /** Hit: where on the body it landed. */
    zone?: HitZone;
    fallHeight?: number;
    impactSpeed?: number;
    faceUp?: boolean;
    /** How it lies (Down, Settled, GettingUp): 1 on its back, −1 on its front, 0 on its side. */
    lying?: -1 | 0 | 1;
}

/** Per-model settings (ModelNode.ragdollConfig.reactions). */
export interface ModelReactionConfig {
    /** The reaction set to use, by id or name (default: the skeleton's default). */
    set?: string | null;
    /** Multiplies every muscle: a tough character, a weak one. */
    strength?: number;
    /** Starting health 0..1. */
    health?: number;
    /** False: a reaction that ends on the ground stays there. */
    getUp?: boolean;
    /** False: no reactions at all (hits go to the capsule, as before). */
    enabled?: boolean;
}

const REACTION_SLOT = 'Reaction';
/** The body mass the sets' strengths are given for. */
const REFERENCE_MASS = 70;
/** On its feet, how fast a part's drawing moves between the animation and the body (of the whole way, per second). */
const MAP_RATE = 1 / 0.15;
/** On its feet, the most a hit may change the struck part's velocity (m/s): what is left of it is the shove's. */
const MAX_KICK_SPEED = 1.2;
/** The upper body counts as back on its animation once no part of it is farther from it than this (radians). */
const TRACKED = 6 * Math.PI / 180;
/** A hit's impulse counts toward a stagger or a fall for this long (s): a burst adds up. */
const RECENT_HITS = 1;
/**
 * How long a kinematic part takes to catch up with its animation when it has drifted from it (s), and the fastest
 * that correction moves and turns it (m/s, rad/s): on top of the animation's own motion. Slow enough to stay steady
 * with the physics worker's step or two of latency.
 */
const KINEMATIC_CATCH_UP = 0.1;
const MAX_CATCH_UP_SPEED = 2;
const MAX_CATCH_UP_SPIN = 6;
/** The same with the physics worker, whose pose is older still: gentler, so a stale gap is never chased. */
const KINEMATIC_CATCH_UP_WORKER = 0.5;
const MAX_CATCH_UP_SPEED_WORKER = 0.5;
const MAX_CATCH_UP_SPIN_WORKER = 2;
/** The fastest the animation itself moves and turns a kinematic part (m/s, rad/s): past it, a jump, not a motion. */
const KINEMATIC_MAX_SPEED = 7;
const KINEMATIC_MAX_SPIN = 8;
function clampLength(v: number[], max: number): number[] {
    const n = Math.hypot(v[0], v[1], v[2]);
    if (!Number.isFinite(n)) return [0, 0, 0];
    return n > max ? [v[0] * max / n, v[1] * max / n, v[2] * max / n] : v;
}
/** The fastest shoves add up to, in Stumble speeds. */
const MAX_KNOCK_SPEEDS = 2;
/** A shove faster than this (m/s) lets the feet go (Animator.footLockSuppressed): they cannot stay planted. */
const KNOCK_UNLOCKS_FEET = 0.15;
/** A clip playing from `start` seconds in, as a get-up clock whose time and length count from there. */
function clockFrom(action: GetUpClock, start: number): GetUpClock {
    if (!(start > 0)) return action;
    return {
        get time() { return Math.max(0, action.time - start); },
        get duration() { return Math.max(0, action.duration - start); },
        get done() { return action.done; },
        seek: (seconds: number) => action.seek(start + Math.max(0, seconds)),
        stop: (blendOut?: number) => action.stop(blendOut),
    };
}

/** A part of the body that is the animation's while the character stands (kinematic on it). */
const LOWER = (region: string) => region === 'pelvis' || region === 'legs' || region === 'feet';
/** The states whose muscles follow the reference pose (off its feet). */
const OFF_FEET_REF = (s: ReactionState) => s === 'falling' || s === 'tumble' || s === 'down' || s === 'dead';
/** What a body dropped out cold (a graph's limp Ragdoll state) does not do: no hand out, no head tucked, no reach. */
const LIMP_OFF = new Set(['hitReact', 'catchFall', 'protectHead', 'landing', 'airborne', 'tumble', 'writhe']);
const IDENTITY = new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) as unknown as mat4;
/** The skeleton at rest, per skin: each part's centre, long axis and half-length, and how high the body reaches. */
const REST_BODIES = new WeakMap<object, { parts: Map<string, { c: number[]; y: number[]; half: number }>; min: number; max: number } | null>();

export class ReactionController implements AnimatorReactionLink {
    public readonly node: ModelNode;
    private readonly _physics: PhysicsSystem;
    public set: ReactionSet;
    public readonly sensors = new BodySensors();
    public ragdoll: Ragdoll | null = null;
    private _body: ReactionBody | null = null;
    private _state: ReactionState = 'animated';
    private _stateTime = 0;
    private _time = 0;
    private _health = 1;
    private _alive = true;
    private _strength = 1;
    private _unconsciousUntil = 0;
    private readonly _wounds: ReactionWound[] = [];
    private readonly _running = new Map<ReactionBehaviour, number>();
    private _prevAnim: number[][] = [];
    private _clip: string | null = null;
    /** The get-up's clip: a Get Up state's on the base layer (Animator.playGetUp), or the Reaction slot's action. */
    private _getUpAction: GetUpClock | null = null;
    /** Asked to get up (getUp()) while the graph holds the body in a Ragdoll state: CanGetUp says so. */
    private _riseAsked = false;
    /** Out cold (a graph's limp Ragdoll state): no protective behaviours, no firm start. */
    private _limp = false;
    /** Stepping to stay on its feet (a stagger on legs of its own), the steps, and the shove they answer. */
    private _stepping = false;
    private _balancer: Balancer | null = null;
    private readonly _shoveV = [0, 0, 0];
    private readonly _brakeV = [0, 0, 0];
    private _shoveWait = 0;
    private _knockCount = 0;
    /** How it lies off its feet (classifyLying), null on them. */
    private _lying: -1 | 0 | 1 | null = null;
    /** Rolling onto its back before it gets up, which way (+1: its left side up), since when; rolled already. */
    private _rolling = false;
    private _rollSign = 1;
    private _rollStart = 0;
    private _rolled = false;
    /** The last hit, for the graph's hit parameters (AnimatorReactionLink). */
    private readonly _lastHit = { count: 0, angle: 0, height: 0.5, strength: 0 };
    /** Reaction-clock seconds the current reaction began at (it left plain animation). */
    private _reactionStart = 0;
    /** Recovering from a get-up: the skin is the animation's already (see _base). */
    private _recoverFromGetUp = false;
    private _landed = false;
    private _settledSent = false;
    private _clearUntil = 0;
    private _clearBody: { collisionFilterMask: number } | null = null;
    private _clearMask = 0;
    private _feetOffset = 0;
    private readonly _drive: JointDrive = { frequency: 0, damping: 1, maxTorque: 0, friction: 0, gravityCompensation: 0 };
    private readonly _pin: BodyPin = { linearFrequency: 0, angularFrequency: 0, damping: 1, maxForce: 0, maxTorque: 0 };
    private readonly _vel = [0, 0, 0, 0, 0, 0];
    /** What every behaviour was doing last frame, by part: for the bench's timeline. */
    public readonly owners: (string | null)[] = [];
    /**
     * Which hands are busy (on a weapon, a wheel) and so never leave it for a wound: set by a script each frame or
     * once. Null: both while the animator's support-hand IK holds a weapon in two hands, neither otherwise.
     */
    public busyHands: { L: boolean; R: boolean } | null = null;
    /** The legs and hips kinematic on the animation (the character on its feet). */
    private _split = false;
    /** Per part, how much of it is drawn simulated now (moved toward the state's by MAP_RATE). */
    private _mapNow = new Float64Array(0);
    private _tiltFor = 0;
    private _fallStart = 0;
    /** The shove it walks out of (world m/s), fading with a half-life of `_knockHalfLife` (also given to the Character). */
    private readonly _knockV = [0, 0, 0];
    private _knockHalfLife = 0.35;
    /** Recent hits' impulses and when (reaction clock): a burst adds up to a stagger or a fall. */
    private readonly _recent: { at: number; impulse: number }[] = [];
    private readonly _q = [0, 0, 0, 1];

    constructor(node: ModelNode, physics: PhysicsSystem) {
        this.node = node;
        this._physics = physics;
        const cfg = this.config;
        this.set = pickReactionSet(parseReactionSets(this._skin?.reactionSets), cfg.set);
        this._strength = cfg.strength ?? 1;
        this._health = Math.max(0, Math.min(1, cfg.health ?? 1));
    }

    // ---- what it is doing ----

    public get state(): ReactionState { return this._state; }
    /** Seconds in the current state. */
    public get stateTime(): number { return this._stateTime; }
    /** A reaction has the body (anything but plain animation). */
    public get reacting(): boolean { return this._state !== 'animated'; }
    /**
     * Off its feet: falling, tumbling, down, getting up (to the end of its get-up clip and the blend back onto the
     * animation: the recovery that follows it) or dead.
     */
    public get isDown(): boolean {
        return this._offFeet() || (this._state === 'recover' && this._recoverFromGetUp);
    }
    /**
     * The character keeps its control: on its feet, flinching or staggering (its Collider live, its legs on its
     * animation); a script goes on moving, aiming and firing it. False off its feet ({@link isDown}), the whole
     * get-up included: a brain or a stick that took over before the clip had finished walked the body out of it.
     */
    public get hasControl(): boolean { return !this.isDown; }
    /** On its feet with a reaction running: the legs on the animation, the upper body following it. */
    public get standing(): boolean { return this._standingState(); }
    /** Lying on its back: its hips and chest facing up together (the sensors' guess before there is a body). */
    public get faceUp(): boolean { return this._lyingFaceUp(); }
    /**
     * How it lies, off its feet: 1 on its back, −1 on its front, 0 on its side (the front of its hips and chest
     * against up, with some give either way so it does not flicker: classifyLying). 0 on its feet.
     */
    public get lying(): -1 | 0 | 1 { return this._lying ?? 0; }
    /** Rolling onto its back to get up (the set's Roll over). */
    public get rollingOver(): boolean { return this._rolling; }
    /** Off its feet and the physics': falling, tumbling, lying, dead (not getting up). */
    public get ragdolled(): boolean { const s = this._state; return s === 'falling' || s === 'tumble' || s === 'down' || s === 'dead'; }
    /** Lying, alive and ready to rise, or asked to (getUp() while the graph holds it). */
    public get canGetUp(): boolean { return this._mayRise() && (this._asked() || this._readyToRise()); }
    /** Shoved back on its feet, stepping to stay up. */
    public get staggering(): boolean { return this._state === 'stagger'; }
    /** The steps it is taking to stay on its feet (a stagger), or took in its last one; null before any. */
    public get balance(): Balancer | null { return this._balancer; }
    /** Times it has been knocked off balance so far: each stagger and each fall from its feet. */
    public get knockCount(): number { return this._knockCount; }
    /**
     * How much it hurts now, 0..1 (Euphoria's conscious pain): each wound's, by how hard it was against the fall
     * threshold, rising over 0.2 s, held a second, easing off over 1.5 s; a knock off balance hurts too.
     */
    public get pain(): number {
        let p = 0;
        const now = this._physics.simulatedTime;
        for (const w of this._wounds) {
            const age = now - w.clock, sev = w.severity;
            const rise = Math.min(1, Math.max(0, age / 0.2));
            p += sev * rise * (age < 1.2 ? 1 : Math.exp(-(age - 1.2) / 1.5));
        }
        return Math.min(1, p);
    }
    /** Hits taken so far (each a shot, a blow, a car's), whether the body reacted or not. */
    public get hitCount(): number { return this._lastHit.count; }
    /** The last hit's side: where it came from against the way the character faces, degrees (front 0, its left +90). */
    public get hitAngle(): number { return this._lastHit.angle; }
    /** Where up the body the last hit landed, 0 (feet) to 1 (top of the head), on the skeleton at rest. */
    public get hitHeight(): number { return this._lastHit.height; }
    /** How hard the last hit was, 0..1 against the fall threshold. */
    public get hitStrength(): number { return this._lastHit.strength; }
    /** The rig's get-up clips (its reaction set's). */
    public get getUpClips(): { faceUp?: string; faceDown?: string } { return this.set.behaviours.getUp.clips ?? {}; }
    public get alive(): boolean { return this._alive; }
    public get health(): number { return this._health; }
    public set health(v: number) { this._health = Math.max(0, Math.min(1, v)); }
    public get wounds(): readonly ReactionWound[] { return this._wounds; }
    /** Multiplies every muscle on top of the set's own strength. */
    public get strength(): number { return this._strength; }
    public setStrength(v: number): void { this._strength = Math.max(0, v); }
    /** The model's own reaction settings. */
    public get config(): ModelReactionConfig { return ((this.node.ragdollConfig as { reactions?: ModelReactionConfig } | null)?.reactions) ?? {}; }
    /** The reaction body: poses and muscle targets per part (null while plain animation). */
    public get body(): ReactionBody | null { return this._body; }
    /** Which behaviours run now, and how strongly (0..1). */
    public get behaviours(): ReadonlyMap<string, number> { return new Map([...this._running].map(([b, w]) => [b.id, w])); }

    /**
     * The part a ray (world, `from` to `to`) strikes on the body as it is now — the simulated parts while a
     * reaction has it, else the parts as the animation poses them (a character that has not been touched yet has
     * no bodies to hit) — and where along the ray. What a gun asks before it has a body to shoot.
     */
    public partByRay(from: ArrayLike<number>, to: ArrayLike<number>): { part: string; point: [number, number, number]; distance: number } | null {
        const segs = this._segments();
        if (!segs.length) return null;
        const a: [number, number, number] = [from[0], from[1], from[2]], b: [number, number, number] = [to[0], to[1], to[2]];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1;
        let best: { part: string; point: [number, number, number]; distance: number } | null = null;
        for (const s of segs) {
            const k = Math.max(0, s.half - s.r);
            const p0: [number, number, number] = [s.c[0] - s.y[0] * k, s.c[1] - s.y[1] * k, s.c[2] - s.y[2] * k];
            const p1: [number, number, number] = [s.c[0] + s.y[0] * k, s.c[1] + s.y[1] * k, s.c[2] + s.y[2] * k];
            const hit = closestSegmentSegment(a, b, p0, p1);
            if (hit.dist2 > s.r * s.r) continue;
            // Back along the ray to the capsule's surface.
            const along = Math.hypot(hit.c1[0] - a[0], hit.c1[1] - a[1], hit.c1[2] - a[2]) - Math.sqrt(Math.max(0, s.r * s.r - hit.dist2));
            if (best && along >= best.distance) continue;
            const t = Math.max(0, along) / len;
            best = { part: s.name, point: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], distance: Math.max(0, along) };
        }
        return best;
    }

    /**
     * The body's parts as capsule segments (centre, long axis, half-length, radius): the simulated parts while a
     * reaction has it, else the parts as the animation poses them.
     */
    private _segments(): { name: string; c: [number, number, number]; y: [number, number, number]; half: number; r: number }[] {
        const skin = this._skin, animator = this.node.animator;
        const segs: { name: string; c: [number, number, number]; y: [number, number, number]; half: number; r: number }[] = [];
        if (!skin || !animator) return segs;
        if (this.ragdoll && !this.ragdoll.destroyed) {
            for (const p of this.ragdoll.parts) {
                const b = p.body, q = b.quaternion;
                segs.push({ name: p.name, c: [b.position.x, b.position.y, b.position.z], y: quatRotateTuple([q.x, q.y, q.z, q.w], [0, 1, 0]), half: p.halfLength, r: p.radius });
            }
            return segs;
        }
        const layout = this._layout();
        if (!layout) return segs;
        const bones = animator.getFinalBoneMatrices(), world = this.node.worldTransform as mat4, pose = [0, 0, 0, 0, 0, 0, 1];
        for (const lp of layout.parts) {
            const scale = ragdollPartPoseInto(skin, lp, world, bones[lp.joint] as mat4, pose);
            segs.push({ name: lp.part.name, c: [pose[0], pose[1], pose[2]], y: quatRotateTuple([pose[3], pose[4], pose[5], pose[6]], [0, 1, 0]), half: lp.length * scale / 2, r: lp.radius * scale });
        }
        return segs;
    }

    /** The ragdoll layout a reaction would build, for hits before it has (cached per skin and profile). */
    private _layout(): RagdollLayout | null {
        const skin = this._skin;
        if (!skin) return null;
        const profile = skinRagdollProfile(skin);
        return profile ? cachedRagdollLayout(skin, profile) : null;
    }

    /** Use another of the skeleton's reaction sets (by id or name). */
    public useSet(name: string): void { this.set = pickReactionSet(parseReactionSets(this._skin?.reactionSets), name); }

    // ---- what scripts ask of it ----

    /**
     * A hit: a bullet, a punch. On its feet a hit is a flinch of the upper body on whatever the animation does; a
     * harder one (or a burst adding up) shoves the character back on its feet, a stagger it keeps its control
     * through; the hardest knock it down.
     */
    public hit(h: ReactionHit = {}): void {
        if (this.config.enabled === false) return;
        const T = this.set.thresholds;
        // How the graph's states have it take hits now (AnimationState.reactions): harder or softer, flinch only, none.
        const fx = this._effectsNow();
        const dir = h.direction ? vec3.normalize(vec3.create(), [h.direction[0], h.direction[1], h.direction[2]]) : vec3.fromValues(0, 0, -1);
        const impulse = Math.max(0, h.impulse ?? 20) * fx.force;
        if (h.damage) this._health = Math.max(0, this._health - h.damage);
        const dying = this._alive && this._health <= 0;
        if (impulse < T.minHitImpulse && !dying) return;
        this._noteHit(dir, h.point ?? null, impulse, h.part);
        if (fx.react === 'none' && !dying) {
            // The hit counts (its event, the graph's hit parameters); the body does not take it.
            const point = h.point ? [h.point[0], h.point[1], h.point[2]] as [number, number, number] : [0, 0, 0] as [number, number, number];
            this._emit('Hit', { part: -1, partName: this._partNameOf(h.part), impulse, point });
            return;
        }
        const full = fx.react === 'full';
        const recent = this._addRecent(impulse);
        const onFeet = this._onFeetState();
        const falls = dying || (full && (impulse >= T.fallImpulse || (onFeet && recent >= T.fallImpulse)));
        const stepping = this.set.behaviours.stepBalance.enabled;
        // A hit it would only flinch or stumble from asks for a body within the budget (PhysicsSystem.maxPoweredRagdolls);
        // refused, the hit still counts (its Hit event), and a stumble still shoves the capsule.
        const r = this._ensure(falls ? 'fall' : 'flinch');
        // Rocked back by a hard hit, a burst adding up, or a heavy round in the trunk: a stagger, kept on its feet.
        const region = this._regionOf(h.part, h.point);
        const legHit = region === 'legs' || region === 'feet';
        const staggers = full && onFeet && stepping && !falls && fx.shove > 0 && (impulse >= T.staggerImpulse || recent >= T.staggerImpulse
            || ((region === 'pelvis' || region === 'spine') && T.stumbleImpulse > 0 && impulse >= T.stumbleImpulse)
            // A leg hit gives the leg: it steps on it.
            || (legHit && T.stumbleImpulse > 0 && impulse >= T.stumbleImpulse * this.set.behaviours.hitReact.params.legStagger));
        if (!r) {
            if (!this.ragdoll && this.node.animator && this._skin) {
                const point = h.point ? [h.point[0], h.point[1], h.point[2]] as [number, number, number] : [0, 0, 0] as [number, number, number];
                this._emit('Hit', { part: -1, partName: this._partNameOf(h.part), impulse, point });
            }
            if (staggers) this._knockBack(dir, impulse);
            return;
        }
        // Off its feet first, so the whole hit lands on a body that has every part (getting up, a hit knocks it down
        // again, unless its state takes flinches only).
        if (falls || (this._state === 'getUp' && full)) this._go('falling');
        const kept = onFeet && this._state !== 'falling';
        const part = this._resolvePart(h.part, h.point);
        const p = r.parts[part];
        const point = h.point ? [h.point[0], h.point[1], h.point[2]] : [p.body.position.x, p.body.position.y, p.body.position.z];
        if ((kept && this._physicsCanStand()) || (!full && this._state === 'getUp')) {
            // On its feet the struck part takes a kick, no more: what is left of the hit is the shove's. Shaped as
            // Euphoria shapes a bullet: most of it at once where it struck, the rest along the spine over 0.1 s. A part
            // that is the animation's (a leg, the hips) passes it to the trunk's centre: at the leg's point it would
            // tip the chest toward the shooter.
            const lower = LOWER(p.region) && !!this._body?.kinematic[part];
            const kickPart = lower ? this._body!.chest : part;
            const q = r.parts[kickPart], P = this.set.behaviours.hitReact.params;
            const kick = Math.min(impulse, P.maxKick, MAX_KICK_SPEED * q.mass) * this._braced();
            const at = lower ? [q.body.position.x, q.body.position.y, q.body.position.z] : point;
            r.applyImpulse([dir[0] * kick * 0.6, dir[1] * kick * 0.6, dir[2] * kick * 0.6], at, kickPart);
            this._spread(dir, kick * 0.4);
        } else {
            const m = impulse * this._braced();
            r.applyImpulse([dir[0] * m, dir[1] * m, dir[2] * m], point, part);
        }
        const zone = this._wound(part, point, dir, impulse);
        const before = this._state;
        this._emit('Hit', { part, partName: r.parts[part].name, impulse, point: point as [number, number, number], zone });
        if (dying) { this.kill(); return; }
        // A listener took it further (a script's push knocked it down): that stands.
        if (this._state !== before) return;
        if (kept && !this._standingState()) this._go('hitReact');
        if (staggers) { this._go('stagger'); this._knockBack(dir, impulse); }
    }

    /**
     * How much of a hit the body takes, by how it is standing (Euphoria's bullet multipliers by balance state): all of
     * it on both feet (or its legs on the animation), less on one foot (stepping), less again in the air, where there
     * is nothing to push against and a full hit would fling it rather than snap it. The hit still counts in full
     * toward a stagger or a fall.
     */
    private _braced(): number {
        const H = this.set.behaviours.hitReact.params, s = this.sensors;
        if (this._standingState() && !this._stepping) return 1;
        if (s.feetDown >= 2) return 1;
        if (s.feetDown === 1) return Math.max(0, H.impulseOneFoot ?? 0.8);
        return s.grounded ? 1 : Math.max(0, H.impulseAirborne ?? 0.5);
    }

    /** A free hand still holding a wound (its reach under way). */
    private _holdingWound(): boolean {
        const P = this.set.behaviours.hitReact.params;
        return this._wounds.some(w => !!w.hand && this._handFree(w.hand) && this._time - w.at < P.reachDelay + P.holdTime);
    }

    /** The body region a hit lands on: its part's, on the body or, before there is one, on the layout as animated. */
    private _regionOf(part: number | string | undefined, point: ArrayLike<number> | null | undefined): string {
        if (this.ragdoll && !this.ragdoll.destroyed) return this.ragdoll.parts[this._resolvePart(part, point)]?.region ?? '';
        let name = typeof part === 'string' ? part : this._partNameOf(part);
        if (!name && point) {
            let best = Infinity;
            for (const s of this._segments()) {
                const k = Math.max(0, s.half - s.r);
                const hit = closestSegmentSegment([point[0], point[1], point[2]], [point[0], point[1], point[2]],
                    [s.c[0] - s.y[0] * k, s.c[1] - s.y[1] * k, s.c[2] - s.y[2] * k], [s.c[0] + s.y[0] * k, s.c[1] + s.y[1] * k, s.c[2] + s.y[2] * k]);
                const d = Math.sqrt(hit.dist2) - s.r;
                if (d < best) { best = d; name = s.name; }
            }
        }
        const layout = this._layout();
        const lp = layout?.parts.find(p => p.part.name === name);
        if (lp) return lp.parent < 0 ? 'pelvis' : /spine|chest|abdomen|torso/i.test(name) ? 'spine' : '';
        return /pelvis|hips|spine|chest|abdomen|torso/i.test(name) ? 'spine' : '';
    }

    /** The backend can keep a character on its feet through a reaction (its legs kinematic on the animation). */
    private _physicsCanStand(): boolean {
        return !!this._physics.capabilities?.kinematicParts;
    }

    /** On the ground or on its way to it: falling, tumbling, down, getting up, dead. */
    private _offFeet(): boolean {
        const s = this._state;
        return s === 'falling' || s === 'tumble' || s === 'down' || s === 'getUp' || s === 'dead';
    }

    /** On its feet: plain animation, a flinch, a stagger, or a recovery from them (not from a get-up). */
    private _onFeetState(): boolean {
        const s = this._state;
        return s === 'animated' || s === 'hitReact' || s === 'stagger' || (s === 'recover' && !this._recoverFromGetUp);
    }

    /** A hit's impulse added to the recent ones; their sum over the last second (the physics' clock). */
    private _addRecent(impulse: number): number {
        const now = this._physics.simulatedTime, list = this._recent;
        while (list.length && now - list[0].at > RECENT_HITS) list.shift();
        list.push({ at: now, impulse });
        let sum = 0;
        for (const x of list) sum += x.impulse;
        return sum;
    }

    /**
     * Shoved back on its feet: a fading velocity along `dir` (flat) on the character's capsule
     * (CharacterNode.knockback) — its walk and its legs carry it — or, with no Character over it, on the model.
     */
    private _knockBack(dir: ArrayLike<number>, impulse: number): void {
        const T = this.set.thresholds, P = this.set.behaviours.stepBalance.params;
        const flat = Math.hypot(dir[0], dir[2]);
        if (flat < 1e-3) return;
        const speed = T.stumbleSpeed * Math.min(2.5, impulse / Math.max(1, T.stumbleImpulse)) * this._effectsNow().shove;
        if (!(speed > 0)) return;
        const v = [dir[0] / flat * speed, 0, dir[2] / flat * speed];
        if (this._stepping) this._shoveBody(v);
        else this._knock(v, P.knockTime);
    }

    /**
     * A shove on a body stepping to stay up: given to its parts on the next step (the trunk and the arms all of it,
     * the thighs half, the shins and feet none: the legs are left behind). Too fast for any step to catch, it falls.
     */
    private _shoveBody(v: ArrayLike<number>): void {
        const P = this.set.behaviours.stepBalance.params;
        this._shoveV[0] += v[0]; this._shoveV[2] += v[2];
        // The upper body's lean follows it, fading (ctx.knock), as a shove on the capsule did.
        this._knockHalfLife = Math.max(0.05, P.knockTime);
        this._knockV[0] += v[0]; this._knockV[2] += v[2];
        if (Math.hypot(this._shoveV[0], this._shoveV[2]) > P.maxShove) { this._applyShove(); this._go('falling'); }
    }

    /** The shove waiting for the body, and the brake on the walk it was taking, as impulses on its parts. */
    private _applyShove(): void {
        const body = this._body, sv = this._shoveV, bv = this._brakeV;
        if (!body) return;
        for (const p of body.parts) {
            const role = p.role ?? '';
            const share = p.region === 'feet' || role.startsWith('leg.') ? 0 : role.startsWith('upLeg.') ? 0.5 : 1;
            const x = sv[0] * share - bv[0] * 0.6, z = sv[2] * share - bv[2] * 0.6;
            if (x !== 0 || z !== 0) p.body.applyImpulse([x * p.mass, 0, z * p.mass]);
        }
        sv[0] = sv[2] = 0;
        bv[0] = bv[2] = 0;
    }

    /** Part of a hit's kick given along the spine over the next 0.1 s (a bullet's impulse spread, not one spike). */
    private _spread(dir: ArrayLike<number>, amount: number): void {
        if (!(amount > 0)) return;
        this._spreadKick.push({ dir: [dir[0], dir[1], dir[2]], left: amount, per: amount / 0.1 });
    }
    private readonly _spreadKick: { dir: number[]; left: number; per: number }[] = [];

    /** This step's share of the spread kicks, on the spine's parts by their mass. */
    private _applySpread(body: ReactionBody, dt: number): void {
        if (!this._spreadKick.length) return;
        const spine = body.partsOf(['spine']).filter(i => !body.kinematic[i]);
        let mass = 0;
        for (const i of spine) mass += body.parts[i].mass;
        for (let k = this._spreadKick.length - 1; k >= 0; k--) {
            const s = this._spreadKick[k], now = Math.min(s.left, s.per * Math.max(dt, 1 / 240));
            s.left -= now;
            if (mass > 0) for (const i of spine) {
                const share = now * body.parts[i].mass / mass;
                body.parts[i].body.applyImpulse([s.dir[0] * share, s.dir[1] * share, s.dir[2] * share]);
            }
            if (s.left <= 1e-6) this._spreadKick.splice(k, 1);
        }
    }

    /** A linear impulse (N·s, world) at part `i`'s centre. */
    private _impulse(i: number, x: number, y: number, z: number): void {
        const p = this._body?.parts[i];
        if (!p || !Number.isFinite(x + y + z)) return;
        p.body.applyImpulse([x, y, z]);
    }

    private _knock(v: ArrayLike<number>, halfLife: number): void {
        this._knockHalfLife = Math.max(0.05, halfLife);
        // Shoves add up, to a stumble's pace at most: a burst stacked them past a run, the legs flailing at it.
        const k = this._knockV, max = MAX_KNOCK_SPEEDS * Math.max(0.1, this.set.thresholds.stumbleSpeed);
        let nx = k[0] + v[0], nz = k[2] + v[2];
        const n = Math.hypot(nx, nz);
        if (n > max) { nx *= max / n; nz *= max / n; }
        const dx = nx - k[0], dz = nz - k[2];
        k[0] = nx; k[2] = nz;
        const character = this._character() as { knockback?: (v: ArrayLike<number>, halfLife?: number) => void } | null;
        if (character && typeof character.knockback === 'function' && (dx !== 0 || dz !== 0)) character.knockback([dx, 0, dz], this._knockHalfLife);
    }

    /**
     * Struck by something big and moving (a car), going `velocity` (world): the legs are taken out at its speed and
     * the trunk thrown less and upward, so the body pivots over what hit it. It braces as it goes (the Struck
     * behaviour: knees and hips bent, arms round the head) and falls. `point`: where it was struck, for the wound.
     */
    public impact(opts: { velocity: ArrayLike<number>; point?: ArrayLike<number> | null }): void {
        if (this.config.enabled === false) return;
        const fx = this._effectsNow();
        if (fx.react !== 'full') {
            // Its state takes no fall: counted, and (flinch only) a sway on its feet.
            const v = opts.velocity, speed = Math.hypot(v[0], v[1], v[2]);
            if (!(speed > 1e-3)) return;
            const dir = [v[0] / speed, v[1] / speed, v[2] / speed];
            const impulse = speed * 70 * fx.force;
            this._noteHit(dir, opts.point ?? null, impulse, undefined);
            if (fx.react === 'flinch') { const k = Math.min(1, MAX_KICK_SPEED / speed); this.push([v[0] * k, 0, v[2] * k]); }
            const at = opts.point ? [opts.point[0], opts.point[1], opts.point[2]] as [number, number, number] : [0, 0, 0] as [number, number, number];
            this._emit('Hit', { part: -1, partName: '', impulse, point: at });
            return;
        }
        const r = this._ensure();
        if (!r) return;
        const P = this.set.behaviours.struck.params;
        const v = opts.velocity, speed = Math.hypot(v[0], v[1], v[2]);
        if (!(speed > 1e-3)) return;
        const lift = P.lift * Math.hypot(v[0], v[2]);
        for (const p of r.parts) {
            const legs = p.region === 'legs' || p.region === 'feet';
            const share = legs ? P.legShare : p.region === 'pelvis' ? (P.legShare + P.trunkShare) * 0.5 : P.trunkShare;
            const up = legs ? lift * 0.3 : lift;
            const b = p.body.velocity;
            b.set(b.x + v[0] * share, b.y + v[1] * share + up, b.z + v[2] * share);
        }
        const dir = [v[0] / speed, v[1] / speed, v[2] / speed];
        const point = opts.point ?? null;
        const part = this._resolvePart(point ? undefined : 'Shin L', point);
        const q = r.parts[part];
        const at = point ? [point[0], point[1], point[2]] : [q.body.position.x, q.body.position.y, q.body.position.z];
        const impulse = speed * this._massScale(r) * 70;
        this._noteHit(dir, at, impulse, part);
        this._wound(part, at, dir, impulse);
        this._emit('Hit', { part, partName: q.name, impulse, point: at as [number, number, number] });
        if (this._body) STRUCK.set(this._body, this._time);
        this.sensors.reset();
        this._go('falling');
    }

    /**
     * A shove: every part (or one) given this velocity change (m/s, world). On its feet the capsule takes it (the
     * character walks it out, keeping its control) and the upper body sways; one hard enough knocks it down.
     */
    public push(velocity: ArrayLike<number>, part?: number | string): void {
        if (this.config.enabled === false) return;
        const fx = this._effectsNow();
        if (fx.react === 'none') return;
        const full = fx.react === 'full';
        // Its state's Shove: carried this many times as far.
        if (fx.shove !== 1) velocity = [velocity[0] * fx.shove, velocity[1] * fx.shove, velocity[2] * fx.shove];
        const r = this._ensure();
        if (!r) return;
        const T = this.set.thresholds;
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
        const parts = part === undefined ? r.parts : [r.parts[this._resolvePart(part, null)]];
        let impulse = 0;
        for (const p of parts) impulse += speed * p.mass;
        const onFeet = this._onFeetState();
        const stepping = this.set.behaviours.stepBalance.enabled;
        const fallSized = full && impulse >= T.fallImpulse;
        if (fallSized || !onFeet || !stepping) {
            if (fallSized || (full && this._state === 'getUp' && impulse >= T.minHitImpulse)) this._go('falling');
            for (const p of parts) p.body.applyImpulse([velocity[0] * p.mass, velocity[1] * p.mass, velocity[2] * p.mass]);
            if (onFeet && !this._standingState() && this._state !== 'falling') this._go('hitReact');
            return;
        }
        if (!this._standingState()) this._go('hitReact');
        const staggers = full && impulse >= T.staggerImpulse;
        // The upper body sways (no part changed by more than a kick); the capsule carries the rest (flinching only,
        // it is not shoved). Not before a stagger: its shove is the whole of it (a sway on top counted it twice).
        if (!staggers || !(this._stepping || this._canStep())) {
            const v = Math.min(speed, MAX_KICK_SPEED), k = speed > 0 ? v / speed : 0;
            for (const p of parts) if (!this._body?.kinematic[p.index]) p.body.applyImpulse([velocity[0] * k * p.mass, velocity[1] * k * p.mass, velocity[2] * k * p.mass]);
        }
        if (!staggers) return;
        // Shoved hard enough to stagger: it steps to stay up, the shove on its body (or, with no legs to step on, on
        // its capsule, its legs walking it out). A softer shove is a flinch only: it never slides it along the ground.
        this._go('stagger');
        if (this._stepping) this._shoveBody([velocity[0], 0, velocity[2]]);
        else this._knock([velocity[0], 0, velocity[2]], this.set.behaviours.stepBalance.params.knockTime);
    }

    /** Fall now (off a ledge, a floor giving way): the body takes over, falling as it was moving. */
    public fall(): void {
        if (this.config.enabled === false || !this._ensure()) return;
        this._go('falling');
    }

    /** Trip over something: the feet stop, the body goes on, it falls forward. */
    public trip(): void {
        if (this.config.enabled === false) return;
        const r = this._ensure();
        if (!r) return;
        const s = this.sensors, fwd = this._forward();
        for (const p of r.parts) {
            const k = p.region === 'feet' || p.region === 'legs' ? -0.9 : p.region === 'pelvis' ? 0.2 : 1.4;
            p.body.applyImpulse([fwd[0] * k * p.mass, 0.1 * p.mass, fwd[2] * k * p.mass]);
        }
        s.reset();
        this._go('falling');
    }

    /** Out cold: falls limp and lies there for `seconds` before it can get up. */
    public knockOut(seconds = 4): void {
        if (!this._ensure()) return;
        this._unconsciousUntil = this._time + seconds;
        this._go(this._offFeet() ? this._state : 'falling');
    }

    /** Dies: falls limp and never gets up. */
    public kill(): void {
        this._alive = false;
        this._health = 0;
        if (!this._ensure()) return;
        this._emit('Died', {});
        this._go('dead');
    }

    /**
     * Get up now, if it is down (and alive). While the animator's graph holds the body in a Ragdoll state, the graph
     * decides: this makes its CanGetUp true, and its way into a Get Up state rises.
     */
    public getUp(): void {
        if (this._state !== 'down' || !this._alive) return;
        // Lying on its front with a roll to do first: asked, it rolls now, and rises once it has.
        if (this._needsRoll() && !this._rolling) this._startRoll();
        if (this._graphKind() === 'ragdoll' || this._rolling) { this._riseAsked = true; return; }
        this._go('getUp');
    }

    // ---- the animator's graph (AnimatorReactionLink) ----

    /**
     * The graph entered a Ragdoll state (AnimationState.ragdoll): on its feet the body falls as `start` says; off them
     * it is only held (it never gets up by itself while the graph is there). A graph's own state, so the state's
     * reaction effects do not stop it.
     */
    public graphRagdoll(start: AnimationRagdollStart): void {
        if (this.config.enabled === false) return;
        if (this._offFeet() && this._state !== 'getUp') {
            if (start === 'limp') this._limp = true;
            return;
        }
        this._limp = start === 'limp';
        if (start === 'trip') this.trip();
        else this.fall();
        // Out cold: no firm start (see _base), the protective behaviours off (see _fade).
        if (this._limp) this._fallStart = -Infinity;
    }

    /** The graph entered a Get Up state: lying and ready (or asked to), the body rises on it now; else when it is. */
    public graphGetUp(): void {
        if (this._mayRise() && (this._asked() || this._readyToRise())) this._go('getUp');
    }

    /** Asked to get up (getUp()), and done rolling onto its back first if it had to: that roll come to rest. */
    private _asked(): boolean {
        return this._riseAsked && (!this._rolled || this.sensors.stillFor > 0.2);
    }

    /** Down, alive, and not lying on its front with a roll to do first (or doing it). */
    private _mayRise(): boolean {
        return this._state === 'down' && this._alive && !this._rolling && !this._needsRoll();
    }

    /** Lying on its front or side with the set's Roll over on, not yet rolled. */
    private _needsRoll(): boolean {
        return !!this._body && this.set.behaviours.rollOver.enabled && !this._rolled && this._lying !== 1;
    }

    /** Roll onto its back: the shorter way round, held to the end (ctx.rollSign). Its bodies back in the world. */
    private _startRoll(): void {
        const body = this._body;
        if (!body) return;
        this._rolling = true;
        this._rollStart = this._stateTime;
        const angle = rollAngle(body, body.pelvis);
        this._rollSign = angle >= 0 ? 1 : -1;
        if (this.ragdoll?.frozen) this.ragdoll.unfreeze();
        this.sensors.stillFor = 0;
    }

    /** The reaction state the animator's graph is in (Animator.reactionKind), read live. */
    private _graphKind(): 'ragdoll' | 'getUp' | null {
        return (this.node.animator as { reactionKind?: 'ragdoll' | 'getUp' | null } | null | undefined)?.reactionKind ?? null;
    }

    /** The graph's reaction effects now (Animator.reactionEffects). */
    private _effectsNow(): Readonly<ReactionEffectsNow> {
        return (this.node.animator as { reactionEffects?: Readonly<ReactionEffectsNow> } | null | undefined)?.reactionEffects ?? NO_REACTION_EFFECTS;
    }

    /** Lying still long enough to rise on its own (the set's Get up delay), alive and not out cold. */
    private _readyToRise(): boolean {
        const B = this.set.behaviours, T = this.set.thresholds;
        const writhing = B.writhe.enabled && this._wounds.length > 0 && this._stateTime < B.writhe.params.duration;
        if (!(B.getUp.enabled && this._alive && this._time >= this._unconsciousUntil && !writhing) || this._rolling) return false;
        // Rolled onto its back to get up: up as soon as the roll has come to rest.
        if (this._rolled) return this.sensors.stillFor > 0.2;
        return this.sensors.stillFor > T.settleTime + B.getUp.params.delay && !this._needsRoll();
    }

    /** Lying on its back: the hips and the chest facing up together (one alone cannot tell a body on its side). */
    private _lyingFaceUp(): boolean {
        const body = this._body;
        if (!body) return this.sensors.faceUp;
        if (this._lying === 1 || this._lying === -1) return this._lying === 1;
        const fwdY = (i: number) => quatRotateTuple(body.simRotation(i), [0, 0, 1])[1];
        return fwdY(body.pelvis) + (body.chest >= 0 ? fwdY(body.chest) : 0) > 0;
    }

    /** A hit, for the graph's hit parameters: which side it came from, how high it landed, how hard. */
    private _noteHit(dir: ArrayLike<number>, point: ArrayLike<number> | null, impulse: number, part: number | string | undefined): void {
        const h = this._lastHit, f = this._forward();
        h.angle = planarSignedAngle(f, [-dir[0], -dir[1], -dir[2]], [0, 1, 0]);
        h.strength = clamp(impulse / Math.max(1, this.set.thresholds.fallImpulse), 0, 1);
        h.height = this._hitHeight(part, point);
        h.count++;
    }

    /**
     * How high up the body a hit at `point` is, 0 (the feet) to 1 (the top of the head): carried along its part onto
     * the skeleton at rest, so a crouch or a fall does not change what a head shot is.
     */
    private _hitHeight(part: number | string | undefined, point: ArrayLike<number> | null): number {
        const rest = this._restBody();
        if (!rest || (!point && part === undefined)) return 0.5;
        const segs = this._segments();
        if (!segs.length) return 0.5;
        let name = '';
        const r = this.ragdoll && !this.ragdoll.destroyed ? this.ragdoll : null;
        if (typeof part === 'number') name = r?.parts[part]?.name ?? this._partNameOf(part);
        else if (typeof part === 'string') { const i = r ? r.findPart(part) : -1; name = i >= 0 ? r!.parts[i].name : part; }
        let s = segs.find(x => x.name === name);
        if (!s && point) {
            let best = Infinity;
            for (const x of segs) {
                const k = Math.max(0, x.half - x.r);
                const hit = closestSegmentSegment([point[0], point[1], point[2]], [point[0], point[1], point[2]],
                    [x.c[0] - x.y[0] * k, x.c[1] - x.y[1] * k, x.c[2] - x.y[2] * k], [x.c[0] + x.y[0] * k, x.c[1] + x.y[1] * k, x.c[2] + x.y[2] * k]);
                const d = Math.sqrt(hit.dist2) - x.r;
                if (d < best) { best = d; s = x; }
            }
        }
        const rp = s ? rest.parts.get(s.name) : undefined;
        if (!s || !rp) return 0.5;
        // Along the part (its middle for a hit that names the part and not the point).
        const along = point ? clamp(((point[0] - s.c[0]) * s.y[0] + (point[1] - s.c[1]) * s.y[1] + (point[2] - s.c[2]) * s.y[2]) / (s.half || 1), -1, 1) : 0;
        const y = rp.c[1] + rp.y[1] * along * rp.half;
        return clamp((y - rest.min) / Math.max(1e-6, rest.max - rest.min), 0, 1);
    }

    /** The skeleton at rest, as ragdoll parts (cached per skin): what a hit's height is measured on. */
    private _restBody(): { parts: Map<string, { c: number[]; y: number[]; half: number }>; min: number; max: number } | null {
        const skin = this._skin;
        if (!skin) return null;
        if (REST_BODIES.has(skin)) return REST_BODIES.get(skin)!;
        const layout = this._layout();
        let out: { parts: Map<string, { c: number[]; y: number[]; half: number }>; min: number; max: number } | null = null;
        if (layout) {
            const parts = new Map<string, { c: number[]; y: number[]; half: number }>();
            let min = Infinity, max = -Infinity;
            const pose = [0, 0, 0, 0, 0, 0, 1];
            for (const lp of layout.parts) {
                const scale = ragdollPartPoseInto(skin, lp, IDENTITY, IDENTITY, pose);
                const y = quatRotateTuple([pose[3], pose[4], pose[5], pose[6]], [0, 1, 0]);
                const half = lp.length * scale / 2, rad = lp.radius * scale;
                parts.set(lp.part.name, { c: [pose[0], pose[1], pose[2]], y, half });
                min = Math.min(min, pose[1] - Math.abs(y[1]) * half - rad);
                max = Math.max(max, pose[1] + Math.abs(y[1]) * half + rad);
            }
            if (parts.size && max > min) out = { parts, min, max };
        }
        REST_BODIES.set(skin, out);
        return out;
    }

    /**
     * Thrown from a moving vehicle: it leaves with `velocity` (the vehicle's, world), thrown out along
     * `exitDirection`, clear of `vehicle` (its body) for a moment so it does not catch on it.
     */
    public bail(opts: { velocity: ArrayLike<number>; exitDirection?: ArrayLike<number>; vehicle?: { body?: PhysicsBody | null } | null }): void {
        const r = this._ensure();
        if (!r) return;
        const P = this.set.behaviours.vehicleBail.params;
        const exit = opts.exitDirection ? vec3.normalize(vec3.create(), [opts.exitDirection[0], opts.exitDirection[1], opts.exitDirection[2]]) : vec3.create();
        const v = [
            opts.velocity[0] * P.inherit + exit[0] * P.ejectSpeed, opts.velocity[1] * P.inherit + P.ejectUp, opts.velocity[2] * P.inherit + exit[2] * P.ejectSpeed,
        ];
        for (const p of r.parts) p.body.velocity.set(v[0], v[1], v[2]);
        if (this._body) BAILS.set(this._body, this._time);
        const vb = opts.vehicle?.body as unknown as { collisionFilterMask: number } | null | undefined;
        if (vb && typeof vb.collisionFilterMask === 'number') {
            this._clearBody = vb;
            this._clearMask = vb.collisionFilterMask;
            vb.collisionFilterMask = vb.collisionFilterMask & ~LAYER.RAGDOLL;
            this._clearUntil = this._time + P.clearTime;
        }
        this.sensors.reset();
        this._go('falling');
    }

    /** Back to plain animation at once, wherever the body is (a respawn). */
    public reset(): void {
        this._restoreClear();
        this._release();
        this._wounds.length = 0;
        this._running.clear();
        this._state = 'animated';
        this._stateTime = 0;
        this._alive = true;
        this._riseAsked = false;
        this._limp = false;
        this._health = Math.max(0, Math.min(1, this.config.health ?? 1));
        // A graph holding the body in a Ragdoll or Get Up state goes back to its entry with it.
        (this.node.animator as { endReactionStates?: () => void } | null | undefined)?.endReactionStates?.();
    }

    // ---- the frame (PhysicsSystem calls these) ----

    /** Before the physics step: compose the targets and send them to the muscles and strings. */
    public _preStep(dt: number): void {
        const r = this.ragdoll, body = this._body;
        if (!r || !body || r.destroyed || r.frozen) return;
        // The get-up clip waits on its first frame while the skin blends onto it.
        if (this._state === 'getUp' && this._getUpAction && this._stateTime < this._getUpHold()) this._getUpAction.seek(0);
        // Read a step late (the worker's last step not back yet), the poses are carried on to where the world is.
        body.followSpin = Math.max(0, Math.min(1, this.set.behaviours.hitReact.params.followSpin ?? 1));
        body.begin(dt, this._physics.posesLag ? dt : 0);
        if (this._split) this._driveKinematic(body, dt);
        // A stagger's shove, the step after its legs went dynamic (a body switched and pushed in one step keeps neither).
        if (this._stepping && this._shoveWait-- <= 0) this._applyShove();
        this._applySpread(body, dt);
        // Looseness wears off at the rate the set's Recover in says (a part as weak as a hit leaves it, back in that time).
        const H = this.set.behaviours.hitReact.params, ease = dt / Math.max(1e-3, H.weaknessTime);
        for (let i = 0; i < this._loose.length; i++) if (this._loose[i] > 0) this._loose[i] = Math.max(0, this._loose[i] - ease);
        this._evolveRef(body, dt);
        this._base(body, dt);
        const ctx = this._context(dt);
        for (const b of BEHAVIOURS) {
            const w = this._running.get(b) ?? 0;
            if (w > 0) b.update(ctx, this.set.behaviours[b.id], w);
        }
        // Off its feet every muscle is at least critically damped: a soft limb that rings reads as jelly.
        if (OFF_FEET_REF(this._state)) for (const p of body.parts) if (body.damping[p.index] < 1) body.damping[p.index] = 1;
        // The nervous system (nerves.ts): the body tensing after a hit, and no gain jumping in a step.
        this._nerves.tone(body, this._toneNow(), this._loose);
        this._nerves.filter(body, dt);
        this._upload(body, dt);
    }

    /**
     * The legs and hips on their animation: each kinematic part moved at the animation's own velocity (its motion
     * between frames), plus a correction that takes up what it has drifted from where the animation will have it a
     * frame on, over KINEMATIC_CATCH_UP seconds and no faster than a cap. Never the whole gap in one step: with the
     * physics worker the pose read here is a step or two old (the one in flight is not back yet), and a velocity
     * sized to close that stale gap overshoots by the steps still to land, more every frame: the hips flung off and
     * the upper body, jointed to them, stretched after them. Far from it (a teleport), put there.
     */
    private _driveKinematic(body: ReactionBody, dt: number): void {
        if (!(dt > 1e-4)) return;
        const worker = this._physics.executor === 'worker';
        const k = 1 / Math.max(dt, worker ? KINEMATIC_CATCH_UP_WORKER : KINEMATIC_CATCH_UP);
        const maxSpeed = worker ? MAX_CATCH_UP_SPEED_WORKER : MAX_CATCH_UP_SPEED, maxSpin = worker ? MAX_CATCH_UP_SPIN_WORKER : MAX_CATCH_UP_SPIN;
        for (const p of body.parts) {
            const i = p.index;
            if (!body.kinematic[i]) continue;
            const a = body.anim[i], v = body.animVel[i], s = body.sim[i], b = p.body;
            const tx = a[0] + v[0] * dt, ty = a[1] + v[1] * dt, tz = a[2] + v[2] * dt;
            const qa = rotationVectorToQuat([v[3] * dt, v[4] * dt, v[5] * dt]);
            const qt = quatMultiplyTuple(qa, [a[3], a[4], a[5], a[6]]);
            const ex = tx - s[0], ey = ty - s[1], ez = tz - s[2];
            if (Math.hypot(ex, ey, ez) > 0.3) {
                b.position.set(a[0], a[1], a[2]);
                b.quaternion.set(a[3], a[4], a[5], a[6]);
                b.velocity.set(v[0], v[1], v[2]);
                b.angularVelocity.set(v[3], v[4], v[5]);
                continue;
            }
            const c = clampLength([ex * k, ey * k, ez * k], maxSpeed);
            // The animation's own velocity capped too: a hop of the animated hips (a step up, a capsule placed) is a
            // frame's jump, not a motion, and as a velocity it jolts everything jointed to them.
            const va = clampLength([v[0], v[1], v[2]], KINEMATIC_MAX_SPEED), wa = clampLength([v[3], v[4], v[5]], KINEMATIC_MAX_SPIN);
            b.velocity.set(va[0] + c[0], va[1] + c[1], va[2] + c[2]);
            const e = quatToRotationVector(quatMultiplyTuple(qt, quatConjugateTuple([s[3], s[4], s[5], s[6]])));
            const w = clampLength([e[0] * k, e[1] * k, e[2] * k], maxSpin);
            b.angularVelocity.set(wa[0] + w[0], wa[1] + w[1], wa[2] + w[2]);
        }
    }

    /** After the physics step: measure the body, move between states, fade behaviours, follow with the Collider. */
    public _postStep(dt: number, contacts: ContactList | null): void {
        const r = this.ragdoll;
        if (!r || !this._body) return;
        if (r.destroyed) { this._forget(); return; }
        this._time += dt;
        this._stateTime += dt;
        if (!r.frozen) {
            // What the state reads, and no more: where a fall lands and the ground ahead only while it is in the air
            // or rolling; the ground under it every step while it stands or falls, every fourth lying or rising.
            const st = this._state, airborne = st === 'falling' || st === 'tumble';
            const d = this._detail;
            d.sweep = airborne; d.terrain = airborne;
            d.under = airborne || st === 'hitReact' || st === 'stagger' || (++this._senseFrame & 3) === 0;
            this.sensors.update(r, dt, contacts, this.set.thresholds.settleSpeed, this._raycaster, d);
        } else this.sensors.stillFor += dt;
        this._lying = this._offFeet() ? classifyLying(this.sensors.bellyUp, this._lying) : null;
        if (this._clearBody && this._time >= this._clearUntil) this._restoreClear();
        this._fadeKnock(dt);
        this._transitions(dt);
        if (!this.ragdoll || !this._body) return;
        this._fade(dt);
        this._follow();
        // Drop wounds long healed.
        // Kept longer the worse they were (a bad one hurts for a while).
        const keep = this.set.behaviours.hitReact.params.holdTime + this.set.behaviours.hitReact.params.reachDelay + 1;
        for (let i = this._wounds.length - 1; i >= 0; i--) {
            const w = this._wounds[i];
            if (this._time - w.at > keep + 6 * w.severity && this._state !== 'down') this._wounds.splice(i, 1);
        }
    }

    /** The model left the world: end everything. */
    public destroy(): void { this.reset(); }

    // ---- states ----

    private _transitions(dt: number): void {
        const s = this.sensors, T = this.set.thresholds, B = this.set.behaviours;
        const t = this._stateTime;
        if (this._time - this._reactionStart > T.maxReactionSeconds && ['falling', 'tumble'].includes(this._state)) { this._go('down'); return; }
        switch (this._state) {
            case 'hitReact': {
                // Over once its time is up and no free hand is still holding a wound (it would be let go of the moment
                // the body is handed back to its walk).
                if (this._tippedOver(dt)) this._go('falling');
                else if ((t > B.hitReact.params.duration && !this._holdingWound()) || this._time - this._reactionStart > T.maxReactionSeconds) this._go('recover');
                break;
            }
            case 'stagger': {
                const P = B.stepBalance.params;
                if (this._stepping) {
                    const b = this._balancer;
                    if (!b || b.outcome === 'falling') { this._go('falling'); break; }
                    if (b.outcome === 'recovered' || t > 6) this._go('recover');
                    break;
                }
                if (this._tippedOver(dt)) { this._go('falling'); break; }
                // Walked out of the shove: back on its animation once it has faded for a moment.
                if (Math.hypot(this._knockV[0], this._knockV[2]) < 0.15) { if ((this._balancedFor += dt) > P.recoverTime) this._go('recover'); }
                else this._balancedFor = 0;
                if (t > 6) this._go('recover');
                break;
            }
            case 'falling': {
                if (!this._landed && s.grounded && s.touchedNow.size > 0 && t > 0.05) {
                    this._landed = true;
                    this._emit('Landed', { fallHeight: s.fallHeight, impactSpeed: s.impactSpeed });
                }
                if (!s.grounded || t < 0.15) break;
                // Thrown from a vehicle, it lands moving: it rolls on, rather than stopping dead where it came down.
                const bailRoll = !!this._body && BAILS.has(this._body) && Math.hypot(s.velocity[0], s.velocity[2]) > B.vehicleBail.params.rollSpeed;
                const rolling = bailRoll || s.trunkSpin > T.tumbleAngularSpeed || ((s.terrain === 'stairs' || s.terrain === 'slope') && s.speed > B.tumble.params.slowDownSpeed);
                if (rolling && B.tumble.enabled) this._go('tumble');
                else if (s.speed < T.downSpeed) this._go('down');
                break;
            }
            case 'tumble':
                if (s.speed < T.downSpeed && s.trunkSpin < T.tumbleAngularSpeed * 0.5) this._go('down');
                else if (t > 8) this._go('down');
                break;
            case 'down': {
                if (s.stillFor > T.settleTime && !this._settledSent) { this._settledSent = true; this._emit('Settled', { faceUp: this._lyingFaceUp(), lying: this.lying }); }
                if (!this._alive) { this._go('dead'); break; }
                if (!s.grounded && s.speed > T.downSpeed * 3) { this._go('falling'); break; }
                // The animator's graph decides while it is in a Ragdoll state (it never rises by itself) or a Get Up
                // state (it rises once ready, the model's Gets up switch notwithstanding: that is for its own get-up).
                const graph = this._graphKind();
                const conscious = this._time >= this._unconsciousUntil;
                const wantsUp = !graph && B.getUp.enabled && this.config.getUp !== false && conscious;
                const writhing = B.writhe.enabled && this._wounds.length > 0 && t < B.writhe.params.duration;
                // Lying on its front or side, about to get up: it rolls onto its back first (Roll over), when it would
                // have got up, or when asked to.
                if (this._rolling) {
                    if (this._lying === 1 || t - this._rollStart > B.rollOver.params.giveUp) { this._rolling = false; this._rolled = true; }
                } else if (this._needsRoll() && this._alive && (this._riseAsked
                    || (conscious && !writhing && B.getUp.enabled && (graph !== null || wantsUp) && s.stillFor > T.settleTime + B.getUp.params.delay))) {
                    this._startRoll();
                }
                if (graph === 'getUp' && this._mayRise() && (this._asked() || this._readyToRise())) { this._go('getUp'); break; }
                // Lying still with nothing left to do but wait: its bodies leave the world, the pose held where it lies,
                // until it gets up or something moves it (a hit, a push: _ensure puts them back).
                const r = this.ragdoll;
                if (r && !r.frozen && this._settledSent && !writhing && this._alive && !this._rolling) r.freeze();
                if (!graph && this._mayRise() && (this._asked() || (wantsUp && this._readyToRise()))) this._go('getUp');
                break;
            }
            case 'getUp': {
                const a = this._getUpAction;
                const blend = B.getUp.params.blendTime;
                if (!a || a.done || a.duration <= 0 || a.time >= a.duration - blend || t > Math.max(a?.duration ?? 0, B.getUp.params.regainTime) + 1) {
                    if (!a && t < B.getUp.params.regainTime + 0.3) break;   // the strings-only rise
                    this._go('recover');
                }
                break;
            }
            case 'recover':
                // On its feet: back once the drawing is the animation's again (the upper body let go only once it
                // follows the animation closely, see _base), or after a second whatever. From a get-up: the blend.
                if (this._split ? this._mapNow.every(m => m <= 1e-3) || t > 1.2 : t >= Math.max(0.05, B.getUp.params.blendTime)) {
                    this._release();
                    this._go('animated');
                }
                break;
            case 'dead':
                if (this.ragdoll) this.ragdoll.autoFreeze = true;
                break;
        }
    }
    private _balancedFor = 0;
    private _letGo = false;

    /**
     * On its feet, tipped too far to stay up: the chest farther from where the animation has it (against the hips)
     * than the stagger's Falls past, for its For.
     */
    private _tippedOver(dt: number): boolean {
        const P = this.set.behaviours.stepBalance.params;
        const tilt = this._chestTilt();
        this._tiltFor = tilt > P.giveUpTilt ? this._tiltFor + dt : 0;
        return this._tiltFor > P.giveUpTime && this._tiltFor > 0;
    }

    /** The angle (radians) between the chest's up as simulated and as animated, each against its hips. */
    private _chestTilt(): number {
        const body = this._body;
        if (!body || body.chest < 0 || body.chest === body.pelvis) return 0;
        const up = (pelvis: number[], chest: number[]) => quatRotateTuple(
            quatMultiplyTuple(quatConjugateTuple([pelvis[3], pelvis[4], pelvis[5], pelvis[6]]), [chest[3], chest[4], chest[5], chest[6]]), [0, 1, 0]);
        const a = up(body.sim[body.pelvis], body.sim[body.chest]), b = up(body.anim[body.pelvis], body.anim[body.chest]);
        return Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
    }

    /** The farthest any simulated upper-body part is from its animation (radians, each against the hips). */
    private _trackingError(): number {
        const body = this._body;
        if (!body) return 0;
        const ps = body.sim[body.pelvis], pa = body.anim[body.pelvis];
        const isp = quatConjugateTuple([ps[3], ps[4], ps[5], ps[6]]), iap = quatConjugateTuple([pa[3], pa[4], pa[5], pa[6]]);
        let worst = 0;
        for (const p of body.parts) {
            if (body.kinematic[p.index] || p.index === body.pelvis) continue;
            const s = body.sim[p.index], a = body.anim[p.index];
            const rs = quatMultiplyTuple(isp, [s[3], s[4], s[5], s[6]]), ra = quatMultiplyTuple(iap, [a[3], a[4], a[5], a[6]]);
            const d = Math.abs(rs[0] * ra[0] + rs[1] * ra[1] + rs[2] * ra[2] + rs[3] * ra[3]);
            worst = Math.max(worst, 2 * Math.acos(Math.min(1, d)));
        }
        return worst;
    }

    /** hitReact, stagger, or a recovery from them: on its feet, its legs kinematic on the animation. */
    private _standingState(): boolean {
        return (this._split || this._stepping) && (this._state === 'hitReact' || this._state === 'stagger' || this._state === 'recover');
    }

    /** A stagger can step: a body with both legs (Jolt's reactions have them dynamic, on their muscles). */
    private _canStep(): boolean {
        const body = this._body;
        return !!body && !!body.legs.L && !!body.legs.R && !!this.ragdoll && !this.ragdoll.frozen;
    }

    /** The capsule walks again: it no longer follows the body. */
    private _unfollow(): void {
        const c = this._character() as { followBody?: (t: ArrayLike<number> | null) => void } | null;
        c?.followBody?.(null);
    }

    /**
     * The legs and hips kinematic on the animation (on: a character on its feet; the backend must move kinematic
     * parts, capabilities.kinematicParts) or every part simulated again (off: it falls). The upper body is drawn
     * against the hips while on (Ragdoll.anchorPart), so the legs' frame-late step never shows at the waist.
     */
    private _setSplit(on: boolean): void {
        const r = this.ragdoll, body = this._body;
        if (!r || !body || r.frozen) { this._split = false; return; }
        if (on && !this._physics.capabilities?.kinematicParts) on = false;
        if (on === this._split) return;
        let ok = on;
        for (const p of body.parts) {
            if (!LOWER(p.region)) continue;
            const set = r.setKinematic(p.index, on);
            if (on && !set) ok = false;
            body.kinematic[p.index] = on && set ? 1 : 0;
        }
        if (on && !ok) {
            for (const p of body.parts) if (body.kinematic[p.index]) { r.setKinematic(p.index, false); body.kinematic[p.index] = 0; }
        }
        this._split = on && ok;
        r.anchorPart = this._split ? body.pelvis : -1;
    }

    /** The shove fading (its half-life); the model itself carried by it when no Character is over it. */
    private _fadeKnock(dt: number): void {
        const k = this._knockV;
        if (k[0] === 0 && k[2] === 0) return;
        if (!this._character() && this._standingState() && !this._stepping) {
            const p = this.node.worldPosition;
            this.node.setWorldPosition([p[0] + k[0] * dt, p[1], p[2] + k[2] * dt]);
            this.node.updateTransforms(this.node.parent ? this.node.parent.worldTransform : null);
        }
        const f = Math.pow(0.5, dt / this._knockHalfLife);
        k[0] *= f; k[2] *= f;
        if (Math.hypot(k[0], k[2]) < 0.02) k[0] = k[2] = 0;
    }

    private _go(next: ReactionState): void {
        const from = this._state;
        if (next === from) return;
        this._state = next;
        this._stateTime = 0;
        this._balancedFor = 0;
        this._letGo = false;
        // Onto a clip (getting up) or gone: the muscles as they are told at once, no ramp from what they were.
        if (next === 'getUp' || next === 'dead') this._nerves.snap();
        // Off the ground's rest: its bodies back in the world (they left it lying still).
        if (from === 'down' && next !== 'dead' && this.ragdoll?.frozen) this.ragdoll.unfreeze();
        if (from === 'down') this._riseAsked = false;
        if (next === 'down' && from !== 'down') { this._rolling = false; this._rolled = false; }
        if (from === 'down') this._rolling = false;
        // Up again: out cold no more.
        if (next === 'getUp' || next === 'recover' || next === 'animated' || next === 'hitReact' || next === 'stagger') this._limp = false;
        if (next !== 'animated' && from === 'animated') { this._reactionStart = this._time; this._emit('Started', { from }); }
        // A get-up cut short (a hit, a push): its clip stops, and the body is the body's again.
        if (from === 'getUp' && next !== 'recover') this._stopGetUp();
        if (next === 'recover') this._recoverFromGetUp = from === 'getUp' && !!this._getUpAction;
        // Knocked off balance: every stagger, and every fall from its feet (what a brain's Hurt counts).
        if (next === 'stagger' || (next === 'falling' && from !== 'stagger' && from !== 'tumble' && from !== 'down')) this._knockCount++;
        // A stagger steps on legs of its own (the physics', the Collider following the body); flinching and walking
        // it off, the legs are the animation's. Off its feet every part is the body's.
        const wasStepping = this._stepping;
        const stepping = next === 'stagger' && (this._stepping || this._canStep());
        if (stepping !== this._stepping) {
            this._stepping = stepping;
            if (stepping) {
                this._balancer = new Balancer();
                this._shoveWait = 1;
                this._shoveV[0] = this._shoveV[2] = 0;
                // The walk it was taking, braced against (most of it).
                const c = this._character() as { velocity?: ArrayLike<number> } | null;
                const cv = c?.velocity;
                this._brakeV[0] = cv ? cv[0] : 0; this._brakeV[2] = cv ? cv[2] : 0;
            } else this._unfollow();
        }
        const onFeet = next === 'hitReact' || (next === 'stagger' && !stepping) || (next === 'recover' && (from === 'hitReact' || from === 'stagger'));
        if (onFeet) this._setSplit(true);
        else if (next !== 'animated') this._setSplit(false);
        this._tiltFor = 0;
        switch (next) {
            case 'hitReact':
                break;
            case 'stagger':
                this._emit('Stagger', { from });
                break;
            case 'falling':
                this._suspend();
                this._landed = false;
                // Firm at first only off its feet: a body shoved along the ground falls as limp as it lay.
                this._fallStart = from === 'animated' || from === 'hitReact' || from === 'stagger' || from === 'recover' ? this._time : -Infinity;
                this._knockV[0] = this._knockV[2] = 0;
                {
                    // The shove is the body's now: off the capsule, which leaves the world.
                    const c = this._character() as { knockbackVelocity?: readonly number[]; knockback?: (v: ArrayLike<number>, h?: number) => void } | null;
                    const k = c?.knockbackVelocity;
                    if (k && c?.knockback && (k[0] !== 0 || k[2] !== 0)) c.knockback([-k[0], 0, -k[2]]);
                }
                this._emit('Fell', { from, fallHeight: this.sensors.fallHeight });
                break;
            case 'tumble':
                this._suspend();
                break;
            case 'down':
                this._suspend();
                this._settledSent = false;
                this._emit('Down', { from, faceUp: this._lyingFaceUp(), lying: this.lying });
                break;
            case 'getUp':
                this._suspend();
                this._startGetUp();
                this._emit('GettingUp', { from, faceUp: this._lyingFaceUp(), lying: this.lying });
                break;
            case 'recover':
                // Up from the ground, or caught after stepping: the Collider under the body, the animation there.
                if (from === 'getUp' || wasStepping) this._placeCharacterAtBody(false);
                this._resume();
                break;
            case 'animated':
                this._emit(from === 'recover' && this._gotUp ? 'GotUp' : 'Recovered', { from });
                this._gotUp = false;
                break;
            case 'dead':
                this._suspend();
                this._playClip(null);
                break;
        }
    }
    private _gotUp = false;

    // ---- the body ----

    /**
     * The powered ragdoll, made from the pose the character holds now. Null where it cannot be (no skin, no profile),
     * or for a `flinch` the budget refuses (PhysicsSystem.maxPoweredRagdolls; a `fall` always gets one).
     */
    private _ensure(kind: 'flinch' | 'fall' = 'fall'): Ragdoll | null {
        if (this.ragdoll && !this.ragdoll.destroyed) {
            if (this.ragdoll.frozen) { this.ragdoll.unfreeze(); this.ragdoll.autoFreeze = !this._alive; }
            return this.ragdoll;
        }
        const animator = this.node.animator;
        if (!animator || !this._skin) return null;
        if (!this._physics._admitReaction(this.node, kind)) return null;
        const r = this._physics.startRagdoll(this.node, { mode: 'powered' });
        if (!r.powered || r.parts.length === 0) { this._physics.stopRagdoll(this.node); return null; }
        r.autoFreeze = false;
        this.ragdoll = r;
        this._body = new ReactionBody(r);
        this._prevAnim = [];
        this.owners.length = r.parts.length;
        this.owners.fill(null);
        this.sensors.reset();
        this._time = 0;
        this._nerves.snap();
        this._selfOffUntil = [];
        this._loose = new Float64Array(r.parts.length);
        this._split = false;
        this._mapNow = new Float64Array(r.parts.length);
        // Where the feet are below the Collider's origin: what following the hips puts back.
        const character = this._character();
        const collider = character?.collider;
        this._feetOffset = collider && character ? collider.worldPosition[1] - this.node.worldPosition[1] : 0;
        this._body.begin();
        return r;
    }

    private _release(): void {
        if (this._stepping) { this._stepping = false; this._unfollow(); }
        this._setSplit(false);
        this._knockV[0] = this._knockV[2] = 0;
        this._playClip(null);
        if (this.ragdoll && !this.ragdoll.destroyed) this._physics.stopRagdoll(this.node);
        this._forget();
        this._resume();
    }

    private _forget(): void {
        this._ownMask = [];
        this.ragdoll = null;
        this._body = null;
        this._running.clear();
        this._getUpAction = null;
    }

    /**
     * The pose the muscles follow off its feet (ReactionBody.ref), moved on every step:
     * - falling: the pose it fell in, eased toward a brace (the animation's pose as it fell, knees, hips and elbows
     *   a little bent);
     * - a clip playing as the body's (the Reaction slot's, the graph's Ragdoll state's own) eased toward the clip:
     *   what gets a fall or a writhe clip to the muscles;
     * - lying: the pose it came to rest in, let go toward the pose it holds once it is still; a part pressed into
     *   the ground far from its target always lets go a little, so no muscle shoves at the floor.
     */
    private _evolveRef(body: ReactionBody, dt: number): void {
        const st = this._state;
        if (!OFF_FEET_REF(st)) { this._refState = null; return; }
        const entered = this._refState !== st;
        const from = this._refState;
        this._refState = st;
        if (entered && (st === 'falling' || from === null || st === 'down' || st === 'dead')) {
            body.captureRef();
            if (st === 'falling') {
                // The brace it eases into: the animation's pose as it fell (body.target holds it now), bent a little.
                for (const p of body.parts) { const t = body.target[p.index], b = this._brace[p.index] ??= [0, 0, 0, 1]; b[0] = t[0]; b[1] = t[1]; b[2] = t[2]; b[3] = t[3]; }
                this._braceBent(body);
            }
        }
        const ease = (tau: number) => 1 - Math.exp(-Math.max(0, dt) / tau);
        const animator = this.node.animator as { reactionClipPlaying?: boolean } | null | undefined;
        const clipLed = !!this._clip || !!animator?.reactionClipPlaying;
        if (clipLed) {
            // The clip is the pose (body.target is the animation's at the start of the step).
            const k = ease(0.25);
            for (const p of body.parts) if (p.parent >= 0) body.refToward(p.index, body.target[p.index], k);
        } else if (st === 'falling') {
            const k = ease(0.4);
            for (const p of body.parts) if (p.parent >= 0 && this._brace[p.index]) body.refToward(p.index, this._brace[p.index], k);
        } else if ((st === 'down' || st === 'dead') && this.sensors.stillFor > this.set.thresholds.settleTime) {
            const k = ease(0.6);
            for (const p of body.parts) if (p.parent >= 0) body.relaxRef(p.index, k);
        }
        // A part on the ground well away from its target gives way to it.
        const k = ease(0.3);
        for (const i of this.sensors.touching) {
            const p = body.parts[i];
            if (!p || p.parent < 0) continue;
            const r = body.ref[i], s = body.simRelative(i);
            const err = 2 * Math.acos(Math.min(1, Math.abs(r[0] * s[0] + r[1] * s[1] + r[2] * s[2] + r[3] * s[3])));
            if (err > 0.35) body.relaxRef(i, k);
        }
    }
    private _refState: ReactionState | null = null;
    private readonly _brace: number[][] = [];

    /** The fall's brace bent a little: knees and elbows folded, hips forward, as a body does when it goes. */
    private _braceBent(body: ReactionBody): void {
        const bend = (i: number, angle: number) => {
            const p = body.parts[i];
            if (!p || p.parent < 0 || !p.layout.hingeAxis || !this._brace[i]) return;
            const pr = body.parts[p.parent].layout.rotation, h = p.layout.hingeAxis;
            const axis = quatRotateTuple([-pr[0], -pr[1], -pr[2], pr[3]], [h[0], h[1], h[2]]);
            const s = Math.sin(angle / 2);
            const q = quatMultiplyTuple([axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)], this._brace[i]);
            const b = this._brace[i]; b[0] = q[0]; b[1] = q[1]; b[2] = q[2]; b[3] = q[3];
        };
        for (const side of ['L', 'R'] as const) {
            const leg = body.legs[side], arm = body.arms[side];
            if (leg) bend(leg.mid, 0.35);
            if (arm) bend(arm.mid, 0.5);
        }
    }

    /** The base every behaviour composes over: the set's muscles, this state's strings and drawing. */
    private _base(body: ReactionBody, dt: number): void {
        const set = this.set, state = this._state;
        const health = 0.4 + 0.6 * this._health;
        const k = set.strength * this._strength * health;
        const pins = set.pins;
        const G = set.behaviours.getUp.params, H = set.behaviours.hitReact.params;
        const hold = this._getUpHold();
        const standing = this._standingState();
        // Falling, the body is alive: its muscles as firm as on its feet at first, tiring toward the set's over a
        // couple of seconds (and on the ground, below).
        const fatigue = (state === 'falling' || state === 'tumble') && Number.isFinite(this._fallStart) ? Math.max(0.25, Math.exp(-(this._time - this._fallStart) / 1.8)) : 0;
        // Back on its animation once the upper body follows it closely: until then the drawing stays the body's.
        // Latched: once let go back to the animation, it stays let go (a tracking error that rises again does not
        // hand the drawing back to the body, flickering between the two).
        const letGo = this._letGo ||= state === 'recover' && standing && (this._stateTime > 0.6 || this._trackingError() < TRACKED);
        for (const p of body.parts) {
            const i = p.index;
            const m = p.region === 'pelvis' ? set.muscles.spine : set.muscles[p.region as keyof typeof set.muscles];
            const track = H.trackStiffness * (p.region === 'arms' ? 0.85 : p.region === 'hands' ? 0.7 : 1) * Math.sqrt(k);
            body.frequency[i] = m.frequency * Math.sqrt(k);
            body.damping[i] = m.damping;
            body.torque[i] = m.maxTorque * k;
            body.holdUp[i] = m.gravityCompensation;
            body.friction[i] = 0;
            if (standing) {
                // On its feet: firm muscles following the animation with its motion (the target's spin).
                body.frequency[i] = Math.max(body.frequency[i], track);
                body.damping[i] = 1;
                body.torque[i] *= Math.max(1, H.trackStrength);
                body.holdUp[i] = 1;
            } else if (fatigue > 0) {
                // Half as firm as on its feet at most: a trunk any firmer falls like a plank, its head first.
                body.frequency[i] = Math.max(body.frequency[i], 0.5 * track * fatigue);
                body.torque[i] *= Math.max(1, 0.5 * H.trackStrength * fatigue);
            }
            // Off its feet the muscles hold what the body does rather than pull it back to standing (the behaviours
            // brace, protect and land on top); on the ground (rolling, lying) they let it lie with its weight: they
            // hold up little, and tire.
            // Off its feet the muscles follow the reference pose (the pose it fell in, a brace, a clip; _evolveRef):
            // held where it is they only resisted, and the body looked dead.
            if (state === 'falling' || state === 'tumble' || state === 'down' || state === 'dead') body.blend(i, body.ref[i], 1);
            if (state === 'tumble' || state === 'down') { body.holdUp[i] *= 0.3; body.torque[i] *= 0.6; }
            let pin = 0, map = 1;
            if (standing) {
                // The legs and hips are the animation's; the upper body is drawn simulated (a hand on a weapon a
                // little less, so it stays on its grip), until it is let go back to the animation.
                const arm = (p.region === 'arms' || p.region === 'hands') && p.side ? p.side : null;
                map = body.kinematic[i] ? 0 : letGo ? 0 : arm && !this._handFree(arm) && !this._stepping ? 0.3 : 1;
            } else if (state === 'hitReact') {
                const legs = p.region === 'legs' || p.region === 'feet';
                pin = legs ? pins.legs : 1;
                // Legs held on the animation are drawn from it, and so are the hips they hang from, the trunk blending
                // in from there: a simulated pelvis over animated legs shears the skin at the hips.
                if (pins.legs >= 0.99) map = legs || p.region === 'pelvis' ? 0 : p.region === 'spine' && p.parent === body.pelvis ? 0.5 : 1;
            } else if (state === 'getUp') {
                if (hold > 0) {
                    // On a clip: held on its first frame (lined up with the body) while the skin blends from the body
                    // to it, the strings firm at once; then the clip plays, and the skin is the animation's.
                    pin = Math.min(1, 0.4 + this._stateTime / Math.max(0.05, G.regainTime * 0.5));
                    map = 1 - Math.min(1, this._stateTime / hold);
                } else {
                    // Without one, the strings lift the body onto the animation, and the skin is the body's.
                    pin = Math.min(1, this._stateTime / Math.max(0.05, G.regainTime));
                }
            } else if (state === 'recover') {
                pin = 1;
                map = this._recoverFromGetUp ? 0 : 1 - Math.min(1, this._stateTime / Math.max(0.05, G.blendTime));
            }
            body.pin[i] = pin;
            body.mapping[i] = map;
        }
        if (state === 'getUp') this._gotUp = true;
        void dt;
    }

    /** Whether a hand may leave what it holds for a wound (see {@link busyHands}). */
    private _handFree(side: 'L' | 'R'): boolean {
        if (this.busyHands) return !this.busyHands[side];
        // The graph's states (AnimationState.reactions busyHands), then the support-hand IK.
        const fx = this._effectsNow();
        if (fx.busyHands) return !fx.busyHands[side];
        const animator = this.node.animator as { handIkActive?: 'left' | 'right' | null } | null | undefined;
        return !animator?.handIkActive;
    }

    /** Targets, gains, strings and drawing, to the ragdoll. */
    private _upload(body: ReactionBody, dt: number): void {
        const r = this.ragdoll!, pins = this.set.pins, d = this._drive, pin = this._pin;
        const massScale = this._massScale(r);
        const n = body.parts.length;
        const total = body.parts.reduce((s, p) => s + p.mass, 0) || 1;
        while (this._prevAnim.length < n) this._prevAnim.push(body.anim[this._prevAnim.length].slice());
        for (const p of body.parts) {
            const i = p.index;
            if (p.joint !== null) {
                // The target goes as it is, with its (smoothed) spin: the motor leads it along that spin by as much as
                // its spring would trail it (joltWorld), once. A second lead here (a frame) doubled every jerk of the
                // pose (a recoil, a flinch) into the muscles.
                body.clampTarget(i);
                d.frequency = Math.max(0, body.frequency[i]);
                d.damping = Math.max(0, body.damping[i]);
                d.maxTorque = Math.max(0, body.torque[i] * massScale);
                d.gravityCompensation = Math.max(0, Math.min(1, body.holdUp[i]));
                d.friction = Math.max(0, body.friction[i]);
                // A spring sized to a load named outright (a planted leg's, the body it carries), else the joint's own.
                if (body.inertia[i] > 0) d.inertia = body.inertia[i]; else delete d.inertia;
                r.setMuscle(i, d);
                // A torque asked of the joint (the balancer's), into the parent's frame the drive takes it in.
                const jt = body.jointTorque[i];
                if (jt[0] !== 0 || jt[1] !== 0 || jt[2] !== 0) {
                    const ps = body.sim[p.parent];
                    const local = quatRotateTuple([-ps[3], -ps[4], -ps[5], ps[6]], jt);
                    r.setTarget(i, body.target[i], body.spin[i], local);
                } else r.setTarget(i, body.target[i], body.spin[i]);
            }
            const w = body.kinematic[i] ? 0 : body.pin[i], gw = body.kinematic[i] ? 0 : body.goalWeight[i];
            if (gw > 1e-3) {
                // A string to a point (a hand onto a wound): position only, moving as the point does.
                pin.linearFrequency = pins.frequency * gw;
                pin.angularFrequency = 0;
                pin.damping = pins.damping;
                pin.maxForce = pins.maxForce * gw * p.mass * n / total * massScale;
                pin.maxTorque = 0;
                r.setPin(i, pin);
                const g = body.goal[i], s = body.sim[i], t = this._goalPose, gv = body.goalVel[i], v = this._vel6;
                t[0] = g[0]; t[1] = g[1]; t[2] = g[2]; t[3] = s[3]; t[4] = s[4]; t[5] = s[5]; t[6] = s[6];
                v[0] = gv[0]; v[1] = gv[1]; v[2] = gv[2]; v[3] = v[4] = v[5] = 0;
                r.setPinTarget(i, t, v);
            } else if (w > 1e-3) {
                pin.linearFrequency = pins.frequency * w;
                pin.angularFrequency = pins.frequency * w;
                pin.damping = pins.damping;
                pin.maxForce = pins.maxForce * w * p.mass * n / total * massScale;
                pin.maxTorque = pins.maxTorque * w * p.mass * n / total * massScale;
                r.setPin(i, pin);
                // The animation's own velocity, so a running character's strings do not drag behind it.
                const a = body.anim[i], b = this._prevAnim[i], v = this._vel;
                if (dt > 1e-4) { v[0] = (a[0] - b[0]) / dt; v[1] = (a[1] - b[1]) / dt; v[2] = (a[2] - b[2]) / dt; }
                r.setPinTarget(i, a, v);
            } else r.setPin(i, null);
            // The drawing moves toward the state's at a rate, never in a step (from the legs' animation to their body
            // as it falls, the upper body's back to its animation).
            const was = this._mapNow[i] ?? body.mapping[i], want = body.mapping[i], rate = MAP_RATE * Math.max(dt, 1 / 240);
            const now = this._state === 'getUp' || this._state === 'dead' || this._state === 'down' ? want
                : want > was ? Math.min(want, was + rate) : Math.max(want, was - rate);
            this._mapNow[i] = now;
            r.setMapping(i, now);
            // Self-collision off for a part that asks to pass through the body (and back on after), and for the legs
            // and hips while they are the animation's: kinematic, they would shove an arm hanging beside them out of
            // the way with no give at all (the animation's own arm passes them by).
            // And the arms and hands while it stands (Euphoria's self-avoidance; PuppetMaster turns internal collisions
            // off while pinned): a hand on a grip beside the other, a forearm across the chest, are where the animation
            // puts them, and contacts there are a chatter the muscles fight. Back on half a second after it leaves its
            // feet, once the arms have come away.
            const arm = p.region === 'arms' || p.region === 'hands';
            if (arm && this._standingState()) this._selfOffUntil[i] = this._time + 0.5;
            const b = p.body, own = this._ownMask[i] ??= b.collisionFilterMask;
            const avoid = arm && this._time < (this._selfOffUntil[i] ?? -Infinity);
            const mask = body.passThrough[i] || body.kinematic[i] || avoid ? own & ~LAYER.RAGDOLL : own;
            if (b.collisionFilterMask !== mask) b.collisionFilterMask = mask;
            const prev = this._prevAnim[i];
            for (let k = 0; k < 7; k++) prev[k] = body.anim[i][k];
        }
        const st = this._state;
        r.loose = st === 'falling' || st === 'tumble' || st === 'down' || st === 'dead';
        const animator = this.node.animator;
        if (animator) {
            // On its feet the legs are the animation's, feet planted by its IK, and a hand on a weapon stays on it
            // (only a free hand reaches for a wound). Off them the body carries the legs and the hands: IK off.
            const standing = this._standingState();
            animator.ikSuppressed = !standing;
            animator.handIkSuppressed = !standing;
            // Shoved, the capsule slides under the feet: they follow the animation rather than stay planted.
            animator.footLockSuppressed = standing && (this._stepping || Math.hypot(this._knockV[0], this._knockV[2]) > KNOCK_UNLOCKS_FEET);
        }
    }

    private readonly _goalPose = [0, 0, 0, 0, 0, 0, 1];
    private readonly _vel6 = [0, 0, 0, 0, 0, 0];
    /** Per part: until when (reaction clock) its self-collision stays off after it stood (see _upload). */
    private _selfOffUntil: number[] = [];
    private readonly _nerves = new Nerves();

    /**
     * How tense the body is now (Nerves.tone): the set's Tense, by the worst recent hit, from TONE_DELAY on, easing off
     * over Tense for.
     */
    private _toneNow(): number {
        const H = this.set.behaviours.hitReact.params;
        if (!(H.tone > 0) || !this._wounds.length) return 0;
        let t = 0;
        for (const w of this._wounds) t = Math.max(t, Math.min(1, w.severity * 2) * reflexEnvelope(this._time - w.at - TONE_DELAY, 0.03, 0.15, Math.max(0.05, H.toneTime)));
        return H.tone * t;
    }
    /** Per part: how loose a hit has left it (0 none, up to 2), easing off (see hitReact). */
    private _loose = new Float64Array(0);
    /** Each part's collision mask as the ragdoll made it (what passThrough turns self-collision off from). */
    private _ownMask: number[] = [];

    private _massScale(r: Ragdoll): number {
        return r.parts.reduce((s, p) => s + p.mass, 0) / REFERENCE_MASS || 1;
    }

    /**
     * Change part `i`'s spin by (x, y, z) rad/s as an angular impulse (a pair of opposite impulses about its centre):
     * never a velocity written over the body's, which with the physics worker is a step or two old.
     */
    private _spin(i: number, x: number, y: number, z: number): void {
        const p = this._body?.parts[i];
        if (!p) return;
        // The body's inertia about the axis, as a capsule's (about its long axis or across it, roughly).
        const inertia = p.mass * (p.radius * p.radius * 0.4 + p.halfLength * p.halfLength / 3);
        this._angularImpulse(i, x * inertia, y * inertia, z * inertia);
    }

    /** An angular impulse (N·m·s, world) on part `i`: a pair of opposite impulses about its centre. */
    private _angularImpulse(i: number, x: number, y: number, z: number): void {
        const p = this._body?.parts[i];
        if (!p) return;
        const L = Math.hypot(x, y, z);
        if (!(L > 1e-9) || !Number.isFinite(L)) return;
        const ax = [x / L, y / L, z / L];
        // A unit vector square to the axis, and the couple's arm along it.
        const u = Math.abs(ax[1]) < 0.9 ? [ax[2], 0, -ax[0]] : [0, -ax[2], ax[1]];
        const un = Math.hypot(u[0], u[1], u[2]) || 1;
        u[0] /= un; u[1] /= un; u[2] /= un;
        const arm = 0.1, k = L / (2 * arm);
        const j = [(ax[1] * u[2] - ax[2] * u[1]) * k, (ax[2] * u[0] - ax[0] * u[2]) * k, (ax[0] * u[1] - ax[1] * u[0]) * k];
        p.body.applyImpulse(j, [u[0] * arm, u[1] * arm, u[2] * arm]);
        p.body.applyImpulse([-j[0], -j[1], -j[2]], [-u[0] * arm, -u[1] * arm, -u[2] * arm]);
    }

    private _context(dt: number): ReactionContext {
        return {
            body: this._body!, sensors: this.sensors, set: this.set, skin: this._skin!, state: this._state,
            stateTime: this._stateTime, time: this._time, dt, wounds: this._wounds, gravity: 9.81,
            massScale: this.ragdoll ? this._massScale(this.ragdoll) : 1,
            playClip: (clip, loop) => this._playClip(clip, loop),
            spin: (i, x, y, z) => this._spin(i, x, y, z),
            angularImpulse: (i, x, y, z) => this._angularImpulse(i, x, y, z),
            impulse: (i, x, y, z) => this._impulse(i, x, y, z),
            balancer: this._stepping ? this._balancer : null,
            standing: this._standingState(), knock: this._knockV,
            handFree: side => this._handFree(side),
            loose: this._loose,
            outCold: this._limp || this._time < this._unconsciousUntil,
            rolling: this._rolling, rollSign: this._rollSign,
        };
    }

    /** Fade every behaviour toward running (if its state allows it and it wants to) or not. */
    private _fade(dt: number): void {
        const ctx = this._context(dt);
        for (const b of BEHAVIOURS) {
            const config = this.set.behaviours[b.id];
            // Out cold (a limp Ragdoll state): relaxed as it falls too, nothing protective.
            const limp = this._limp && (this._state === 'falling' || this._state === 'tumble' || this._state === 'down');
            const inState = b.states.includes(this._state) || (limp && b.id === 'relax');
            const on = config.enabled && inState && !(limp && LIMP_OFF.has(b.id)) && (this._state !== 'down' || b.id !== 'relax' || !this._writhing()) && b.wants(ctx, config);
            const was = this._running.get(b) ?? 0;
            const step = dt / Math.max(1e-3, b.fade);
            const w = on ? Math.min(1, was + step) : Math.max(0, was - step);
            if (was === 0 && w > 0) b.start?.(ctx, config);
            if (was > 0 && w === 0) { b.stop?.(ctx, config); this._running.delete(b); continue; }
            if (w > 0) this._running.set(b, w);
        }
        const strongest = new Map<number, [string, number]>();
        // A rough owner per part for the timeline: the last running behaviour (they compose in order).
        for (const [b, w] of this._running) for (const i of this._body!.parts.map(p => p.index)) if (!strongest.has(i) || w >= strongest.get(i)![1]) strongest.set(i, [b.id, w]);
        for (let i = 0; i < this.owners.length; i++) this.owners[i] = strongest.get(i)?.[0] ?? null;
    }

    private _writhing(): boolean {
        const B = this.set.behaviours.writhe;
        return B.enabled && this._wounds.length > 0 && this._stateTime < B.params.duration;
    }

    // ---- wounds, parts ----

    private _resolvePart(part: number | string | undefined, point: ArrayLike<number> | null | undefined): number {
        const r = this.ragdoll!;
        if (typeof part === 'number' && r.parts[part]) return part;
        if (typeof part === 'string') { const i = r.findPart(part); if (i >= 0) return i; }
        if (point) return r.partAt(point)?.part ?? this._body!.chest;
        return this._body!.chest;
    }

    /** Where a hit on `part` pushing along `dir` landed: the zone it reacts by. */
    private _zoneOf(part: number, dir: ArrayLike<number>): HitZone {
        const p = this._body!.parts[part];
        if (p.region === 'neck' || p.role === 'head' || p.role === 'neck') return 'head';
        if (p.region === 'arms' || p.region === 'hands') return 'arm';
        if (p.region === 'legs' || p.region === 'feet') return 'leg';
        // The trunk: from behind (it pushes the way the body faces), the back; low on it, the gut; else the chest.
        const f = this._forward();
        if (dir[0] * f[0] + dir[2] * f[2] > 0.35) return 'back';
        return p.region === 'pelvis' || p.role === 'spine' ? 'gut' : 'chest';
    }

    private _wound(part: number, point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number): HitZone {
        const body = this._body!, p = body.parts[part];
        const q = quatConjugateTuple(body.simRotation(part));
        const c = p.body.position;
        const local = quatRotateTuple(q, [point[0] - c.x, point[1] - c.y, point[2] - c.z]);
        const normal = quatRotateTuple(q, [-dir[0], -dir[1], -dir[2]]);
        // A hand that can reach it: never the struck arm's own.
        let hand: 'L' | 'R' | null = null;
        const sides = (['L', 'R'] as const).filter(s => body.arms[s] && !(p.side === s && (p.region === 'arms' || p.region === 'hands')) && this._handFree(s));
        if (sides.length === 1) hand = sides[0];
        else if (sides.length === 2) {
            const d = (s: 'L' | 'R') => vec3.distance(body.pivot(body.arms[s]!.end), point as vec3);
            hand = d('L') <= d('R') ? 'L' : 'R';
        }
        const zone = this._zoneOf(part, dir);
        const severity = Math.min(1, impulse / Math.max(1, this.set.thresholds.fallImpulse) * 2);
        this._wounds.push({ part, local, normal, impulse: [dir[0] * impulse, dir[1] * impulse, dir[2] * impulse], at: this._time, hand, zone, severity, clock: this._physics.simulatedTime });
        // The struck part goes loose by how bad the hit was, ON TOP of what looseness it still has (Euphoria's
        // looseness per bullet): a second round on a weak arm keeps it weak, it does not start its ramp over. Off its
        // feet its neighbours give a little too.
        const L = this._loose;
        if (L.length > part) {
            L[part] = Math.min(2, L[part] + Math.max(0.25, severity));
            if (!this._standingState()) for (const j of [p.parent, ...p.children]) if (j >= 0 && j < L.length) L[j] = Math.min(2, L[j] + 0.5 * severity);
        }
        // Four at most: the slightest goes first (the oldest of equals), not merely the oldest.
        if (this._wounds.length > 4) {
            let worst = 0;
            for (let i = 1; i < this._wounds.length; i++) if (this._wounds[i].severity < this._wounds[worst].severity) worst = i;
            this._wounds.splice(worst, 1);
        }
        return zone;
    }

    // ---- the character ----

    private get _skin(): Skin | undefined {
        return (this.node.model as AnimatedModel | undefined)?.skin ?? undefined;
    }

    /** The Character this model stands for, if any. */
    private _character(): (Node & { teleport?: (p: ArrayLike<number>, yaw?: number) => unknown; collider: Node | null }) | null {
        for (let n: Node | null = this.node.parent; n; n = n.parent) if (n.nodeType === 'character') return n as never;
        return null;
    }

    private _collider(): (Node & { physicsEnabled: boolean }) | null {
        const c = this._character()?.collider;
        return c && c.nodeType === 'collider' ? c as never : null;
    }

    /** The character's Collider out of the world while the body is down: nothing walks or falls it meanwhile. */
    private _suspend(): void {
        const c = this._collider();
        if (c && c.physicsEnabled) c.physicsEnabled = false;
    }

    private _resume(): void {
        const c = this._collider();
        if (c && !c.physicsEnabled) c.physicsEnabled = true;
    }

    /**
     * While down, the Collider over the hips (cameras, AI and the HUD follow the body). Stepping to stay up, the
     * capsule follows the body's centre (CharacterNode.followBody), a little behind; with no Character, the model.
     */
    private _follow(): void {
        if (this._stepping && this._state === 'stagger') {
            const com = this.sensors.com, character = this._character() as { followBody?: (t: ArrayLike<number> | null, tau?: number) => void } | null;
            const tau = this._physics.executor === 'worker' ? 0.15 : 0.12;
            if (character?.followBody) character.followBody([com[0], com[2]], tau);
            else if (!character) {
                const p = this.node.worldPosition, k = Math.min(1, (1 / 60) / tau);
                this.node.setWorldPosition([p[0] + (com[0] - p[0]) * k, p[1], p[2] + (com[2] - p[2]) * k]);
                this.node.updateTransforms(this.node.parent ? this.node.parent.worldTransform : null);
            }
            return;
        }
        if (!['falling', 'tumble', 'down', 'dead'].includes(this._state)) return;
        const character = this._character(), collider = this._collider();
        if (!character || !collider || collider.physicsEnabled) return;
        const body = this._body!, p = body.simPosition(body.pelvis);
        const g = Number.isFinite(this.sensors.groundY) && this.sensors.height < 3 ? this.sensors.groundY : p[1] - 1;
        collider.setWorldPosition([p[0], g + this._feetOffset, p[2]]);
    }

    /** Stand the character (or, without one, the model itself) at `p` on the ground, facing `yaw` degrees when given. */
    private _place(p: ArrayLike<number>, yaw?: number): void {
        const character = this._character();
        if (character && typeof character.teleport === 'function') { character.teleport(p, yaw); return; }
        const node = this.node;
        node.setWorldPosition([p[0], p[1], p[2]]);
        if (yaw !== undefined) node.setWorldYaw(yaw);
        node.updateTransforms(node.parent ? node.parent.worldTransform : null);
    }

    /** The way the character (or the model) faces now, degrees. */
    private _yawNow(): number {
        const n = this._character() ?? this.node, q = n.worldQuaternion;
        const f = quatRotateTuple([q[0], q[1], q[2], q[3]], [0, 0, 1]);
        return yawFromDirection(f[0], f[2]);
    }

    /** Put the character standing where the body is, facing the way the body does. */
    private _placeCharacterAtBody(faceBody = true): void {
        if (!this._body) return;
        const body = this._body, p = body.simPosition(body.pelvis);
        const g = Number.isFinite(this.sensors.groundY) && this.sensors.height < 3 ? this.sensors.groundY : p[1] - 1;
        const f = this.sensors.forward;
        this._place([p[0], g, p[2]], faceBody ? yawFromDirection(f[0], f[2]) : undefined);
    }

    /**
     * Into the get-up clip: the character placed so the clip's first frame lies where the body does — its hips
     * over the body's hips, turned so its hips-to-head runs the way the body's does — then the strings pull the
     * body onto the clip.
     */
    private _startGetUp(): void {
        const B = this.set.behaviours.getUp, clips = B.clips ?? {};
        const animator = this.node.animator, body = this._body;
        this._getUpAction = null;
        if (!animator || !body) return;
        // Face up or down by the hips and the chest together: a body on its side is neither, by one of them alone.
        const faceUp = this._lyingFaceUp();
        // The graph's Get Up state plays it on the base layer (its clip, else the rig's), when it is in one.
        const graphClock = animator.playGetUp?.(faceUp, clips) ?? null;
        if (graphClock) {
            // Nothing of the Reaction slot over it (a writhe), at once: the pose measured next is the clip's first frame.
            if (this._clip) { animator.stopAction(REACTION_SLOT, 0); this._clip = null; }
            this._getUpAction = graphClock;
        } else {
            const clip = faceUp ? clips.faceUp ?? clips.faceDown : clips.faceDown ?? clips.faceUp;
            if (clip && animator.playAction) {
                this._clip = null;
                // Joined where the body in it starts to rise (a capture's get-up often lies still a second or more
                // first), present at once (a blend-in of 0): the pose measured next is that frame.
                const anim = (this.node.model as AnimatedModel | undefined)?.animations?.find(a => a.name === clip);
                const start = anim && this._skin ? clipRiseStart(anim, this._skin) : 0;
                const action = animator.playAction(clip, { slot: REACTION_SLOT, blendIn: 0.0, blendOut: 0.2, ikWeight: 0, startTime: start });
                if (!action.done) this._getUpAction = clockFrom(action, start);
            }
        }
        // Where the clip (or the plain animation) puts the hips now, against where the body has them.
        animator.update(0);
        body.begin();
        // The clip turned about the vertical to lie the way the body lies: its hips' long axis (hips to head) matched
        // to the body's where both lie flat enough to tell, else their side axis (a body sitting up). One axis, not a
        // blend of both: where the two disagree (the clip on its back, the body on its side), a blend cancels out.
        const qs = body.simRotation(body.pelvis), qa = body.animRotation(body.pelvis);
        let turn: number | null = null;
        for (const axis of [[0, 1, 0], [1, 0, 0]]) {
            const s = quatRotateTuple(qs, axis), a = quatRotateTuple(qa, axis);
            if (Math.hypot(s[0], s[2]) * Math.hypot(a[0], a[2]) < 0.25) continue;
            turn = Math.atan2(s[0], s[2]) - Math.atan2(a[0], a[2]);
            break;
        }
        const yaw = turn !== null
            ? this._yawNow() + turn * 180 / Math.PI
            : yawFromDirection(this.sensors.forward[0], this.sensors.forward[2]);
        const pelvisSim = body.simPosition(body.pelvis);
        const g = Number.isFinite(this.sensors.groundY) ? this.sensors.groundY : pelvisSim[1] - 0.2;
        this._place([pelvisSim[0], g, pelvisSim[2]], yaw);
        animator.update(0);
        body.begin();
        // The clip's hips straight over the body's: what is left of the gap, taken up by the character.
        const a = body.anim[body.pelvis];
        this._place([pelvisSim[0] * 2 - a[0], g, pelvisSim[2] * 2 - a[2]], yaw);
        animator.update(0);
    }

    /** Seconds the get-up clip waits on its first frame while the skin blends onto it (0: no clip, no wait). */
    private _getUpHold(): number {
        return this._getUpAction ? Math.max(0.15, this.set.behaviours.getUp.params.blendTime) : 0;
    }

    /** A get-up cut short: its clip faded out at once. */
    private _stopGetUp(): void {
        const a = this._getUpAction;
        this._getUpAction = null;
        if (a && !a.done) a.stop(0.12);
    }

    private _playClip(clip: string | null, loop = true): void {
        const animator = this.node.animator;
        if (!animator || clip === this._clip) return;
        if (clip) animator.playAction(clip, { slot: REACTION_SLOT, loop, blendIn: 0.25, blendOut: 0.3, ikWeight: 0 });
        else if (this._clip) animator.stopAction(REACTION_SLOT, 0.3);
        this._clip = clip;
    }

    private _restoreClear(): void {
        if (this._clearBody) { this._clearBody.collisionFilterMask = this._clearMask; this._clearBody = null; }
    }

    private _forward(): [number, number, number] {
        const q = this.node.worldQuaternion;
        const f = quatRotateTuple([q[0], q[1], q[2], q[3]], [0, 0, 1]);
        const n = Math.hypot(f[0], f[2]) || 1;
        return [f[0] / n, 0, f[2] / n];
    }

    private readonly _detail: SensorDetail = { sweep: true, terrain: true, under: true };
    private _senseFrame = 0;
    /** The senses' rays: past its own limbs and its own capsule. One filter and one options record, reused. */
    private readonly _rejectOwn = (_owner: Node | null, body: PhysicsBody) => this._physics.ragdollPartOf(body)?.ragdoll === this.ragdoll || this._isOwnCollider(body);
    private readonly _rayOptions: { ignore: PhysicsBody[]; reject: (owner: Node | null, body: PhysicsBody) => boolean } = { ignore: [], reject: this._rejectOwn };
    private readonly _rayFrom = vec3.create();
    private readonly _rayTo = vec3.create();
    private readonly _raycaster: Raycaster = (from, to, ignore) => {
        physicsStats.sensorRays++;
        this._rayOptions.ignore = ignore as PhysicsBody[];
        const hit = this._physics.raycast(vec3.set(this._rayFrom, from[0], from[1], from[2]), vec3.set(this._rayTo, to[0], to[1], to[2]), this._rayOptions);
        return hit ? { point: [hit.point[0], hit.point[1], hit.point[2]], normal: [hit.normal[0], hit.normal[1], hit.normal[2]], distance: hit.distance } : null;
    };

    /** A part's name for a hit before there is a body (its index or name in the layout, as the hit gives it). */
    private _partNameOf(part: unknown): string {
        if (typeof part === 'string') return part;
        if (typeof part === 'number') return this._layout()?.parts[part]?.part.name ?? '';
        return '';
    }

    private _isOwnCollider(body: PhysicsBody): boolean {
        const c = this._collider() as unknown as { ownBody?: PhysicsBody | null } | null;
        return !!c && c.ownBody === body;
    }

    private _emit(event: string, extra: Partial<ReactionEventInfo>): void {
        const [channel, name] = resolveEvent(`reaction:${event}`);
        if (!channel.hasListeners(name)) return;
        const info: ReactionEventInfo = { event, state: this._state, from: null, node: this.node, controller: this, ...extra };
        try { channel.fire(name, [info], this.node); } catch { /* a listener's error is the listener's */ }
    }
}

