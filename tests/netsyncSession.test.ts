import { describe, expect, it } from 'vitest';
import { ManualScheduler } from '../src/netsync/time';
import { createLoopbackPair } from '../src/netsync/link/loopbackLink';
import { ConditionedLink, type LinkConditions } from '../src/netsync/link/conditionedLink';
import type { NetLink } from '../src/netsync/link/netLink';
import { HostSession, type HostSessionOptions } from '../src/netsync/session/hostSession';
import { JoinRefusedError, PeerSession, type JoinOptions } from '../src/netsync/session/peerSession';
import { FIRST_APP_TYPE, hashContent } from '../src/netsync/session/messages';

const CONTENT = 'content-v1';

/** A host plus a connector that joins peers to it over loopback links, optionally conditioned. */
function setup(hostOptions: Partial<HostSessionOptions> = {}, conditions?: LinkConditions) {
    const s = new ManualScheduler(1000);
    const host = new HostSession({ contentHash: CONTENT, scheduler: s, ...hostOptions });
    const links: NetLink[] = []; // every peer-side link handed out, latest last
    let refuseConnections = false;
    const connector = async () => {
        if (refuseConnections) throw new Error('host unreachable');
        const [peerEnd, hostEnd] = createLoopbackPair(s);
        const link = conditions ? new ConditionedLink(peerEnd, conditions, s) : peerEnd;
        host.accept(hostEnd);
        links.push(link);
        return { link, fallbackReason: null };
    };
    const join = (o: Partial<JoinOptions> = {}) => PeerSession.join({ endpoint: {}, contentHash: CONTENT, connector, scheduler: s, ...o });
    /** Join and run the clock until the handshake completes. */
    const joined = async (o: Partial<JoinOptions> = {}) => {
        const p = join(o);
        await s.advance(conditions ? 4 * ((conditions.latencyMs ?? 0) + (conditions.jitterMs ?? 0)) + 10 : 10);
        return p;
    };
    return { s, host, join, joined, links, unreachable: (v: boolean) => { refuseConnections = v; } };
}

function events(host: HostSession) {
    const log: string[] = [];
    host.on('join', (p) => log.push(`join ${p.id}`));
    host.on('drop', (e) => log.push(`drop ${e.peer.id}`));
    host.on('resume', (p) => log.push(`resume ${p.id}`));
    host.on('leave', (e) => log.push(`leave ${e.peer.id}: ${e.reason}`));
    return log;
}

describe('NetSync session: handshake', () => {
    it('seats peers with the lowest free ids', async () => {
        const { host, joined } = setup();
        const log = events(host);
        const a = await joined({ name: 'ann' });
        const b = await joined({ name: 'bob' });
        expect([a.peerId, b.peerId]).toEqual([1, 2]);
        expect(a.tickRate).toBe(30);
        expect(host.peers.get(1)!.name).toBe('ann');
        expect(log).toEqual(['join 1', 'join 2']);
    });

    it('refuses a different protocol, different content, a full host, and a failed authorization', async () => {
        const { s, join } = setup({ maxPeers: 1, authorize: (h) => (h.token === 'bad' ? 'banned' : null) });
        const expectRefused = async (o: Partial<JoinOptions>, code: string) => {
            const p = join(o);
            const check = expect(p).rejects.toMatchObject({ code });
            await s.advance(10);
            await check;
        };
        await expectRefused({ protocol: 999 }, 'protocol');
        await expectRefused({ contentHash: 'other' }, 'content');
        await expectRefused({ token: 'bad' }, 'unauthorized');
        const first = join();
        await s.advance(10);
        await first;
        await expectRefused({}, 'full');
    });

    it('raises JoinRefusedError', async () => {
        const { s, join } = setup();
        const p = join({ contentHash: 'other' });
        const check = expect(p).rejects.toBeInstanceOf(JoinRefusedError);
        await s.advance(10);
        await check;
    });

    it('closes a link that never says hello', async () => {
        const { s, host } = setup({ helloTimeoutMs: 100 });
        const [peerEnd, hostEnd] = createLoopbackPair(s);
        host.accept(hostEnd);
        await s.advance(150);
        expect(peerEnd.isClosed).toBe(true);
    });

    it('hashes content the same way every time', async () => {
        const a = await hashContent(['scene', new Uint8Array([1, 2])]);
        expect(a).toMatch(/^[0-9a-f]{64}$/);
        expect(await hashContent(['scene', new Uint8Array([1, 2])])).toBe(a);
        expect(await hashContent(['scen', 'e', new Uint8Array([1, 2])])).not.toBe(a); // parts are length-prefixed
    });
});

describe('NetSync session: clock', () => {
    it('agrees with the host on the tick within one tick, at 100 ms RTT with jitter', async () => {
        const { s, host, joined } = setup({ tickRate: 30 }, { latencyMs: 50, jitterMs: 20, seed: 11 });
        const peer = await joined();
        await s.advance(3000);
        expect(peer.clock.synced).toBe(true);
        const tickMs = 1000 / 30;
        for (let i = 0; i < 20; i++) {
            await s.advance(137);
            expect(Math.abs(peer.hostTimeNow() - host.timeMs())).toBeLessThan(tickMs);
            expect(Math.abs(peer.hostTick() - host.tick())).toBeLessThanOrEqual(1);
        }
        expect(peer.clock.rttMs).toBeGreaterThan(100);
        expect(peer.clock.rttMs).toBeLessThan(140);
    });

    it('stays within one tick under 10 % pulse loss', async () => {
        const { s, host, joined } = setup({ tickRate: 30 }, { latencyMs: 40, jitterMs: 30, loss: 0.1, seed: 4 });
        const peer = await joined();
        await s.advance(5000);
        expect(Math.abs(peer.hostTimeNow() - host.timeMs())).toBeLessThan(1000 / 30);
    });
});

describe('NetSync session: messages', () => {
    it('passes app messages both ways on every lane, and keeps session messages to itself', async () => {
        const { s, host, joined } = setup();
        const peer = await joined();
        const atHost: string[] = [];
        host.onControl = (p, m) => atHost.push(`c${p.id}:${m[0]}`);
        host.onPulse = (p, m) => atHost.push(`p${p.id}:${m[0]}`);
        host.onBulk = (p, m) => atHost.push(`b${p.id}:${m.length}`);
        const atPeer: string[] = [];
        peer.onControl = (m) => atPeer.push(`c:${m[0]}`);
        peer.onPulse = (m) => atPeer.push(`p:${m[0]}`);
        peer.onBulk = (m) => atPeer.push(`b:${m.length}`);

        peer.sendControl(new Uint8Array([FIRST_APP_TYPE]));
        peer.sendPulse(new Uint8Array([FIRST_APP_TYPE + 1]));
        peer.sendBulk(new Uint8Array(5000));
        host.peers.get(peer.peerId)!.sendControl(new Uint8Array([FIRST_APP_TYPE + 2]));
        host.peers.get(peer.peerId)!.sendPulse(new Uint8Array([FIRST_APP_TYPE + 3]));
        await s.advance(1000); // pings and pongs flow meanwhile; none may surface
        expect(atHost).toEqual([`c1:${FIRST_APP_TYPE}`, `p1:${FIRST_APP_TYPE + 1}`, 'b1:5000']);
        expect(atPeer).toEqual([`c:${FIRST_APP_TYPE + 2}`, `p:${FIRST_APP_TYPE + 3}`]);
    });
});

describe('NetSync session: leaving and reconnecting', () => {
    it('frees the seat at once on Bye', async () => {
        const { s, host, joined } = setup();
        const log = events(host);
        const peer = await joined();
        peer.leave('done');
        await s.advance(10);
        expect(log).toEqual(['join 1', 'leave 1: done']);
        expect(host.peers.size).toBe(0);
        expect(peer.state).toBe('closed');
    });

    it('takes the same seat back after a dropped link', async () => {
        const { s, host, joined, links } = setup();
        const log = events(host);
        const peer = await joined();
        const states: string[] = [];
        peer.on('reconnecting', () => states.push('reconnecting'));
        peer.on('reconnected', () => states.push('reconnected'));
        links[0].close('wifi dropped');
        await s.advance(100);
        expect(states).toEqual(['reconnecting', 'reconnected']);
        expect(peer.state).toBe('connected');
        expect(peer.peerId).toBe(1);
        expect(log).toEqual(['join 1', 'drop 1', 'resume 1']);
        expect(host.peers.get(1)!.connected).toBe(true);
        // The new link works.
        const got: number[] = [];
        host.onControl = (_, m) => got.push(m[0]);
        peer.sendControl(new Uint8Array([FIRST_APP_TYPE]));
        await s.advance(10);
        expect(got).toEqual([FIRST_APP_TYPE]);
    });

    it('keeps retrying while the host is unreachable, inside the grace period', async () => {
        const { s, host, joined, links, unreachable } = setup({ reconnectGraceMs: 10_000 });
        const peer = await joined({ reconnect: { graceMs: 9000 } });
        unreachable(true);
        links[0].close('cable pulled');
        await s.advance(3000);
        expect(peer.state).toBe('reconnecting');
        unreachable(false);
        await s.advance(3000);
        expect(peer.state).toBe('connected');
        expect(peer.peerId).toBe(1);
        expect(host.peers.size).toBe(1);
    });

    it('gives the seat up when the peer does not come back in time', async () => {
        const { s, host, joined, links, unreachable } = setup({ reconnectGraceMs: 2000 });
        const log = events(host);
        const peer = await joined({ reconnect: { graceMs: 1500 } });
        const closed: string[] = [];
        peer.on('closed', (e) => closed.push(e.reason));
        unreachable(true);
        links[0].close('gone');
        await s.advance(5000);
        expect(peer.state).toBe('closed');
        expect(closed[0]).toContain('could not reconnect');
        expect(log).toEqual(['join 1', 'drop 1', expect.stringMatching(/^leave 1: did not come back/)]);
        expect(host.peers.size).toBe(0);
    });

    it('drops a silent peer, and a silent host drops the peer', async () => {
        const { s, host, joined, links } = setup({ timeoutMs: 1000 });
        const log = events(host);
        const peer = await joined({ timeoutMs: 1000, reconnect: false });
        // Make the link deaf in both directions without closing it.
        const link = links[0];
        link.sendControl = () => {};
        link.sendPulse = () => true;
        link.onControl = link.onPulse = null;
        await s.advance(3000);
        expect(log[1]).toBe('drop 1');
        expect(peer.state).toBe('closed');
    });

    it('ends the session for its peers when the host closes', async () => {
        const { s, host, joined } = setup();
        const peer = await joined();
        const closed: string[] = [];
        peer.on('closed', (e) => closed.push(e.reason));
        host.close('server restarting');
        await s.advance(500);
        expect(closed).toEqual(['server restarting']);
        expect(host.peers.size).toBe(0);
    });

    it('refuses a resume after the seat is gone', async () => {
        const { s, joined, links, unreachable } = setup({ reconnectGraceMs: 500 });
        const peer = await joined({ reconnect: { graceMs: 5000 } });
        unreachable(true);
        links[0].close('gone');
        await s.advance(1000); // the host's grace (500 ms) runs out while unreachable
        unreachable(false);
        await s.advance(5000);
        expect(peer.state).toBe('closed');
    });
});
