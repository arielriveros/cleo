import { quatFromToTuple, quatMultiplyTuple, quatRotateTuple, quatSlerpTuple, rotationVectorToQuat } from '../../core/math';
import type { Skin } from '../../animation/animatedModel';
import type { BodySensors } from './bodySensors';
import { posePartTargets, type Limb, type ReactionBody } from './reactionBody';
import type { BehaviourConfig, BehaviourId, ReactionSet } from './reactionSet';

// The reflexes a reaction is made of (Euphoria's behaviours): each owns some of the body for a while and tells
// its muscles where to go and how hard — through the ReactionBody's targets, IK and tuning, by a weight the
// controller fades in and out. They run in the order listed (later ones win where they overlap) while their
// reaction state allows them and their own condition holds; every number is the set's (reactionSet.ts).

/** What a running reaction is at: which state, how long into it. */
export type ReactionState = 'animated' | 'hitReact' | 'stagger' | 'falling' | 'tumble' | 'down' | 'getUp' | 'recover' | 'dead';

/** A wound: where a hit landed on a part, kept in that part's frame so a hand can follow it. */
export interface ReactionWound {
    part: number;
    /** In the part's frame, from its centre. */
    local: [number, number, number];
    /** The surface's outward normal, in the part's frame. */
    normal: [number, number, number];
    /** The push, world, N·s. */
    impulse: [number, number, number];
    /** Reaction-clock seconds it happened at. */
    at: number;
    /** The hand that goes to it ('L' | 'R'), or null when neither can. */
    hand: 'L' | 'R' | null;
}

/** What a behaviour reads and writes, once a frame. */
export interface ReactionContext {
    body: ReactionBody;
    sensors: BodySensors;
    set: ReactionSet;
    skin: Skin;
    state: ReactionState;
    /** Seconds in this state, and since the reaction began. */
    stateTime: number;
    time: number;
    dt: number;
    wounds: readonly ReactionWound[];
    /** World up, and gravity's pull (m/s²). */
    gravity: number;
    /** The character's mass over the 70 kg the muscles' strengths are given for. */
    massScale: number;
    /** Play `clip` (looped) on the reaction's own slot as the base the muscles reach for; null stops it. */
    playClip(clip: string | null, loop?: boolean): void;
    /** Give part `i` a spin (rad/s, world), as a hand from outside would (a tumble kept rolling). */
    spin(i: number, x: number, y: number, z: number): void;
}

export interface ReactionBehaviour {
    readonly id: BehaviourId;
    /** States it may run in. */
    readonly states: readonly ReactionState[];
    /** Seconds to fade in and out. */
    readonly fade: number;
    /** Whether it wants to run now (its state allows it). */
    wants(ctx: ReactionContext, config: BehaviourConfig): boolean;
    /** Compose into the body at weight `w` (0..1). */
    update(ctx: ReactionContext, config: BehaviourConfig, w: number): void;
    /** Started / stopped (weight left 0 / reached 0). */
    start?(ctx: ReactionContext, config: BehaviourConfig): void;
    stop?(ctx: ReactionContext, config: BehaviourConfig): void;
}

const UP = [0, 1, 0];
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const t = clamp01(v); return t * t * (3 - 2 * t); };
const axisAngle = (axis: ArrayLike<number>, angle: number) => rotationVectorToQuat([axis[0] * angle, axis[1] * angle, axis[2] * angle]);
const add = (a: ArrayLike<number>, b: ArrayLike<number>, s = 1): [number, number, number] => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const legLength = (body: ReactionBody, leg: Limb) => {
    const a = body.pivot(leg.root), b = body.pivot(leg.mid), c = body.pivot(leg.end);
    return [Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]), Math.hypot(c[0] - b[0], c[1] - b[1], c[2] - b[2])];
};

/** A pose slot's part targets, or null. */
function slotPose(ctx: ReactionContext, config: BehaviourConfig, slot: string): (number[] | null)[] | null {
    const pose = config.poses?.[slot]?.pose;
    return pose ? posePartTargets(ctx.body.ragdoll, ctx.skin, pose) : null;
}

/** Flex a limb's root about the character's left (world) by `angle` (+ forward), on top of its target. */
function flex(ctx: ReactionContext, part: number, angle: number, w: number): void {
    if (part < 0) return;
    const body = ctx.body, p = body.parts[part];
    if (p.parent < 0) return;
    // Turn the part's world rotation (as targeted, against its simulated parent) about the left axis.
    const parentQ = body.simRotation(p.parent);
    const worldNow = quatMultiplyTuple(parentQ, body.target[part]);
    const turned = quatMultiplyTuple(axisAngle(ctx.sensors.left, -angle), worldNow);
    body.blendWorld(part, turned, w);
}

// ---------------------------------------------------------------------------------------------------------

/** A hit staying on its feet: weakness, a snap away, a hand to the wound, the head to it. */
const hitReact: ReactionBehaviour = {
    id: 'hitReact', states: ['hitReact', 'stagger', 'falling', 'down', 'tumble'], fade: 0.08,
    wants: (ctx, c) => ctx.wounds.some(w => ctx.time - w.at < c.params.holdTime + c.params.reachDelay + 0.5),
    update(ctx, c, w) {
        const P = c.params, body = ctx.body;
        const flinch = slotPose(ctx, c, 'flinch');
        for (const wound of ctx.wounds) {
            const age = ctx.time - wound.at;
            const part = body.parts[wound.part];
            if (!part) continue;
            // The struck part and its neighbours lose strength, and their strings, then get them back.
            const keep = P.weakness + (1 - P.weakness) * smooth(age / Math.max(1e-3, P.weaknessTime));
            for (const i of [wound.part, part.parent, ...part.children]) {
                if (i < 0) continue;
                const k = i === wound.part ? keep : 0.5 + 0.5 * keep;
                body.torque[i] *= k;
                body.frequency[i] *= 0.5 + 0.5 * k;
                body.pin[i] *= k;
            }
            // A snap of the spine and neck away from the hit.
            const kick = Math.hypot(...wound.impulse);
            if (P.snap > 0 && age < 0.2 && kick > 0) {
                const dir = wound.impulse.map(v => v / kick);
                const axis = [UP[1] * dir[2] - UP[2] * dir[1], UP[2] * dir[0] - UP[0] * dir[2], UP[0] * dir[1] - UP[1] * dir[0]];
                const amount = P.snap * Math.min(1, kick / 40) * (1 - age / 0.2) * w;
                for (const i of body.partsOf(['spine', 'neck'])) body.turn(i, axisAngle(axis, amount * 0.5), 1);
            }
            if (flinch && age < 0.5) body.pose(flinch, body.partsOf(['spine', 'neck', 'arms']), w * (1 - age / 0.5) * 0.6);
            const point = body.simPoint(wound.part, wound.local);
            // The head turns to it.
            if (age < P.lookTime) body.look(point, w * (1 - smooth((age - P.lookTime * 0.6) / (P.lookTime * 0.4))));
            // A hand to it, after a moment, for a while.
            if (wound.hand && age > P.reachDelay && age < P.reachDelay + P.holdTime) {
                const arm = body.arms[wound.hand];
                if (!arm) continue;
                const ramp = smooth((age - P.reachDelay) / 0.25) * (1 - smooth((age - P.reachDelay - P.holdTime + 0.3) / 0.3));
                // A wounded arm is brought in front of the chest to meet the hand that holds it.
                const hurtArm = (part.region === 'arms' || part.region === 'hands') && part.side ? body.arms[part.side] : undefined;
                if (hurtArm && body.chest >= 0) {
                    const meet = add(add(body.simPosition(body.chest), ctx.sensors.forward, 0.3), [0, -0.12, 0]);
                    const s = part.side === 'L' ? 1 : -1;
                    const shoulderHurt = body.pivot(hurtArm.root);
                    body.reach(hurtArm, add(meet, ctx.sensors.left, 0.08 * s), w * ramp, add(add(shoulderHurt, ctx.sensors.left, 0.25 * s), [0, -0.3, 0]));
                    for (const i of [hurtArm.root, hurtArm.mid, hurtArm.end]) { body.tune(i, w * ramp, { frequency: P.reachStiffness * 0.8, holdUp: 1 }); body.pin[i] *= 1 - ramp; }
                }
                const shoulder = body.pivot(arm.root);
                if (Math.hypot(point[0] - shoulder[0], point[1] - shoulder[1], point[2] - shoulder[2]) > P.maxReach + (hurtArm ? 0.4 : 0)) continue;
                const n = quatRotateTuple(body.simRotation(wound.part), wound.normal);
                const hand = body.parts[arm.end];
                // The palm on the wound: the hand's centre a hand's thickness off it, along its normal, and the wrist
                // a hand's half-length back from there along the way the hand points.
                const palmAt = add(point, n, hand.radius);
                const along = quatRotateTuple(body.simRotation(arm.end), [0, 1, 0]);
                const toWrist = add(palmAt, along, -hand.halfLength);
                // Across the body the elbow comes forward and the arm goes round the front; on its own side, out and down.
                const sideSign = hand.side === 'L' ? 1 : -1;
                const lateral = (point[0] - shoulder[0]) * ctx.sensors.left[0] + (point[2] - shoulder[2]) * ctx.sensors.left[2];
                const across = lateral * sideSign < 0;
                const pole = across
                    ? add(add(shoulder, ctx.sensors.forward, 0.45), [0, -0.25, 0])
                    : add(add(shoulder, ctx.sensors.left, 0.3 * sideSign), [0, -0.3, 0]);
                body.reach(arm, toWrist, w * ramp, pole);
                // And a string to land the hand there, however the backend's muscles carry the arm.
                body.pull(arm.end, palmAt, P.reachPull * w * ramp);
                // The chest turns a little toward the reach, as a body does reaching across itself.
                if (across && body.chest >= 0 && body.chest !== body.pelvis) body.turn(body.chest, axisAngle(UP, -0.35 * sideSign), w * ramp);
                for (const i of [arm.root, arm.mid, arm.end]) {
                    body.tune(i, w * ramp, { frequency: P.reachStiffness, holdUp: 1 });
                    body.pin[i] *= 1 - ramp;
                }
            }
        }
    },
};

/** Physical stepping: the legs go where the capture point says, until it is inside the feet or it gives up. */
interface StepState { swing: 'L' | 'R' | null; t: number; from: [number, number, number]; to: [number, number, number]; steps: number; last: 'L' | 'R' | null; stance: Record<'L' | 'R', [number, number, number] | null> }
const STEP = new WeakMap<ReactionBody, StepState>();

export function stepState(body: ReactionBody): StepState {
    let s = STEP.get(body);
    if (!s) { s = { swing: null, t: 0, from: [0, 0, 0], to: [0, 0, 0], steps: 0, last: null, stance: { L: null, R: null } }; STEP.set(body, s); }
    return s;
}

const stepBalance: ReactionBehaviour = {
    id: 'stepBalance', states: ['stagger'], fade: 0.05,
    wants: () => true,
    start(ctx) { const s = stepState(ctx.body); s.swing = null; s.steps = 0; s.last = null; s.stance.L = s.stance.R = null; },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, sense = ctx.sensors, s = stepState(body);
        const legs = body.legs;
        if (!legs.L || !legs.R) return;
        const groundY = Number.isFinite(sense.groundY) ? sense.groundY : sense.com[1] - 1;
        const tire = Math.pow(P.perStepReduction, s.steps);
        // Stance feet: on the ground, held there.
        for (const side of ['L', 'R'] as const) {
            const leg = legs[side]!;
            const onGround = sense.touching.has(leg.end);
            if (s.swing === side) continue;
            if (onGround && !s.stance[side]) s.stance[side] = body.pivot(leg.end);
            if (!onGround && s.stance[side] && s.swing !== side) s.stance[side] = null;
        }
        // Start a step when the capture point is out of the feet.
        if (!s.swing && sense.captureMargin > P.captureMargin && s.steps < P.maxSteps) {
            const cp = sense.capture;
            const toward = [cp[0] - sense.com[0], cp[1] - sense.com[2]];
            const lateral = toward[0] * sense.left[0] + toward[1] * sense.left[2];
            const fwd = toward[0] * sense.forward[0] + toward[1] * sense.forward[2];
            // The leg on the side it falls toward when that is mostly sideways; else the leg farther from the point.
            let side: 'L' | 'R';
            if (Math.abs(lateral) > Math.abs(fwd) * 0.8) side = lateral > 0 ? 'L' : 'R';
            else {
                const d = (l: Limb) => { const f = body.pivot(l.end); return Math.hypot(f[0] - cp[0], f[2] - cp[1]); };
                side = d(legs.L) > d(legs.R) ? 'L' : 'R';
            }
            if (side === s.last && s.steps > 0) side = side === 'L' ? 'R' : 'L';
            const leg = legs[side]!, other = legs[side === 'L' ? 'R' : 'L']!;
            const foot = body.pivot(leg.end), stance = s.stance[side === 'L' ? 'R' : 'L'] ?? body.pivot(other.end);
            // Where to put it: past the capture point, no farther than a step from the other foot, never across it.
            let tx = cp[0] + (cp[0] - sense.com[0]) * 0.15, tz = cp[1] + (cp[1] - sense.com[2]) * 0.15;
            const dx = tx - stance[0], dz = tz - stance[2], d = Math.hypot(dx, dz);
            if (d > P.maxStepLength) { tx = stance[0] + dx / d * P.maxStepLength; tz = stance[2] + dz / d * P.maxStepLength; }
            const sideSign = side === 'L' ? 1 : -1;
            const across = (tx - stance[0]) * sense.left[0] + (tz - stance[2]) * sense.left[2];
            if (across * sideSign < 0.14) { tx += sense.left[0] * (0.14 * sideSign - across); tz += sense.left[2] * (0.14 * sideSign - across); }
            s.swing = side; s.t = 0; s.from = foot; s.to = [tx, groundY + (foot[1] - groundY > 0 ? Math.min(0.1, foot[1] - groundY) : 0.08), tz];
            s.stance[side] = null;
        }
        // The swing.
        if (s.swing) {
            const leg = legs[s.swing]!;
            s.t += ctx.dt / Math.max(0.05, P.stepTime);
            const t = Math.min(1, s.t);
            const at: [number, number, number] = [
                s.from[0] + (s.to[0] - s.from[0]) * t,
                s.from[1] + (s.to[1] - s.from[1]) * t + P.stepHeight * Math.sin(Math.PI * t),
                s.from[2] + (s.to[2] - s.from[2]) * t,
            ];
            const knee = add(body.pivot(leg.mid), sense.forward, 0.5);
            body.reach(leg, at, w, knee, flatFoot(ctx, leg));
            body.tuneAll([leg.root, leg.mid, leg.end], w, { frequency: P.legStiffness * 1.4 * tire });
            body.pin[leg.end] = 0;
            if (t >= 1 || (t > 0.6 && sense.touching.has(leg.end))) {
                s.last = s.swing; s.steps++; s.stance[s.swing] = body.pivot(leg.end); s.swing = null;
            }
        }
        // Stance legs hold the body up over their feet.
        for (const side of ['L', 'R'] as const) {
            if (s.swing === side) continue;
            const leg = legs[side]!, at = s.stance[side];
            body.tuneAll([leg.root, leg.mid, leg.end], w, { frequency: P.legStiffness * tire, holdUp: 1 });
            if (at) { body.reach(leg, at, w * 0.7, add(body.pivot(leg.mid), sense.forward, 0.5), flatFoot(ctx, leg)); body.pin[leg.end] = w; }
        }
        // Loose arms, a lean into it, help staying upright that runs out by the last step.
        body.tuneAll(body.partsOf(['arms', 'hands']), w, { frequency: P.armStiffness, holdUp: 0.3 });
        const v = sense.velocity, flat = Math.hypot(v[0], v[2]);
        if (flat > 0.1 && P.leanInto > 0) {
            const axis = [v[2] / flat, 0, -v[0] / flat];
            for (const i of body.partsOf(['spine'])) body.turn(i, axisAngle(axis, P.leanInto * 0.5 * Math.min(1, flat)), w);
        }
        const assist = P.uprightAssist * Math.max(0, 1 - s.steps / Math.max(1, P.maxSteps));
        body.pin[body.pelvis] = Math.max(body.pin[body.pelvis], assist * w);
        if (body.chest >= 0) body.pin[body.chest] = Math.max(body.pin[body.chest], assist * w);
    },
};

/** A foot's world rotation flat on the ground, facing the body's way. */
function flatFoot(ctx: ReactionContext, leg: Limb): number[] {
    // Part frames: Y along the foot (heel to toe), X to the character's left.
    const body = ctx.body, q = body.animRotation(leg.end);
    const y = quatRotateTuple(q, [0, 1, 0]);
    const flatY = [y[0], 0, y[2]], n = Math.hypot(flatY[0], flatY[2]) || 1;
    return quatMultiplyTuple(quatFromToTuple(y, [flatY[0] / n, 0, flatY[2] / n]), q);
}

/** Hands to where the fall lands, elbows giving when they touch, knees bent. */
const catchFall: ReactionBehaviour = {
    id: 'catchFall', states: ['falling'], fade: 0.12,
    wants(ctx, c) {
        const i = ctx.sensors.impact;
        return !!i && i.time < c.params.predictionTime && !(i.headFirst && ctx.sensors.trunkSpin > ctx.set.thresholds.tumbleAngularSpeed)
            && ctx.sensors.uprightness < (ctx.set.behaviours.landing.params.uprightness ?? 0.85);
    },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, sense = ctx.sensors, impact = sense.impact;
        const brace = slotPose(ctx, c, 'brace');
        if (brace) body.pose(brace, body.partsOf(['arms', 'hands', 'legs']), w * 0.7);
        const touched = MEMORY.get(body) ?? { at: -1, first: -1 };
        MEMORY.set(body, touched);
        for (const side of ['L', 'R'] as const) {
            const arm = body.arms[side];
            if (!arm) continue;
            if (sense.touchedNow.has(arm.end) && touched.at < 0) touched.at = ctx.time;
            // The hand nearer the ground first, the other a moment later.
            const delay = side === (sense.left[1] < 0 ? 'L' : 'R') ? 0 : P.handDelay;
            const ramp = smooth((ctx.stateTime - delay) / 0.12);
            if (impact) {
                const shoulder = body.pivot(arm.root);
                const sideways = side === 'L' ? 1 : -1;
                const at = add(add(impact.point, sense.left, 0.18 * sideways), [sense.velocity[0], 0, sense.velocity[2]], P.armForward * 0.25);
                at[1] = Math.max(at[1], impact.point[1]) + body.parts[arm.end].radius * 2;
                // Out in front of the shoulder, never behind it.
                const reachFrom = add(shoulder, sense.forward, P.armForward);
                const target = add(at, [reachFrom[0] - at[0], 0, reachFrom[2] - at[2]], 0.35);
                body.reach(arm, target, w * ramp, add(add(shoulder, sense.left, 0.3 * sideways), [0, 0.2, 0]));
            }
            const giving = touched.at >= 0 && ctx.time - touched.at < P.absorbTime;
            const f = P.armStiffness * (giving ? P.absorb : 1);
            body.tuneAll([arm.root, arm.mid, arm.end], w * ramp, { frequency: f, holdUp: 1 });
        }
        for (const side of ['L', 'R'] as const) {
            const leg = body.legs[side];
            if (leg) body.bend(leg.mid, P.kneeBend, w * 0.6);
        }
    },
    stop(ctx) { MEMORY.delete(ctx.body); },
};
const MEMORY = new WeakMap<ReactionBody, { at: number; first: number }>();

/** Arms round the head, chin tucked. */
const protectHead: ReactionBehaviour = {
    id: 'protectHead', states: ['falling', 'tumble'], fade: 0.15,
    wants(ctx) {
        const s = ctx.sensors, i = s.impact;
        return ctx.state === 'tumble' || s.terrain === 'stairs' && !s.grounded
            || (!!i && i.headFirst && i.time < 0.7) || s.trunkSpin > ctx.set.thresholds.tumbleAngularSpeed;
    },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body;
        if (body.head < 0) return;
        const pose = slotPose(ctx, c, 'protect');
        const headQ = body.simRotation(body.head), headP = body.simPosition(body.head);
        const left = quatRotateTuple(headQ, [1, 0, 0]), fwd = quatRotateTuple(headQ, [0, 0, 1]);
        if (pose) body.pose(pose, body.partsOf(['arms', 'hands']), w);
        else {
            for (const side of ['L', 'R'] as const) {
                const arm = body.arms[side];
                if (!arm) continue;
                const s = side === 'L' ? 1 : -1;
                const at = add(add(headP, left, P.handSpread * s), fwd, 0.1);
                body.reach(arm, at, w, add(add(body.pivot(arm.mid), fwd, 0.3), left, 0.2 * s));
            }
        }
        body.tuneAll(body.partsOf(['arms', 'hands']), w, { frequency: P.armStiffness, holdUp: 1 });
        // Chin to chest: the head turned forward about its own left axis.
        body.blendWorld(body.head, quatMultiplyTuple(axisAngle(left, P.chinTuck), headQ), w);
        body.tune(body.head, w, { frequency: P.neckStiffness });
    },
};

/** Knees and hips bent before touchdown, softening on it. */
const landing: ReactionBehaviour = {
    id: 'landing', states: ['falling'], fade: 0.08,
    wants(ctx, c) {
        const s = ctx.sensors, i = s.impact;
        return s.uprightness > c.params.uprightness && !!i && !i.headFirst && i.time < c.params.leadTime + 0.15;
    },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, sense = ctx.sensors;
        const pose = slotPose(ctx, c, 'landing');
        const mem = MEMORY.get(body) ?? { at: -1, first: -1 };
        MEMORY.set(body, mem);
        if (mem.at < 0 && (body.legs.L && sense.touchedNow.has(body.legs.L.end) || body.legs.R && sense.touchedNow.has(body.legs.R.end))) mem.at = ctx.time;
        const hard = sense.impactSpeed > P.maxSpeed;
        for (const side of ['L', 'R'] as const) {
            const leg = body.legs[side];
            if (!leg) continue;
            if (pose) body.pose(pose, [leg.root, leg.mid, leg.end], w);
            else {
                // Feet under the hips at the height a bent knee leaves them.
                const [a, b] = legLength(body, leg);
                const reach = Math.sqrt(Math.max(0.01, a * a + b * b + 2 * a * b * Math.cos(P.kneeBend)));
                const hip = body.pivot(leg.root);
                const down = [0, -1, 0];
                const at = add(add(hip, down, reach * Math.cos(P.hipBend * 0.5)), sense.forward, reach * Math.sin(P.hipBend * 0.5) * 0.4);
                body.reach(leg, at, w, add(body.pivot(leg.mid), sense.forward, 0.6), flatFoot(ctx, leg));
            }
            const soft = mem.at >= 0 && ctx.time - mem.at < P.absorbTime;
            const f = body.frequency[leg.mid] * (hard ? 0.15 : soft ? 0.5 : 1.2);
            body.tuneAll([leg.root, leg.mid, leg.end], w, { frequency: f, holdUp: hard ? 0.2 : 1 });
        }
    },
    stop(ctx) { MEMORY.delete(ctx.body); },
};

/** Windmilling arms and pedalling legs on a long drop (or a clip). */
const airborne: ReactionBehaviour = {
    id: 'airborne', states: ['falling'], fade: 0.3,
    wants(ctx, c) {
        const s = ctx.sensors;
        return s.airTime > c.params.minTime && (!s.impact || s.impact.time > 0.4) && s.fallHeight + (s.impact ? s.impact.time * s.speed : 0) > ctx.set.thresholds.highFallHeight * 0.5;
    },
    start(ctx, c) { if (c.clips?.fall) ctx.playClip(c.clips.fall, true); },
    stop(ctx, c) { if (c.clips?.fall) ctx.playClip(null); },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, t = ctx.time;
        if (!c.clips?.fall) {
            for (const side of ['L', 'R'] as const) {
                const arm = body.arms[side], leg = body.legs[side];
                const phase = side === 'L' ? 0 : Math.PI;
                if (arm) flex(ctx, arm.root, 1.2 + P.armAmplitude * Math.sin(P.armSpeed * t + phase), w);
                if (leg) {
                    flex(ctx, leg.root, 0.4 + P.legAmplitude * Math.sin(P.legSpeed * t + phase), w);
                    body.bend(leg.mid, 0.7 + 0.4 * Math.sin(P.legSpeed * t + phase + 1), w);
                }
            }
        }
        body.tuneAll(body.parts.map(p => p.index), w, { frequency: P.stiffness });
    },
};

/** Curled up and rolling down stairs or a slope; spread out to stop once slow. */
const tumble: ReactionBehaviour = {
    id: 'tumble', states: ['tumble'], fade: 0.2,
    wants: () => true,
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, sense = ctx.sensors;
        const pose = slotPose(ctx, c, 'curl');
        const slow = sense.speed < P.slowDownSpeed;
        if (pose) body.pose(pose, body.parts.map(p => p.index), w);
        else {
            for (const i of body.partsOf(['spine'])) flex(ctx, i, -P.curl * 0.45, w);
            for (const side of ['L', 'R'] as const) {
                const leg = body.legs[side];
                if (!leg) continue;
                flex(ctx, leg.root, P.curl, w);
                body.bend(leg.mid, P.curl * 1.3, w);
            }
        }
        if (slow) {
            // Arms out to the sides, down to the ground: what stops a roll.
            for (const side of ['L', 'R'] as const) {
                const arm = body.arms[side];
                if (!arm) continue;
                const s = side === 'L' ? 1 : -1, shoulder = body.pivot(arm.root);
                const at = add(shoulder, sense.left, 0.55 * s);
                at[1] = Number.isFinite(sense.groundY) ? sense.groundY + 0.05 : shoulder[1] - 0.3;
                body.reach(arm, at, w);
            }
        }
        body.tuneAll(body.parts.map(p => p.index), w, { frequency: P.stiffness, damping: P.damping });
        // Rolling, not sliding: a little spin about the axis across the slope, while it is still moving.
        if (P.rollTorque > 0 && !slow) {
            const v = sense.velocity, flat = Math.hypot(v[0], v[2]);
            if (flat > 0.3 && sense.trunkSpin < 5) {
                const axis = [v[2] / flat, 0, -v[0] / flat];
                const k = P.rollTorque * ctx.dt * 4 * w;
                for (const i of body.partsOf(['pelvis', 'spine'])) ctx.spin(i, axis[0] * k, axis[1] * k, axis[2] * k);
            }
        }
    },
};

/** Thrown from a vehicle: the controller's bail() sets it moving; while airborne it braces. */
const vehicleBail: ReactionBehaviour = {
    id: 'vehicleBail', states: ['falling'], fade: 0.1,
    wants: (ctx, c) => ctx.time < c.params.clearTime + 0.5 && BAILS.has(ctx.body),
    update(ctx, _c, w) {
        // Arms tucked in, body tense, until the ground is near (catch the fall takes over).
        const body = ctx.body;
        body.tuneAll(body.partsOf(['spine', 'neck']), w, { frequency: 3 });
        for (const side of ['L', 'R'] as const) { const arm = body.arms[side]; if (arm) flex(ctx, arm.root, 0.6, w * 0.5); }
    },
};
export const BAILS = new WeakSet<ReactionBody>();

/** Lying hurt: slow movement, a hand on the wound, or a clip played softly. */
const writhe: ReactionBehaviour = {
    id: 'writhe', states: ['down'], fade: 0.6,
    wants: (ctx, c) => ctx.stateTime < c.params.duration && (ctx.wounds.length > 0),
    start(ctx, c) { if (c.clips?.writhe) ctx.playClip(c.clips.writhe, true); },
    stop(ctx, c) { if (c.clips?.writhe) ctx.playClip(null); },
    update(ctx, c, w) {
        const P = c.params, body = ctx.body, t = ctx.time;
        if (!c.clips?.writhe) {
            for (const i of body.parts.map(p => p.index)) body.hold(i, w * 0.6);
            const phase = 2 * Math.PI * t / Math.max(0.1, P.period);
            const twist = quatRotateTuple(body.simRotation(body.pelvis), [0, 1, 0]);
            for (const i of body.partsOf(['spine'])) body.turn(i, axisAngle(twist, P.amplitude * 0.4 * Math.sin(phase)), w);
            for (const side of ['L', 'R'] as const) {
                const leg = body.legs[side];
                if (leg) body.bend(leg.mid, 0.6 + P.amplitude * Math.sin(phase + (side === 'L' ? 0 : 1.7)), w);
            }
            // A hand on the latest wound.
            const wound = ctx.wounds[ctx.wounds.length - 1];
            const arm = wound?.hand ? body.arms[wound.hand] : undefined;
            if (wound && arm) body.reach(arm, body.simPoint(wound.part, wound.local), w * 0.8);
        }
        body.tuneAll(body.parts.map(p => p.index), w, { frequency: P.stiffness, damping: P.damping, holdUp: 0.4 });
    },
};

/** Unconscious or dead: muscles let go. */
const relax: ReactionBehaviour = {
    id: 'relax', states: ['down', 'dead'], fade: 0.4,
    wants: (ctx) => ctx.state === 'dead' || ctx.stateTime > 0,
    update(ctx, c, w) {
        const P = c.params, body = ctx.body;
        for (const p of body.parts) {
            body.hold(p.index, w);
            body.tune(p.index, w, { frequency: body.frequency[p.index] * P.strength, torque: body.torque[p.index] * Math.max(P.strength, 0.02), holdUp: 0, friction: P.friction * ctx.massScale });
        }
    },
};

/** Getting up: the clip plays as the target; strength up while it does. */
const getUp: ReactionBehaviour = {
    id: 'getUp', states: ['getUp'], fade: 0.2,
    wants: () => true,
    update(ctx, c, w) {
        const body = ctx.body;
        for (const p of body.parts) body.tune(p.index, w, { frequency: body.frequency[p.index] * Math.max(1, c.params.strength), torque: body.torque[p.index] * c.params.strength, holdUp: 1 });
    },
};

/** Every behaviour, in the order they compose (later ones win where they overlap). */
export const BEHAVIOURS: readonly ReactionBehaviour[] = [relax, writhe, airborne, tumble, landing, vehicleBail, catchFall, protectHead, stepBalance, getUp, hitReact];
