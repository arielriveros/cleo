// Fleet adapters (docs/design/netsync.md §7.2): how the allocator gets a host for a new match. The only
// provider-specific code in the allocator.
//
//   static   hosts you run (a VPS or a few): warm cleo-host processes started with --await-allocation --reuse,
//            allocated over their control port (POST /allocate)
//   docker   a container per match on a Docker host you own (Docker Engine API)
//   agones   Kubernetes + Agones: a GameServerAllocation from a fleet of warm GameServers
//   edgegap  Edgegap: a deployment per match, near the player
//
// A host started per match (docker, edgegap) is handed its session, the token key and a certificate the
// allocator made, so the hash players pin is known before the host is up. A warm host (static, agones) made its
// own; static hosts say it in their allocation answer, Agones GameServers in an annotation.

import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync, existsSync } from 'node:fs';
import { generateCertificate, type HostCertificate } from '../devCertificate';

export interface AcquireRequest {
    sessionId: string;
    mode?: string;
    scene?: string;
    region?: string;
    maxPeers: number;
    /** The joining player's IP, for platforms that place a host near it. */
    playerIp?: string;
}

/** A host serving one session: where players reach it (public), and how to ask it how it is doing. */
export interface HostHandle {
    /** The fleet's own name for it (container id, GameServer name, deployment id, host name). */
    id: string;
    publicAddress: string;
    udpPort: number;
    /** Its WebSocket port, as the gateway reaches it (often a private address: `tcpAddress`). */
    tcpPort: number;
    tcpAddress?: string;
    certHash: string;
    region?: string;
    /** Its state and players, when the allocator can reach its control port. */
    status?: () => Promise<{ state: string; peers: number } | null>;
}

export interface FleetHostStatus { id: string; state: string; peers: number; region?: string }

export interface FleetAdapter {
    readonly name: string;
    acquire(req: AcquireRequest): Promise<HostHandle>;
    release(host: HostHandle): Promise<void>;
    list(): Promise<FleetHostStatus[]>;
}

/** What a host started for one session needs in its environment. */
export interface HostEnvInputs {
    session: { id: string; mode?: string; scene?: string; maxPeers?: number };
    tokenKey?: string;
    certificate: HostCertificate;
    publicAddress?: string;
}
export function hostEnv(i: HostEnvInputs): Record<string, string> {
    const env: Record<string, string> = {
        NETSYNC_SESSION: JSON.stringify(i.session),
        NETSYNC_CERT: Buffer.from(i.certificate.cert).toString('base64'),
        NETSYNC_CERT_KEY: Buffer.from(i.certificate.key).toString('base64'),
        NETSYNC_LOG: 'json',
    };
    if (i.tokenKey) env.NETSYNC_TOKEN_KEY = i.tokenKey;
    if (i.publicAddress) env.NETSYNC_PUBLIC_ADDRESS = i.publicAddress;
    return env;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function controlStatus(control: string, secret?: string): Promise<{ state: string; peers: number } | null> {
    try {
        const res = await fetch(`${control}/status`, { headers: secret ? { authorization: `Bearer ${secret}` } : {} });
        if (!res.ok) return null;
        const s = await res.json() as any;
        return { state: s.state, peers: s.peers?.length ?? 0 };
    } catch { return null; }
}

// ----- static -----------------------------------------------------------------------------------------------------

export interface StaticHostConfig {
    name: string;
    /** Its control port, as the allocator reaches it: http://10.0.0.5:4490 */
    control: string;
    /** Where players reach it: an IP or a name. */
    publicAddress: string;
    /** Where the gateway reaches its WebSocket port, when not the public address (a private network). */
    privateAddress?: string;
    region?: string;
    controlSecret?: string;
}

/** Warm hosts you run: the first `ready` one (in the region asked for, when there is one) takes the session. */
export class StaticFleet implements FleetAdapter {
    public readonly name = 'static';
    constructor(private readonly _hosts: StaticHostConfig[]) {}

    public async acquire(req: AcquireRequest): Promise<HostHandle> {
        const order = [...this._hosts].sort((a, b) => Number(b.region === req.region) - Number(a.region === req.region));
        for (const h of order) {
            const st = await controlStatus(h.control, h.controlSecret);
            if (st?.state !== 'ready') continue;
            const res = await fetch(`${h.control}/allocate`, {
                method: 'POST',
                headers: { 'content-type': 'application/json', ...(h.controlSecret ? { authorization: `Bearer ${h.controlSecret}` } : {}) },
                body: JSON.stringify({ id: req.sessionId, mode: req.mode, scene: req.scene, maxPeers: req.maxPeers }),
            }).catch(() => null);
            if (!res?.ok) continue; // taken in the meantime, or gone
            const { endpoint } = await res.json() as any;
            const wt = new URL(endpoint.webTransport.url), ws = new URL(endpoint.webSocket.url);
            return {
                id: h.name, publicAddress: h.publicAddress, udpPort: Number(wt.port), tcpPort: Number(ws.port),
                tcpAddress: h.privateAddress ?? h.publicAddress, certHash: endpoint.webTransport.certHashes[0], region: h.region,
                status: () => controlStatus(h.control, h.controlSecret),
            };
        }
        throw new Error(`no free host${req.region ? ` in ${req.region}` : ''} (all ${this._hosts.length} busy or unreachable)`);
    }

    /** A static host ends its session itself (everyone left) and, run with --reuse, is ready again. */
    public async release(): Promise<void> {}

    public async list(): Promise<FleetHostStatus[]> {
        return Promise.all(this._hosts.map(async (h) => {
            const st = await controlStatus(h.control, h.controlSecret);
            return { id: h.name, state: st?.state ?? 'unreachable', peers: st?.peers ?? 0, region: h.region };
        }));
    }
}

// ----- docker -----------------------------------------------------------------------------------------------------

export interface DockerFleetConfig {
    /** The Docker Engine API: unix:///var/run/docker.sock (default) or http://host:2375 */
    docker?: string;
    /** The host image (your published cleo-host image with the game in it). */
    image: string;
    /** The Docker host's address, as players reach it (published ports are on it). */
    publicAddress: string;
    /** As the allocator and gateway reach it, when not the public one. Default: publicAddress. */
    privateAddress?: string;
    /** Ports inside the container. Defaults 4433, 4480, 4490. */
    ports?: { udp?: number; tcp?: number; control?: number };
    /** Extra environment for every host. */
    env?: Record<string, string>;
    tokenKey?: string;
    /** How long a container gets to report ready. Default 60 s. */
    readyTimeoutMs?: number;
}

/** A container per match, its ports published on the Docker host; it removes itself when its session ends. */
export class DockerFleet implements FleetAdapter {
    public readonly name = 'docker';
    constructor(private readonly _c: DockerFleetConfig) {}

    private _api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
        const base = this._c.docker ?? 'unix:///var/run/docker.sock';
        return new Promise((resolve, reject) => {
            const data = body === undefined ? undefined : JSON.stringify(body);
            const target = base.startsWith('unix://')
                ? { socketPath: base.slice('unix://'.length), path }
                : (() => { const u = new URL(path, base); return { hostname: u.hostname, port: u.port, path: u.pathname + u.search }; })();
            const req = httpRequest({ ...target, method, headers: { 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
                let text = '';
                res.on('data', (c) => { text += c; });
                res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: text ? JSON.parse(text) : null }); } catch { resolve({ status: res.statusCode ?? 0, json: text }); } });
            });
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    public async acquire(req: AcquireRequest): Promise<HostHandle> {
        const p = { udp: 4433, tcp: 4480, control: 4490, ...this._c.ports };
        const certificate = await generateCertificate(2);
        const env = { ...this._c.env, ...hostEnv({ session: { id: req.sessionId, mode: req.mode, scene: req.scene, maxPeers: req.maxPeers }, tokenKey: this._c.tokenKey, certificate, publicAddress: this._c.publicAddress }) };
        const keys = [`${p.udp}/udp`, `${p.tcp}/tcp`, `${p.control}/tcp`];
        const created = await this._api('POST', `/containers/create?name=cleo-${req.sessionId.replace(/[^\w.-]/g, '-')}`, {
            Image: this._c.image,
            Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
            ExposedPorts: Object.fromEntries(keys.map((k) => [k, {}])),
            Labels: { 'netsync.session': req.sessionId, ...(req.mode ? { 'netsync.mode': req.mode } : {}) },
            HostConfig: { AutoRemove: true, PortBindings: Object.fromEntries(keys.map((k) => [k, [{ HostPort: '' }]])) },
        });
        if (created.status !== 201) throw new Error(`docker create: HTTP ${created.status} ${JSON.stringify(created.json)}`);
        const id: string = created.json.Id;
        const started = await this._api('POST', `/containers/${id}/start`);
        if (started.status !== 204 && started.status !== 304) throw new Error(`docker start: HTTP ${started.status}`);
        const info = await this._api('GET', `/containers/${id}/json`);
        const port = (k: string) => Number(info.json?.NetworkSettings?.Ports?.[k]?.[0]?.HostPort);
        const reach = this._c.privateAddress ?? this._c.publicAddress;
        const control = `http://${reach}:${port(keys[2])}`;
        const deadline = Date.now() + (this._c.readyTimeoutMs ?? 60_000);
        for (;;) {
            const st = await controlStatus(control);
            if (st && st.state !== 'starting') break;
            if (Date.now() > deadline) { await this.release({ id } as HostHandle); throw new Error('the host container did not become ready in time'); }
            await sleep(250);
        }
        return {
            id, publicAddress: this._c.publicAddress, udpPort: port(keys[0]), tcpPort: port(keys[1]), tcpAddress: reach,
            certHash: certificate.hash, status: () => controlStatus(control),
        };
    }

    public async release(host: HostHandle): Promise<void> {
        await this._api('POST', `/containers/${host.id}/stop?t=10`).catch(() => {});
    }

    public async list(): Promise<FleetHostStatus[]> {
        const res = await this._api('GET', `/containers/json?filters=${encodeURIComponent(JSON.stringify({ label: ['netsync.session'] }))}`);
        return (res.json ?? []).map((c: any) => ({ id: c.Id, state: c.State, peers: -1 }));
    }
}

// ----- agones -----------------------------------------------------------------------------------------------------

export interface AgonesFleetConfig {
    /** The Agones fleet to allocate from. */
    fleet: string;
    namespace?: string;
    /** The Kubernetes API. Default: in-cluster (https://kubernetes.default.svc with the service account). */
    apiServer?: string;
    token?: string;
    ca?: string;
    /** The GameServer's port names (its spec's ports). Defaults "webtransport" and "websocket". */
    portNames?: { udp?: string; tcp?: string };
}

const SA = '/var/run/secrets/kubernetes.io/serviceaccount';

/**
 * A GameServerAllocation from a fleet of warm GameServers (each a cleo-host with --lifecycle agones). The session
 * goes on the GameServer as the `netsync.session` annotation; the host's certificate hash comes back from the
 * annotation the host set (agones.dev/sdk-netsync-cert-hash).
 */
export class AgonesFleet implements FleetAdapter {
    public readonly name = 'agones';
    private readonly _ns: string;
    constructor(private readonly _c: AgonesFleetConfig) {
        this._ns = _c.namespace ?? (existsSync(`${SA}/namespace`) ? readFileSync(`${SA}/namespace`, 'utf8').trim() : 'default');
    }

    private _api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
        const base = this._c.apiServer ?? 'https://kubernetes.default.svc';
        const token = this._c.token ?? (existsSync(`${SA}/token`) ? readFileSync(`${SA}/token`, 'utf8').trim() : undefined);
        const ca = this._c.ca ?? (existsSync(`${SA}/ca.crt`) ? readFileSync(`${SA}/ca.crt`, 'utf8') : undefined);
        const u = new URL(path, base);
        const data = body === undefined ? undefined : JSON.stringify(body);
        const send = u.protocol === 'https:' ? httpsRequest : httpRequest;
        return new Promise((resolve, reject) => {
            const req = send({
                hostname: u.hostname, port: u.port, path: u.pathname + u.search, method, ...(ca ? { ca } : {}),
                headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
            }, (res) => {
                let text = '';
                res.on('data', (c) => { text += c; });
                res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, json: JSON.parse(text) }); } catch { resolve({ status: res.statusCode ?? 0, json: null }); } });
            });
            req.on('error', reject);
            if (data) req.write(data);
            req.end();
        });
    }

    public async acquire(req: AcquireRequest): Promise<HostHandle> {
        const session = { id: req.sessionId, ...(req.mode ? { mode: req.mode } : {}), ...(req.scene ? { scene: req.scene } : {}), maxPeers: req.maxPeers };
        const res = await this._api('POST', `/apis/allocation.agones.dev/v1/namespaces/${this._ns}/gameserverallocations`, {
            apiVersion: 'allocation.agones.dev/v1', kind: 'GameServerAllocation',
            spec: {
                selectors: [{ matchLabels: { 'agones.dev/fleet': this._c.fleet } }],
                metadata: { annotations: { 'netsync.session': JSON.stringify(session) } },
            },
        });
        const st = res.json?.status;
        if (res.status >= 300 || st?.state !== 'Allocated') throw new Error(`no free GameServer in fleet ${this._c.fleet} (${st?.state ?? `HTTP ${res.status}`})`);
        const port = (name: string) => Number((st.ports ?? []).find((p: any) => p.name === name)?.port);
        let annotations: Record<string, string> = st.metadata?.annotations ?? {};
        if (!certHashIn(annotations)) {
            // Older Agones: the allocation does not carry the GameServer's metadata. Read it.
            const gs = await this._api('GET', `/apis/agones.dev/v1/namespaces/${this._ns}/gameservers/${st.gameServerName}`);
            annotations = gs.json?.metadata?.annotations ?? {};
        }
        const certHash = certHashIn(annotations);
        if (!certHash) throw new Error(`GameServer ${st.gameServerName} has no netsync-cert-hash annotation (is it a cleo-host with --lifecycle agones?)`);
        return {
            id: st.gameServerName, publicAddress: st.address, certHash,
            udpPort: port(this._c.portNames?.udp ?? 'webtransport'), tcpPort: port(this._c.portNames?.tcp ?? 'websocket'),
        };
    }

    /** The GameServer shuts itself down when its session ends. */
    public async release(): Promise<void> {}

    public async list(): Promise<FleetHostStatus[]> {
        const res = await this._api('GET', `/apis/agones.dev/v1/namespaces/${this._ns}/gameservers?labelSelector=${encodeURIComponent(`agones.dev/fleet=${this._c.fleet}`)}`);
        return (res.json?.items ?? []).map((g: any) => ({ id: g.metadata?.name, state: g.status?.state ?? 'unknown', peers: -1 }));
    }
}

/** The host's certificate hash among a GameServer's annotations, whatever prefix the SDK gave the key. */
export function certHashIn(annotations: Record<string, string>): string | undefined {
    const key = Object.keys(annotations).find((k) => k === 'netsync-cert-hash' || k.endsWith('/sdk-netsync-cert-hash'));
    return key ? annotations[key] : undefined;
}

// ----- edgegap ----------------------------------------------------------------------------------------------------

export interface EdgegapFleetConfig {
    /** The value of the Authorization header (Edgegap's dashboard gives the API token; its docs do not say whether a prefix such as "token " is part of it — use it exactly as given). */
    apiToken: string;
    application: string;
    version: string;
    /** The app version's port names. Defaults "webtransport" (UDP) and "websocket" (TCP). */
    portNames?: { udp?: string; tcp?: string };
    tokenKey?: string;
    apiBase?: string;
    readyTimeoutMs?: number;
}

/**
 * A deployment per match, placed near the joining player (v2 POST /deployments with the player's IP), its status
 * polled until it runs (v1 GET /status/{id}). The host stops its own deployment when its session ends
 * (EdgegapLifecycle). Written from Edgegap's API reference (2026-11); not yet run against the live service.
 */
export class EdgegapFleet implements FleetAdapter {
    public readonly name = 'edgegap';
    private readonly _base: string;
    constructor(private readonly _c: EdgegapFleetConfig, private readonly _fetch: typeof fetch = fetch) {
        this._base = _c.apiBase ?? 'https://api.edgegap.com';
    }

    private async _call(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
        const res = await this._fetch(this._base + path, {
            method, headers: { authorization: this._c.apiToken, 'content-type': 'application/json', accept: 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        let json: any = null;
        try { json = await res.json(); } catch { /* empty */ }
        return { status: res.status, json };
    }

    public async acquire(req: AcquireRequest): Promise<HostHandle> {
        const certificate = await generateCertificate(2);
        const env = hostEnv({ session: { id: req.sessionId, mode: req.mode, scene: req.scene, maxPeers: req.maxPeers }, tokenKey: this._c.tokenKey, certificate });
        env.NETSYNC_LIFECYCLE = 'edgegap';
        const created = await this._call('POST', '/v2/deployments', {
            application: this._c.application,
            version: this._c.version,
            // Placed near the player who asked (the allocator always has its address).
            users: [{ user_type: 'ip_address', user_data: { ip_address: req.playerIp ?? '' } }],
            environment_variables: Object.entries(env).map(([key, value]) => ({ key, value, is_hidden: key === 'NETSYNC_CERT_KEY' })),
            tags: [req.sessionId],
        });
        if (created.status !== 202 && created.status !== 200) throw new Error(`Edgegap deploy: HTTP ${created.status} ${created.json?.message ?? ''}`);
        const id: string = created.json.request_id;
        const deadline = Date.now() + (this._c.readyTimeoutMs ?? 90_000);
        for (;;) {
            const st = await this._call('GET', `/v1/status/${id}`);
            if (st.json?.running) {
                const ports = st.json.ports ?? {};
                const ext = (name: string) => Number(ports[name]?.external);
                return {
                    id, publicAddress: st.json.public_ip ?? st.json.fqdn, certHash: certificate.hash,
                    udpPort: ext(this._c.portNames?.udp ?? 'webtransport'), tcpPort: ext(this._c.portNames?.tcp ?? 'websocket'),
                    region: st.json.location?.city,
                };
            }
            if (st.json?.error) throw new Error(`Edgegap deployment ${id} failed: ${st.json.error_detail ?? st.json.current_status}`);
            if (Date.now() > deadline) { await this.release({ id } as HostHandle); throw new Error(`Edgegap deployment ${id} did not start in time`); }
            await sleep(1000);
        }
    }

    public async release(host: HostHandle): Promise<void> {
        await this._call('DELETE', `/v1/stop/${host.id}`).catch(() => {});
    }

    public async list(): Promise<FleetHostStatus[]> {
        const res = await this._call('GET', '/v1/deployments');
        return (res.json?.data ?? []).map((d: any) => ({ id: d.request_id, state: d.ready ? 'running' : 'starting', peers: -1 }));
    }
}
