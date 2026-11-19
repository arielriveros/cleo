// The session's own messages (docs/design/netsync.md §3, layer 2). The first byte of every control-lane and
// pulse-lane message is its type; types below FIRST_APP_TYPE belong to the session, the rest are handed up to
// whoever uses the session (the sync layer, from phase 3).

import { ByteReader, ByteWriter } from '../bytes';

/** Bumped whenever a message's layout changes. Host and peer must match exactly. */
export const NETSYNC_PROTOCOL = 1;

/** The first message type the session passes up instead of handling itself (both lanes). */
export const FIRST_APP_TYPE = 32;

/** Control-lane session messages. */
export const SessionControl = {
    hello: 1,
    welcome: 2,
    refuse: 3,
    bye: 4,
} as const;

/** Pulse-lane session messages. */
export const SessionPulse = {
    ping: 1,
    pong: 2,
} as const;

/** Why a host turned a peer away. */
export type RefuseCode = 'protocol' | 'content' | 'full' | 'unauthorized' | 'unknown-session' | 'closing' | 'bad-hello';

/** Peer → host, the first message on a new link. */
export interface Hello {
    protocol: number;
    /** Hash of the game content the peer runs; must equal the host's. */
    contentHash: string;
    /** From an earlier Welcome, to take the same seat back after a dropped link. Empty on a first join. */
    resumeToken: string;
    /** Join token from the allocator (phase 9). Empty when the host does not ask for one. */
    token: string;
    /** Display name, for logs and the debugger. */
    name: string;
}

/** Host → peer, accepting a Hello. */
export interface Welcome {
    peerId: number;
    resumeToken: string;
    /** The host's simulation rate. */
    tickRate: number;
    /** The host's clock (ms since the session started) when it sent this. */
    hostTimeMs: number;
    /** True when the Hello's resume token took back an existing seat. */
    resumed: boolean;
}

export interface Refuse { code: RefuseCode; message: string; }
export interface Bye { reason: string; }
export interface Ping { id: number; peerTimeMs: number; }
export interface Pong { id: number; peerTimeMs: number; hostTimeMs: number; }

export function encodeHello(h: Hello): Uint8Array {
    return new ByteWriter(64).u8(SessionControl.hello).u16(h.protocol).string(h.contentHash)
        .string(h.resumeToken).string(h.token).string(h.name).finish();
}

export function decodeHello(r: ByteReader): Hello {
    return { protocol: r.u16(), contentHash: r.string(), resumeToken: r.string(), token: r.string(), name: r.string() };
}

export function encodeWelcome(w: Welcome): Uint8Array {
    return new ByteWriter(48).u8(SessionControl.welcome).u16(w.peerId).string(w.resumeToken).u16(w.tickRate)
        .f64(w.hostTimeMs).u8(w.resumed ? 1 : 0).finish();
}

export function decodeWelcome(r: ByteReader): Welcome {
    return { peerId: r.u16(), resumeToken: r.string(), tickRate: r.u16(), hostTimeMs: r.f64(), resumed: r.u8() === 1 };
}

export function encodeRefuse(f: Refuse): Uint8Array {
    return new ByteWriter(32).u8(SessionControl.refuse).string(f.code).string(f.message).finish();
}

export function decodeRefuse(r: ByteReader): Refuse {
    return { code: r.string() as RefuseCode, message: r.string() };
}

export function encodeBye(b: Bye): Uint8Array {
    return new ByteWriter(16).u8(SessionControl.bye).string(b.reason).finish();
}

export function decodeBye(r: ByteReader): Bye {
    return { reason: r.string() };
}

export function encodePing(p: Ping): Uint8Array {
    return new ByteWriter(13).u8(SessionPulse.ping).u32(p.id).f64(p.peerTimeMs).finish();
}

export function decodePing(r: ByteReader): Ping {
    return { id: r.u32(), peerTimeMs: r.f64() };
}

export function encodePong(p: Pong): Uint8Array {
    return new ByteWriter(21).u8(SessionPulse.pong).u32(p.id).f64(p.peerTimeMs).f64(p.hostTimeMs).finish();
}

export function decodePong(r: ByteReader): Pong {
    return { id: r.u32(), peerTimeMs: r.f64(), hostTimeMs: r.f64() };
}

/** A fresh random token (resume tokens), base64url, 128 bits. */
export function randomToken(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * SHA-256 of the given parts, hex. For the content hash a host and its peers compare in the handshake
 * (the published scenes and templates, from phase 2).
 */
export async function hashContent(parts: (Uint8Array | string)[]): Promise<string> {
    const enc = new TextEncoder();
    const w = new ByteWriter(256);
    for (const p of parts) w.bytes(typeof p === 'string' ? enc.encode(p) : p);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', w.finish() as Uint8Array<ArrayBuffer>));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}
