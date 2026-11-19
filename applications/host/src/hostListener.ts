// Where links come from on a dedicated host (docs/design/netsync.md §4, §7). Listens for WebTransport on UDP
// and for WebSocket on TCP, wraps each new connection as a NetLink, and hands it to `onLink` — usually
// HostSession.accept. Nothing above this file knows which transport a peer used.
//
//   UDP webTransportPort  HTTP/3 + WebTransport at /netsync (self-signed cert, pinned by hash)
//   TCP webSocketPort     HTTP: /ws (WebSocket), /endpoint (a HostEndpoint for development), /healthz
//
// The WebSocket side is plain `ws://`: in development peers reach it on localhost / LAN, in production through
// the gateway, which terminates TLS on 443 (§7.1).

import { Http3Server } from '@fails-components/webtransport';
import { WebSocketServer } from 'ws';
import { createServer, type Server } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { WebSocketLink, WebTransportLink, type HostEndpoint, type NetLink, type WebSocketLike, type WebTransportLike } from '../../../src/netsync';
import type { HostCertificate } from './devCertificate';

export interface HostListenerOptions {
    certificate: HostCertificate;
    /** UDP port for WebTransport; 0 picks a free one. Default 4433. */
    webTransportPort?: number;
    /** TCP port for WebSocket and the HTTP endpoints; 0 picks a free one. Default 4480. */
    webSocketPort?: number;
    /**
     * Address to bind. Default '::' (IPv6 and IPv4): Chrome resolves `localhost` to ::1 first and does not
     * retry IPv4 for QUIC, so an IPv4-only host fails every WebTransport handshake from a localhost page.
     */
    bindAddress?: string;
    /** Every new link, already wrapped. */
    onLink: (link: NetLink) => void;
    log?: (line: string) => void;
}

export class HostListener {
    private constructor(
        private readonly _h3: Http3Server,
        private readonly _http: Server,
        private readonly _wss: WebSocketServer,
        public readonly webTransportPort: number,
        public readonly webSocketPort: number,
        public readonly certificate: HostCertificate,
    ) {}

    public static async start(options: HostListenerOptions): Promise<HostListener> {
        const log = options.log ?? (() => {});
        const bind = options.bindAddress ?? '::';

        // The library's typings mark `defaultDatagramsReadableMode` as required, but its code treats it as
        // optional; leaving it out keeps datagrams as plain Uint8Array chunks (its 'bytes' mode would not).
        const h3 = new Http3Server({
            port: options.webTransportPort ?? 4433,
            host: bind,
            secret: randomBytes(16).toString('hex'),
            cert: options.certificate.cert,
            privKey: options.certificate.key,
        } as ConstructorParameters<typeof Http3Server>[0]);
        h3.startServer();
        await h3.ready;
        const wtPort = (h3.address() as { port: number } | null)?.port ?? options.webTransportPort ?? 4433;
        (async () => {
            const sessions = (await h3.sessionStream('/netsync')).getReader();
            for (;;) {
                const { value: session, done } = await sessions.read();
                if (done) break;
                (async () => {
                    await session.ready;
                    const link = await WebTransportLink.open(session as unknown as WebTransportLike, 'host');
                    log(`webtransport link (datagrams via ${link.datagramWriter})`);
                    options.onLink(link);
                })().catch((e) => log(`webtransport session failed: ${(e as Error)?.message ?? e}`));
            }
        })().catch((e) => log(`webtransport listener stopped: ${(e as Error)?.message ?? e}`));

        let endpointFor: (hostHeader: string) => HostEndpoint = () => ({});
        const http = createServer((req, res) => {
            const url = new URL(req.url ?? '/', 'http://x');
            const json = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
                res.end(JSON.stringify(body));
            };
            if (url.pathname === '/healthz') return json(200, { ok: true });
            if (url.pathname === '/endpoint') return json(200, endpointFor(req.headers.host ?? 'localhost'));
            res.writeHead(404);
            res.end();
        });
        const wss = new WebSocketServer({ server: http, path: '/ws' });
        wss.on('connection', (ws) => {
            log('websocket link');
            options.onLink(new WebSocketLink(ws as unknown as WebSocketLike));
        });
        await new Promise<void>((resolve, reject) => {
            http.once('error', reject);
            http.listen(options.webSocketPort ?? 4480, bind, () => resolve());
        });
        const wsPort = (http.address() as AddressInfo).port;

        const listener = new HostListener(h3, http, wss, wtPort, wsPort, options.certificate);
        endpointFor = (hostHeader) => listener.endpoint(hostHeader.replace(/:\d+$/, ''));
        return listener;
    }

    /** How a peer reaches this host at `publicHost` (a name or an IP). */
    public endpoint(publicHost: string): HostEndpoint {
        const h = publicHost.includes(':') && !publicHost.startsWith('[') ? `[${publicHost}]` : publicHost;
        return {
            webTransport: { url: `https://${h}:${this.webTransportPort}/netsync`, certHashes: [this.certificate.hash] },
            webSocket: { url: `ws://${h}:${this.webSocketPort}/ws` },
        };
    }

    public async close(): Promise<void> {
        this._h3.stopServer();
        for (const client of this._wss.clients) client.terminate();
        this._wss.close();
        this._http.closeAllConnections?.();
        await new Promise<void>((r) => this._http.close(() => r()));
    }
}
