// A player's side of a NetSync session (docs/design/netsync.md §3, layer 2, and §5).
//
// `PeerSession.join()` connects (WebTransport, falling back to WebSocket), says Hello, and resolves once the
// host has seated it. From then on it keeps the host clock estimate fresh with pings, notices a silent host,
// and — when the link drops without a Bye — reconnects on its own and takes its seat back with the resume
// token, inside the host's grace period.

import { ByteReader } from '../bytes';
import { TypedEmitter } from '../../core/typedEmitter';
import { connect, type ConnectOptions, type Connection, type HostEndpoint } from '../link/connect';
import type { LinkKind, NetLink } from '../link/netLink';
import { realScheduler, type Scheduler } from '../time';
import { ClockSync } from './clockSync';
import {
    FIRST_APP_TYPE, NETSYNC_PROTOCOL, SessionControl, SessionPulse,
    decodeBye, decodePong, decodeRefuse, decodeWelcome, encodeBye, encodeHello, encodePing,
    type RefuseCode, type Welcome,
} from './messages';

export interface JoinOptions {
    endpoint: HostEndpoint;
    /** Must equal the host's (see hashContent). */
    contentHash: string;
    name?: string;
    /** Join token from the allocator, when the host asks for one. */
    token?: string;
    connectOptions?: ConnectOptions;
    /** How to get a link; `connect()` by default. Tests pass a loopback. */
    connector?: (endpoint: HostEndpoint, options: ConnectOptions) => Promise<Connection>;
    /** No Welcome within this rejects the join. Default 5000 ms. */
    welcomeTimeoutMs?: number;
    /** A host silent this long counts as gone. Default 5000 ms. */
    timeoutMs?: number;
    /** Ping period once synced. Default 500 ms (the first few go every 50 ms). */
    pingIntervalMs?: number;
    /** Reconnect after an unexpected drop; give up after `graceMs` (keep ≤ the host's grace). Default on, 9000 ms. */
    reconnect?: false | { graceMs?: number };
    scheduler?: Scheduler;
    /** Overrides the protocol version (tests only). */
    protocol?: number;
}

export type PeerState = 'connected' | 'reconnecting' | 'closed';

export interface PeerSessionEvents {
    /** The link dropped; trying to get the seat back. */
    reconnecting: { reason: string };
    /** Back in the same seat on a new link. */
    reconnected: { linkKind: LinkKind; fallbackReason: string | null };
    /** The session is over: left, kicked, refused on resume, or could not reconnect in time. */
    closed: { reason: string };
}

/** The host turned this peer away (see `code`). */
export class JoinRefusedError extends Error {
    constructor(public readonly code: RefuseCode, message: string) {
        super(`host refused the join (${code}): ${message}`);
        this.name = 'JoinRefusedError';
    }
}

const SYNC_BURST = 6;
const SYNC_BURST_MS = 50;

export class PeerSession extends TypedEmitter<PeerSessionEvents> {
    public readonly peerId: number;
    public readonly tickRate: number;
    public readonly clock: ClockSync;
    /** App messages (type ≥ FIRST_APP_TYPE) from the host. */
    public onControl: ((message: Uint8Array) => void) | null = null;
    public onPulse: ((message: Uint8Array) => void) | null = null;
    public onBulk: ((message: Uint8Array) => void) | null = null;

    private _link: NetLink;
    private _fallbackReason: string | null;
    private _state: PeerState = 'connected';
    private readonly _resumeToken: string;
    private _lastHeard: number;
    private _pingId = 0;
    private _burstLeft = SYNC_BURST;
    private _pingTimer: unknown = null;
    private _watchTimer: unknown = null;
    private readonly _pending = new Map<number, number>();

    private constructor(
        private readonly _options: JoinOptions,
        private readonly _scheduler: Scheduler,
        h: HandshakeResult,
    ) {
        super();
        this.peerId = h.welcome.peerId;
        this.tickRate = h.welcome.tickRate;
        this._resumeToken = h.welcome.resumeToken;
        this._link = h.connection.link;
        this._fallbackReason = h.connection.fallbackReason;
        this._lastHeard = h.welcomeAt;
        this.clock = new ClockSync(() => this._scheduler.now());
        // The handshake is the first round trip.
        this.clock.addSample(h.helloSentAt, h.welcome.hostTimeMs, h.welcomeAt);
        this._schedulePing(0);
        this._armWatch();
        this._take(h);
    }

    /** Connect, say Hello, and resolve once seated. Rejects with {@link JoinRefusedError} when refused. */
    public static async join(options: JoinOptions): Promise<PeerSession> {
        const scheduler = options.scheduler ?? realScheduler;
        return new PeerSession(options, scheduler, await handshake(options, scheduler, ''));
    }

    public get state(): PeerState { return this._state; }
    public get linkKind(): LinkKind { return this._link.kind; }
    /** Why this peer is on the WebSocket fallback, or null on WebTransport / loopback. */
    public get fallbackReason(): string | null { return this._fallbackReason; }
    public get pulseBudget(): number { return this._link.pulseBudget; }

    /** The host's session clock now (ms), as estimated from the pings. */
    public hostTimeNow(): number { return this.clock.hostTimeNow(); }
    /** The host tick due now. */
    public hostTick(): number { return this.clock.hostTickNow(this.tickRate); }

    /** Send on the control lane. False while reconnecting or closed (the message is not queued). */
    public sendControl(message: Uint8Array): boolean {
        if (this._state !== 'connected') return false;
        this._link.sendControl(message);
        return true;
    }

    public sendPulse(message: Uint8Array): boolean {
        return this._state === 'connected' ? this._link.sendPulse(message) : false;
    }

    public sendBulk(message: Uint8Array): boolean {
        if (this._state !== 'connected') return false;
        this._link.sendBulk(message);
        return true;
    }

    /** Leave for good: the host frees the seat at once. */
    public leave(reason: string = 'left'): void {
        if (this._state === 'closed') return;
        const link = this._link;
        if (this._state === 'connected') link.sendControl(encodeBye({ reason }));
        this._close(reason);
        this._detach(link);
        // A moment for the Bye to leave before the transport goes.
        this._scheduler.setTimeout(() => link.close(reason), 250);
    }

    // ----- link handling -----------------------------------------------------------------------------

    /** Take over a freshly handshaken link: attach, replay what arrived early, notice if it already closed. */
    private _take(h: HandshakeResult): void {
        const link = h.connection.link;
        this._attach(link);
        for (const e of h.early) {
            if (e.lane === 'control') this._onControl(e.message);
            else if (e.lane === 'pulse') this._onPulse(e.message);
            else link.onBulk?.(e.message);
        }
        if (link.isClosed && link === this._link) this._dropped('closed during the handshake');
    }

    private _attach(link: NetLink): void {
        link.onControl = (m) => this._onControl(m);
        link.onPulse = (m) => this._onPulse(m);
        link.onBulk = (m) => { this._lastHeard = this._scheduler.now(); this.onBulk?.(m); };
        link.onClose = (reason) => { if (link === this._link) this._dropped(reason); };
    }

    private _detach(link: NetLink): void {
        link.onControl = link.onPulse = link.onBulk = null;
        link.onClose = null;
    }

    private _onControl(m: Uint8Array): void {
        this._lastHeard = this._scheduler.now();
        if (m.length === 0) return;
        if (m[0] >= FIRST_APP_TYPE) { this.onControl?.(m); return; }
        if (m[0] === SessionControl.bye) {
            let reason = 'host said bye';
            try { reason = decodeBye(new ByteReader(m, 1)).reason || reason; } catch { /* keep default */ }
            const link = this._link;
            this._close(reason);
            this._detach(link);
            link.close(reason);
        }
    }

    private _onPulse(m: Uint8Array): void {
        this._lastHeard = this._scheduler.now();
        if (m.length === 0) return;
        if (m[0] >= FIRST_APP_TYPE) { this.onPulse?.(m); return; }
        if (m[0] === SessionPulse.pong) {
            try {
                const pong = decodePong(new ByteReader(m, 1));
                if (this._pending.delete(pong.id)) this.clock.addSample(pong.peerTimeMs, pong.hostTimeMs, this._scheduler.now());
            } catch { /* a malformed pong is ignored */ }
        }
    }

    private _schedulePing(ms: number): void {
        this._pingTimer = this._scheduler.setTimeout(() => {
            this._pingTimer = null;
            if (this._state !== 'connected') return;
            const id = ++this._pingId >>> 0;
            const now = this._scheduler.now();
            this._pending.set(id, now);
            if (this._pending.size > 64) this._pending.delete(this._pending.keys().next().value as number);
            this._link.sendPulse(encodePing({ id, peerTimeMs: now }));
            const next = this._burstLeft > 0 ? (this._burstLeft--, SYNC_BURST_MS) : (this._options.pingIntervalMs ?? 500);
            this._schedulePing(next);
        }, ms);
    }

    private _armWatch(): void {
        const timeout = this._options.timeoutMs ?? 5000;
        this._watchTimer = this._scheduler.setTimeout(() => {
            this._watchTimer = null;
            if (this._state === 'closed') return;
            if (this._state === 'connected' && this._scheduler.now() - this._lastHeard > timeout) {
                this._link.close('host timed out');
            }
            this._armWatch();
        }, Math.max(50, Math.min(1000, timeout / 4)));
    }

    private _dropped(reason: string): void {
        if (this._state !== 'connected') return;
        const reconnect = this._options.reconnect;
        if (reconnect === false) { this._close(`link lost: ${reason}`); return; }
        this._state = 'reconnecting';
        this.emit('reconnecting', { reason });
        this._reconnect(reconnect?.graceMs ?? 9000, reason);
    }

    private async _reconnect(graceMs: number, firstReason: string): Promise<void> {
        const deadline = this._scheduler.now() + graceMs;
        const backoff = [0, 250, 500, 1000, 2000];
        let lastError = firstReason;
        // Reconnect over the kind of link that worked, so a WebSocket peer does not wait out the
        // WebTransport timeout again on every attempt.
        const connectOptions: ConnectOptions = { ...this._options.connectOptions };
        if (this._link.kind === 'websocket' && !connectOptions.only) connectOptions.only = 'websocket';
        for (let attempt = 0; this._state === 'reconnecting'; attempt++) {
            const wait = backoff[Math.min(attempt, backoff.length - 1)];
            if (this._scheduler.now() + wait >= deadline) break;
            if (wait > 0) await new Promise<void>((r) => this._scheduler.setTimeout(r, wait));
            if (this._state !== 'reconnecting') return;
            try {
                const h = await handshake({ ...this._options, connectOptions }, this._scheduler, this._resumeToken);
                if (this._state !== 'reconnecting') { h.connection.link.close('no longer wanted'); return; }
                this._link = h.connection.link;
                this._fallbackReason = h.connection.fallbackReason;
                this._lastHeard = this._scheduler.now();
                this.clock.addSample(h.helloSentAt, h.welcome.hostTimeMs, h.welcomeAt);
                this._state = 'connected';
                this._burstLeft = SYNC_BURST;
                if (this._pingTimer !== null) this._scheduler.clearTimeout(this._pingTimer);
                this._schedulePing(0);
                this.emit('reconnected', { linkKind: this._link.kind, fallbackReason: this._fallbackReason });
                this._take(h);
                return;
            } catch (e) {
                lastError = (e as Error)?.message ?? String(e);
                if (e instanceof JoinRefusedError) break; // the seat is gone; retrying cannot help
            }
        }
        if (this._state === 'reconnecting') this._close(`could not reconnect: ${lastError}`);
    }

    private _close(reason: string): void {
        if (this._state === 'closed') return;
        this._state = 'closed';
        if (this._pingTimer !== null) this._scheduler.clearTimeout(this._pingTimer);
        if (this._watchTimer !== null) this._scheduler.clearTimeout(this._watchTimer);
        this._pingTimer = this._watchTimer = null;
        this.emit('closed', { reason });
    }
}

interface HandshakeResult {
    connection: Connection;
    welcome: Welcome;
    helloSentAt: number;
    welcomeAt: number;
    /** Whatever arrived after the Welcome before the session took the link over, to replay in order. */
    early: { lane: 'control' | 'pulse' | 'bulk'; message: Uint8Array }[];
}

/** Connect, send Hello (resuming `resumeToken` if not empty), wait for Welcome or Refuse. */
async function handshake(options: JoinOptions, scheduler: Scheduler, resumeToken: string): Promise<HandshakeResult> {
    const connector = options.connector ?? connect;
    const connection = await connector(options.endpoint, options.connectOptions ?? {});
    const link = connection.link;
    return new Promise<HandshakeResult>((resolve, reject) => {
        let done = false;
        const early: HandshakeResult['early'] = [];
        const finish = (fn: () => void) => {
            if (done) return;
            done = true;
            scheduler.clearTimeout(timer);
            // Messages can follow the Welcome in the same chunk; keep them until the session attaches.
            link.onControl = (message) => early.push({ lane: 'control', message });
            link.onPulse = (message) => early.push({ lane: 'pulse', message });
            link.onBulk = (message) => early.push({ lane: 'bulk', message });
            link.onClose = null;
            fn();
        };
        const timer = scheduler.setTimeout(() => finish(() => {
            link.close('no welcome');
            reject(new Error(`no welcome from the host within ${options.welcomeTimeoutMs ?? 5000} ms`));
        }), options.welcomeTimeoutMs ?? 5000);
        link.onClose = (reason) => finish(() => reject(new Error(`link closed during the handshake: ${reason}`)));
        link.onControl = (m) => {
            const r = new ByteReader(m);
            let type: number;
            try { type = r.u8(); } catch { return; }
            if (type === SessionControl.welcome) {
                const welcome = decodeWelcome(r);
                const welcomeAt = scheduler.now();
                finish(() => resolve({ connection, welcome, helloSentAt, welcomeAt, early }));
            } else if (type === SessionControl.refuse) {
                const refuse = decodeRefuse(r);
                finish(() => {
                    link.close(`refused: ${refuse.code}`);
                    reject(new JoinRefusedError(refuse.code, refuse.message));
                });
            }
        };
        const helloSentAt = scheduler.now();
        link.sendControl(encodeHello({
            protocol: options.protocol ?? NETSYNC_PROTOCOL,
            contentHash: options.contentHash,
            resumeToken,
            token: options.token ?? '',
            name: options.name ?? '',
        }));
    });
}
