// The dev host behind Play › Multiplayer (devHost.ts): the editor sends it a packed game, it runs a host for it on
// ports and a certificate known in advance, and only pages on this machine may drive it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { PeerSession } from '../../../src/netsync';
import { generateCertificate } from '../src/devCertificate';
import { DevHost } from '../src/devHost';

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

    it('refuses pages that are not on this machine', async () => {
        const res = await fetch(`${base}/dev/play`, { method: 'POST', body: new Uint8Array(100), headers: { origin: 'https://example.com' } });
        expect(res.status).toBe(403);
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });
});
