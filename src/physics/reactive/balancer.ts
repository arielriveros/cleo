import { quatFromToTuple, quatMultiplyTuple, quatRotateTuple } from '../../core/math';
import type { ReactionContext } from './behaviours';
import type { Limb } from './reactionBody';

// The steps a body takes to stay on its feet when it is shoved (the Stagger behaviour): Euphoria's balancer in
// short, quick steps. Its legs are the physics' while it does (dynamic, on their muscles); each step is aimed where
// the body will be a moment ahead, no longer and no wider than a stumbling step, the legs tiring step by step, and
// it gives up and falls when it cannot catch itself. Nothing here refers to where the animation has the character in
// the world: the character's capsule follows the body (CharacterNode.followBody), never the other way round.

export type BalanceOutcome = 'falling' | 'recovered' | null;
type Side = 'L' | 'R';

/** Why a stagger gave up (the bench's and the tests' to read). */
export type GiveUp = 'steps' | 'capture' | 'height' | 'tilt' | 'air' | 'time' | 'legs';

const smooth = (v: number) => { const t = v < 0 ? 0 : v > 1 ? 1 : v; return t * t * (3 - 2 * t); };
/** How far outside its feet the capture point may be (m) and the body still count as caught: no step for that. */
const CAUGHT = 0.08;
const other = (s: Side): Side => (s === 'L' ? 'R' : 'L');

export class Balancer {
    /** What came of it: it fell, it caught itself, or it is still stepping (null). */
    public outcome: BalanceOutcome = null;
    public gaveUp: GiveUp | null = null;
    /** Steps taken so far. */
    public steps = 0;
    /** Each step's length on the ground (m), as it landed. */
    public readonly stepLengths: number[] = [];
    /** The foot in the air now, if any. */
    public get swinging(): Side | null { return this._swing; }

    private _time = 0;
    private _swing: Side | null = null;
    private _swingT = 0;
    private readonly _from = [0, 0, 0];
    private readonly _to = [0, 0, 0];
    /** Where each planted foot's ankle is held (world), latched as it came down. */
    private readonly _planted: Record<Side, number[] | null> = { L: null, R: null };
    private _height0 = 0;
    private _tiltFor = 0;
    private _airFor = 0;
    private _stableFor = 0;
    private _sinceLanded = Infinity;
    private _started = false;

    /** Compose the legs' targets and the helping hand for this step, by `w` (0..1); P: the Stagger's numbers. */
    public update(ctx: ReactionContext, P: Record<string, number>, w: number): void {
        const body = ctx.body, s = ctx.sensors, dt = ctx.dt;
        const legs = { L: body.legs.L, R: body.legs.R };
        if (!legs.L || !legs.R) { this._give('legs'); return; }
        const ground = Number.isFinite(s.groundY) ? s.groundY : body.simPosition(body.pelvis)[1] - 0.9;
        const pelvis = body.simPosition(body.pelvis);
        if (!this._started) {
            this._started = true;
            this._height0 = Math.max(0.3, pelvis[1] - ground);
            for (const side of ['L', 'R'] as const) this._planted[side] = body.pivot(legs[side]!.end);
        }
        this._time += dt;

        // ---- giving up ----
        const topPart = body.head >= 0 ? body.head : body.chest;
        const top = body.simPosition(topPart);
        const upLen = Math.hypot(top[0] - pelvis[0], top[1] - pelvis[1], top[2] - pelvis[2]) || 1;
        const tilt = Math.acos(Math.max(-1, Math.min(1, (top[1] - pelvis[1]) / upLen)));
        this._tiltFor = tilt > P.giveUpTilt ? this._tiltFor + dt : 0;
        this._airFor = s.feetDown === 0 ? this._airFor + dt : 0;
        if (this.steps >= P.maxSteps && !this._swing && s.captureMargin > 0.05) { this._give('steps'); return; }
        // Gone far past its feet once it has stepped (before, its first step is what catches it).
        if (this.steps >= 1 && s.captureMargin > Math.max(0.6, 2 * P.stepLength)) { this._give('capture'); return; }
        if (pelvis[1] - ground < 0.5 * this._height0) { this._give('height'); return; }
        if (this._tiltFor > P.giveUpTime) { this._give('tilt'); return; }
        if (this._airFor > 0.3) { this._give('air'); return; }
        if (this._time > 4) { this._give('time'); return; }

        // ---- caught: over its feet (near enough) a moment, and slow ----
        const v = s.velocity, speed = Math.hypot(v[0], v[2]);
        this._stableFor = !this._swing && s.captureMargin <= CAUGHT && speed < 0.3 ? this._stableFor + dt : 0;
        if (this._stableFor > P.recoverTime) { this.outcome = 'recovered'; return; }

        const tire = Math.pow(Math.max(0.05, P.tire), Math.max(0, this.steps - 2));
        const left = s.left;

        // ---- a step: the foot farther from where the body is going, once the last has settled ----
        this._sinceLanded += dt;
        if (!this._swing && this._time > 0.08 && this._sinceLanded > 0.12) {
            const a = this._planted.L!, b = this._planted.R!;
            const apart = Math.hypot(a[0] - b[0], a[2] - b[2]);
            const crossed = ((a[0] - b[0]) * left[0] + (a[2] - b[2]) * left[2]) < 0.04;
            if (s.captureMargin > CAUGHT || crossed || apart < P.widthMin * 0.6) {
                const cp = s.capture;
                const d = (p: number[]) => Math.hypot(p[0] - cp[0], p[2] - cp[1]);
                this._swing = d(a) > d(b) ? 'L' : 'R';
                this._swingT = 0;
                const at = body.pivot(legs[this._swing]!.end);
                this._from[0] = at[0]; this._from[1] = at[1]; this._from[2] = at[2];
                this._aim(ctx, P, true);
            }
        }

        // ---- the swing: a short arc onto where it aims, re-aimed while under way ----
        if (this._swing) {
            const side = this._swing, leg = legs[side]!;
            const progress = Math.min(1, this._swingT / Math.max(0.05, P.stepTime));
            if (progress < 0.6) this._aim(ctx, P, false);
            const k = smooth(progress), arc = P.stepHeight * Math.sin(Math.PI * progress);
            const foot = [this._from[0] + (this._to[0] - this._from[0]) * k, this._from[1] + (this._to[1] - this._from[1]) * k + arc, this._from[2] + (this._to[2] - this._from[2]) * k];
            body.reach(leg, foot, w, kneePole(ctx, leg), flatFoot(ctx, leg));
            body.tuneAll([leg.root, leg.mid, leg.end], w, { frequency: 8 * Math.sqrt(tire), damping: 1, holdUp: 1 });
            this._swingT += dt;
            if (progress >= 1 || (progress > 0.5 && s.touchedNow.has(leg.end))) {
                const at = body.pivot(leg.end);
                this._planted[side] = at;
                this.stepLengths.push(Math.hypot(at[0] - this._from[0], at[2] - this._from[2]));
                this.steps++;
                this._swing = null;
                this._sinceLanded = 0;
            }
        }

        // ---- the planted feet: held where they came down, the leg reaching from where the hip should be ----
        // Solved as though the hips stood at the height they started at (the foot's target lowered by as much as
        // they have sunk), so a planted leg pushes the body back up rather than folding under it.
        const sunk = Math.max(0, this._height0 - (pelvis[1] - ground));
        for (const side of ['L', 'R'] as const) {
            if (side === this._swing) continue;
            const leg = legs[side]!, at = this._planted[side]!;
            body.reach(leg, [at[0], at[1] - sunk * 0.9, at[2]], w, kneePole(ctx, leg), flatFoot(ctx, leg));
            body.tuneAll([leg.root, leg.mid, leg.end], w, { frequency: 6 * Math.sqrt(tire), damping: 1, holdUp: 0.5 });
        }

        // ---- a helping hand (Euphoria's StayUpright): the trunk kept from toppling, the hips from sinking ----
        // Pushes on the trunk's parts, by their mass, sized to the body; weakening as the legs tire, none once it
        // gives up. Pushes, never a velocity: with the physics worker the pose read here is a step or two old.
        const help = Math.max(0, P.assist) * tire * w;
        if (!(help > 0) || !(dt > 0)) return;
        const trunk = body.partsOf(['pelvis', 'spine', 'neck']);
        let mass = 0, mTrunk = 0, mUpper = 0;
        for (const p of body.parts) mass += p.mass;
        for (const i of trunk) { mTrunk += body.parts[i].mass; if (i !== body.pelvis) mUpper += body.parts[i].mass; }
        if (!(mTrunk > 0)) return;
        const g = ctx.gravity;
        // Upright: the top of the trunk over the hips, a 3 Hz spring on how far it is off, critically damped.
        const vt = body.parts[topPart].body.velocity, vp = body.parts[body.pelvis].body.velocity;
        const wn = 2 * Math.PI * 3;
        let fx = -(mUpper * wn * wn * (top[0] - pelvis[0]) + 2 * mUpper * wn * (vt.x - vp.x));
        let fz = -(mUpper * wn * wn * (top[2] - pelvis[2]) + 2 * mUpper * wn * (vt.z - vp.z));
        const most = mass * g * 0.6, fn = Math.hypot(fx, fz);
        if (fn > most) { fx *= most / fn; fz *= most / fn; }
        // Up: half the body's weight, and a 2 Hz spring on how far the hips have sunk below where they started.
        const wh = 2 * Math.PI * 2;
        const low = this._height0 * 0.98 - (pelvis[1] - ground);
        const lift = Math.max(0, Math.min(mass * g, mass * g * 0.5 + mass * wh * wh * low - 2 * mass * wh * vp.y));
        // Slowed while a foot is down (what an ankle and a hip do against the ground), more on both: what keeps the
        // steps short.
        const brake = s.feetDown >= 2 ? mass * 3 : s.feetDown > 0 ? mass * 1.5 : 0;
        let bx = -brake * s.velocity[0], bz = -brake * s.velocity[2];
        // And drawn back over its feet when the capture point is just past them: what the ankles do, pressing on
        // the edge of the foot. Not past a step's reach: that is the next step's to catch.
        if (s.feetDown > 0 && s.captureMargin > 0 && s.captureMargin < P.stepLength && s.support.length) {
            let cx = 0, cz = 0;
            for (const q of s.support) { cx += q[0]; cz += q[1]; }
            cx /= s.support.length; cz /= s.support.length;
            const ox = s.capture[0] - cx, oz = s.capture[1] - cz, on = Math.hypot(ox, oz);
            if (on > 1e-6) {
                const k = mass * g / Math.max(0.5, s.com[1] - ground) * 1.5 * s.captureMargin;
                bx -= k * ox / on; bz -= k * oz / on;
            }
        }
        // The upright push is a turn, not a shove: what it gives the upper trunk the hips take back.
        for (const i of trunk) {
            const m = body.parts[i].mass;
            const across = !(mUpper > 0) ? 0 : i === body.pelvis ? -1 : m / mUpper;
            const share = m / mTrunk;
            ctx.impulse(i, (fx * across + bx * share) * dt * help, lift * share * dt * help, (fz * across + bz * share) * dt * help);
        }
    }

    /** Aim the step: a moment ahead of the body, beside the planted foot, no longer or wider than a stumbling step. */
    private _aim(ctx: ReactionContext, P: Record<string, number>, first: boolean): void {
        const s = ctx.sensors, side = this._swing!, stance = this._planted[other(side)]!;
        const com = s.com, v = s.velocity, left = s.left;
        const dx = com[0] + v[0] * P.prediction + 0.5 * (com[0] - stance[0]) - stance[0];
        const dz = com[2] + v[2] * P.prediction + 0.5 * (com[2] - stance[2]) - stance[2];
        // Across the body (to its own side of the planted foot, never across it) and along it.
        const sign = side === 'L' ? 1 : -1;
        const fx = left[2], fz = -left[0];
        const lat = Math.max(P.widthMin, Math.min(P.widthMax, (dx * left[0] + dz * left[2]) * sign));
        let lon = dx * fx + dz * fz;
        const most = Math.max(0.05, P.stepLength);
        if (Math.hypot(lat, lon) > most) lon = Math.sign(lon) * Math.sqrt(Math.max(0, most * most - lat * lat));
        const tx = stance[0] + left[0] * lat * sign + fx * lon, tz = stance[2] + left[2] * lat * sign + fz * lon;
        if (first) { this._to[0] = tx; this._to[1] = stance[1]; this._to[2] = tz; return; }
        // Re-aimed at no more than 2 m/s: a foot in the air does not dart about.
        const ex = tx - this._to[0], ez = tz - this._to[2], e = Math.hypot(ex, ez), cap = 2 * ctx.dt;
        const k = e > cap ? cap / e : 1;
        this._to[0] += ex * k; this._to[2] += ez * k; this._to[1] = stance[1];
    }

    private _give(why: GiveUp): void {
        this.outcome = 'falling';
        this.gaveUp = why;
    }
}

/** Where a knee points: forward of itself, the way the body faces. */
function kneePole(ctx: ReactionContext, leg: Limb): number[] {
    const k = ctx.body.pivot(leg.mid), f = ctx.sensors.forward;
    return [k[0] + f[0] * 0.6, k[1], k[2] + f[2] * 0.6];
}

/** A foot's world rotation flat on the ground, the way the animation turns it about the vertical. */
function flatFoot(ctx: ReactionContext, leg: Limb): number[] {
    // Part frames: Y along the foot (heel to toe).
    const q = ctx.body.animRotation(leg.end);
    const y = quatRotateTuple(q, [0, 1, 0]);
    const n = Math.hypot(y[0], y[2]) || 1;
    return quatMultiplyTuple(quatFromToTuple(y, [y[0] / n, 0, y[2] / n]), q);
}
