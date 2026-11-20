// Join tokens (docs/design/netsync.md §7.2): the allocator signs a short-lived token naming the session a player
// may join; the host checks it with the allocator's PUBLIC key. Host and allocator never call each other, so they
// can run on different providers, and a host never holds a key that could mint tokens.
//
//   token = base64url(JSON payload) "." base64url(Ed25519 signature of the payload part)
//   payload = { sid: session id, exp: expiry (Unix seconds), name?: player name, slot?: seat hint }

import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';

export interface JoinClaims {
    /** The session it admits to. */
    sid: string;
    /** Expiry, Unix seconds. */
    exp: number;
    name?: string;
    slot?: number;
}

const b64url = (b: Buffer) => b.toString('base64url');

/** A new Ed25519 key pair, both PEM: the private one for the allocator, the public one for hosts. */
export function generateTokenKeys(): { privateKey: string; publicKey: string } {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    return {
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    };
}

/** A key from PEM text, or from base64 of its DER (one line, for an environment variable). */
function readKey(text: string, kind: 'public' | 'private'): KeyObject {
    const pem = text.includes('-----BEGIN');
    const make = kind === 'public' ? createPublicKey : createPrivateKey;
    return pem
        ? make(text)
        : make({ key: Buffer.from(text.trim(), 'base64'), format: 'der', type: kind === 'public' ? 'spki' : 'pkcs8' } as any);
}

/** Sign claims with the allocator's private key. */
export function signJoinToken(claims: JoinClaims, privateKey: string | KeyObject): string {
    const key = typeof privateKey === 'string' ? readKey(privateKey, 'private') : privateKey;
    const body = b64url(Buffer.from(JSON.stringify(claims)));
    return `${body}.${b64url(sign(null, Buffer.from(body), key))}`;
}

export class JoinTokenVerifier {
    private readonly _key: KeyObject;

    /** `publicKey`: PEM, or base64 DER (NETSYNC_TOKEN_KEY). */
    constructor(publicKey: string) {
        this._key = readKey(publicKey, 'public');
    }

    /**
     * Why `token` does not admit a player to session `sessionId` now, or null when it does. (`sessionId` null: any
     * session — a host not told its own.)
     */
    public check(token: string | undefined, sessionId: string | null, nowSeconds: number = Date.now() / 1000): string | null {
        if (!token) return 'a join token is required';
        const dot = token.indexOf('.');
        if (dot <= 0) return 'malformed join token';
        const body = token.slice(0, dot);
        let ok = false;
        try { ok = verify(null, Buffer.from(body), this._key, Buffer.from(token.slice(dot + 1), 'base64url')); } catch { ok = false; }
        if (!ok) return 'join token signature is not valid';
        let claims: JoinClaims;
        try { claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { return 'malformed join token'; }
        if (typeof claims.exp !== 'number' || claims.exp < nowSeconds) return 'join token has expired';
        if (sessionId !== null && claims.sid !== sessionId) return 'join token is for another session';
        return null;
    }
}
