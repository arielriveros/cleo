// The dev host behind Play › Multiplayer (devHost.ts): the editor sends it a packed game, it runs a host for it on
// ports and a certificate known in advance, and only pages on this machine may drive it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { PeerSession } from '../../../src/netsync';
import { generateCertificate } from '../src/devCertificate';
import { DevHost } from '../src/devHost';
import { packExampleGame } from '../src/exampleGame';

async function freePort(): Promise<number> {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
}

let dev: DevHost;
let base: string;
beforeAll(async () => {
    dev = await DevHost.start({ certificate: await generateCertificate(), port: 0, udpPort: await freePort(), tcpPort: await freePort() });
    base = `http://127.0.0.1:${dev.port}`;
});
afterAll(async () => { await dev.close(); });

describe('the dev host', () => {
    it('tells the address players will join before there is a game', async () => {
        const e = await (await fetch(`${base}/dev/endpoint`, { headers: { origin: 'http://localhost:8080' } })).json();
        expect(e.webTransport.url).toBe(`https://localhost:${dev.udpPort}/netsync`);
        expect(e.webSocket.url).toBe(`ws://localhost:${dev.tcpPort}/ws`);
        expect(await (await fetch(`${base}/dev/status`)).json()).toEqual({ state: 'idle' });
    });

    it('runs the game the editor sends, and runs the next one in its place', async () => {
        const bin = await packExampleGame(path.resolve(__dirname, '../../editor/public/examples/sandbox'));
        const res = await fetch(`${base}/dev/play`, { method: 'POST', body: Buffer.from(bin), headers: { origin: 'app://cleo-editor' } });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('app://cleo-editor');
        const { status } = await res.json();
        expect(status.scene).toBe('Sandbox');
        expect(status.state).toBe('allocated');

        const peer = await PeerSession.join({ endpoint: dev.endpoint(), contentHash: status.contentHash, connectOptions: { only: 'websocket' }, reconnect: false });
        expect(peer.peerId).toBe(1);
        // Restart: the player is let go, and the new game is up on the same address.
        const again = await (await fetch(`${base}/dev/play`, { method: 'POST', body: Buffer.from(bin) })).json();
        expect(again.status.peers).toEqual([]);
        await new Promise((r) => setTimeout(r, 200));
        expect(peer.state).not.toBe('connected');
        await fetch(`${base}/dev/stop`, { method: 'POST' });
        expect(await (await fetch(`${base}/dev/status`)).json()).toEqual({ state: 'idle' });
    }, 60_000);

    it('refuses pages that are not on this machine', async () => {
        const res = await fetch(`${base}/dev/play`, { method: 'POST', body: new Uint8Array(100), headers: { origin: 'https://example.com' } });
        expect(res.status).toBe(403);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
});
