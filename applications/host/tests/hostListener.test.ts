// End to end over real sockets: a HostSession behind a HostListener, peers joining from Node over
// WebTransport (the host library's client) and over WebSocket (Node's built-in WebSocket).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { FIRST_APP_TYPE, HostSession, PeerSession, type HostEndpoint, type JoinOptions } from '../../../src/netsync';
import { generateCertificate } from '../src/devCertificate';
import { HostListener } from '../src/hostListener';

let host: HostSession;
let listener: HostListener;
let endpoint: HostEndpoint;
const sessions: PeerSession[] = [];

const until = async (what: string, ok: () => boolean, ms = 10_000) => {
    const end = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
};

const join = async (o: Partial<JoinOptions> = {}) => {
    const s = await PeerSession.join({
        endpoint,
        contentHash: 'test-content',
        ...o,
        connectOptions: { WebTransportImpl: WebTransport as any, webTransportTimeoutMs: 2000, ...o.connectOptions },
    });
    sessions.push(s);
    return s;
};

beforeAll(async () => {
    await quicheLoaded;
    host = new HostSession({ contentHash: 'test-content', tickRate: 30 });
    listener = await HostListener.start({
        certificate: await generateCertificate(),
        webTransportPort: 0,
        webSocketPort: 0,
        onLink: (link) => host.accept(link),
    });
    endpoint = listener.endpoint('127.0.0.1');
});

afterAll(async () => {
    for (const s of sessions) s.leave('test over');
    host.close();
    await new Promise((r) => setTimeout(r, 300));
    await listener.close();
});

describe('cleo-host listener', () => {
    it('serves its endpoint over HTTP', async () => {
        const res = await fetch(`http://127.0.0.1:${listener.webSocketPort}/endpoint`);
        const e = await res.json() as HostEndpoint;
        expect(e.webTransport!.url).toBe(`https://127.0.0.1:${listener.webTransportPort}/netsync`);
        expect(e.webTransport!.certHashes).toEqual([listener.certificate.hash]);
        expect(e.webSocket!.url).toBe(`ws://127.0.0.1:${listener.webSocketPort}/ws`);
    });

    it('seats a peer over WebTransport and one over WebSocket', async () => {
        const wt = await join({ name: 'wt' });
        const ws = await join({ name: 'ws', connectOptions: { only: 'websocket' } });
        expect(wt.linkKind).toBe('webtransport');
        expect(wt.fallbackReason).toBeNull();
        expect(ws.linkKind).toBe('websocket');
        expect(host.peers.get(wt.peerId)!.linkKind).toBe('webtransport');
        expect(host.peers.get(ws.peerId)!.linkKind).toBe('websocket');
    });

    it('falls back to WebSocket when WebTransport cannot be reached', async () => {
        const broken: HostEndpoint = { ...endpoint, webTransport: { ...endpoint.webTransport!, url: 'https://127.0.0.1:9/netsync' } };
        const s = await join({ endpoint: broken, connectOptions: { webTransportTimeoutMs: 1000 } });
        expect(s.linkKind).toBe('websocket');
        expect(s.fallbackReason).toMatch(/WebTransport failed/);
    });

    it('agrees with the host on the tick over both links', async () => {
        const wt = await join();
        const ws = await join({ connectOptions: { only: 'websocket' } });
        await until('clock sync', () => wt.clock.synced && ws.clock.synced);
        await new Promise((r) => setTimeout(r, 500));
        for (const s of [wt, ws]) {
            expect(Math.abs(s.hostTimeNow() - host.timeMs())).toBeLessThan(1000 / 30);
            expect(Math.abs(s.hostTick() - host.tick())).toBeLessThanOrEqual(1);
        }
    });

    it('carries app messages on all three lanes, both ways', async () => {
        for (const only of [undefined, 'websocket'] as const) {
            const peer = await join({ connectOptions: { only } });
            const hostPeer = host.peers.get(peer.peerId)!;
            const atHost: string[] = [];
            host.onControl = (p, m) => { if (p === hostPeer) atHost.push(`c${m[0]}`); };
            host.onPulse = (p, m) => { if (p === hostPeer) atHost.push(`p${m[0]}`); };
            host.onBulk = (p, m) => { if (p === hostPeer) atHost.push(`b${m.length}`); };
            const atPeer: string[] = [];
            peer.onControl = (m) => atPeer.push(`c${m[0]}`);
            peer.onBulk = (m) => atPeer.push(`b${m.length}`);
            peer.sendControl(new Uint8Array([FIRST_APP_TYPE]));
            peer.sendPulse(new Uint8Array([FIRST_APP_TYPE + 1]));
            peer.sendBulk(new Uint8Array(300_000).fill(1));
            hostPeer.sendControl(new Uint8Array([FIRST_APP_TYPE + 2]));
            hostPeer.sendBulk(new Uint8Array(250_000).fill(2));
            await until(`messages over ${peer.linkKind}`, () => atHost.length === 3 && atPeer.length === 2);
            expect(atHost.sort()).toEqual([`b300000`, `c${FIRST_APP_TYPE}`, `p${FIRST_APP_TYPE + 1}`]);
            expect(atPeer.sort()).toEqual([`b250000`, `c${FIRST_APP_TYPE + 2}`]);
        }
        host.onControl = host.onPulse = host.onBulk = null;
    });

    it('takes the same seat back after the link drops, on either link', async () => {
        for (const only of [undefined, 'websocket'] as const) {
            const peer = await join({ connectOptions: { only } });
            const id = peer.peerId;
            const kind = peer.linkKind;
            const states: string[] = [];
            peer.on('reconnecting', () => states.push('reconnecting'));
            peer.on('reconnected', () => states.push('reconnected'));
            // Kill the link from the host's side, as a network failure would.
            host.peers.get(id)!.link!.close('simulated drop');
            await until('reconnect', () => states.includes('reconnected'));
            expect(peer.peerId).toBe(id);
            expect(peer.linkKind).toBe(kind);
            expect(host.peers.get(id)!.connected).toBe(true);
        }
    });

    it('frees the seat when a peer leaves', async () => {
        const peer = await join();
        const id = peer.peerId;
        peer.leave();
        await until('leave', () => !host.peers.has(id));
    });
});
