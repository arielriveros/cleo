// The host's side of a NetSync session (docs/design/netsync.md §3, layer 2): who is connected, under which
// PeerId, since when, and what to do when a link drops.
//
// Transport-agnostic: the host process hands every new NetLink — WebTransport session, WebSocket, loopback —
// to `accept()`. The session runs the handshake (protocol version, content hash, optional join token), seats
// the peer, answers its pings with the host clock, and watches for silence.
//
// A link that drops without a Bye does not free the seat at once: the peer keeps it for `reconnectGraceMs`
// and can take it back with the resume token from its Welcome (same PeerId, same everything above).

import { ByteReader } from '../bytes';
import { TypedEmitter } from '../../core/typedEmitter';
import type { LinkKind, NetLink } from '../link/netLink';
import { realScheduler, type Scheduler } from '../time';
import {
    FIRST_APP_TYPE, NETSYNC_PROTOCOL, SessionControl, SessionPulse,
    decodeBye, decodeHello, decodePing, encodeBye, encodePong, encodeRefuse, encodeWelcome, randomToken,
    type Hello, type RefuseCode,
} from './messages';

export interface HostSessionOptions {
    /** Hash of the game content (see hashContent); a peer with a different one is refused. */
    contentHash: string;
    /** Simulation rate, Hz. Default 30. */
    tickRate?: number;
    /** Seats, including ones held for a dropped peer. Default 16. */
    maxPeers?: number;
    /** How long a dropped peer's seat is held. Default 10 000 ms. */
    reconnectGraceMs?: number;
    /** A connected peer silent for this long is dropped. Default 5000 ms. */
    timeoutMs?: number;
    /** A new link that sends no Hello within this is closed. Default 5000 ms. */
    helloTimeoutMs?: number;
    /** Return a refusal message to turn a Hello away (bad join token, banned name…), or null to accept. */
    authorize?: (hello: Hello) => string | null;
    scheduler?: Scheduler;
    /** Overrides the protocol version (tests only). */
    protocol?: number;
}

export interface HostSessionEvents {
    /** A new peer took a seat. */
    join: HostPeer;
    /** A peer's link dropped; its seat is held for the grace period. */
    drop: { peer: HostPeer; reason: string };
    /** A dropped peer came back on a new link. */
    resume: HostPeer;
    /** A peer is gone for good: it said Bye, was kicked, or its grace period ran out. */
    leave: { peer: HostPeer; reason: string };
}

/** One seat at the host. Survives a dropped link until its grace period ends. */
export class HostPeer {
    /** @internal */ public link: NetLink | null = null;
    /** @internal */ public lastHeard = 0;
    /** @internal */ public graceTimer: unknown = null;
    /** @internal */ public readonly resumeToken = randomToken();

    constructor(public readonly id: number, public readonly name: string) {}

    public get connected(): boolean { return this.link !== null && !this.link.isClosed; }
    public get linkKind(): LinkKind | null { return this.link?.kind ?? null; }

    /** Send on the control lane. False when the peer is not connected right now. */
    public sendControl(message: Uint8Array): boolean {
        if (!this.connected) return false;
        this.link!.sendControl(message);
        return true;
    }

    public sendPulse(message: Uint8Array): boolean {
        return this.connected ? this.link!.sendPulse(message) : false;
    }

    public sendBulk(message: Uint8Array): boolean {
        if (!this.connected) return false;
        this.link!.sendBulk(message);
        return true;
    }
}

export class HostSession extends TypedEmitter<HostSessionEvents> {
    public readonly contentHash: string;
    public readonly tickRate: number;
    public readonly maxPeers: number;
    public readonly reconnectGraceMs: number;
    public readonly timeoutMs: number;
    public readonly helloTimeoutMs: number;

    /**
     * App messages (type ≥ FIRST_APP_TYPE) from seated peers that no {@link route} claims. The layers above the
     * session (sync, commands) route their own types, so they never compete for these.
     */
    public onControl: ((peer: HostPeer, message: Uint8Array) => void) | null = null;
    public onPulse: ((peer: HostPeer, message: Uint8Array) => void) | null = null;
    public onBulk: ((peer: HostPeer, message: Uint8Array) => void) | null = null;

    private readonly _peers = new Map<number, HostPeer>();
    private readonly _routes = { control: new Map<number, (peer: HostPeer, m: Uint8Array) => void>(), pulse: new Map<number, (peer: HostPeer, m: Uint8Array) => void>() };
    private readonly _scheduler: Scheduler;
    private readonly _origin: number;
    private readonly _protocol: number;
    private readonly _authorize: ((hello: Hello) => string | null) | null;
    private _watchdog: unknown = null;
    private _closed = false;

    constructor(options: HostSessionOptions) {
        super();
        this.contentHash = options.contentHash;
        this.tickRate = options.tickRate ?? 30;
        this.maxPeers = Math.min(options.maxPeers ?? 16, 0xfffe);
        this.reconnectGraceMs = options.reconnectGraceMs ?? 10_000;
        this.timeoutMs = options.timeoutMs ?? 5000;
        this.helloTimeoutMs = options.helloTimeoutMs ?? 5000;
        this._authorize = options.authorize ?? null;
        this._protocol = options.protocol ?? NETSYNC_PROTOCOL;
        this._scheduler = options.scheduler ?? realScheduler;
        this._origin = this._scheduler.now();
        this._armWatchdog();
    }

    /** Every seat, connected or held for a dropped peer. */
    public get peers(): ReadonlyMap<number, HostPeer> { return this._peers; }
    public get closed(): boolean { return this._closed; }

    /** The session clock: ms since the session started. What peers synchronise to. */
    public timeMs(): number { return this._scheduler.now() - this._origin; }

    /** The tick due now. */
    public tick(): number { return Math.floor(this.timeMs() * this.tickRate / 1000); }

    /** Take a new link: it must say Hello within `helloTimeoutMs`. */
    public accept(link: NetLink): void {
        if (this._closed) { this._refuse(link, 'closing', 'the session is closing'); return; }
        const helloTimer = this._scheduler.setTimeout(() => link.close('no hello'), this.helloTimeoutMs);
        link.onPulse = null;
        link.onBulk = null;
        link.onClose = () => this._scheduler.clearTimeout(helloTimer);
        link.onControl = (m) => {
            this._scheduler.clearTimeout(helloTimer);
            link.onControl = null;
            let hello: Hello;
            try {
                const r = new ByteReader(m);
                if (r.u8() !== SessionControl.hello) throw new Error('first message is not a hello');
                hello = decodeHello(r);
            } catch (e) {
                this._refuse(link, 'bad-hello', (e as Error).message);
                return;
            }
            this._onHello(link, hello);
        };
    }

    /**
     * Deliver app messages of one type on one lane to `handler` (null removes it). Each layer above the session
     * claims its own types, so several can share the session.
     */
    public route(lane: 'control' | 'pulse', type: number, handler: ((peer: HostPeer, message: Uint8Array) => void) | null): void {
        if (handler) this._routes[lane].set(type, handler);
        else this._routes[lane].delete(type);
    }

    /** Send Bye and free the seat at once (no grace). */
    public kick(peerId: number, reason: string = 'kicked'): void {
        const peer = this._peers.get(peerId);
        if (!peer) return;
        peer.sendControl(encodeBye({ reason }));
        this._leave(peer, reason, true);
    }

    /** Say Bye to everyone and stop accepting links. */
    public close(reason: string = 'host closed'): void {
        if (this._closed) return;
        this._closed = true;
        for (const peer of [...this._peers.values()]) this.kick(peer.id, reason);
        if (this._watchdog !== null) this._scheduler.clearTimeout(this._watchdog);
        this._watchdog = null;
    }

    private _onHello(link: NetLink, hello: Hello): void {
        if (hello.protocol !== this._protocol) {
            this._refuse(link, 'protocol', `host speaks protocol ${this._protocol}, peer ${hello.protocol}`);
            return;
        }
        if (hello.contentHash !== this.contentHash) {
            this._refuse(link, 'content', 'peer and host run different game content');
            return;
        }
        const denied = this._authorize?.(hello) ?? null;
        if (denied !== null) { this._refuse(link, 'unauthorized', denied); return; }

        if (hello.resumeToken) {
            const peer = [...this._peers.values()].find((p) => p.resumeToken === hello.resumeToken);
            if (!peer) { this._refuse(link, 'unknown-session', 'that seat is no longer held'); return; }
            this._seat(peer, link, true);
            return;
        }

        const id = this._freeId();
        if (id === null) { this._refuse(link, 'full', `all ${this.maxPeers} seats are taken`); return; }
        const peer = new HostPeer(id, hello.name);
        this._peers.set(id, peer);
        this._seat(peer, link, false);
    }

    private _seat(peer: HostPeer, link: NetLink, resumed: boolean): void {
        if (peer.graceTimer !== null) { this._scheduler.clearTimeout(peer.graceTimer); peer.graceTimer = null; }
        const old = peer.link;
        if (old && old !== link) {
            // The same peer again while its old link still looks alive: the new one wins.
            old.onClose = null;
            old.onControl = old.onPulse = old.onBulk = null;
            old.close('replaced by a new link');
        }
        peer.link = link;
        peer.lastHeard = this._scheduler.now();

        link.onControl = (m) => this._onControl(peer, link, m);
        link.onPulse = (m) => this._onPulse(peer, link, m);
        link.onBulk = (m) => { peer.lastHeard = this._scheduler.now(); this.onBulk?.(peer, m); };
        link.onClose = (reason) => { if (peer.link === link) this._drop(peer, reason); };

        link.sendControl(encodeWelcome({
            peerId: peer.id, resumeToken: peer.resumeToken, tickRate: this.tickRate, hostTimeMs: this.timeMs(), resumed,
        }));
        if (resumed) this.emit('resume', peer);
        else this.emit('join', peer);
    }

    private _onControl(peer: HostPeer, link: NetLink, m: Uint8Array): void {
        peer.lastHeard = this._scheduler.now();
        if (m.length === 0) return;
        if (m[0] >= FIRST_APP_TYPE) { (this._routes.control.get(m[0]) ?? this.onControl)?.(peer, m); return; }
        if (m[0] === SessionControl.bye) {
            let reason = 'left';
            try { reason = decodeBye(new ByteReader(m, 1)).reason || reason; } catch { /* keep default */ }
            this._leave(peer, reason, true);
        }
    }

    private _onPulse(peer: HostPeer, link: NetLink, m: Uint8Array): void {
        peer.lastHeard = this._scheduler.now();
        if (m.length === 0) return;
        if (m[0] >= FIRST_APP_TYPE) { (this._routes.pulse.get(m[0]) ?? this.onPulse)?.(peer, m); return; }
        if (m[0] === SessionPulse.ping) {
            try {
                const ping = decodePing(new ByteReader(m, 1));
                link.sendPulse(encodePong({ id: ping.id, peerTimeMs: ping.peerTimeMs, hostTimeMs: this.timeMs() }));
            } catch { /* a malformed ping is ignored */ }
        }
    }

    private _drop(peer: HostPeer, reason: string): void {
        if (!this._peers.has(peer.id)) return;
        peer.link = null;
        if (this._closed) { this._leave(peer, reason, false); return; }
        this.emit('drop', { peer, reason });
        peer.graceTimer = this._scheduler.setTimeout(() => {
            peer.graceTimer = null;
            this._leave(peer, `did not come back (${reason})`, false);
        }, this.reconnectGraceMs);
    }

    private _leave(peer: HostPeer, reason: string, closeLink: boolean): void {
        if (!this._peers.has(peer.id)) return;
        this._peers.delete(peer.id);
        if (peer.graceTimer !== null) { this._scheduler.clearTimeout(peer.graceTimer); peer.graceTimer = null; }
        const link = peer.link;
        peer.link = null;
        if (link && closeLink) {
            link.onClose = null;
            link.onControl = link.onPulse = link.onBulk = null;
            // Give the Bye a moment to leave before the transport goes (closing at once can discard it).
            this._scheduler.setTimeout(() => link.close(reason), 250);
        }
        this.emit('leave', { peer, reason });
    }

    private _refuse(link: NetLink, code: RefuseCode, message: string): void {
        link.onControl = link.onPulse = link.onBulk = null;
        link.sendControl(encodeRefuse({ code, message }));
        // The peer closes when it reads the refusal; close anyway if it does not.
        this._scheduler.setTimeout(() => link.close(`refused: ${code}`), 1000);
    }

    private _freeId(): number | null {
        if (this._peers.size >= this.maxPeers) return null;
        for (let id = 1; id <= this.maxPeers; id++) if (!this._peers.has(id)) return id;
        return null;
    }

    private _armWatchdog(): void {
        const period = Math.max(50, Math.min(1000, this.timeoutMs / 4));
        this._watchdog = this._scheduler.setTimeout(() => {
            const now = this._scheduler.now();
            for (const peer of this._peers.values()) {
                if (peer.connected && now - peer.lastHeard > this.timeoutMs) peer.link!.close('timed out');
            }
            if (!this._closed) this._armWatchdog();
        }, period);
    }
}
