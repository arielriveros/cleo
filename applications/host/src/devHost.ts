// The development host behind the editor's Play › Multiplayer (docs/design/netsync.md §8): `cleo-host --dev`.
// It waits on localhost for the editor to send it the game it just packed, then runs a host for it — the same
// HostApp a deployed host is — on fixed ports with a certificate kept across restarts, so the address players join
// is known before the game is: the editor opens its player windows at once, inside the click.
//
//   GET  /dev/endpoint   the HostEndpoint players join (fixed ports, the cached certificate's hash)
//   POST /dev/play       body: game.bin (Play in window's pack). (Re)starts the host on it; answers its status.
//   GET  /dev/status     the running host's /status, or { state: 'idle' }
//   POST /dev/stop       stops it
//
// Only pages on this machine may call it (an Origin on localhost / 127.0.0.1, or the desktop shell's app://):
// a web page elsewhere must not be able to hand this machine a game to run.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { HostCertificate } from './devCertificate';
import { HostApp, type HostLog } from './hostApp';
import { readSettings } from './settings';

export interface DevHostOptions {
    certificate: HostCertificate;
    /** The dev host's own HTTP port. Default 4490. */
    port?: number;
    udpPort?: number;
    tcpPort?: number;
    log?: HostLog;
}

const LOCAL_ORIGIN = /^(https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|app:\/\/[\w.-]+)$/;

export class DevHost {
    public app: HostApp | null = null;
    private _starting: Promise<unknown> | null = null;

    private constructor(private readonly _server: Server, public readonly port: number, private readonly _o: DevHostOptions) {}

    public get udpPort(): number { return this._o.udpPort ?? 4433; }
    public get tcpPort(): number { return this._o.tcpPort ?? 4480; }

    public static async start(options: DevHostOptions): Promise<DevHost> {
        let self: DevHost | null = null;
        const server = createServer((req, res) => void self?._http(req, res));
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(options.port ?? 4490, '127.0.0.1', () => resolve());
        });
        self = new DevHost(server, (server.address() as AddressInfo).port, options);
        return self;
    }

    /** Where players join, on this machine. */
    public endpoint() {
        return {
            webTransport: { url: `https://localhost:${this.udpPort}/netsync`, certHashes: [this._o.certificate.hash] },
            webSocket: { url: `ws://localhost:${this.tcpPort}/ws` },
        };
    }

    /** Run `bin` (stopping whatever ran before). */
    public async play(bin: Uint8Array): Promise<HostApp> {
        await this.stop();
        const settings = readSettings(['--wt-port', String(this.udpPort), '--ws-port', String(this.tcpPort), '--control-port', 'off'], {});
        const log = this._o.log ?? (() => {});
        const starting = HostApp.start(settings, {
            certificate: this._o.certificate, game: { bin }, log,
            // A dev host's game ends when the editor says so, never on its own.
            exit: () => log('info', 'the game\'s session ended'),
        });
        this._starting = starting;
        try { this.app = await starting; } finally { this._starting = null; }
        log('info', `playing "${this.app.runtime?.sceneName}" for the editor`);
        return this.app;
    }

    public async stop(): Promise<void> {
        await this._starting?.catch(() => {});
        const app = this.app;
        this.app = null;
        if (app) await app.close();
    }

    public async close(): Promise<void> {
        await this.stop();
        this._server.closeAllConnections?.();
        await new Promise<void>((r) => this._server.close(() => r()));
    }

    private async _http(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const origin = req.headers.origin;
        const cors: Record<string, string> = origin && LOCAL_ORIGIN.test(origin)
            ? { 'access-control-allow-origin': origin, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type', vary: 'origin' }
            : {};
        const json = (status: number, body: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...cors });
            res.end(JSON.stringify(body));
        };
        // A page that is not on this machine: nothing.
        if (origin && !LOCAL_ORIGIN.test(origin)) return json(403, { error: 'only pages on this machine may use the dev host' });
        const url = new URL(req.url ?? '/', 'http://x');
        try {
            if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
            if (req.method === 'GET' && url.pathname === '/dev/endpoint') return json(200, this.endpoint());
            if (req.method === 'GET' && url.pathname === '/dev/status') return json(200, this.app ? this.app.status() : { state: 'idle' });
            if (req.method === 'POST' && url.pathname === '/dev/stop') { await this.stop(); return json(200, { state: 'idle' }); }
            if (req.method === 'POST' && url.pathname === '/dev/play') {
                const chunks: Buffer[] = [];
                for await (const c of req) chunks.push(c as Buffer);
                const bin = new Uint8Array(Buffer.concat(chunks));
                if (bin.length < 16) return json(400, { error: 'the body must be a game.bin' });
                const app = await this.play(bin);
                return json(200, { endpoint: this.endpoint(), status: app.status() });
            }
            json(404, { error: 'not found' });
        } catch (e) {
            json(500, { error: (e as Error)?.message ?? String(e) });
        }
    }
}
