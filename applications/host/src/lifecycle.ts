// Lifecycle adapters (docs/design/netsync.md §7.2): how a host tells the platform it runs on that it is up, ready,
// in a match or done, and hears that it was allocated or must shut down. The only platform-specific code in the
// host; everything else is the HTTP control port, which needs no adapter.
//
//   none    VPS, Docker, Edgegap, any container platform: the control port is enough (POST /allocate, /readyz,
//           SIGTERM). The default.
//   agones  Kubernetes with Agones: the Agones SDK's REST sidecar (localhost:AGONES_SDK_HTTP_PORT, 9358 by
//           default) — Ready, Health every few seconds, Allocated (watched), Shutdown. The host's certificate hash
//           goes on the GameServer as an annotation, where the allocator reads it.
//   edgegap  Edgegap: the platform starts a deployment per match (the allocator hands it its session and
//           certificate in its environment); when the session ends the host stops its own deployment
//           (ARBITRIUM_DELETE_URL with ARBITRIUM_DELETE_TOKEN).

import type { SessionSpec } from './settings';

export interface HostInfo {
    udpPort: number;
    tcpPort: number;
    controlPort: number;
    certHash: string;
}

export interface HostLifecycle {
    readonly name: string;
    /** The host process is up (ports bound). */
    start(host: HostInfo): Promise<void>;
    /** Content loaded: it can take a session. */
    ready(): Promise<void>;
    /** The platform assigned this host a session (Agones: the GameServer became Allocated). */
    onAllocate(cb: (spec: SessionSpec) => void): void;
    /** The session is over: the platform may recycle or stop the host. */
    sessionEnded(): Promise<void>;
    /** The platform asks the host to drain and stop. */
    onShutdown(cb: () => void): void;
    dispose(): void;
}

/** No platform to talk to: allocation comes over POST /allocate, shutdown as SIGTERM (wired by the host). */
export class NoLifecycle implements HostLifecycle {
    public readonly name = 'none';
    public async start(): Promise<void> {}
    public async ready(): Promise<void> {}
    public onAllocate(): void {}
    public async sessionEnded(): Promise<void> {}
    public onShutdown(): void {}
    public dispose(): void {}
}

export interface AgonesOptions {
    /** The SDK sidecar's REST base. Default http://localhost:$AGONES_SDK_HTTP_PORT (9358). */
    baseUrl?: string;
    /** Health ping period, ms. Default 2000 (Agones' default failure threshold is a few missed seconds). */
    healthMs?: number;
    fetch?: typeof fetch;
    log?: (line: string) => void;
}

/**
 * Agones through its SDK's REST sidecar. The session spec of an allocation is read from the GameServer's
 * annotations or labels (`netsync.session` as JSON, or `netsync.session-id` / `netsync.scene` / `netsync.mode`),
 * which a GameServerAllocation sets with its `metadata`; with none, the session id is the GameServer's name.
 */
export class AgonesLifecycle implements HostLifecycle {
    public readonly name = 'agones';
    private readonly _base: string;
    private readonly _fetch: typeof fetch;
    private _health: ReturnType<typeof setInterval> | null = null;
    private _watch: AbortController | null = null;
    private _onAllocate: ((spec: SessionSpec) => void) | null = null;
    private _onShutdown: (() => void) | null = null;
    private _allocated = false;

    constructor(private readonly _options: AgonesOptions = {}) {
        this._base = _options.baseUrl ?? `http://localhost:${process.env.AGONES_SDK_HTTP_PORT || 9358}`;
        this._fetch = _options.fetch ?? fetch;
    }

    public async start(host: HostInfo): Promise<void> {
        // Where the allocator finds the hash to pin (Agones prefixes the key: agones.dev/sdk-netsync-cert-hash).
        await this._put('/metadata/annotation', { key: 'netsync-cert-hash', value: host.certHash });
        this._health = setInterval(() => { void this._post('/health').catch(() => {}); }, this._options.healthMs ?? 2000);
        void this._watchGameServer();
    }

    public async ready(): Promise<void> {
        this._allocated = false;
        await this._post('/ready');
    }

    public onAllocate(cb: (spec: SessionSpec) => void): void { this._onAllocate = cb; }
    public onShutdown(cb: () => void): void { this._onShutdown = cb; }

    /** One session per GameServer: Agones replaces it after Shutdown (a fleet's usual shape). */
    public async sessionEnded(): Promise<void> {
        await this._post('/shutdown');
    }

    public dispose(): void {
        if (this._health) clearInterval(this._health);
        this._health = null;
        this._watch?.abort();
        this._watch = null;
    }

    private async _put(path: string, body: unknown): Promise<void> {
        const res = await this._fetch(this._base + path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`Agones SDK ${path}: HTTP ${res.status}`);
    }

    private async _post(path: string): Promise<void> {
        const res = await this._fetch(this._base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        if (!res.ok) throw new Error(`Agones SDK ${path}: HTTP ${res.status}`);
    }

    /** GET /watch/gameserver streams one JSON object per line ({ result: GameServer }) on every change. */
    private async _watchGameServer(): Promise<void> {
        for (;;) {
            if (!this._health) return; // disposed
            this._watch = new AbortController();
            try {
                const res = await this._fetch(this._base + '/watch/gameserver', { signal: this._watch.signal });
                if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
                const reader = res.body.getReader();
                const decoder = new TextDecoder();
                let buffered = '';
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffered += decoder.decode(value, { stream: true });
                    let nl: number;
                    while ((nl = buffered.indexOf('\n')) >= 0) {
                        const line = buffered.slice(0, nl).trim();
                        buffered = buffered.slice(nl + 1);
                        if (line) this._onGameServer(JSON.parse(line));
                    }
                }
            } catch (e) {
                if (!this._health) return;
                this._options.log?.(`agones: watch ended (${(e as Error)?.message ?? e}); retrying`);
            }
            await new Promise((r) => setTimeout(r, 1000));
        }
    }

    private _onGameServer(message: any): void {
        const gs = message?.result ?? message;
        const state: string | undefined = gs?.status?.state;
        if (state === 'Allocated' && !this._allocated) {
            this._allocated = true;
            this._onAllocate?.(sessionFromGameServer(gs));
        }
        if (state === 'Shutdown') this._onShutdown?.();
    }
}

/** The session an Agones allocation asked for, from the GameServer's metadata. */
export function sessionFromGameServer(gs: any): SessionSpec {
    const meta = { ...(gs?.object_meta?.labels ?? gs?.objectMeta?.labels ?? {}), ...(gs?.object_meta?.annotations ?? gs?.objectMeta?.annotations ?? {}) };
    if (typeof meta['netsync.session'] === 'string') {
        try { const spec = JSON.parse(meta['netsync.session']); if (spec?.id) return spec; } catch { /* fall through */ }
    }
    return {
        id: meta['netsync.session-id'] || gs?.object_meta?.name || gs?.objectMeta?.name || 'session',
        ...(meta['netsync.scene'] ? { scene: meta['netsync.scene'] } : {}),
        ...(meta['netsync.mode'] ? { mode: meta['netsync.mode'] } : {}),
    };
}

/**
 * Edgegap: a deployment is one match. Its session and certificate arrive in the environment (NETSYNC_SESSION,
 * NETSYNC_CERT); when the session ends the host stops its own deployment rather than idling until Edgegap's
 * maximum duration.
 */
export class EdgegapLifecycle implements HostLifecycle {
    public readonly name = 'edgegap';
    constructor(private readonly _env: Record<string, string | undefined> = process.env, private readonly _fetch: typeof fetch = fetch,
                private readonly _log?: (line: string) => void) {}
    public async start(): Promise<void> {}
    public async ready(): Promise<void> {}
    public onAllocate(): void {}
    public onShutdown(): void {}
    public dispose(): void {}
    public async sessionEnded(): Promise<void> {
        const url = this._env.ARBITRIUM_DELETE_URL, token = this._env.ARBITRIUM_DELETE_TOKEN;
        if (!url || !token) { this._log?.('edgegap: no ARBITRIUM_DELETE_URL / ARBITRIUM_DELETE_TOKEN; not stopping the deployment'); return; }
        const res = await this._fetch(url, { method: 'DELETE', headers: { authorization: token } });
        if (!res.ok && res.status !== 410) throw new Error(`Edgegap self-stop: HTTP ${res.status}`);
    }
}

export function createLifecycle(name: 'none' | 'agones' | 'edgegap', log?: (line: string) => void): HostLifecycle {
    if (name === 'agones') return new AgonesLifecycle({ log });
    if (name === 'edgegap') return new EdgegapLifecycle(process.env, fetch, log);
    return new NoLifecycle();
}
