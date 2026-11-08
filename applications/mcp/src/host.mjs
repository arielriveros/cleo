#!/usr/bin/env node
// @ts-check
// The Cleo agent host: the one long-lived process that owns the editor link. It
//   - hosts the bridge the editor connects to (bridge.mjs) and advertises it in the discovery file;
//   - relays tool calls from peers: the stdio MCP server every Claude Code session launches (index.mjs);
//   - runs the in-editor chat panel's Claude sessions (chat.mjs);
//   - hosts the user's own Claude Code in a terminal the editor shows (terminal.mjs).
//
// Started on demand, detached, by ensureHost.mjs (from index.mjs or the editor's dev server); exits after a
// while with nothing connected and nothing running. Logs go to ~/.cleo/agent-host.log.
//
//   CLEO_AGENT_HOST_IDLE_MS   idle time before exiting (default 15 min); also how long a hosted Claude Code
//                             keeps running after the last editor went away
//   CLEO_AGENT_MOCK=1         a scripted chat agent instead of Claude (no API key needed; for tests)
//   CLEO_CLAUDE_PATH          the `claude` to host (default: the one on the PATH)
//   CLEO_CLAUDE_CWD           the folder it starts in (default: this engine checkout)

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EditorBridge, describeClient } from './bridge.mjs';
import { DEFAULT_PORT, discoveryFilePath, removeDiscovery, writeDiscovery } from './discovery.mjs';
import { findHost } from './ensureHost.mjs';
import { ChatManager } from './chat.mjs';
import { TerminalManager } from './terminal.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
const discovery = discoveryFilePath();
const dataDir = path.dirname(discovery);
const logFile = path.join(dataDir, 'agent-host.log');
const IDLE_MS = Number(process.env.CLEO_AGENT_HOST_IDLE_MS) || 15 * 60_000;

fs.mkdirSync(dataDir, { recursive: true });
const log = (/** @type {string} */ msg) => {
    const line = `${new Date().toISOString()} [host ${process.pid}] ${msg}\n`;
    try { fs.appendFileSync(logFile, line); } catch { /* best effort */ }
    if (process.stderr.isTTY) process.stderr.write(line);
};

async function main() {
    // Two starters racing (an MCP server and the chat panel at once): the second one bows out.
    if (await findHost(discovery)) { log('another host is already running; exiting'); return; }

    const bridge = new EditorBridge({
        port: Number(process.env.CLEO_MCP_PORT) || DEFAULT_PORT,
        token: crypto.randomBytes(24).toString('base64url'),
        allowedOrigins: (process.env.CLEO_MCP_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
        serverInfo: { name: 'cleo-agent-host', version: PKG.version },
        capabilities: ['chat', 'terminal'],
        log,
    });
    // Ready before the editor can connect: its first attach must find the terminal's state.
    const terminal = new TerminalManager({ bridge, dataDir, discoveryFile: discovery, log });
    await terminal.init();
    const port = await bridge.start();
    writeDiscovery(discovery, { role: 'host', port, token: bridge.token, pid: process.pid, version: PKG.version, chat: true, terminal: true, startedAt: new Date().toISOString() });
    log(`listening on ws://127.0.0.1:${port}`);

    const chat = new ChatManager({ bridge, dataDir, version: PKG.version, log, mock: process.env.CLEO_AGENT_MOCK === '1' });
    /** When the last editor went away; null while one is connected. */
    let editorGoneAt = /** @type {number | null} */ (Date.now());
    bridge.on('connected', client => { editorGoneAt = null; log(`editor: ${describeClient(client)}`); });
    bridge.on('disconnected', () => { editorGoneAt = Date.now(); });

    // Exit once nothing has needed us for IDLE_MS. A hosted Claude Code keeps its own MCP server connected as
    // a peer, so it would keep the host up forever: it is stopped once no editor has shown it for IDLE_MS.
    let idleSince = Date.now();
    const timer = setInterval(() => {
        if (terminal.running && editorGoneAt !== null && Date.now() - editorGoneAt > IDLE_MS) {
            terminal.stop(`no editor for ${Math.round(IDLE_MS / 60000)} min`);
        }
        const busy = bridge.connected || bridge.peers.size > 0 || chat.busy || terminal.running;
        if (busy) { idleSince = Date.now(); return; }
        if (Date.now() - idleSince > IDLE_MS) void shutdown('idle');
    }, 5000);

    let closing = false;
    const shutdown = async (/** @type {string} */ why) => {
        if (closing) return;
        closing = true;
        clearInterval(timer);
        log(`shutting down (${why})`);
        removeDiscovery(discovery);
        terminal.dispose();
        await chat.interrupt().catch(() => {});
        await bridge.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    process.on('exit', () => removeDiscovery(discovery));
    process.on('uncaughtException', err => log(`uncaught: ${err?.stack ?? err}`));
    process.on('unhandledRejection', err => log(`unhandled rejection: ${/** @type {any} */ (err)?.stack ?? err}`));
}

main().catch(err => { log(`fatal: ${err?.stack ?? err}`); process.exit(1); });
