// The peer's way onto the network (docs/design/netsync.md §4.6): WebTransport first, the WebSocket fallback
// when WebTransport is missing, fails, or does not come up in time (a network that drops UDP fails only by
// timing out). The caller gets a NetLink and never needs to know which one it got.

import { base64ToBytes } from '../../core/base64';
import type { NetLink } from './netLink';
import { WebTransportLink, type WebTransportLike } from './webTransportLink';
import { WebSocketLink, openWebSocket, type WebSocketLike } from './webSocketLink';

/** Where a host can be reached. The allocator (or the editor) hands this to a peer. */
export interface HostEndpoint {
    webTransport?: {
        /** `https://host:port/path` */
        url: string;
        /**
         * Base64 SHA-256 hashes of the host's self-signed certificate (`serverCertificateHashes`). Omit when
         * the host has a certificate from a public CA.
         */
        certHashes?: string[];
    };
    webSocket?: {
        /** `wss://…` (or `ws://` on localhost / LAN in development) */
        url: string;
    };
}

export interface ConnectOptions {
    /** Skip WebTransport ('websocket'), or never fall back ('webtransport'). Default: try both, in that order. */
    only?: 'webtransport' | 'websocket';
    /** How long WebTransport gets before the WebSocket is tried. Default 2500 ms. */
    webTransportTimeoutMs?: number;
    webSocketTimeoutMs?: number;
    /** Constructors to use instead of the platform's (the Node host library's client in tests). */
    WebTransportImpl?: new (url: string, options?: any) => WebTransportLike;
    WebSocketImpl?: new (url: string) => WebSocketLike;
}

export interface Connection {
    link: NetLink;
    /** Why WebTransport was not used, or null when it was. */
    fallbackReason: string | null;
}

export async function connect(endpoint: HostEndpoint, options: ConnectOptions = {}): Promise<Connection> {
    let fallbackReason: string | null = null;
    if (options.only === 'websocket') {
        fallbackReason = 'WebSocket requested';
    } else if (!endpoint.webTransport) {
        fallbackReason = 'host offers no WebTransport';
    } else {
        const WT = options.WebTransportImpl ?? (globalThis as any).WebTransport;
        if (!WT) {
            fallbackReason = 'no WebTransport on this platform';
        } else {
            try {
                return { link: await connectWebTransport(WT, endpoint.webTransport, options.webTransportTimeoutMs ?? 2500), fallbackReason: null };
            } catch (e) {
                fallbackReason = `WebTransport failed: ${(e as any)?.message || e}`;
            }
        }
        if (options.only === 'webtransport') throw new Error(fallbackReason);
    }
    if (!endpoint.webSocket) throw new Error(`cannot reach host: ${fallbackReason}, and it offers no WebSocket`);
    const ws = await openWebSocket(endpoint.webSocket.url, options.webSocketTimeoutMs ?? 5000, options.WebSocketImpl);
    return { link: new WebSocketLink(ws), fallbackReason };
}

async function connectWebTransport(
    WT: new (url: string, options?: any) => WebTransportLike,
    target: NonNullable<HostEndpoint['webTransport']>,
    timeoutMs: number,
): Promise<NetLink> {
    const init = target.certHashes?.length
        ? { serverCertificateHashes: target.certHashes.map((h) => ({ algorithm: 'sha-256', value: base64ToBytes(h) })) }
        : undefined;
    const wt = new WT(target.url, init);
    wt.closed.catch(() => { /* reported through `ready` or the link */ });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([
            wt.ready,
            new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`not ready after ${timeoutMs} ms`)), timeoutMs); }),
        ]);
        return await WebTransportLink.open(wt, 'peer');
    } catch (e) {
        try { wt.close(); } catch { /* already failed */ }
        throw e;
    } finally {
        clearTimeout(timer);
    }
}
