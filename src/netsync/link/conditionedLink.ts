// A NetLink that makes another one worse on purpose: latency, jitter and loss (docs/design/netsync.md §3, §8).
// Wrap one end of any link — a loopback pair in a test, a real peer's link in the editor's Play › Multiplayer —
// and both directions through it are conditioned.
//
// Control and bulk stay reliable and in order (each message waits for the one before it). Pulses are delayed
// independently, so they can arrive out of order, and are dropped with probability `loss` — unless `tcp` is
// set, which models the WebSocket fallback: nothing is lost, a "lost" pulse is retransmitted one round trip
// later, and everything behind it waits (head-of-line blocking).

import { LinkBase, type LinkKind, type NetLink } from './netLink';
import { realScheduler, type Scheduler } from '../time';
import { seededRandom } from '../../core/math';

export interface LinkConditions {
    /** One-way delay in ms, each direction (round trip = 2 × latencyMs). */
    latencyMs?: number;
    /** Extra random one-way delay in ms, 0..jitterMs. */
    jitterMs?: number;
    /** Chance (0..1) a pulse is lost (or, with `tcp`, retransmitted). */
    loss?: number;
    /** Model a TCP link: pulses are never lost and never overtake each other. */
    tcp?: boolean;
    /** Seed for the jitter and loss dice, so a test sees the same network every run. */
    seed?: number;
}

export class ConditionedLink extends LinkBase {
    public readonly kind: LinkKind;
    public readonly pulseBudget: number;
    /** Pulses dropped by the conditions (not by the inner link). */
    public dropped = 0;
    private readonly _random: () => number;
    // Earliest delivery time per ordered stream, so control (and bulk, and tcp pulses) never overtake.
    private readonly _orderedOut = { control: 0, bulk: 0, pulse: 0 };
    private readonly _orderedIn = { control: 0, bulk: 0, pulse: 0 };
    private readonly _timers = new Set<unknown>();

    constructor(
        private readonly _inner: NetLink,
        public conditions: LinkConditions = {},
        private readonly _scheduler: Scheduler = realScheduler,
    ) {
        super();
        this.kind = _inner.kind;
        this.pulseBudget = _inner.pulseBudget;
        this._random = seededRandom(conditions.seed ?? 1);
        _inner.onControl = (m) => this._later(this._orderedIn, 'control', false, () => this.onControl?.(m));
        _inner.onBulk = (m) => this._later(this._orderedIn, 'bulk', false, () => this.onBulk?.(m));
        _inner.onPulse = (m) => this._pulse(this._orderedIn, () => this.onPulse?.(m));
        _inner.onClose = (reason) => this._markClosed(reason);
    }

    public sendControl(m: Uint8Array): void {
        if (this.isClosed) return;
        this._later(this._orderedOut, 'control', false, () => this._inner.sendControl(m));
    }

    public sendBulk(m: Uint8Array): void {
        if (this.isClosed) return;
        this._later(this._orderedOut, 'bulk', false, () => this._inner.sendBulk(m));
    }

    public sendPulse(m: Uint8Array): boolean {
        if (this.isClosed || m.length > this.pulseBudget) return false;
        this._pulse(this._orderedOut, () => { this._inner.sendPulse(m); });
        return true;
    }

    protected _closeTransport(reason: string): void {
        for (const t of this._timers) this._scheduler.clearTimeout(t);
        this._timers.clear();
        this._inner.close(reason);
    }

    private _delay(): number {
        const c = this.conditions;
        return (c.latencyMs ?? 0) + (c.jitterMs ?? 0) * this._random();
    }

    private _pulse(ordered: Record<'control' | 'bulk' | 'pulse', number>, deliver: () => void): void {
        const c = this.conditions;
        const lost = (c.loss ?? 0) > 0 && this._random() < (c.loss ?? 0);
        if (c.tcp) {
            // Retransmitted one round trip later; ordered, so later pulses queue behind it.
            this._later(ordered, 'pulse', lost, deliver);
            return;
        }
        if (lost) { this.dropped++; return; }
        this._schedule(this._delay(), deliver);
    }

    private _later(ordered: Record<'control' | 'bulk' | 'pulse', number>, lane: 'control' | 'bulk' | 'pulse', retransmit: boolean, deliver: () => void): void {
        const now = this._scheduler.now();
        const extra = retransmit ? 2 * (this.conditions.latencyMs ?? 0) + (this.conditions.jitterMs ?? 0) : 0;
        const at = Math.max(now + this._delay() + extra, ordered[lane]);
        ordered[lane] = at;
        this._schedule(at - now, deliver);
    }

    private _schedule(ms: number, fn: () => void): void {
        const t = this._scheduler.setTimeout(() => { this._timers.delete(t); if (!this.isClosed) fn(); }, ms);
        this._timers.add(t);
    }
}

