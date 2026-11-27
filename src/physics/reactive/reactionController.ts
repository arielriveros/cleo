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
import { closestSegmentSegment, quatConjugateTuple, quatMultiplyTuple, quatRotateTuple, quatToRotationVector, rotationVectorToQuat, yawFromDirection } from '../../core/math';
import { cachedRagdollLayout, ragdollPartPoseInto, skinRagdollProfile, type RagdollLayout } from '../ragdollProfile';
import { physicsStats } from '../physicsStats';
import type { mat4 } from 'gl-matrix';
import { BodySensors, type ContactList, type Raycaster, type SensorDetail } from './bodySensors';
import { ReactionBody } from './reactionBody';
import { BAILS, BEHAVIOURS, STRUCK, type ReactionBehaviour, type ReactionContext, type ReactionState, type ReactionWound } from './behaviours';
import type { AnimationActionHandle } from '../../animation/animator';
import { pickReactionSet, parseReactionSets, type ReactionSet } from './reactionSet';

export type { ReactionState, ReactionWound } from './behaviours';

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
    fallHeight?: number;
    impactSpeed?: number;
    faceUp?: boolean;
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
/** A part of the body that is the animation's while the character stands (kinematic on it). */
const LOWER = (region: string) => region === 'pelvis' || region === 'legs' || region === 'feet';

export class ReactionController {
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
    private _getUpAction: AnimationActionHandle | null = null;
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
    /** Off its feet: falling, tumbling, down, getting up or dead. */
    public get isDown(): boolean { return ['falling', 'tumble', 'down', 'getUp', 'dead'].includes(this._state); }
    /**
     * The character keeps its control: on its feet, flinching or staggering (its Collider live, its legs on its
     * animation); a script goes on moving, aiming and firing it. False only off its feet ({@link isDown}).
     */
    public get hasControl(): boolean { return !this.isDown; }
    /** On its feet with a reaction running: the legs on the animation, the upper body following it. */
    public get standing(): boolean { return this._standingState(); }
    public get faceUp(): boolean { return this.sensors.faceUp; }
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
        const dir = h.direction ? vec3.normalize(vec3.create(), [h.direction[0], h.direction[1], h.direction[2]]) : vec3.fromValues(0, 0, -1);
        const impulse = Math.max(0, h.impulse ?? 20);
        if (h.damage) this._health = Math.max(0, this._health - h.damage);
        const dying = this._alive && this._health <= 0;
        if (impulse < T.minHitImpulse && !dying) return;
        const recent = this._addRecent(impulse);
        const onFeet = this._onFeetState();
        const falls = dying || impulse >= T.fallImpulse || (onFeet && recent >= T.fallImpulse);
        const stepping = this.set.behaviours.stepBalance.enabled;
        // A hit it would only flinch or stumble from asks for a body within the budget (PhysicsSystem.maxPoweredRagdolls);
        // refused, the hit still counts (its Hit event), and a stumble still shoves the capsule.
        const r = this._ensure(falls ? 'fall' : 'flinch');
        // Rocked back by a hard hit, a burst adding up, or a heavy round in the trunk: a stagger, kept on its feet.
        const region = this._regionOf(h.part, h.point);
        const staggers = onFeet && stepping && !falls && (impulse >= T.staggerImpulse || recent >= T.staggerImpulse
            || ((region === 'pelvis' || region === 'spine') && T.stumbleImpulse > 0 && impulse >= T.stumbleImpulse));
        if (!r) {
            if (!this.ragdoll && this.node.animator && this._skin) {
                const point = h.point ? [h.point[0], h.point[1], h.point[2]] as [number, number, number] : [0, 0, 0] as [number, number, number];
                this._emit('Hit', { part: -1, partName: this._partNameOf(h.part), impulse, point });
            }
            if (staggers) this._knockBack(dir, impulse);
            return;
        }
        // Off its feet first, so the whole hit lands on a body that has every part.
        if (falls || this._state === 'getUp') this._go('falling');
        const kept = onFeet && this._state !== 'falling';
        let part = this._resolvePart(h.part, h.point);
        const p = r.parts[part];
        const point = h.point ? [h.point[0], h.point[1], h.point[2]] : [p.body.position.x, p.body.position.y, p.body.position.z];
        if (kept && this._physicsCanStand()) {
            // On its feet the struck part takes a kick, no more: what is left of the hit is the shove's. A part that is
            // the animation's (a leg, the hips) passes it to the trunk.
            if (LOWER(p.region)) part = this._body!.chest;
            const q = r.parts[part], P = this.set.behaviours.hitReact.params;
            const kick = Math.min(impulse, P.maxKick, MAX_KICK_SPEED * q.mass);
            r.applyImpulse([dir[0] * kick, dir[1] * kick, dir[2] * kick], point, part);
        } else r.applyImpulse([dir[0] * impulse, dir[1] * impulse, dir[2] * impulse], point, part);
        this._wound(part, point, dir, impulse);
        this._emit('Hit', { part, partName: r.parts[part].name, impulse, point: point as [number, number, number] });
        if (dying) { this.kill(); return; }
        if (kept && !this._standingState()) this._go('hitReact');
        if (staggers) { this._knockBack(dir, impulse); this._go('stagger'); }
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
        const speed = T.stumbleSpeed * Math.min(2.5, impulse / Math.max(1, T.stumbleImpulse));
        this._knock([dir[0] / flat * speed, 0, dir[2] / flat * speed], P.knockTime);
    }

    private _knock(v: ArrayLike<number>, halfLife: number): void {
        this._knockHalfLife = Math.max(0.05, halfLife);
        this._knockV[0] += v[0]; this._knockV[2] += v[2];
        const character = this._character() as { knockback?: (v: ArrayLike<number>, halfLife?: number) => void } | null;
        if (character && typeof character.knockback === 'function') character.knockback([v[0], 0, v[2]], this._knockHalfLife);
    }

    /**
     * Struck by something big and moving (a car), going `velocity` (world): the legs are taken out at its speed and
     * the trunk thrown less and upward, so the body pivots over what hit it. It braces as it goes (the Struck
     * behaviour: knees and hips bent, arms round the head) and falls. `point`: where it was struck, for the wound.
     */
    public impact(opts: { velocity: ArrayLike<number>; point?: ArrayLike<number> | null }): void {
        if (this.config.enabled === false) return;
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
        const r = this._ensure();
        if (!r) return;
        const T = this.set.thresholds;
        const speed = Math.hypot(velocity[0], velocity[1], velocity[2]);
        const parts = part === undefined ? r.parts : [r.parts[this._resolvePart(part, null)]];
        let impulse = 0;
        for (const p of parts) impulse += speed * p.mass;
        const onFeet = this._onFeetState();
        const stepping = this.set.behaviours.stepBalance.enabled;
        if (impulse >= T.fallImpulse || !onFeet || !stepping) {
            if (impulse >= T.fallImpulse || this._state === 'getUp' && impulse >= T.minHitImpulse) this._go('falling');
            for (const p of parts) p.body.applyImpulse([velocity[0] * p.mass, velocity[1] * p.mass, velocity[2] * p.mass]);
            if (onFeet && !this._standingState() && this._state !== 'falling') this._go('hitReact');
            return;
        }
        if (!this._standingState()) this._go('hitReact');
        // The upper body sways (no part changed by more than a kick); the capsule carries the rest.
        const v = Math.min(speed, MAX_KICK_SPEED), k = speed > 0 ? v / speed : 0;
        for (const p of parts) if (!this._body?.kinematic[p.index]) p.body.applyImpulse([velocity[0] * k * p.mass, velocity[1] * k * p.mass, velocity[2] * k * p.mass]);
        this._knock([velocity[0], 0, velocity[2]], this.set.behaviours.stepBalance.params.knockTime);
        if (impulse >= T.staggerImpulse) this._go('stagger');
    }

    /** Fall now (off a ledge, a floor giving way): the body takes over, falling as it was moving. */
    public fall(): void {
        if (this.config.enabled === false || !this._ensure()) return;
        this._go('falling');
    }

    /** Trip over something: the feet stop, the body goes on, it falls forward. */
    public trip(): void {
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
        this._go(this.isDown ? this._state : 'falling');
    }

    /** Dies: falls limp and never gets up. */
    public kill(): void {
        this._alive = false;
        this._health = 0;
        if (!this._ensure()) return;
        this._emit('Died', {});
        this._go('dead');
    }

    /** Get up now, if it is down (and alive). */
    public getUp(): void {
        if (this._state === 'down' && this._alive) this._go('getUp');
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
        if (this._body) BAILS.add(this._body);
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
        this._health = Math.max(0, Math.min(1, this.config.health ?? 1));
    }

    // ---- the frame (PhysicsSystem calls these) ----

    /** Before the physics step: compose the targets and send them to the muscles and strings. */
    public _preStep(dt: number): void {
        const r = this.ragdoll, body = this._body;
        if (!r || !body || r.destroyed || r.frozen) return;
        // The get-up clip waits on its first frame while the skin blends onto it.
        if (this._state === 'getUp' && this._getUpAction && this._stateTime < this._getUpHold()) this._getUpAction.seek(0);
        body.begin(dt);
        if (this._split) this._driveKinematic(body, dt);
        this._base(body, dt);
        const ctx = this._context(dt);
        for (const b of BEHAVIOURS) {
            const w = this._running.get(b) ?? 0;
            if (w > 0) b.update(ctx, this.set.behaviours[b.id], w);
        }
        this._upload(body, dt);
    }

    /**
     * The legs and hips on their animation: each kinematic part given the velocity that takes it, over this step, to
     * where the animation will have it a frame on (its pose, moved on by its own motion: the animator poses after the
     * physics steps). Far from it (a teleport), put there.
     */
    private _driveKinematic(body: ReactionBody, dt: number): void {
        if (!(dt > 1e-4)) return;
        const r = this.ragdoll!;
        for (const p of body.parts) {
            const i = p.index;
            if (!body.kinematic[i]) continue;
            const a = body.anim[i], v = body.animVel[i], s = body.sim[i], b = p.body;
            const tx = a[0] + v[0] * dt, ty = a[1] + v[1] * dt, tz = a[2] + v[2] * dt;
            const qa = rotationVectorToQuat([v[3] * dt, v[4] * dt, v[5] * dt]);
            const qt = quatMultiplyTuple(qa, [a[3], a[4], a[5], a[6]]);
            if (Math.hypot(tx - s[0], ty - s[1], tz - s[2]) > 0.3) {
                b.position.set(a[0], a[1], a[2]);
                b.quaternion.set(a[3], a[4], a[5], a[6]);
                b.velocity.set(v[0], v[1], v[2]);
                b.angularVelocity.set(v[3], v[4], v[5]);
                continue;
            }
            b.velocity.set((tx - s[0]) / dt, (ty - s[1]) / dt, (tz - s[2]) / dt);
            const w = quatToRotationVector(quatMultiplyTuple(qt, quatConjugateTuple([s[3], s[4], s[5], s[6]])));
            b.angularVelocity.set(w[0] / dt, w[1] / dt, w[2] / dt);
        }
        void r;
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
        if (this._clearBody && this._time >= this._clearUntil) this._restoreClear();
        this._fadeKnock(dt);
        this._transitions(dt);
        if (!this.ragdoll || !this._body) return;
        this._fade(dt);
        this._follow();
        // Drop wounds long healed.
        const keep = this.set.behaviours.hitReact.params.holdTime + this.set.behaviours.hitReact.params.reachDelay + 1;
        for (let i = this._wounds.length - 1; i >= 0; i--) if (this._time - this._wounds[i].at > keep && this._state !== 'down') this._wounds.splice(i, 1);
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
                if (this._tippedOver(dt)) this._go('falling');
                else if (t > B.hitReact.params.duration || this._time - this._reactionStart > T.maxReactionSeconds) this._go('recover');
                break;
            }
            case 'stagger': {
                const P = B.stepBalance.params;
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
                const rolling = s.trunkSpin > T.tumbleAngularSpeed || ((s.terrain === 'stairs' || s.terrain === 'slope') && s.speed > B.tumble.params.slowDownSpeed);
                if (rolling && B.tumble.enabled) this._go('tumble');
                else if (s.speed < T.downSpeed) this._go('down');
                break;
            }
            case 'tumble':
                if (s.speed < T.downSpeed && s.trunkSpin < T.tumbleAngularSpeed * 0.5) this._go('down');
                else if (t > 8) this._go('down');
                break;
            case 'down': {
                if (s.stillFor > T.settleTime && !this._settledSent) { this._settledSent = true; this._emit('Settled', { faceUp: s.faceUp }); }
                if (!this._alive) { this._go('dead'); break; }
                if (!s.grounded && s.speed > T.downSpeed * 3) { this._go('falling'); break; }
                const wantsUp = B.getUp.enabled && this.config.getUp !== false && this._time >= this._unconsciousUntil;
                const writhing = B.writhe.enabled && this._wounds.length > 0 && t < B.writhe.params.duration;
                // Lying still with nothing left to do but wait: its bodies leave the world, the pose held where it lies,
                // until it gets up or something moves it (a hit, a push: _ensure puts them back).
                const r = this.ragdoll;
                if (r && !r.frozen && this._settledSent && !writhing && this._alive) r.freeze();
                if (wantsUp && !writhing && s.stillFor > T.settleTime + B.getUp.params.delay) this._go('getUp');
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
        return this._split && (this._state === 'hitReact' || this._state === 'stagger' || this._state === 'recover');
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
        if (!this._character() && this._standingState()) {
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
        // Off the ground's rest: its bodies back in the world (they left it lying still).
        if (from === 'down' && next !== 'dead' && this.ragdoll?.frozen) this.ragdoll.unfreeze();
        if (next !== 'animated' && from === 'animated') { this._reactionStart = this._time; this._emit('Started', { from }); }
        // A get-up cut short (a hit, a push): its clip stops, and the body is the body's again.
        if (from === 'getUp' && next !== 'recover') this._stopGetUp();
        if (next === 'recover') this._recoverFromGetUp = from === 'getUp' && !!this._getUpAction;
        // On its feet the legs are the animation's and the Collider stays; off them every part is the body's.
        const onFeet = next === 'hitReact' || next === 'stagger' || (next === 'recover' && (from === 'hitReact' || from === 'stagger'));
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
                this._emit('Down', { from, faceUp: this.sensors.faceUp });
                break;
            case 'getUp':
                this._suspend();
                this._startGetUp();
                this._emit('GettingUp', { from, faceUp: this.sensors.faceUp });
                break;
            case 'recover':
                // Up from the ground: the Collider back under the body, the animation there. On its feet it never left.
                if (from === 'getUp') this._placeCharacterAtBody(false);
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
        this._split = false;
        this._mapNow = new Float64Array(r.parts.length);
        this._recent.length = 0;
        // Where the feet are below the Collider's origin: what following the hips puts back.
        const character = this._character();
        const collider = character?.collider;
        this._feetOffset = collider && character ? collider.worldPosition[1] - this.node.worldPosition[1] : 0;
        this._body.begin();
        return r;
    }

    private _release(): void {
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
        const letGo = state === 'recover' && standing && (this._stateTime > 0.6 || this._trackingError() < TRACKED);
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
            if (state === 'falling' || state === 'tumble' || state === 'down' || state === 'dead') body.hold(i, 1);
            if (state === 'tumble' || state === 'down') { body.holdUp[i] *= 0.3; body.torque[i] *= 0.6; }
            let pin = 0, map = 1;
            if (standing) {
                // The legs and hips are the animation's; the upper body is drawn simulated (a hand on a weapon a
                // little less, so it stays on its grip), until it is let go back to the animation.
                const arm = (p.region === 'arms' || p.region === 'hands') && p.side ? p.side : null;
                map = body.kinematic[i] ? 0 : letGo ? 0 : arm && !this._handFree(arm) ? 0.6 : 1;
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
        const lead = this._split ? dt : 0;
        for (const p of body.parts) {
            const i = p.index;
            if (p.joint !== null) {
                // A frame ahead along the animation's own motion: the animator poses after the physics steps, so the
                // pose read is a frame old, and a muscle aimed at it would trail a swinging arm.
                const s = body.spin[i];
                if (lead > 0 && (s[0] !== 0 || s[1] !== 0 || s[2] !== 0)) {
                    const t = body.target[i], q = quatMultiplyTuple(rotationVectorToQuat([s[0] * lead, s[1] * lead, s[2] * lead]), t);
                    t[0] = q[0]; t[1] = q[1]; t[2] = q[2]; t[3] = q[3];
                }
                body.clampTarget(i);
                d.frequency = Math.max(0, body.frequency[i]);
                d.damping = Math.max(0, body.damping[i]);
                d.maxTorque = Math.max(0, body.torque[i] * massScale);
                d.gravityCompensation = Math.max(0, Math.min(1, body.holdUp[i]));
                d.friction = Math.max(0, body.friction[i]);
                r.setMuscle(i, d);
                r.setTarget(i, body.target[i], body.spin[i]);
            }
            const w = body.kinematic[i] ? 0 : body.pin[i], gw = body.kinematic[i] ? 0 : body.goalWeight[i];
            if (gw > 1e-3) {
                // A string to a point (a hand onto a wound): position only, still.
                pin.linearFrequency = pins.frequency * gw;
                pin.angularFrequency = 0;
                pin.damping = pins.damping;
                pin.maxForce = pins.maxForce * gw * p.mass * n / total * massScale;
                pin.maxTorque = 0;
                r.setPin(i, pin);
                const g = body.goal[i], s = body.sim[i], t = this._goalPose;
                t[0] = g[0]; t[1] = g[1]; t[2] = g[2]; t[3] = s[3]; t[4] = s[4]; t[5] = s[5]; t[6] = s[6];
                r.setPinTarget(i, t, null);
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
            const b = p.body, own = this._ownMask[i] ??= b.collisionFilterMask;
            const mask = body.passThrough[i] || body.kinematic[i] ? own & ~LAYER.RAGDOLL : own;
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
        }
    }

    private readonly _goalPose = [0, 0, 0, 0, 0, 0, 1];
    /** Each part's collision mask as the ragdoll made it (what passThrough turns self-collision off from). */
    private _ownMask: number[] = [];

    private _massScale(r: Ragdoll): number {
        return r.parts.reduce((s, p) => s + p.mass, 0) / REFERENCE_MASS || 1;
    }

    private _context(dt: number): ReactionContext {
        return {
            body: this._body!, sensors: this.sensors, set: this.set, skin: this._skin!, state: this._state,
            stateTime: this._stateTime, time: this._time, dt, wounds: this._wounds, gravity: 9.81,
            massScale: this.ragdoll ? this._massScale(this.ragdoll) : 1,
            playClip: (clip, loop) => this._playClip(clip, loop),
            spin: (i, x, y, z) => { const b = this._body?.parts[i]?.body; if (b) b.angularVelocity.vadd({ x, y, z }, b.angularVelocity); },
            standing: this._standingState(), knock: this._knockV,
            handFree: side => this._handFree(side),
        };
    }

    /** Fade every behaviour toward running (if its state allows it and it wants to) or not. */
    private _fade(dt: number): void {
        const ctx = this._context(dt);
        for (const b of BEHAVIOURS) {
            const config = this.set.behaviours[b.id];
            const on = config.enabled && b.states.includes(this._state) && (this._state !== 'down' || b.id !== 'relax' || !this._writhing()) && b.wants(ctx, config);
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

    private _wound(part: number, point: ArrayLike<number>, dir: ArrayLike<number>, impulse: number): void {
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
        this._wounds.push({ part, local, normal, impulse: [dir[0] * impulse, dir[1] * impulse, dir[2] * impulse], at: this._time, hand });
        if (this._wounds.length > 4) this._wounds.shift();
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

    /** While down, the Collider over the hips (cameras, AI and the HUD follow the body). */
    private _follow(): void {
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
        const fwdY = (i: number) => quatRotateTuple(body.simRotation(i), [0, 0, 1])[1];
        const faceUp = fwdY(body.pelvis) + (body.chest >= 0 ? fwdY(body.chest) : 0) > 0;
        const clip = faceUp ? clips.faceUp ?? clips.faceDown : clips.faceDown ?? clips.faceUp;
        if (clip && animator.playAction) {
            this._clip = null;
            // Present at once (a blend-in of 0): the pose measured next is the clip's first frame.
            const action = animator.playAction(clip, { slot: REACTION_SLOT, blendIn: 0.0, blendOut: 0.2, ikWeight: 0 });
            if (!action.done) this._getUpAction = action;
        }
        // Where the clip (or the plain animation) puts the hips now, against where the body has them.
        animator.update(0);
        body.begin();
        // The clip turned about the vertical to lie the way the body lies: its hips' long axis (hips to head) and
        // their side axis, each weighted by how flat it lies, matched to the body's. The body does not turn.
        const qs = body.simRotation(body.pelvis), qa = body.animRotation(body.pelvis);
        let sx = 0, sz = 0;
        for (const axis of [[0, 1, 0], [1, 0, 0]]) {
            const s = quatRotateTuple(qs, axis), a = quatRotateTuple(qa, axis);
            const w = Math.hypot(s[0], s[2]) * Math.hypot(a[0], a[2]);
            if (w < 1e-4) continue;
            const d = Math.atan2(s[0], s[2]) - Math.atan2(a[0], a[2]);
            sx += w * Math.sin(d); sz += w * Math.cos(d);
        }
        const yaw = sx !== 0 || sz !== 0
            ? this._yawNow() + Math.atan2(sx, sz) * 180 / Math.PI
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

