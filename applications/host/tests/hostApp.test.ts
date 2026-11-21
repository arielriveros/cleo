// The host contract (docs/design/netsync.md §7.2), over real sockets: settings from flags, the environment and the
// game; join tokens; a warm host allocated over its control port, joined, emptied and ended (or reused); draining;
// and the Agones lifecycle against a stand-in for its SDK sidecar. The
// parts that run a game run the Sandbox, and live with it (examples/sandbox/tests/net/hostApp.test.ts).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import path from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PeerSession } from '../../../src/netsync';
import { generateCertificate, type HostCertificate } from '../src/devCertificate';
import { HostApp } from '../src/hostApp';
import { JoinTokenVerifier, generateTokenKeys, signJoinToken } from '../src/joinToken';
import { AgonesLifecycle, sessionFromGameServer } from '../src/lifecycle';
import { readSettings, withGameDefaults, type HostSettings } from '../src/settings';

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

describe('host settings', () => {
    it('takes a flag over the environment, the environment over the game, the game over the default', () => {
        const s = readSettings(['--tick-rate', '60', '--lifecycle', 'agones'], { NETSYNC_TICK_RATE: '20', NETSYNC_MAX_PEERS: '8', NETSYNC_UDP_PORT: '5000', NETSYNC_REUSE: '1' });
        expect(s.tickRate).toBe(60);
        expect(s.udpPort).toBe(5000);
        expect(s.reuse).toBe(true);
        expect(s.lifecycle).toBe('agones');
        const g = withGameDefaults(s, { tickRate: 30, maxPeers: 4, playerTemplate: 'Hero', spawn: [1, 2, 3], trust: 'versus' });
        expect(g).toEqual({ tickRate: 60, maxPeers: 8, playerTemplate: 'Hero', spawn: [1, 2, 3], trust: 'versus' });
        expect(withGameDefaults(readSettings([], {}), undefined)).toEqual({ tickRate: 30, maxPeers: 16, playerTemplate: undefined, spawn: [0, 1, 0], trust: 'coop' });
        expect(readSettings(['--control-port', 'off'], {}).controlPort).toBe(-1);
        expect(readSettings([], { NETSYNC_SESSION: '{"id":"m1","mode":"coop"}' }).session).toEqual({ id: 'm1', mode: 'coop' });
        expect(() => readSettings(['--lifecycle', 'gamelift'], {})).toThrow(/unknown/);
    });
});

describe('join tokens', () => {
    it('admit to their session until they expire, signed by the allocator’s key alone', () => {
        const keys = generateTokenKeys();
        const verifier = new JoinTokenVerifier(keys.publicKey);
        const now = 1_800_000_000;
        const token = signJoinToken({ sid: 'match-7', exp: now + 60, name: 'A' }, keys.privateKey);
        expect(verifier.check(token, 'match-7', now)).toBeNull();
        expect(verifier.check(token, null, now)).toBeNull();
        expect(verifier.check(token, 'match-8', now)).toMatch(/another session/);
        expect(verifier.check(token, 'match-7', now + 61)).toMatch(/expired/);
        expect(verifier.check(undefined, 'match-7', now)).toMatch(/required/);
        const forged = signJoinToken({ sid: 'match-7', exp: now + 60 }, generateTokenKeys().privateKey);
        expect(verifier.check(forged, 'match-7', now)).toMatch(/signature/);
        // Tampered claims, original signature.
        const [, sig] = token.split('.');
        const tampered = `${Buffer.from(JSON.stringify({ sid: 'match-7', exp: now + 9999 })).toString('base64url')}.${sig}`;
        expect(verifier.check(tampered, 'match-7', now)).toMatch(/signature/);
        // A key as one line of base64 DER (an environment variable) works as PEM does.
        const der = keys.publicKey.replace(/-----[^-]+-----/g, '').replace(/\s/g, '');
        expect(new JoinTokenVerifier(der).check(token, 'match-7', now)).toBeNull();
    });
});
