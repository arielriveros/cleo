// @ts-check
// The link to the running editor. The editor is a web page, and a page cannot listen on a socket, so the
// roles are reversed: this process hosts a loopback WebSocket and the editor connects OUT to it (the
// PlayCanvas Editor MCP topology). Every tool call is relayed to the editor, which owns the project data
// (IndexedDB) and the live scene, and runs the command there.
//
// Wire protocol (JSON text frames):
//   editor -> server   {type:'hello', token, client:{app, version, origin, project}}
//   server -> editor   {type:'welcome', server:{name, version}}
//   server -> editor   {type:'call', id, method, params}
//   editor -> server   {type:'result', id, ok:true, result} | {type:'result', id, ok:false, error:{message}}
//   editor -> server   {type:'status', client:{...}}           (project switched, play state, ...)
//
// Security (the holes behind CVE-2025-52882 / CVE-2025-49596 were exactly an unauthenticated localhost
// socket): bound to 127.0.0.1 only; the Host header must name the loopback address (DNS rebinding); a
// browser Origin must be a local editor origin; and the first frame must carry the per-launch token that
// only the discovery file holds.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

/** Close codes the editor shows to the user. */
export const CLOSE = { BAD_TOKEN: 4401, NO_HELLO: 4408, REPLACED: 4409 };

export class BridgeError extends Error {
    /** @param {string} code @param {string} message */
    constructor(code, message) { super(message); this.code = code; }
}

/**
 * Is `origin` a page this server will take commands from? Local http origins (the Vite dev server on any
 * port, a worktree's second editor) and the packaged desktop app's `app://editor`. A missing Origin is a
 * non-browser client (a test, a script): it still needs the token, so it is let through.
 * @param {string | undefined} origin
 * @param {readonly string[]} extra exact origins added through CLEO_MCP_ALLOWED_ORIGINS
 */
export function isAllowedOrigin(origin, extra = []) {
    if (!origin) return true;
    if (extra.includes(origin)) return true;
    if (origin === 'app://editor') return true;
    let url;
    try { url = new URL(origin); } catch { return false; }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
}

/**
 * Does the Host header name this server on a loopback address? A DNS-rebound page reaches 127.0.0.1 under
 * the attacker's own hostname, which is what this rejects.
 * @param {string | undefined} host
 * @param {number} port
 */
export function isLoopbackHost(host, port) {
    if (!host) return false;
    return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`;
}

/** @param {string} a @param {string} b */
function sameToken(a, b) {
    const x = Buffer.from(String(a)), y = Buffer.from(String(b));
    return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export class EditorBridge extends EventEmitter {
    /**
     * @param {{ port: number, token: string, allowedOrigins?: string[], serverInfo?: {name: string, version: string},
     *           log?: (msg: string) => void, helloTimeoutMs?: number }} opts
     */
    constructor(opts) {
        super();
        this.requestedPort = opts.port;
        this.token = opts.token;
        this.allowedOrigins = opts.allowedOrigins ?? [];
        this.serverInfo = opts.serverInfo ?? { name: 'cleo-mcp', version: '0.0.0' };
        this.log = opts.log ?? (() => {});
        this.helloTimeoutMs = opts.helloTimeoutMs ?? 5000;
        /** @type {number} */
        this.port = 0;
        /** @type {import('ws').WebSocket | null} */
        this.socket = null;
        /** What the connected editor said about itself (project, version, origin). */
        this.client = /** @type {any} */ (null);
        this.nextId = 1;
        /** @type {Map<number, {resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, method: string}>} */
        this.pending = new Map();
        this.http = http.createServer((req, res) => {
            // Nothing but the WebSocket lives here. Say what this is, without any project data.
            res.writeHead(426, { 'Content-Type': 'text/plain' }).end('Cleo MCP editor bridge: WebSocket only.\n');
        });
        this.wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
        this.http.on('upgrade', (req, socket, head) => this._upgrade(req, socket, head));
    }

    /** Listen on the requested port, or on any free one if it is taken. Resolves to the port in use. */
    async start() {
        const listen = (/** @type {number} */ port) => new Promise((resolve, reject) => {
            const onError = (/** @type {any} */ err) => { this.http.off('listening', onListening); reject(err); };
            const onListening = () => { this.http.off('error', onError); resolve(undefined); };
            this.http.once('error', onError);
            this.http.once('listening', onListening);
            this.http.listen(port, '127.0.0.1');
        });
        try {
            await listen(this.requestedPort);
        } catch (err) {
            if (/** @type {any} */ (err).code !== 'EADDRINUSE') throw err;
            this.log(`port ${this.requestedPort} is in use; taking a free one`);
            await listen(0);
        }
        this.port = /** @type {import('node:net').AddressInfo} */ (this.http.address()).port;
        return this.port;
    }

    async close() {
        this._failPending(new BridgeError('closed', 'The MCP server is shutting down.'));
        this.socket?.close(1001, 'server shutting down');
        this.wss.close();
        await new Promise(resolve => this.http.close(() => resolve(undefined)));
    }

    get connected() { return !!this.socket && this.socket.readyState === 1 && !!this.client; }

    /**
     * Wait up to `ms` for an editor. Used right after start-up, when the editor's discovery poll has not
     * found the new server yet.
     * @param {number} ms
     */
    waitForEditor(ms) {
        if (this.connected) return Promise.resolve(true);
        return new Promise(resolve => {
            const timer = setTimeout(() => { this.off('connected', onConnected); resolve(false); }, ms);
            const onConnected = () => { clearTimeout(timer); resolve(true); };
            this.once('connected', onConnected);
        });
    }

    /**
     * Run `method` in the editor and resolve with what it returns.
     * @param {string} method
     * @param {unknown} params
     * @param {{ timeoutMs?: number, waitForEditorMs?: number }} [opts]
     */
    async call(method, params, opts = {}) {
        if (!this.connected && !(await this.waitForEditor(opts.waitForEditorMs ?? 4000))) {
            throw new BridgeError('not_connected', NOT_CONNECTED);
        }
        const socket = /** @type {import('ws').WebSocket} */ (this.socket);
        const id = this.nextId++;
        const timeoutMs = opts.timeoutMs ?? 30000;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new BridgeError('timeout', `The editor did not answer "${method}" within ${Math.round(timeoutMs / 1000)} s. `
                    + 'It may be busy (a long import or bake), or its tab may be hidden and throttled.'));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer, method });
            socket.send(JSON.stringify({ type: 'call', id, method, params: params ?? {} }));
        });
    }

    /** @param {import('node:http').IncomingMessage} req @param {import('node:stream').Duplex} socket @param {Buffer} head */
    _upgrade(req, socket, head) {
        const origin = req.headers.origin;
        if (!isLoopbackHost(req.headers.host, this.port) || !isAllowedOrigin(origin, this.allowedOrigins)) {
            this.log(`refused a connection (host ${req.headers.host}, origin ${origin ?? 'none'})`);
            socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            return;
        }
        this.wss.handleUpgrade(req, socket, head, ws => this._accept(ws, origin));
    }

    /** @param {import('ws').WebSocket} ws @param {string | undefined} origin */
    _accept(ws, origin) {
        let authed = false;
        const helloTimer = setTimeout(() => { if (!authed) ws.close(CLOSE.NO_HELLO, 'no hello'); }, this.helloTimeoutMs);

        ws.on('message', raw => {
            let msg;
            try { msg = JSON.parse(String(raw)); } catch { return; }
            if (!authed) {
                if (msg?.type !== 'hello' || !sameToken(msg.token ?? '', this.token)) {
                    clearTimeout(helloTimer);
                    ws.close(CLOSE.BAD_TOKEN, 'bad token');
                    return;
                }
                authed = true;
                clearTimeout(helloTimer);
                // One editor at a time, the newest wins: a reload or a second tab replaces the old socket,
                // whose calls in flight fail rather than land in a page the user has left.
                if (this.socket && this.socket !== ws) {
                    this._failPending(new BridgeError('replaced', 'Another editor connected; the call was cancelled.'));
                    this.socket.close(CLOSE.REPLACED, 'replaced by a newer editor connection');
                }
                this.socket = ws;
                this.client = { ...(msg.client ?? {}), origin: origin ?? msg.client?.origin };
                ws.send(JSON.stringify({ type: 'welcome', server: this.serverInfo }));
                this.log(`editor connected: ${describeClient(this.client)}`);
                this.emit('connected', this.client);
                return;
            }
            if (msg?.type === 'result') {
                const entry = this.pending.get(msg.id);
                if (!entry) return;
                this.pending.delete(msg.id);
                clearTimeout(entry.timer);
                if (msg.ok) entry.resolve(msg.result);
                else entry.reject(new BridgeError(msg.error?.code ?? 'editor_error', msg.error?.message ?? 'The editor reported an error.'));
            } else if (msg?.type === 'status') {
                this.client = { ...this.client, ...(msg.client ?? {}) };
            }
        });

        ws.on('close', () => {
            clearTimeout(helloTimer);
            if (this.socket !== ws) return;
            this.socket = null;
            this.client = null;
            this._failPending(new BridgeError('disconnected',
                'The editor disconnected during the call (a reload or a project switch reloads the page). '
                + 'Call editor_status to see when it is back.'));
            this.log('editor disconnected');
            this.emit('disconnected');
        });
        ws.on('error', err => this.log(`socket error: ${err.message}`));
    }

    /** @param {Error} err */
    _failPending(err) {
        for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(err); }
        this.pending.clear();
    }
}

/** @param {any} c */
export function describeClient(c) {
    if (!c) return 'none';
    const project = c.project?.name ? `project "${c.project.name}"` : 'no project open';
    return `${c.app ?? 'editor'} ${c.version ?? ''} at ${c.origin ?? '?'}, ${project}`.replace(/\s+/g, ' ');
}

const NOT_CONNECTED = 'No Cleo editor is connected to this MCP server. Start the editor '
    + '(`npm run editor:dev` from the engine root, or `npm run desktop:dev`), open a project, and it connects '
    + 'on its own within a few seconds: an "Agent" chip with a green dot appears in the menu bar. If the chip '
    + 'says "Agent off", click it and choose Connect.';
