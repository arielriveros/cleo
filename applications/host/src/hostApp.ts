// cleo-host as a whole (docs/design/netsync.md §7, §7.2): the game running headless, the NetSync session on top of
// it, the listener players connect to, and the host contract — the HTTP control port, the lifecycle adapter, join
// tokens, draining. main.ts reads the settings and calls startHost; tests call it directly.
//
// A host's session goes through:
//
//   ready      content loaded, no session yet          (--await-allocation: a warm host in a pool)
//   allocated  a session assigned, waiting for players  (POST /allocate, an Agones allocation, NETSYNC_SESSION)
//   running    players in it
//   draining   SIGTERM (or the platform): no new players; ends when they have left or the grace runs out
//   ended      over: the host exits — or, with --reuse, resets its scene and is ready again
//
// A host started with neither a session nor --await-allocation opens one at once and keeps it open for good: a
// plain long-running server (and development). An ALLOCATED session ends when everyone has left (--empty-seconds)
// or when nobody came (--join-seconds).

import { readFileSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AnimHost, CarryHost, HostSession, LagCompensator, RemoteControl, ScriptHost, SyncHost, WeaponHost, hashContent } from '../../../src/netsync';
import type { ControllerNode, Node } from 'cleo';
import type { HostCertificate } from './devCertificate';
import { HostListener } from './hostListener';
import { HostRuntime } from './hostRuntime';
import { packExampleGame } from './exampleGame';
import { buildExampleWeb, type WebBuild } from './webBuild';
import { JoinTokenVerifier } from './joinToken';
import { createLifecycle, type HostLifecycle } from './lifecycle';
import { bufferSource } from '../../editor/src/player/gameSource';
import { readGameHeader } from '../../editor/src/player/unpack';
import { withGameDefaults, type HostSettings, type SessionSpec } from './settings';

export type HostState = 'starting' | 'ready' | 'allocated' | 'running' | 'draining' | 'ended';

export interface HostLog {
    (level: 'info' | 'warn' | 'error', message: string, fields?: Record<string, unknown>): void;
}

/** Text lines with a time, or one JSON object per line (NETSYNC_LOG=json) for a log collector. */
export function createLog(format: 'text' | 'json', write: (line: string) => void = (l) => console.log(l)): HostLog {
    return (level, message, fields) => {
        if (format === 'json') write(JSON.stringify({ t: new Date().toISOString(), level, msg: message, ...fields }));
        else write(`[${new Date().toISOString().slice(11, 23)}] ${level === 'info' ? '' : `${level.toUpperCase()} `}${message}`);
    };
}

export interface StartHostOptions {
    certificate: HostCertificate;
    log?: HostLog;
    /** The platform adapter; default from settings.lifecycle. */
    lifecycle?: HostLifecycle;
    /** What "exit" means: the CLI exits the process; tests get told. */
    exit?: (code: number) => void;
}

export interface HostStatus {
    state: HostState;
    session: SessionSpec | null;
    scene: string;
    peers: { id: number; name: string; link: string; connected: boolean }[];
    maxPeers: number;
    characters: number;
    tick: { rate: number; ticks: number; meanMs: number; p95Ms: number; maxMs: number; skipped: number };
    peakBytesPerTick: number;
    synced: number;
    uptimeSeconds: number;
    contentHash: string;
}

export class HostApp {
    public state: HostState = 'starting';
    public sessionSpec: SessionSpec | null = null;
    /** Why the last session ended. */
    public endReason = '';
    private _control: Server | null = null;
    private _controlPort = 0;
    private _timer: ReturnType<typeof setInterval> | null = null;
    private _stateSince = Date.now();
    private _hadPeers = false;
    private _drainStarted = 0;
    private readonly _started = Date.now();
    /** Ends with no time limit: a session opened at start, not allocated. */
    private _persistent = false;

    private constructor(
        public readonly settings: HostSettings,
        public readonly runtime: HostRuntime | null,
        public readonly session: HostSession,
        public readonly listener: HostListener,
        public readonly sync: SyncHost | null,
        public readonly remote: RemoteControl | null,
        public readonly lifecycle: HostLifecycle,
        public readonly web: WebBuild | null,
        private readonly _log: HostLog,
        private readonly _exit: (code: number) => void,
        private readonly _contentHash: string,
        private readonly _tickRate: number,
    ) {}

    public get controlPort(): number { return this._controlPort; }

    // ----- the session's life ----------------------------------------------------------------------------------

    /** Take a session (POST /allocate, the lifecycle adapter, or at start). False when this host already has one. */
    public async allocate(spec: SessionSpec, persistent = false): Promise<boolean> {
        if (this.state !== 'ready') return false;
        this.sessionSpec = spec;
        this._persistent = persistent;
        if (spec.scene && this.runtime && spec.scene !== this.runtime.sceneName) await this.runtime.loadScene(spec.scene);
        this._setState('allocated');
        this._log('info', `session ${spec.id} allocated${spec.mode ? ` (${spec.mode})` : ''}`, { session: spec.id, mode: spec.mode, scene: this.runtime?.sceneName });
        return true;
    }

    /** Stop taking players and end the session once they have left, or after the drain grace. Then exit. */
    public drain(reason = 'draining'): void {
        if (this.state === 'draining' || this.state === 'ended') return;
        this._log('info', `${reason}: no new players; ending within ${this.settings.drainSeconds} s`);
        this._drainStarted = Date.now();
        this._setState('draining');
        this._check();
    }

    public status(): HostStatus {
        const s = this.runtime?.stats();
        const peers = [...this.session.peers.values()];
        return {
            state: this.state,
            session: this.sessionSpec,
            scene: this.runtime?.sceneName ?? '',
            peers: peers.map((p) => ({ id: p.id, name: p.name, link: p.linkKind ?? '', connected: p.connected })),
            maxPeers: this.sessionSpec?.maxPeers ?? this.session.maxPeers,
            characters: this.runtime ? [...this.runtime.scene.nodes].filter((n: any) => n.nodeType === 'character').length : 0,
            tick: { rate: this._tickRate, ticks: s?.ticks ?? 0, meanMs: s?.meanMs ?? 0, p95Ms: s?.p95Ms ?? 0, maxMs: s?.maxMs ?? 0, skipped: s?.skipped ?? 0 },
            peakBytesPerTick: Math.max(0, ...peers.map((p) => this.sync?.peerStats(p.id)?.maxBytesPerTick ?? 0)),
            synced: this.sync?.syncedCount ?? 0,
            uptimeSeconds: Math.round((Date.now() - this._started) / 1000),
            contentHash: this._contentHash,
        };
    }

    /** Shut everything down (no exit call). */
    public async close(): Promise<void> {
        if (this._timer) clearInterval(this._timer);
        this._timer = null;
        this.lifecycle.dispose();
        this.runtime?.dispose();
        this.session.close('host shutting down');
        await new Promise((r) => setTimeout(r, 200));
        await this.listener.close();
        if (this._control) {
            this._control.closeAllConnections?.();
            await new Promise<void>((r) => this._control!.close(() => r()));
        }
    }

    private _setState(state: HostState): void {
        this.state = state;
        this._stateSince = Date.now();
    }

    /** Once a second (and on joins and leaves): move the session on. */
    private _check(): void {
        const n = this.session.peers.size;
        const since = (Date.now() - this._stateSince) / 1000;
        if (n > 0) this._hadPeers = true;
        switch (this.state) {
            case 'allocated':
                if (n > 0) { this._setState('running'); break; }
                if (!this._persistent && since > this.settings.joinSeconds) void this._end('nobody joined');
                break;
            case 'running':
                if (n > 0) { this._emptySince = 0; break; }
                if (this._persistent) { this._setState('allocated'); break; }
                this._emptySince ||= Date.now();
                if ((Date.now() - this._emptySince) / 1000 > this.settings.emptySeconds) void this._end('everyone left');
                break;
            case 'draining':
                if (n === 0 || (Date.now() - this._drainStarted) / 1000 > this.settings.drainSeconds) void this._end('drained', true);
                break;
        }
    }
    private _emptySince = 0;

    private async _end(reason: string, exit = false): Promise<void> {
        if (this.state === 'ended') return;
        const id = this.sessionSpec?.id;
        this.endReason = reason;
        this._setState('ended');
        this._log('info', `session ${id ?? '-'} ended: ${reason}`, { session: id, reason });
        for (const p of [...this.session.peers.values()]) this.session.kick(p.id, `session ended: ${reason}`);
        try { await this.lifecycle.sessionEnded(); } catch (e) { this._log('warn', `lifecycle: ${(e as Error)?.message ?? e}`); }
        this.sessionSpec = null;
        this._hadPeers = false;
        this._emptySince = 0;
        if (exit || !this.settings.reuse) { this._exit(0); return; }
        // --reuse: the scene back to its authored state, and ready for the next one.
        if (this.runtime) await this.runtime.loadScene(this.runtime.entrySceneName);
        this._setState('ready');
        try { await this.lifecycle.ready(); } catch (e) { this._log('warn', `lifecycle: ${(e as Error)?.message ?? e}`); }
        this._log('info', 'ready for the next session');
    }

    // ----- start ------------------------------------------------------------------------------------------------

    public static async start(settings: HostSettings, options: StartHostOptions): Promise<HostApp> {
        const log = options.log ?? createLog(settings.log);
        const exit = options.exit ?? ((code) => process.exit(code));

        // The game.
        let runtime: HostRuntime | null = null;
        let web: WebBuild | null = null;
        let contentHash = 'dev';
        if (settings.game || settings.example) {
            let bin: Uint8Array;
            let scripts: string | undefined;
            if (settings.game) {
                bin = new Uint8Array(readFileSync(settings.game));
                const scriptsPath = settings.scripts ?? path.join(path.dirname(settings.game), 'game.scripts.js');
                if (existsSync(scriptsPath)) scripts = readFileSync(scriptsPath, 'utf8');
            } else if (settings.serve) {
                log('info', `publishing ${settings.example} as a web game`);
                web = await buildExampleWeb(settings.example!);
                bin = web.bin;
                scripts = web.scripts;
            } else {
                log('info', `packing ${settings.example}`);
                bin = await packExampleGame(settings.example!);
            }
            const t0 = performance.now();
            // The game's own NetSync settings decide what the flags and environment left open — the tick rate too,
            // which the runtime needs from the start.
            const header = await readGameHeader(bufferSource(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength) as ArrayBuffer));
            const tickRate = withGameDefaults(settings, (header.manifest as any).config?.netsync).tickRate;
            runtime = await HostRuntime.open({ bin, scripts }, { tickRate, physicsBackend: settings.physics, logging: settings.verbose });
            contentHash = runtime.contentHash ?? await hashContent([bin]);
            log('info', `game loaded in ${Math.round(performance.now() - t0)} ms: scene "${runtime.sceneName}", ${[...runtime.scene.nodes].length} nodes, physics ${runtime.engine.physics.backend}`);
            runtime.onSceneStarted = (name) => log('info', `scene "${name}" started`);
        }
        const game = withGameDefaults(settings, runtime?.config?.netsync);
        const tickRate = game.tickRate;

        // The session.
        const verifier = settings.tokenKey ? new JoinTokenVerifier(settings.tokenKey) : null;
        let app: HostApp | null = null;
        const session = new HostSession({
            contentHash, tickRate, maxPeers: game.maxPeers,
            authorize: (hello) => {
                if (!app) return 'starting';
                if (app.state === 'draining' || app.state === 'ended') return 'the host is shutting down';
                if (app.state === 'ready' || app.state === 'starting') return 'this host has no session yet';
                const cap = app.sessionSpec?.maxPeers;
                if (cap && session.peers.size >= cap) return `all ${cap} seats are taken`;
                return verifier ? verifier.check(hello.token, app.sessionSpec?.id ?? null) : null;
            },
        });
        session.on('join', (p) => { log('info', `peer ${p.id} joined (${p.name || 'unnamed'}) over ${p.linkKind}`, { peer: p.id, link: p.linkKind }); app?._check(); });
        session.on('drop', (e) => log('info', `peer ${e.peer.id} dropped: ${e.reason} — seat held ${session.reconnectGraceMs} ms`, { peer: e.peer.id }));
        session.on('resume', (p) => log('info', `peer ${p.id} is back over ${p.linkKind}`, { peer: p.id }));
        session.on('leave', (e) => { log('info', `peer ${e.peer.id} left: ${e.reason}`, { peer: e.peer.id }); app?._check(); });

        const listener = await HostListener.start({
            certificate: options.certificate,
            webTransportPort: settings.udpPort,
            webSocketPort: settings.tcpPort,
            onLink: (link) => session.accept(link),
            log: (line) => log('info', line),
            // --serve: the published game, from memory, on this port.
            onHttp: (_req, res, url) => {
                if (!web) return false;
                const file = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
                const body = web.files.get(file);
                if (!body) return false;
                res.writeHead(200, { 'content-type': contentType(file), 'cache-control': 'no-store' });
                res.end(body);
                return true;
            },
        });

        const { sync, remote } = runtime ? HostApp._play(runtime, session, game, tickRate, log) : { sync: null, remote: null };
        const lifecycle = options.lifecycle ?? createLifecycle(settings.lifecycle, (l) => log('info', l));
        app = new HostApp(settings, runtime, session, listener, sync, remote, lifecycle, web, log, exit, contentHash, tickRate);
        await app._startControl();
        lifecycle.onAllocate((spec) => void app!.allocate(spec));
        lifecycle.onShutdown(() => app!.drain('the platform is shutting the host down'));
        await lifecycle.start({ udpPort: listener.webTransportPort, tcpPort: listener.webSocketPort, controlPort: app._controlPort, certHash: options.certificate.hash });

        app._setState('ready');
        await lifecycle.ready();
        if (settings.session) await app.allocate(settings.session);
        else if (!settings.awaitAllocation && settings.lifecycle === 'none') await app.allocate({ id: randomUUID() }, true);
        app._timer = setInterval(() => app!._check(), 1000);
        return app;
    }

    /** Everything that plays the game with the peers: possession, sync, scripts, carrying, weapons, animation. */
    private static _play(runtime: HostRuntime, session: HostSession, game: ReturnType<typeof withGameDefaults>, tickRate: number, log: HostLog) {
        // Possession: a joining player gets a character the level placed for a player while one is free, then a
        // copy of the player template (when the game names one) spread out from the spawn point; it goes when the
        // player leaves, and a level character goes back to waiting.
        const characters = new Map<number, Node>();
        const spawned = new Set<ControllerNode>();
        const subtree = (root: Node): Node[] => [root, ...root.children.flatMap(subtree)];
        const remote = new RemoteControl(session, {
            possess: (peer): ControllerNode | null => {
                // (One a player already drives is 'remote', so 'player' means free.)
                const placed = [...runtime.scene.controllers].find((c: ControllerNode) => c.controlSource === 'player' && !!c.possessed && !spawned.has(c));
                if (placed) { log('info', `peer ${peer.id} drives the level's "${placed.possessed!.name}"`); return placed; }
                if (!game.playerTemplate) { log('info', `peer ${peer.id} spectates (no free character and no player template)`); return null; }
                const [x, y, z] = game.spawn;
                const root = runtime.scene.instantiate(game.playerTemplate, { position: [x + peer.id * 2, y, z] });
                const controller = root ? subtree(root).find((n) => n.nodeType === 'controller') as ControllerNode | undefined : undefined;
                if (!root || !controller) { log('warn', `player template "${game.playerTemplate}" has no Controller in it; peer ${peer.id} spectates`); return null; }
                characters.set(peer.id, root);
                spawned.add(controller);
                log('info', `peer ${peer.id} drives a new "${game.playerTemplate}"`);
                return controller;
            },
            release: (peer, controller) => {
                if (!spawned.has(controller)) { controller.controlSource = 'player'; return; }
                spawned.delete(controller);
                const root = characters.get(peer.id);
                characters.delete(peer.id);
                if (root?.scene) runtime.scene.removeNode(root);
            },
        });
        const sync = new SyncHost(session, () => runtime.scene, {
            sceneKey: () => runtime.sceneName,
            focusOf: (peerId) => remote.controllerOf(peerId)?.possessed?.worldPosition ?? null,
        });
        const scripts = new ScriptHost(session, sync, () => runtime.scene, { ownerOf: (node) => remote.ownerOf(node) ?? 0 });
        const pawnOf = (peerId: number) => remote.controllerOf(peerId)?.possessed ?? null;
        const carry = new CarryHost(session, sync, { pawnOf, trust: game.trust, gravity: () => runtime.engine.physics.gravity });
        const lag = new LagCompensator(sync);
        let lastTick = 0;
        new WeaponHost(session, sync, lag, () => runtime.scene, {
            pawnOf, trust: game.trust, physics: () => runtime.engine.physics, currentTick: () => lastTick,
            gravity: () => runtime.engine.physics.gravity,
            onHit: (h) => log('info', `peer ${h.peer.id} hit "${h.node.name}" with ${h.weapon}${h.claimed ? ' (claimed)' : ''}`),
        });
        runtime.onBeforeTick = (tick) => { remote.beforeTick(tick); carry.beforeTick(tick, 1 / tickRate); };
        // Animation level of detail and the physics simulation range measure from the players' characters.
        runtime.focusPoints = () => [...session.peers.keys()].map((id) => remote.controllerOf(id)?.possessed?.worldPosition).filter((p): p is any => !!p);
        const anim = new AnimHost(session, sync);
        // Tick 0 of the game is tick 0 of the session clock, so a tick number means the same moment to both.
        runtime.start(performance.now() - session.timeMs());
        let last = 0;
        runtime.onTick = (tick) => {
            lastTick = tick;
            lag.record(tick);
            sync.tick(tick);
            scripts.tick();
            anim.tick(tick);
            if (tick - last < tickRate * 30) return;
            last = tick;
            const s = runtime.stats();
            log('info', `tick ${tick}: ${s.meanMs} ms mean, ${s.p95Ms} p95, ${s.maxMs} max (budget ${Math.round(1000 / tickRate)}), skipped ${s.skipped}; ${sync.syncedCount} synced; ${session.peers.size} peers`,
                { tick, meanMs: s.meanMs, p95Ms: s.p95Ms, skipped: s.skipped, peers: session.peers.size });
        };
        return { sync, remote };
    }

    // ----- the control port -------------------------------------------------------------------------------------

    /**
     * GET /healthz (alive), /readyz (can take a session or players), /status (JSON; ?format=prometheus),
     * /cert-hash; POST /allocate {id, scene?, mode?, maxPeers?} (a warm host takes a session; 409 when it has one).
     * Keep this port private to the provider's network: it is the platform's, not the players'.
     */
    private async _startControl(): Promise<void> {
        if (this.settings.controlPort < 0) return;
        const json = (res: any, status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
            res.end(JSON.stringify(body));
        };
        this._control = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://x');
            if (req.method === 'GET' && url.pathname === '/healthz') return json(res, 200, { ok: true });
            if (req.method === 'GET' && url.pathname === '/readyz') {
                const ok = this.state === 'ready' || this.state === 'allocated' || this.state === 'running';
                return json(res, ok ? 200 : 503, { ready: ok, state: this.state });
            }
            if (req.method === 'GET' && url.pathname === '/status') {
                const status = this.status();
                if (url.searchParams.get('format') === 'prometheus') {
                    res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' });
                    res.end(prometheus(status));
                    return;
                }
                return json(res, 200, status);
            }
            if (req.method === 'GET' && url.pathname === '/cert-hash') {
                return json(res, 200, { hash: this.listener.certificate.hash, notAfter: this.listener.certificate.notAfter });
            }
            if (req.method === 'POST' && url.pathname === '/allocate') {
                if (this.settings.controlSecret && req.headers.authorization !== `Bearer ${this.settings.controlSecret}`) return json(res, 401, { error: 'unauthorized' });
                let body = '';
                req.on('data', (c) => { body += c; if (body.length > 65536) req.destroy(); });
                req.on('end', async () => {
                    let spec: SessionSpec;
                    try { spec = JSON.parse(body || '{}'); } catch { return json(res, 400, { error: 'body is not JSON' }); }
                    if (!spec.id) spec.id = randomUUID();
                    try {
                        const ok = await this.allocate(spec);
                        if (!ok) return json(res, 409, { error: `this host is ${this.state}`, state: this.state });
                        const host = this.settings.publicAddress ?? (req.headers.host ?? 'localhost').replace(/:\d+$/, '');
                        return json(res, 200, { session: spec, endpoint: this.listener.endpoint(host) });
                    } catch (e) {
                        return json(res, 500, { error: (e as Error)?.message ?? String(e) });
                    }
                });
                return;
            }
            res.writeHead(404);
            res.end();
        });
        await new Promise<void>((resolve, reject) => {
            this._control!.once('error', reject);
            this._control!.listen(this.settings.controlPort, '::', () => resolve());
        });
        this._controlPort = (this._control.address() as AddressInfo).port;
    }
}

function prometheus(s: HostStatus): string {
    const states: HostState[] = ['starting', 'ready', 'allocated', 'running', 'draining', 'ended'];
    return [
        '# TYPE netsync_host_state gauge',
        ...states.map((st) => `netsync_host_state{state="${st}"} ${s.state === st ? 1 : 0}`),
        '# TYPE netsync_peers gauge', `netsync_peers ${s.peers.length}`,
        '# TYPE netsync_max_peers gauge', `netsync_max_peers ${s.maxPeers}`,
        '# TYPE netsync_characters gauge', `netsync_characters ${s.characters}`,
        '# TYPE netsync_tick_mean_ms gauge', `netsync_tick_mean_ms ${s.tick.meanMs}`,
        '# TYPE netsync_tick_p95_ms gauge', `netsync_tick_p95_ms ${s.tick.p95Ms}`,
        '# TYPE netsync_ticks_skipped_total counter', `netsync_ticks_skipped_total ${s.tick.skipped}`,
        '# TYPE netsync_peak_bytes_per_tick gauge', `netsync_peak_bytes_per_tick ${s.peakBytesPerTick}`,
        '# TYPE netsync_uptime_seconds counter', `netsync_uptime_seconds ${s.uptimeSeconds}`,
        '',
    ].join('\n');
}

function contentType(file: string): string {
    const ext = file.slice(file.lastIndexOf('.') + 1);
    return ({ html: 'text/html', js: 'text/javascript', json: 'application/json', wasm: 'application/wasm', css: 'text/css' } as Record<string, string>)[ext]
        ?? 'application/octet-stream';
}
