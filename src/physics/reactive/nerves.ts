import type { ReactionBody } from './reactionBody';

// The nervous system between the behaviours and the muscles: what a body's muscles are TOLD is not what they DO at
// once. NaturalMotion's characters are "a body, its muscles and the motor nervous system that drives them"; in the
// body a muscle takes about 10 ms to activate and 40 ms to let go (Millard 2013), a stretch reflex answers in 20 to
// 45 ms, a deliberate move in 150 ms or more (Kurtzer 2015), and tensing (co-contraction: both sides of a joint
// pulling) makes a joint stiffer without turning it (Hogan 1984), which is how a body braces rather than by quicker
// reflexes, whose delays would make it shake (Milner 1995).
//
// Here, per part, after the behaviours have composed the gains and before they go to the joints:
// - tone: after a hit, from about 35 ms on, the upper body (the struck part excepted: it has gone loose) tenses, its
//   muscles stiffer and better damped, easing off over a third of a second;
// - activation: every gain (stiffness, damping, strength, strings, hold-up) moves toward what it is told with a
//   muscle's time constants, quick to tense and slower to let go, so no gain ever jumps in a step (a jump in a
//   muscle's strength is a kick to the limb it holds).

/** Seconds a muscle takes to tense, and to let go (first order). */
export const ACTIVATION_TIME = 0.015;
export const DEACTIVATION_TIME = 0.05;
/** How long after a hit the body starts to tense (a short-latency reflex, s). */
export const TONE_DELAY = 0.035;

/** Regions that tense after a hit. */
const TENSE = new Set(['spine', 'neck', 'arms', 'hands']);

export class Nerves {
    private _frequency = new Float64Array(0);
    private _damping = new Float64Array(0);
    private _torque = new Float64Array(0);
    private _pin = new Float64Array(0);
    private _holdUp = new Float64Array(0);
    private _primed = false;

    /** Pass the next commands straight through (a new body, a get-up, a death: no ramp from what was before). */
    public snap(): void { this._primed = false; }

    /**
     * Tense the upper body by `tone` (0 none; 0.35 a third stiffer), the parts `loose` has left weak excepted: stiffer
     * and better damped together, the target untouched.
     */
    public tone(body: ReactionBody, tone: number, loose: ArrayLike<number>): void {
        if (!(tone > 0)) return;
        for (const p of body.parts) {
            const i = p.index;
            if (!TENSE.has(p.region) || body.kinematic[i]) continue;
            const t = tone * Math.max(0, 1 - (loose[i] ?? 0));
            if (!(t > 0)) continue;
            body.frequency[i] *= 1 + t;
            body.damping[i] *= 1 + 0.5 * t;
            body.torque[i] *= 1 + t;
        }
    }

    /** Every gain toward what it is told, with a muscle's time constants (see the header). */
    public filter(body: ReactionBody, dt: number): void {
        const n = body.parts.length;
        if (this._frequency.length !== n) {
            this._frequency = new Float64Array(n); this._damping = new Float64Array(n); this._torque = new Float64Array(n);
            this._pin = new Float64Array(n); this._holdUp = new Float64Array(n);
            this._primed = false;
        }
        if (!this._primed || !(dt > 0)) {
            this._frequency.set(body.frequency); this._damping.set(body.damping); this._torque.set(body.torque);
            this._pin.set(body.pin); this._holdUp.set(body.holdUp);
            this._primed = true;
            return;
        }
        const up = 1 - Math.exp(-dt / ACTIVATION_TIME), down = 1 - Math.exp(-dt / DEACTIVATION_TIME);
        const step = (state: Float64Array, cmd: Float64Array) => {
            for (let i = 0; i < n; i++) {
                const c = cmd[i], s = state[i];
                if (!Number.isFinite(c)) continue;
                const next = !Number.isFinite(s) ? c : s + (c - s) * (c > s ? up : down);
                state[i] = next;
                cmd[i] = next;
            }
        };
        step(this._frequency, body.frequency);
        step(this._damping, body.damping);
        step(this._torque, body.torque);
        step(this._pin, body.pin);
        step(this._holdUp, body.holdUp);
    }
}

/** 0 → 1 over `rise` seconds, held to `hold`, back to 0 over `fall`, smoothly: a reflex's envelope (0 before it). */
export function reflexEnvelope(age: number, rise: number, hold: number, fall: number): number {
    const s = (v: number) => { const t = v < 0 ? 0 : v > 1 ? 1 : v; return t * t * (3 - 2 * t); };
    if (age < 0) return 0;
    if (age < rise) return s(age / Math.max(1e-3, rise));
    if (age < hold) return 1;
    return 1 - s((age - hold) / Math.max(1e-3, fall));
}
