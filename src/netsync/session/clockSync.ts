// How a peer knows what time it is on the host (docs/design/netsync.md §5).
//
// Each ping/pong gives a sample: the peer sent at `t0`, the host stamped `h`, the peer got it back at `t1`.
// Assuming the two legs took equal time, the host's clock read `h` at peer time `t0 + rtt/2`, so
// `offset = h - (t0 + t1) / 2` and host time = peer time + offset.
//
// The equal-legs assumption breaks when a sample was delayed on one leg (queueing, a retransmit). Those
// samples have the longest round trips, so the estimate uses only the fastest third of the recent samples —
// the same idea NTP's clock filter uses.

export interface ClockSample { rttMs: number; offsetMs: number; }

export class ClockSync {
    private readonly _samples: ClockSample[] = [];
    private _offset = 0;
    private _rtt = 0;
    private _jitter = 0;
    private _lastHostTime = -Infinity;

    /**
     * @param _now   the peer's monotonic clock, ms
     * @param _window how many recent samples to estimate from
     */
    constructor(private readonly _now: () => number, private readonly _window: number = 16) {}

    /** Samples taken so far (capped at the window). */
    public get sampleCount(): number { return this._samples.length; }
    /** True once there are enough samples to trust the estimate. */
    public get synced(): boolean { return this._samples.length >= 3; }
    /** Smoothed round-trip time, ms. */
    public get rttMs(): number { return this._rtt; }
    /** Smoothed variation of the round-trip time, ms. */
    public get jitterMs(): number { return this._jitter; }
    /** host time − peer time, ms. */
    public get offsetMs(): number { return this._offset; }

    /** Record one round trip: sent at peer time `sentAt`, stamped `hostTime` by the host, back at `receivedAt`. */
    public addSample(sentAt: number, hostTime: number, receivedAt: number = this._now()): void {
        const rtt = Math.max(0, receivedAt - sentAt);
        const offset = hostTime - (sentAt + receivedAt) / 2;
        this._samples.push({ rttMs: rtt, offsetMs: offset });
        if (this._samples.length > this._window) this._samples.shift();

        if (this._samples.length === 1) { this._rtt = rtt; this._jitter = 0; }
        else {
            this._jitter += (Math.abs(rtt - this._rtt) - this._jitter) / 8;
            this._rtt += (rtt - this._rtt) / 8;
        }

        const fastest = [...this._samples].sort((a, b) => a.rttMs - b.rttMs);
        const keep = fastest.slice(0, Math.max(1, Math.ceil(fastest.length / 3)));
        const offsets = keep.map((s) => s.offsetMs).sort((a, b) => a - b);
        this._offset = offsets[Math.floor(offsets.length / 2)];
    }

    /**
     * The host's clock now, as best this peer can tell. Never goes backwards, even when a better estimate
     * moves the offset down.
     */
    public hostTimeNow(): number {
        const t = Math.max(this._now() + this._offset, this._lastHostTime);
        this._lastHostTime = t;
        return t;
    }

    /** The host tick due now at `tickRate` Hz. */
    public hostTickNow(tickRate: number): number {
        return Math.floor(this.hostTimeNow() * tickRate / 1000);
    }
}
