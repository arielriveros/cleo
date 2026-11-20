// The allocator and gateway (docs/design/netsync.md §7.1, §7.2): join tickets from a static fleet of real warm hosts,
// players connecting with them over WebTransport directly and over WebSocket through the gateway, sessions filled
// before new ones are made, and forgotten when over. The other fleet adapters against stand-ins for their
// platforms' APIs (Docker Engine, Kubernetes + Agones, Edgegap).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { WebTransport, quicheLoaded } from '@fails-components/webtransport';
import { PeerSession } from '../../../src/netsync';
import { certificateFromPem, generateCertificate, type HostCertificate } from '../src/devCertificate';
import { HostApp } from '../src/hostApp';
import { generateTokenKeys, signJoinToken } from '../src/joinToken';
import { readSettings } from '../src/settings';
import { Allocator, type JoinTicket } from '../src/allocator/allocator';
import { AgonesFleet, DockerFleet, EdgegapFleet, StaticFleet, certHashIn } from '../src/allocator/fleet';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); }, 30_000);
let certificate: HostCertificate;
beforeAll(async () => { await quicheLoaded; certificate = await generateCertificate(); });

async function freePort(): Promise<number> {
    const s = createNetServer();
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
    const port = (s.address() as AddressInfo).port;
    await new Promise((r) => s.close(r));
    return port;
}

/** A warm session-only host (no game: fast), on free ports, as a static fleet would run it. */
async function warmHost(tokenKey: string) {
    const settings = readSettings(['--wt-port', '0', '--ws-port', '0', '--control-port', '0', '--await-allocation', '--reuse', '--empty-seconds', '1'], { NETSYNC_TOKEN_KEY: tokenKey });
    const app = await HostApp.start(settings, { certificate, exit: () => {}, log: () => {} });
    closers.push(() => app.close());
    return app;
}

async function serve(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<{ url: string; server: Server }> {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    closers.push(() => new Promise((r) => server.close(r)));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const playWith = (ticket: JoinTicket, only: 'webtransport' | 'websocket') => PeerSession.join({
    endpoint: ticket.endpoint, token: ticket.token, contentHash: 'dev', name: ticket.name,
    connectOptions: { only, WebTransportImpl: WebTransport as any }, reconnect: false,
});

describe('the allocator with a static fleet', () => {
    it('fills a session, then starts another, and players reach theirs directly or through the gateway', async () => {
        const keys = generateTokenKeys();
        const [a, b] = [await warmHost(keys.publicKey), await warmHost(keys.publicKey)];
        const port = await freePort();
        const allocator = await Allocator.start({
            fleet: new StaticFleet([a, b].map((h, i) => ({ name: `host-${i}`, control: `http://localhost:${h.controlPort}`, publicAddress: 'localhost' }))),
            privateKey: keys.privateKey, port, gatewayUrl: `ws://localhost:${port}`, modes: { coop: { maxPeers: 2 } },
        });
        closers.push(() => allocator.close());
        const join = async (body: object) => {
            const res = await fetch(`http://localhost:${port}/join`, { method: 'POST', body: JSON.stringify(body) });
            return { status: res.status, ticket: await res.json() as JoinTicket & { error?: string } };
        };

        const t1 = (await join({ mode: 'coop', name: 'A' })).ticket;
        const t2 = (await join({ mode: 'coop', name: 'B' })).ticket;
        expect(t2.session.id).toBe(t1.session.id); // a seat left: the same session
        expect(t1.endpoint.webSocket!.url).toBe(`ws://localhost:${port}/s/${t1.session.id}`);
        expect(t1.endpoint.webTransport!.certHashes).toEqual([certificate.hash]);
        expect([a.state, b.state].sort()).toEqual(['allocated', 'ready']);

        // A over WebTransport, straight to its host; B over WebSocket, through the gateway.
        const pa = await playWith(t1, 'webtransport');
        // A token is for its session alone (signed by the same allocator, for another session: refused).
        const elsewhere = signJoinToken({ sid: 'some-other-session', exp: Date.now() / 1000 + 60 }, keys.privateKey);
        await expect(PeerSession.join({ endpoint: t1.endpoint, token: elsewhere, contentHash: 'dev', connectOptions: { only: 'websocket' }, reconnect: false }))
            .rejects.toThrow(/another session/);
        const pb = await playWith(t2, 'websocket');
        expect(pa.linkKind).toBe('webtransport');
        expect(pb.linkKind).toBe('websocket');
        expect(allocator.gateway.open).toBe(1);
        const hostOfA = a.state === 'allocated' || a.state === 'running' ? a : b;
        await wait(1200);
        expect(hostOfA.session.peers.size).toBe(2);
        expect(hostOfA.sessionSpec?.id).toBe(t1.session.id);

        // Full: the third coop player gets a new session, on the other host; a fourth finds no host.
        const t3 = (await join({ mode: 'coop', name: 'C' })).ticket;
        expect(t3.session.id).not.toBe(t1.session.id);
        expect(a.state).not.toBe('ready');
        expect(b.state).not.toBe('ready');
        await join({ mode: 'coop' }); // fills t3's session
        const none = await join({ mode: 'coop' });
        expect(none.status).toBe(503);
        expect(none.ticket.error).toMatch(/no free host/);

        // Everyone leaves A's session: its host ends it and (reused) is ready again; the allocator forgets it.
        pa.leave(); pb.leave();
        await wait(3500);
        expect(hostOfA.state).toBe('ready');
        await (allocator as any)._prune();
        expect(allocator.sessions.has(t1.session.id)).toBe(false);
        const listed = await (await fetch(`http://localhost:${port}/sessions`)).json();
        expect(listed.map((s: any) => s.id)).toEqual([t3.session.id]);
    }, 60_000);

    it('lets the developer’s hook refuse a join or change it', async () => {
        const keys = generateTokenKeys();
        const h = await warmHost(keys.publicKey);
        const allocator = await Allocator.start({
            fleet: new StaticFleet([{ name: 'h', control: `http://localhost:${h.controlPort}`, publicAddress: 'localhost' }]),
            privateKey: keys.privateKey, port: 0,
            onRequest: (join) => (join.name === 'banned' ? 'not you' : { ...join, mode: 'forced' }),
        });
        closers.push(() => allocator.close());
        const refused = await fetch(`http://localhost:${allocator.port}/join`, { method: 'POST', body: '{"name":"banned"}' });
        expect(refused.status).toBe(403);
        const ok = await (await fetch(`http://localhost:${allocator.port}/join`, { method: 'POST', body: '{"name":"fine"}' })).json();
        expect(ok.session.mode).toBe('forced');
        expect(h.sessionSpec?.mode).toBe('forced');
        // Without a gateway, the ticket names the host's WebSocket port directly.
        expect(ok.endpoint.webSocket.url).toBe(`ws://localhost:${h.listener.webSocketPort}/ws`);
    }, 30_000);
});

describe('the docker fleet', () => {
    it('starts a container with the session, the token key and a certificate it made, and reads its ports', async () => {
        const calls: { method: string; url: string; body: any }[] = [];
        const control = await serve((_req, res) => { res.end(JSON.stringify({ state: 'allocated', peers: [] })); });
        const controlPort = Number(new URL(control.url).port);
        const docker = await serve((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                calls.push({ method: req.method!, url: req.url!, body: body ? JSON.parse(body) : null });
                if (req.url!.startsWith('/containers/create')) { res.writeHead(201); res.end('{"Id":"c0ffee"}'); return; }
                if (req.url === '/containers/c0ffee/start') { res.writeHead(204); res.end(); return; }
                if (req.url === '/containers/c0ffee/json') {
                    res.end(JSON.stringify({ NetworkSettings: { Ports: {
                        '4433/udp': [{ HostPort: '31001' }], '4480/tcp': [{ HostPort: '31002' }], '4490/tcp': [{ HostPort: String(controlPort) }],
                    } } }));
                    return;
                }
                res.writeHead(204); res.end();
            });
        });
        const fleet = new DockerFleet({ docker: docker.url, image: 'mygame-host:1', publicAddress: '127.0.0.1', tokenKey: 'PUBLIC-KEY' });
        const host = await fleet.acquire({ sessionId: 's-1', mode: 'deathmatch', maxPeers: 16 });
        expect(host).toMatchObject({ id: 'c0ffee', publicAddress: '127.0.0.1', udpPort: 31001, tcpPort: 31002 });
        const create = calls.find((c) => c.url.startsWith('/containers/create'))!;
        expect(create.url).toContain('name=cleo-s-1');
        expect(create.body.Image).toBe('mygame-host:1');
        expect(create.body.HostConfig.AutoRemove).toBe(true);
        const env = Object.fromEntries(create.body.Env.map((e: string) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
        expect(JSON.parse(env.NETSYNC_SESSION)).toEqual({ id: 's-1', mode: 'deathmatch', maxPeers: 16 });
        expect(env.NETSYNC_TOKEN_KEY).toBe('PUBLIC-KEY');
        // The certificate it handed the host is the one whose hash players will pin.
        expect(certificateFromPem(env.NETSYNC_CERT, env.NETSYNC_CERT_KEY).hash).toBe(host.certHash);
        await fleet.release(host);
        expect(calls.at(-1)!.url).toBe('/containers/c0ffee/stop?t=10');
    }, 30_000);
});

describe('the agones fleet', () => {
    it('allocates from the fleet with the session as an annotation, and reads the host’s certificate hash', async () => {
        let posted: any = null;
        let withMetadata = true;
        const api = await serve((req, res) => {
            let body = '';
            req.on('data', (c) => { body += c; });
            req.on('end', () => {
                if (req.method === 'POST' && req.url === '/apis/allocation.agones.dev/v1/namespaces/games/gameserverallocations') {
                    posted = JSON.parse(body);
                    res.end(JSON.stringify({ status: {
                        state: 'Allocated', gameServerName: 'mygame-abc', address: '198.51.100.7',
                        ports: [{ name: 'webtransport', port: 7001 }, { name: 'websocket', port: 7002 }],
                        ...(withMetadata ? { metadata: { annotations: { 'agones.dev/sdk-netsync-cert-hash': 'HASH=' } } } : {}),
                    } }));
                    return;
                }
                if (req.url === '/apis/agones.dev/v1/namespaces/games/gameservers/mygame-abc') {
                    res.end(JSON.stringify({ metadata: { annotations: { 'agones.dev/sdk-netsync-cert-hash': 'FROM-GS=' } } }));
                    return;
                }
                res.writeHead(404); res.end();
            });
        });
        const fleet = new AgonesFleet({ fleet: 'mygame', namespace: 'games', apiServer: api.url, token: 't' });
        const host = await fleet.acquire({ sessionId: 's-9', mode: 'coop', maxPeers: 8 });
        expect(host).toMatchObject({ id: 'mygame-abc', publicAddress: '198.51.100.7', udpPort: 7001, tcpPort: 7002, certHash: 'HASH=' });
        expect(posted.spec.selectors).toEqual([{ matchLabels: { 'agones.dev/fleet': 'mygame' } }]);
        expect(JSON.parse(posted.spec.metadata.annotations['netsync.session'])).toEqual({ id: 's-9', mode: 'coop', maxPeers: 8 });
        // An Agones whose allocations carry no metadata: the GameServer is read.
        withMetadata = false;
        expect((await fleet.acquire({ sessionId: 's-10', maxPeers: 8 })).certHash).toBe('FROM-GS=');
        expect(certHashIn({ 'stable.agones.dev/sdk-netsync-cert-hash': 'old' })).toBe('old');
    }, 30_000);
});

describe('the edgegap fleet', () => {
    it('deploys near the player with the session and certificate, and waits until it runs', async () => {
        const requests: { method: string; url: string; body: any; auth: string | null }[] = [];
        let polls = 0;
        const fake = (async (url: string, init: RequestInit) => {
            const headers = new Headers(init.headers);
            requests.push({ method: init.method!, url, body: init.body ? JSON.parse(String(init.body)) : null, auth: headers.get('authorization') });
            const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
            if (url.endsWith('/v2/deployments')) return reply(202, { request_id: 'eg-42' });
            if (url.endsWith('/v1/status/eg-42')) {
                return ++polls < 2 ? reply(200, { running: false, current_status: 'Deploying' })
                    : reply(200, { running: true, public_ip: '192.0.2.10', location: { city: 'Frankfurt' },
                        ports: { webtransport: { external: 30443, internal: 4433, protocol: 'UDP' }, websocket: { external: 30480, internal: 4480, protocol: 'TCP' } } });
            }
            return reply(200, {});
        }) as unknown as typeof fetch;
        const fleet = new EdgegapFleet({ apiToken: 'token abc', application: 'mygame', version: '1.2', tokenKey: 'PUB' }, fake);
        const host = await fleet.acquire({ sessionId: 's-7', mode: 'coop', maxPeers: 8, playerIp: '203.0.113.9' });
        expect(host).toMatchObject({ id: 'eg-42', publicAddress: '192.0.2.10', udpPort: 30443, tcpPort: 30480, region: 'Frankfurt' });
        const deploy = requests[0];
        expect(deploy.auth).toBe('token abc');
        expect(deploy.body).toMatchObject({ application: 'mygame', version: '1.2', users: [{ user_type: 'ip_address', user_data: { ip_address: '203.0.113.9' } }], tags: ['s-7'] });
        const env = Object.fromEntries(deploy.body.environment_variables.map((v: any) => [v.key, v]));
        expect(env.NETSYNC_LIFECYCLE.value).toBe('edgegap');
        expect(env.NETSYNC_CERT_KEY.is_hidden).toBe(true);
        expect(certificateFromPem(env.NETSYNC_CERT.value, env.NETSYNC_CERT_KEY.value).hash).toBe(host.certHash);
        await fleet.release(host);
        expect(requests.at(-1)).toMatchObject({ method: 'DELETE', url: 'https://api.edgegap.com/v1/stop/eg-42' });
    }, 30_000);
});
