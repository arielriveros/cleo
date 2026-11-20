// The allocator (docs/design/netsync.md §7.2): hands a joining player a join ticket — where its session's host is,
// the certificate hash to pin, and a signed join token — finding a session of the mode asked for with a free seat,
// or getting a new host from the fleet adapter. With the gateway built in (the usual shape), one small service on
// TCP 443 is all that has to stay up between matches.
//
//   POST /join      { mode?, region?, name?, session? }   → { endpoint, token, name?, session: { id, mode } }
//   GET  /sessions                                         → the sessions it knows, with their players
//   GET  /route/:id   (Authorization: Bearer <secret>)     → { host, port } for a gateway run apart
//   GET  /healthz
//
// The ticket is what the player app takes as `?join=<JSON>` (applications/editor/src/player/netsyncJoin.ts).
// Accounts, matchmaking rules and payments stay with the developer's own backend: `onRequest` can refuse a join
// or change what it asks for, `chooseRegion` can pick where it goes.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { HostEndpoint } from '../../../../src/netsync';
import { signJoinToken } from '../joinToken';
import type { FleetAdapter, HostHandle } from './fleet';
import { Gateway, type GatewayRoute } from './gateway';

export interface JoinRequest {
    mode?: string;
    region?: string;
    name?: string;
    /** Join this session (a friend's), if it has a seat. */
    session?: string;
}

export interface JoinTicket {
    endpoint: HostEndpoint;
    token: string;
    name?: string;
    session: { id: string; mode?: string };
}

export interface ModeConfig { maxPeers?: number; scene?: string }

export interface AllocatorOptions {
    fleet: FleetAdapter;
    /** The allocator's Ed25519 private key (PEM or base64 DER); hosts get the public half (NETSYNC_TOKEN_KEY). */
    privateKey: string;
    port: number;
    bindAddress?: string;
    tls?: { cert: string; key: string };
    /**
     * The gateway's public URL (wss://play.example.com): players' WebSocket fallback goes through it. Without, a
     * ticket names each host's WebSocket port directly (development, or hosts with their own certificates).
     */
    gatewayUrl?: string;
    /** Players per session (16) and per mode. */
    maxPeers?: number;
    modes?: Record<string, ModeConfig>;
    /** How long a join token admits its player. Default 60 s. */
    ticketSeconds?: number;
    /** A session whose host the allocator cannot ask is forgotten after this. Default 2 h. */
    sessionMinutes?: number;
    /** For GET /route (a gateway run as its own service). */
    routeSecret?: string;
    /** The developer's say: throw (or return a string) to refuse, return a request to change it. */
    onRequest?: (join: JoinRequest, req: IncomingMessage) => JoinRequest | string | void | Promise<JoinRequest | string | void>;
    chooseRegion?: (join: JoinRequest, req: IncomingMessage) => string | undefined | Promise<string | undefined>;
    log?: (line: string) => void;
}

interface Session {
    id: string;
    mode?: string;
    maxPeers: number;
    host: HostHandle;
    created: number;
    /** Tickets issued, newest last (ms). */
    tickets: number[];
    /** Players the host last reported, and when. */
    peers: number;
    checked: number;
    misses: number;
}

const RECENT_TICKET_MS = 30_000;

export class Allocator {
    public readonly sessions = new Map<string, Session>();
    private _pruning: ReturnType<typeof setInterval> | null = null;
    /** One acquire per mode at a time: players arriving together fill one new host rather than each starting one. */
    private readonly _acquiring = new Map<string, Promise<Session>>();

    private constructor(private readonly _o: AllocatorOptions, public readonly gateway: Gateway) {}

    public get port(): number { return this.gateway.port; }

    public static async start(options: AllocatorOptions): Promise<Allocator> {
        let self: Allocator | null = null;
        const gateway = await Gateway.start({
            port: options.port, bindAddress: options.bindAddress, tls: options.tls, log: options.log,
            resolve: (id) => self?.route(id) ?? null,
            onRequest: (req, res) => void self?._http(req, res),
        });
        self = new Allocator(options, gateway);
        self._pruning = setInterval(() => void self!._prune(), 5000);
        return self;
    }

    /** Where the gateway forwards a session's players. */
    public route(sessionId: string): GatewayRoute | null {
        const s = this.sessions.get(sessionId);
        return s ? { host: s.host.tcpAddress ?? s.host.publicAddress, port: s.host.tcpPort } : null;
    }

    /** A ticket for one player. */
    public async join(request: JoinRequest, ip?: string, req?: IncomingMessage): Promise<JoinTicket> {
        let join = { ...request };
        if (this._o.onRequest && req) {
            const said = await this._o.onRequest(join, req);
            if (typeof said === 'string') throw new HttpError(403, said);
            if (said) join = said;
        }
        if (this._o.chooseRegion && req && !join.region) join.region = await this._o.chooseRegion(join, req);
        const mode = join.mode ?? '';
        const maxPeers = this._o.modes?.[mode]?.maxPeers ?? this._o.maxPeers ?? 16;

        let session: Session | undefined;
        if (join.session) {
            session = this.sessions.get(join.session);
            if (!session) throw new HttpError(404, `no session ${join.session}`);
            if (this._seatsTaken(session) >= session.maxPeers) throw new HttpError(409, `session ${join.session} is full`);
        } else {
            session = [...this.sessions.values()].find((s) => (s.mode ?? '') === mode && this._seatsTaken(s) < s.maxPeers);
            session ??= await this._newSession(mode, maxPeers, join.region, ip);
        }
        session.tickets.push(Date.now());
        const exp = Math.floor(Date.now() / 1000) + (this._o.ticketSeconds ?? 60);
        const token = signJoinToken({ sid: session.id, exp, ...(join.name ? { name: join.name } : {}) }, this._o.privateKey);
        return { endpoint: this.endpointOf(session), token, ...(join.name ? { name: join.name } : {}), session: { id: session.id, ...(session.mode ? { mode: session.mode } : {}) } };
    }

    public endpointOf(s: Session): HostEndpoint {
        const h = s.host;
        const addr = h.publicAddress.includes(':') && !h.publicAddress.startsWith('[') ? `[${h.publicAddress}]` : h.publicAddress;
        return {
            webTransport: { url: `https://${addr}:${h.udpPort}/netsync`, certHashes: [h.certHash] },
            webSocket: { url: this._o.gatewayUrl ? `${this._o.gatewayUrl.replace(/\/$/, '')}/s/${s.id}` : `ws://${addr}:${h.tcpPort}/ws` },
        };
    }

    public async close(): Promise<void> {
        if (this._pruning) clearInterval(this._pruning);
        await this.gateway.close();
    }

    private _seatsTaken(s: Session): number {
        const recent = s.tickets.filter((t) => Date.now() - t < RECENT_TICKET_MS).length;
        // A host that says how many players it has: those, plus tickets out that have not joined yet (at most).
        if (s.host.status) return Math.max(s.peers + recent, recent);
        return s.tickets.length;
    }

    private _newSession(mode: string, maxPeers: number, region?: string, ip?: string): Promise<Session> {
        const key = `${mode}|${region ?? ''}`;
        const pending = this._acquiring.get(key);
        if (pending) return pending;
        const made = (async () => {
            const id = randomUUID();
            const scene = this._o.modes?.[mode]?.scene;
            const host = await this._o.fleet.acquire({ sessionId: id, mode: mode || undefined, scene, region, maxPeers, playerIp: ip });
            const s: Session = { id, mode: mode || undefined, maxPeers, host, created: Date.now(), tickets: [], peers: 0, checked: Date.now(), misses: 0 };
            this.sessions.set(id, s);
            this._o.log?.(`session ${id}${mode ? ` (${mode})` : ''} on ${this._o.fleet.name} host ${host.id} at ${host.publicAddress}`);
            return s;
        })();
        this._acquiring.set(key, made);
        made.finally(() => this._acquiring.delete(key)).catch(() => {});
        return made;
    }

    /** Forget sessions that are over: their host says so, cannot be reached twice, or (unaskable) has aged out. */
    private async _prune(): Promise<void> {
        for (const s of [...this.sessions.values()]) {
            if (!s.host.status) {
                if (Date.now() - s.created > (this._o.sessionMinutes ?? 120) * 60_000) this.sessions.delete(s.id);
                continue;
            }
            const st = await s.host.status().catch(() => null);
            s.checked = Date.now();
            if (!st) { if (++s.misses >= 2) this._end(s, 'unreachable'); continue; }
            s.misses = 0;
            s.peers = st.peers;
            // Ended — or a reused host that is ready again, or holds another session now.
            if (st.state === 'ended' || st.state === 'ready') this._end(s, st.state);
        }
    }

    private _end(s: Session, why: string): void {
        this.sessions.delete(s.id);
        this._o.log?.(`session ${s.id} is over (${why})`);
        void this._o.fleet.release(s.host).catch(() => {});
    }

    private async _http(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization', 'access-control-allow-methods': 'GET, POST, OPTIONS' };
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
            res.end(JSON.stringify(body));
        };
        const url = new URL(req.url ?? '/', 'http://x');
        try {
            if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
            if (req.method === 'GET' && url.pathname === '/healthz') return json(200, { ok: true, sessions: this.sessions.size, gateway: this.gateway.open });
            if (req.method === 'POST' && url.pathname === '/join') {
                const body = await readBody(req);
                let join: JoinRequest;
                try { join = body ? JSON.parse(body) : {}; } catch { return json(400, { error: 'body is not JSON' }); }
                const ip = (String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim()) || req.socket.remoteAddress || undefined;
                return json(200, await this.join(join, ip, req));
            }
            if (req.method === 'GET' && url.pathname === '/sessions') {
                return json(200, [...this.sessions.values()].map((s) => ({
                    id: s.id, mode: s.mode, maxPeers: s.maxPeers, players: s.host.status ? s.peers : null, seatsTaken: this._seatsTaken(s),
                    host: s.host.id, region: s.host.region, ageSeconds: Math.round((Date.now() - s.created) / 1000),
                })));
            }
            const route = /^\/route\/([\w.-]+)$/.exec(url.pathname);
            if (req.method === 'GET' && route) {
                if (!this._o.routeSecret || req.headers.authorization !== `Bearer ${this._o.routeSecret}`) return json(401, { error: 'unauthorized' });
                const r = this.route(route[1]);
                return r ? json(200, r) : json(404, { error: 'no such session' });
            }
            json(404, { error: 'not found' });
        } catch (e) {
            if (e instanceof HttpError) return json(e.status, { error: e.message });
            this._o.log?.(`allocator: ${(e as Error)?.message ?? e}`);
            json(503, { error: (e as Error)?.message ?? String(e) });
        }
    }
}

export class HttpError extends Error {
    constructor(public readonly status: number, message: string) { super(message); }
}

function readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => { body += c; if (body.length > 65536) { req.destroy(); reject(new HttpError(413, 'too large')); } });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}
