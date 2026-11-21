// The dev host behind Play › Multiplayer (devHost.ts): the editor sends it a packed game, it runs a host for it on
// ports and a certificate known in advance, and only pages on this machine may drive it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { PeerSession } from '@engine/netsync';
import { generateCertificate } from '@host/devCertificate';
import { DevHost } from '@host/devHost';
import { packExampleGame } from '@host/exampleGame';
import { EXAMPLE } from '@tools/exampleKit/testKit';

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
    it('runs the game the editor sends, and runs the next one in its place', async () => {
        const bin = await packExampleGame(EXAMPLE);
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
});
