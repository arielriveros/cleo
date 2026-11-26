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
import { closestSegmentSegment, quatConjugateTuple, quatRotateTuple, yawFromDirection } from '../../core/math';
import { autoHumanoidProfile, parseRagdollProfile, ragdollLayout, ragdollPartPoseInto, type RagdollLayout } from '../ragdollProfile';
import type { mat4 } from 'gl-matrix';
import { BodySensors, type ContactList, type Raycaster } from './bodySensors';
import { ReactionBody } from './reactionBody';
import { BAILS, BEHAVIOURS, stepState, type ReactionBehaviour, type ReactionContext, type ReactionState, type ReactionWound } from './behaviours';
import { pickReactionSet, parseReactionSets, type ReactionSet } from './reactionSet';

export type { ReactionState, ReactionWound } from './behaviours';

// A character's reactions: Euphoria's reactive ragdoll for one skinned model. It owns a POWERED ragdoll while
// a reaction runs (physics/ragdoll.ts — the animation keeps playing underneath as the muscles' target) and
// moves it through a few states:
//
//   animated ─hit─► hitReact ─knocked over─► stagger ─gives up─► falling ─lands─► tumble ─► down ─► getUp ─► recover ─► animated
//                      └───────────────── recover ◄─ balanced ◄───┘           (dead: no getting up)
//
// Each state lets some behaviours run (behaviours.ts: protect the head, catch the fall, step to balance...),
// which compose the muscles' targets and stiffness; the controller sends them on before every physics step and
// measures the body (bodySensors.ts) after it. While a reaction has the body down, the character's Collider
// is out of the world and follows the hips, so cameras and AI follow the body; getting up puts it back. It
// fires `reaction:*` events at the model node (they bubble to the Character): Hit, Started, Stagger, Fell,
// Landed, Down, Settled, GettingUp, GotUp, Recovered, Died.

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
    private _getUpAction: { done: boolean; time: number; duration: number } | null = null;
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
        const skin = this._skin, animator = this.node.animator;
        if (!skin || !animator) return null;
        const segs: { name: string; c: [number, number, number]; y: [number, number, number]; half: number; r: number }[] = [];
        if (this.ragdoll && !this.ragdoll.destroyed) {
            for (const p of this.ragdoll.parts) {
                const b = p.body, q = b.quaternion;
                segs.push({ name: p.name, c: [b.position.x, b.position.y, b.position.z], y: quatRotateTuple([q.x, q.y, q.z, q.w], [0, 1, 0]), half: p.halfLength, r: p.radius });
            }
        } else {
            const layout = this._layout();
            if (!layout) return null;
            const bones = animator.getFinalBoneMatrices(), world = this.node.worldTransform as mat4, pose = [0, 0, 0, 0, 0, 0, 1];
            for (const lp of layout.parts) {
                const scale = ragdollPartPoseInto(skin, lp, world, bones[lp.joint] as mat4, pose);
                segs.push({ name: lp.part.name, c: [pose[0], pose[1], pose[2]], y: quatRotateTuple([pose[3], pose[4], pose[5], pose[6]], [0, 1, 0]), half: lp.length * scale / 2, r: lp.radius * scale });
            }
        }
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

    /** The ragdoll layout a reaction would build, for hits before it has (cached per skin profile). */
    private _layout(): RagdollLayout | null {
        const skin = this._skin;
        if (!skin) return null;
        const profile = parseRagdollProfile(skin.ragdollProfile ?? autoHumanoidProfile(skin));
        if (!profile) return null;
        if (!this._layoutOf || this._layoutOf.profile !== skin.ragdollProfile) this._layoutOf = { profile: skin.ragdollProfile, layout: ragdollLayout(skin, profile) };
        return this._layoutOf.layout;
    }
    private _layoutOf: { profile: unknown; layout: RagdollLayout } | null = null;

    /** Use another of the skeleton's reaction sets (by id or name). */
    public useSet(name: string): void { this.set = pickReactionSet(parseReactionSets(this._skin?.reactionSets), name); }

    // ---- what scripts ask of it ----

    /** A hit: a bullet, a punch. Small hits flinch, harder ones stagger, the hardest knock it down. */
    public hit(h: ReactionHit = {}): void {
        if (this.config.enabled === false) return;
        const T = this.set.thresholds;
        const dir = h.direction ? vec3.normalize(vec3.create(), [h.direction[0], h.direction[1], h.direction[2]]) : vec3.fromValues(0, 0, -1);
        const impulse = Math.max(0, h.impulse ?? 20);
        if (h.damage) this._health = Math.max(0, this._health - h.damage);
        const dying = this._alive && this._health <= 0;
        if (impulse < T.minHitImpulse && !dying) return;
        const r = this._ensure();
        if (!r) return;
        const part = this._resolvePart(h.part, h.point);
        const p = r.parts[part];
        const point = h.point ? [h.point[0], h.point[1], h.point[2]] : [p.body.position.x, p.body.position.y, p.body.position.z];
        r.applyImpulse([dir[0] * impulse, dir[1] * impulse, dir[2] * impulse], point, part);
        this._wound(part, point, dir, impulse);
        this._emit('Hit', { part, partName: p.name, impulse, point: point as [number, number, number] });
        if (dying) { this.kill(); return; }
        // How far it goes.
        if (impulse >= T.fallImpulse) this._go('falling');
        else if (impulse >= T.staggerImpulse && this.set.behaviours.stepBalance.enabled && this._state !== 'falling') this._go(this._state === 'animated' || this._state === 'hitReact' ? 'stagger' : this._state);
        else if (this._state === 'animated' || this._state === 'recover') this._go('hitReact');
    }

    /** A shove: every part (or one) given this velocity change (m/s, world). */
    public push(velocity: ArrayLike<number>, part?: number | string): void {
        if (this.config.enabled === false) return;
        const r = this._ensure();
        if (!r) return;
        const parts = part === undefined ? r.parts : [r.parts[this._resolvePart(part, null)]];
        let impulse = 0;
        for (const p of parts) {
            p.body.applyImpulse([velocity[0] * p.mass, velocity[1] * p.mass, velocity[2] * p.mass]);
            impulse += Math.hypot(velocity[0], velocity[1], velocity[2]) * p.mass;
        }
        const T = this.set.thresholds;
        if (impulse >= T.fallImpulse) this._go('falling');
        else if (impulse >= T.staggerImpulse && this.set.behaviours.stepBalance.enabled) this._go('stagger');
        else if (this._state === 'animated') this._go('hitReact');
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
        body.begin();
        this._base(body, dt);
        const ctx = this._context(dt);
        for (const b of BEHAVIOURS) {
            const w = this._running.get(b) ?? 0;
            if (w > 0) b.update(ctx, this.set.behaviours[b.id], w);
        }
        this._upload(body, dt);
    }

    /** After the physics step: measure the body, move between states, fade behaviours, follow with the Collider. */
    public _postStep(dt: number, contacts: ContactList | null): void {
        const r = this.ragdoll;
        if (!r || !this._body) return;
        if (r.destroyed) { this._forget(); return; }
        this._time += dt;
        this._stateTime += dt;
        if (!r.frozen) this.sensors.update(r, dt, contacts, this.set.thresholds.settleSpeed, this._raycaster);
        if (this._clearBody && this._time >= this._clearUntil) this._restoreClear();
        this._transitions();
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

    private _transitions(): void {
        const s = this.sensors, T = this.set.thresholds, B = this.set.behaviours;
        const t = this._stateTime;
        if (this._time > T.maxReactionSeconds && ['hitReact', 'stagger', 'falling', 'tumble'].includes(this._state)) { this._go('down'); return; }
        switch (this._state) {
            case 'hitReact': {
                const body = this._body!;
                const knocked = vec3.distance(body.simPosition(body.pelvis), [body.anim[body.pelvis][0], body.anim[body.pelvis][1], body.anim[body.pelvis][2]]) > T.knockOutDistance;
                if (knocked) this._go(B.stepBalance.enabled ? 'stagger' : 'falling');
                else if (t > B.hitReact.params.duration) this._go('recover');
                break;
            }
            case 'stagger': {
                const P = B.stepBalance.params, step = stepState(this._body!);
                if (s.uprightness < P.giveUpUprightness || s.uprightness < T.fallUprightness
                    || (step.steps >= P.maxSteps && !step.swing && s.captureMargin > P.captureMargin)
                    || (s.feetDown > 0 && s.captureMargin > 2.5 * P.maxStepLength) || (s.feetDown === 0 && t > 0.6) || t > 6) { this._go('falling'); break; }
                if (s.captureMargin < 0 && s.speed < 0.35 && !step.swing) { if ((this._balancedFor += 1 / 60) > P.recoverTime) this._go('recover'); }
                else this._balancedFor = 0;
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
                if (t >= Math.max(0.05, B.getUp.params.blendTime)) {
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

    private _go(next: ReactionState): void {
        const from = this._state;
        if (next === from) return;
        this._state = next;
        this._stateTime = 0;
        this._balancedFor = 0;
        if (next !== 'animated' && from === 'animated') this._emit('Started', { from });
        switch (next) {
            case 'hitReact':
                break;
            case 'stagger':
                this._suspend();
                this._emit('Stagger', { from });
                break;
            case 'falling':
                this._suspend();
                this._landed = false;
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
                // Standing where the body is: the Collider back under it, the animation there.
                if (from !== 'hitReact') this._placeCharacterAtBody(from !== 'getUp');
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

    /** The powered ragdoll, made from the pose the character holds now. Null where it cannot be (no skin, no profile). */
    private _ensure(): Ragdoll | null {
        if (this.ragdoll && !this.ragdoll.destroyed) {
            if (this.ragdoll.frozen) { this.ragdoll.unfreeze(); this.ragdoll.autoFreeze = !this._alive; }
            return this.ragdoll;
        }
        const animator = this.node.animator;
        if (!animator || !this._skin) return null;
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
        // Where the feet are below the Collider's origin: what following the hips puts back.
        const character = this._character();
        const collider = character?.collider;
        this._feetOffset = collider && character ? collider.worldPosition[1] - this.node.worldPosition[1] : 0;
        this._body.begin();
        return r;
    }

    private _release(): void {
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
        const loose = state === 'falling' || state === 'tumble' || state === 'down' || state === 'dead';
        const pins = set.pins;
        for (const p of body.parts) {
            const i = p.index;
            const m = p.region === 'pelvis' ? set.muscles.spine : set.muscles[p.region as keyof typeof set.muscles];
            body.frequency[i] = m.frequency * Math.sqrt(k);
            body.damping[i] = m.damping;
            body.torque[i] = m.maxTorque * k;
            body.holdUp[i] = m.gravityCompensation;
            body.friction[i] = 0;
            // Off its feet the muscles hold what the body does rather than pull it back to standing.
            if (loose) body.hold(i, 1);
            let pin = 0, map = 1;
            if (state === 'hitReact') { pin = p.region === 'legs' || p.region === 'feet' ? pins.legs : 1; if (pins.legs >= 0.99 && (p.region === 'legs' || p.region === 'feet')) map = 0; }
            else if (state === 'getUp') pin = Math.min(1, this._stateTime / Math.max(0.05, set.behaviours.getUp.params.regainTime));
            else if (state === 'recover') { pin = 1; map = 1 - Math.min(1, this._stateTime / Math.max(0.05, set.behaviours.getUp.params.blendTime)); }
            body.pin[i] = pin;
            body.mapping[i] = map;
        }
        if (state === 'getUp') this._gotUp = true;
        void dt;
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
                body.clampTarget(i);
                d.frequency = Math.max(0, body.frequency[i]);
                d.damping = Math.max(0, body.damping[i]);
                d.maxTorque = Math.max(0, body.torque[i] * massScale);
                d.gravityCompensation = Math.max(0, Math.min(1, body.holdUp[i]));
                d.friction = Math.max(0, body.friction[i]);
                r.setMuscle(i, d);
                r.setTarget(i, body.target[i], body.spin[i]);
            }
            const w = body.pin[i], gw = body.goalWeight[i];
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
            r.setMapping(i, body.mapping[i]);
            // Self-collision off for a part that asks to pass through the body (and back on after).
            const b = p.body, own = this._ownMask[i] ??= b.collisionFilterMask;
            const mask = body.passThrough[i] ? own & ~LAYER.RAGDOLL : own;
            if (b.collisionFilterMask !== mask) b.collisionFilterMask = mask;
            const prev = this._prevAnim[i];
            for (let k = 0; k < 7; k++) prev[k] = body.anim[i][k];
        }
        const animator = this.node.animator;
        if (animator) animator.ikSuppressed = this._state !== 'hitReact';
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
        const sides = (['L', 'R'] as const).filter(s => body.arms[s] && !(p.side === s && (p.region === 'arms' || p.region === 'hands')));
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
        if (!['stagger', 'falling', 'tumble', 'down', 'dead'].includes(this._state)) return;
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
        const clip = this.sensors.faceUp ? clips.faceUp ?? clips.faceDown : clips.faceDown ?? clips.faceUp;
        const animator = this.node.animator, body = this._body;
        this._getUpAction = null;
        if (!animator || !body) return;
        const head = body.head >= 0 ? body.head : body.chest;
        const simDir = vec3.sub(vec3.create(), body.simPosition(head), body.simPosition(body.pelvis));
        if (clip && animator.playAction) {
            this._clip = null;
            const action = animator.playAction(clip, { slot: REACTION_SLOT, blendIn: 0.0, blendOut: 0.2, ikWeight: 0 });
            if (!action.done) this._getUpAction = action;
        }
        // Where the clip (or the plain animation) puts the hips and head now, against where the body has them.
        animator.update(0);
        body.begin();
        const animDir = vec3.sub(vec3.create(), [body.anim[head][0], body.anim[head][1], body.anim[head][2]], [body.anim[body.pelvis][0], body.anim[body.pelvis][1], body.anim[body.pelvis][2]]);
        // Only when the clip lies along the ground does its hips-to-head say where to face; standing, face the body's way.
        const lying = Math.hypot(animDir[0], animDir[2]) > Math.abs(animDir[1]);
        const yaw = lying
            ? this._yawNow() + (Math.atan2(simDir[0], simDir[2]) - Math.atan2(animDir[0], animDir[2])) * 180 / Math.PI
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

    private readonly _raycaster: Raycaster = (from, to, ignore) => {
        const hit = this._physics.raycast(vec3.fromValues(from[0], from[1], from[2]), vec3.fromValues(to[0], to[1], to[2]), {
            ignore: ignore as PhysicsBody[],
            reject: (_owner: Node | null, body: PhysicsBody) => this._physics.ragdollPartOf(body)?.ragdoll === this.ragdoll || this._isOwnCollider(body),
        });
        return hit ? { point: [hit.point[0], hit.point[1], hit.point[2]], normal: [hit.normal[0], hit.normal[1], hit.normal[2]], distance: hit.distance } : null;
    };

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

