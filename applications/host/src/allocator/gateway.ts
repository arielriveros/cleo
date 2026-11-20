// The gateway (docs/design/netsync.md §7.1): the WebSocket fallback's one entry point. Players on networks that block
// UDP (and unusual TCP ports) reach every host through it, on TCP 443 with a real certificate:
//
//   wss://play.example.com/s/<session>   →   the session's host, ws://<its address>:<its TCP port>/ws
//
// It forwards the upgrade request and then pipes the two sockets: it never reads the WebSocket frames, so it costs
// next to nothing per player. TLS is its own (a certificate for the domain), or a proxy in front of it terminates TLS
// and it listens on plain HTTP. WebTransport never goes through it: players reach hosts directly over UDP.

import { createServer as createHttpServer, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface GatewayRoute { host: string; port: number }

export interface GatewayOptions {
    port: number;
    bindAddress?: string;
    /** TLS for the gateway itself (PEM). Without: plain HTTP (a TLS proxy in front, or development). */
    tls?: { cert: string; key: string };
    /** Where a session's host is; null for a session this gateway does not know. */
    resolve: (sessionId: string) => GatewayRoute | null | Promise<GatewayRoute | null>;
    /** Other HTTP requests (the allocator shares this port when they run as one service). */
    onRequest?: (req: IncomingMessage, res: import('node:http').ServerResponse) => void;
    log?: (line: string) => void;
}

const SESSION_PATH = /^\/s\/([\w.-]{1,128})\/?$/;

export class Gateway {
    /** Players currently piped through. */
    public open = 0;
    public forwarded = 0;

    private constructor(private readonly _server: Server, public readonly port: number) {}

    public static async start(options: GatewayOptions): Promise<Gateway> {
        const handler = (req: IncomingMessage, res: import('node:http').ServerResponse) => {
            if (options.onRequest) return options.onRequest(req, res);
            res.writeHead(404); res.end();
        };
        const server: Server = options.tls ? createHttpsServer({ cert: options.tls.cert, key: options.tls.key }, handler) : createHttpServer(handler);
        let gateway: Gateway | null = null;
        server.on('upgrade', (req: IncomingMessage, client: Socket, head: Buffer) => {
            void (async () => {
                const m = SESSION_PATH.exec(new URL(req.url ?? '/', 'http://x').pathname);
                const route = m ? await options.resolve(m[1]) : null;
                if (!route) { client.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n'); return; }
                const upstream = connect(route.port, route.host);
                upstream.on('connect', () => {
                    // The same upgrade request, to the host's own WebSocket path.
                    const lines = [`GET /ws HTTP/1.1`];
                    for (let i = 0; i < req.rawHeaders.length; i += 2) {
                        const name = req.rawHeaders[i];
                        lines.push(`${name}: ${name.toLowerCase() === 'host' ? `${route.host}:${route.port}` : req.rawHeaders[i + 1]}`);
                    }
                    upstream.write(lines.join('\r\n') + '\r\n\r\n');
                    if (head.length) upstream.write(head);
                    upstream.pipe(client);
                    client.pipe(upstream);
                    if (gateway) { gateway.open++; gateway.forwarded++; }
                    options.log?.(`gateway: session ${m![1]} → ${route.host}:${route.port}`);
                });
                let closed = false;
                const close = () => {
                    if (closed) return;
                    closed = true;
                    if (gateway && upstream.readyState !== 'opening') gateway.open = Math.max(0, gateway.open - 1);
                    client.destroy(); upstream.destroy();
                };
                upstream.on('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); close(); });
                upstream.on('close', close);
                client.on('error', close);
                client.on('close', close);
            })().catch(() => client.destroy());
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(options.port, options.bindAddress ?? '::', () => resolve());
        });
        gateway = new Gateway(server, (server.address() as AddressInfo).port);
        return gateway;
    }

    public async close(): Promise<void> {
        this._server.closeAllConnections?.();
        await new Promise<void>((r) => this._server.close(() => r()));
    }
}
