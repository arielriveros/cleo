// The host contract (docs/design/netsync.md §7.2) on the Sandbox, over real sockets: a warm host allocated over its
// control port, joined, emptied and ended (or reused); draining; and the Agones lifecycle against a stand-in for its
// SDK sidecar. (Settings and join tokens: applications/host/tests/hostApp.test.ts.)
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PeerSession } from '@engine/netsync';
import { generateCertificate, type HostCertificate } from '@host/devCertificate';
import { HostApp } from '@host/hostApp';
import { JoinTokenVerifier, generateTokenKeys, signJoinToken } from '@host/joinToken';
import { AgonesLifecycle, sessionFromGameServer } from '@host/lifecycle';
import { readSettings, withGameDefaults, type HostSettings } from '@host/settings';
import { EXAMPLE } from '@tools/exampleKit/testKit';

const SANDBOX = EXAMPLE;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
let certificate: HostCertificate;
const apps: HostApp[] = [];
const servers: Server[] = [];
beforeAll(async () => { certificate = await generateCertificate(); });
afterEach(async () => {
    for (const a of apps.splice(0)) await a.close();
    for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
});

/** A host on free ports, quiet, its exits recorded. */
async function host(argv: string[], env: Record<string, string> = {}, extra: Partial<Parameters<typeof HostApp.start>[1]> = {}) {
    const settings: HostSettings = readSettings(['--wt-port', '0', '--ws-port', '0', '--control-port', '0', ...argv], env);
    const exits: number[] = [];
    const lines: string[] = [];
    const app = await HostApp.start(settings, { certificate, exit: (c) => exits.push(c), log: (_l, m) => lines.push(m), ...extra });
    apps.push(app);
    const control = `http://localhost:${app.controlPort}`;
    return { app, exits, lines, control };
}

const join = (app: HostApp, token?: string) => PeerSession.join({
    endpoint: app.listener.endpoint('localhost'), contentHash: app.status().contentHash, token, name: 'tester',
    connectOptions: { only: 'websocket' }, reconnect: false,
});

describe('a warm host', () => {
    it('waits for an allocation, takes players with a token, and ends when they have left', async () => {
        const keys = generateTokenKeys();
        const { app, exits, control } = await host(['--example', SANDBOX, '--await-allocation', '--empty-seconds', '1', '--player-template', 'Player'], { NETSYNC_TOKEN_KEY: keys.publicKey });
        expect(app.state).toBe('ready');
        expect((await fetch(`${control}/healthz`)).status).toBe(200);
        expect(await (await fetch(`${control}/readyz`)).json()).toEqual({ ready: true, state: 'ready' });
        expect((await (await fetch(`${control}/cert-hash`)).json()).hash).toBe(certificate.hash);

        // No session yet: nobody gets in.
        await expect(join(app, signJoinToken({ sid: 'm1', exp: Date.now() / 1000 + 60 }, keys.privateKey))).rejects.toThrow(/no session/);

        const res = await fetch(`${control}/allocate`, { method: 'POST', body: JSON.stringify({ id: 'm1', mode: 'coop' }) });
        expect(res.status).toBe(200);
        const allocation = await res.json();
        expect(allocation.session).toEqual({ id: 'm1', mode: 'coop' });
        expect(allocation.endpoint.webTransport.certHashes).toEqual([certificate.hash]);
        expect(app.state).toBe('allocated');
        expect((await fetch(`${control}/allocate`, { method: 'POST', body: '{"id":"m2"}' })).status).toBe(409);

        // A token for this session lets a player in; none, or one for another session, does not.
        await expect(join(app)).rejects.toThrow(/token is required/);
        await expect(join(app, signJoinToken({ sid: 'm2', exp: Date.now() / 1000 + 60 }, keys.privateKey))).rejects.toThrow(/another session/);
        const peer = await join(app, signJoinToken({ sid: 'm1', exp: Date.now() / 1000 + 60, name: 'A' }, keys.privateKey));
        await wait(1200);
        const status = await (await fetch(`${control}/status`)).json();
        expect(status.state).toBe('running');
        expect(status.peers).toHaveLength(1);
        expect(status.session.id).toBe('m1');
        expect(status.tick.ticks).toBeGreaterThan(10);
        const prom = await (await fetch(`${control}/status?format=prometheus`)).text();
        expect(prom).toContain('netsync_peers 1');
        expect(prom).toContain('netsync_host_state{state="running"} 1');

        // Everyone leaves: after --empty-seconds the session ends, and the host (not --reuse) exits.
        peer.leave();
        await wait(3500);
        expect(app.state).toBe('ended');
        expect(app.endReason).toBe('everyone left');
        expect(exits).toEqual([0]);
    }, 60_000);

    it('with --reuse, resets its scene and is ready for the next session; a session nobody joins ends', async () => {
        const { app, exits, control } = await host(['--example', SANDBOX, '--await-allocation', '--reuse', '--join-seconds', '1']);
        expect((await fetch(`${control}/allocate`, { method: 'POST', body: '{"id":"lonely"}' })).status).toBe(200);
        await wait(3500);
        expect(app.endReason).toBe('nobody joined');
        expect(exits).toEqual([]);
        expect(app.state).toBe('ready');
        expect((await fetch(`${control}/allocate`, { method: 'POST', body: '{"id":"next"}' })).status).toBe(200);
        expect(app.sessionSpec?.id).toBe('next');
    }, 60_000);

    it('drains: no new players, and exits once the last one has left', async () => {
        const { app, exits } = await host(['--example', SANDBOX, '--session', '{"id":"d1"}']);
        expect(app.state).toBe('allocated');
        const a = await join(app);
        await wait(300);
        app.drain('test');
        expect(app.state).toBe('draining');
        expect((await fetch(`http://localhost:${app.controlPort}/readyz`)).status).toBe(503);
        await expect(join(app)).rejects.toThrow(/shutting down/);
        expect(exits).toEqual([]);
        a.leave();
        await wait(1500);
        expect(exits).toEqual([0]);
        expect(app.endReason).toBe('drained');
    }, 60_000);

    it('without a session or --await-allocation opens one at once and keeps it open', async () => {
        const { app, exits } = await host(['--empty-seconds', '0', '--join-seconds', '0']);
        expect(app.state).toBe('allocated');
        const a = await join(app);
        await wait(1200);
        expect(app.state).toBe('running');
        a.leave();
        await wait(2500);
        expect(app.state).toBe('allocated');
        expect(exits).toEqual([]);
    }, 30_000);
});

describe('the Agones lifecycle', () => {
    it('reports Ready and Health, takes its session from an allocation, and shuts down when it ends', async () => {
        // A stand-in for the Agones SDK sidecar: records POSTs; /watch/gameserver streams the GameServer's states.
        const posts: string[] = [];
        const annotations: string[] = [];
        let push: ((gs: unknown) => void) | null = null;
        const sidecar = createServer((req, res) => {
            if (req.method === 'POST') { posts.push(req.url!); res.end('{}'); return; }
            if (req.method === 'PUT') {
                let body = '';
                req.on('data', (c) => { body += c; });
                req.on('end', () => { annotations.push(`${req.url} ${body}`); res.end('{}'); });
                return;
            }
            if (req.url === '/watch/gameserver') {
                res.writeHead(200, { 'content-type': 'application/json' });
                push = (gs) => res.write(JSON.stringify({ result: gs }) + '\n');
                push({ object_meta: { name: 'gs-1' }, status: { state: 'Ready' } });
                return;
            }
            res.writeHead(404); res.end();
        });
        servers.push(sidecar);
        await new Promise<void>((r) => sidecar.listen(0, '127.0.0.1', () => r()));
        const lifecycle = new AgonesLifecycle({ baseUrl: `http://127.0.0.1:${(sidecar.address() as AddressInfo).port}`, healthMs: 200 });

        const { app, exits } = await host(['--example', SANDBOX, '--lifecycle', 'agones', '--join-seconds', '1'], {}, { lifecycle });
        expect(app.state).toBe('ready');
        await wait(700);
        expect(posts).toContain('/ready');
        // The certificate hash, where the Agones fleet adapter reads it from the allocation.
        expect(annotations).toEqual([`/metadata/annotation ${JSON.stringify({ key: 'netsync-cert-hash', value: certificate.hash })}`]);
        expect(posts.filter((p) => p === '/health').length).toBeGreaterThanOrEqual(2);

        // The fleet allocates this GameServer, naming the session in its annotations.
        push!({ object_meta: { name: 'gs-1', annotations: { 'netsync.session': '{"id":"agones-match","mode":"versus"}' } }, status: { state: 'Allocated' } });
        await wait(300);
        expect(app.state).toBe('allocated');
        expect(app.sessionSpec).toEqual({ id: 'agones-match', mode: 'versus' });

        // Nobody comes: the session ends, Agones is told to shut the GameServer down, and the host exits.
        await wait(2500);
        expect(app.endReason).toBe('nobody joined');
        expect(posts).toContain('/shutdown');
        expect(exits).toEqual([0]);
    }, 60_000);

    it('reads a session from labels or the GameServer’s name when no JSON is given', () => {
        expect(sessionFromGameServer({ object_meta: { name: 'gs-9', labels: { 'netsync.scene': 'Arena', 'netsync.mode': 'dm' } } }))
            .toEqual({ id: 'gs-9', scene: 'Arena', mode: 'dm' });
        expect(sessionFromGameServer({ objectMeta: { name: 'gs-2', annotations: { 'netsync.session-id': 'abc' } } })).toEqual({ id: 'abc' });
    });
});
