// @ts-check
// A peer of the agent host: the stdio MCP server's link to the editor when a host owns it. It speaks the
// host's peer protocol (bridge.mjs header) and offers the same `call()` as EditorBridge, so the tool
// catalog cannot tell the two apart.

import WebSocket from 'ws';
import { BridgeError } from './bridge.mjs';

export class PeerBridge {
    /**
     * @param {{ resolveHost: () => Promise<{ port: number, token: string } | null>, name?: string, log?: (m: string) => void }} opts
     *   resolveHost finds (or starts) the host; it is asked again whenever the link has dropped.
     */
    constructor(opts) {
        this.resolveHost = opts.resolveHost;
        this.name = opts.name ?? 'cleo-mcp';
        this.log = opts.log ?? (() => {});
        /** @type {WebSocket | null} */
        this.ws = null;
        /** @type {Promise<WebSocket> | null} */
        this.opening = null;
        this.nextId = 1;
        /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
        this.pending = new Map();
    }

    /** @returns {Promise<WebSocket>} */
    _link() {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) return Promise.resolve(this.ws);
        if (this.opening) return this.opening;
        this.opening = (async () => {
            const host = await this.resolveHost();
            if (!host) throw new BridgeError('no_host', 'The Cleo agent host is not running and could not be started.');
            const ws = new WebSocket(`ws://127.0.0.1:${host.port}`);
            await new Promise((resolve, reject) => {
                ws.once('error', reject);
                ws.once('open', () => ws.send(JSON.stringify({ type: 'hello', role: 'peer', token: host.token, client: { name: this.name, pid: process.pid } })));
                ws.on('message', raw => {
                    let msg;
                    try { msg = JSON.parse(String(raw)); } catch { return; }
                    if (msg.type === 'welcome') resolve(undefined);
                    else if (msg.type === 'result') this._settle(msg);
                });
                ws.once('close', code => reject(new BridgeError('no_host', `The agent host closed the link (${code}).`)));
            });
            ws.on('close', () => {
                if (this.ws === ws) this.ws = null;
                for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new BridgeError('disconnected', 'The link to the Cleo agent host dropped during the call.')); }
                this.pending.clear();
            });
            ws.on('error', err => this.log(`host link error: ${err.message}`));
            this.ws = ws;
            this.log(`linked to the agent host on port ${host.port}`);
            return ws;
        })().finally(() => { this.opening = null; });
        return this.opening;
    }

    /** @param {any} msg */
    _settle(msg) {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new BridgeError(msg.error?.code ?? 'editor_error', msg.error?.message ?? 'The editor reported an error.'));
    }

    /**
     * @param {string} method @param {unknown} params
     * @param {{ timeoutMs?: number, waitForEditorMs?: number }} [opts]
     */
    async call(method, params, opts = {}) {
        const ws = await this._link();
        const id = this.nextId++;
        const timeoutMs = opts.timeoutMs ?? 30000;
        return new Promise((resolve, reject) => {
            // A little longer than the host's own timeout, so its (more specific) message wins the race.
            const timer = setTimeout(() => { this.pending.delete(id); reject(new BridgeError('timeout', `No answer to "${method}" from the agent host.`)); }, timeoutMs + 5000);
            this.pending.set(id, { resolve, reject, timer });
            ws.send(JSON.stringify({ type: 'call', id, method, params: params ?? {}, timeoutMs, waitForEditorMs: opts.waitForEditorMs }));
        });
    }

    async close() { this.ws?.close(1000, 'peer closing'); }
}
