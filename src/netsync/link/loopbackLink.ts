// Two NetLinks joined back to back in one process: what the tests (and, later, the editor's in-process host)
// use instead of a network. Delivery is asynchronous — through the scheduler, never inside the send call — so
// code that works over loopback does not accidentally depend on a re-entrant send.

import { LinkBase, PULSE_BUDGET, type LinkKind } from './netLink';
import { realScheduler, type Scheduler } from '../time';

class LoopbackLink extends LinkBase {
    public readonly kind: LinkKind = 'loopback';
    public readonly pulseBudget = PULSE_BUDGET;
    public other!: LoopbackLink;

    constructor(private readonly _scheduler: Scheduler) { super(); }

    public sendControl(m: Uint8Array): void { this._deliver((l) => l.onControl, m); }
    public sendPulse(m: Uint8Array): boolean {
        if (this.isClosed || m.length > this.pulseBudget) return false;
        this._deliver((l) => l.onPulse, m);
        return true;
    }
    public sendBulk(m: Uint8Array): void { this._deliver((l) => l.onBulk, m); }

    protected _closeTransport(reason: string): void {
        const other = this.other;
        this._scheduler.setTimeout(() => other.closedByPeer(reason), 0);
    }

    public closedByPeer(reason: string): void { this._markClosed(reason); }

    private _deliver(pick: (l: LoopbackLink) => ((m: Uint8Array) => void) | null, m: Uint8Array): void {
        if (this.isClosed) return;
        const copy = m.slice();
        const other = this.other;
        this._scheduler.setTimeout(() => { if (!other.isClosed) pick(other)?.(copy); }, 0);
    }
}

/** Two connected links: what one sends, the other receives. Closing either closes both. */
export function createLoopbackPair(scheduler: Scheduler = realScheduler): [NetLinkPairEnd, NetLinkPairEnd] {
    const a = new LoopbackLink(scheduler);
    const b = new LoopbackLink(scheduler);
    a.other = b;
    b.other = a;
    return [a, b];
}

export type NetLinkPairEnd = LinkBase;
