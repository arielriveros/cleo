#!/usr/bin/env node
// @ts-check
// cleo-mcp: a Model Context Protocol server (stdio) that lets an LLM agent drive a running Cleo editor.
//
//   Claude Code:   claude mcp add cleo -- node <engine>/applications/mcp/src/index.mjs
//
// It serves the tool catalog (tools.mjs) and the engine docs as resources (resources.mjs), and runs every
// tool through the Cleo agent host (host.mjs), the one process that owns the editor link. The host is
// started on demand (ensureHost.mjs), so several Claude sessions and the in-editor chat share one editor.
// CLEO_MCP_STANDALONE=1 skips the host and opens the editor bridge here instead (the original setup).
// stdout carries the MCP protocol, so everything else goes to stderr.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EditorBridge, describeClient } from './bridge.mjs';
import { PeerBridge } from './peer.mjs';
import { ensureHost } from './ensureHost.mjs';
import { DEFAULT_PORT, discoveryFilePath, removeDiscovery, writeDiscovery } from './discovery.mjs';
import { registerTools } from './tools.mjs';
import { registerResources } from './resources.mjs';
import { INSTRUCTIONS } from './instructions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8'));
/** The engine checkout this server ships in: applications/mcp/src -> the repo root. */
const ENGINE_ROOT = process.env.CLEO_ENGINE_ROOT || path.resolve(HERE, '..', '..', '..');

const log = (/** @type {string} */ msg) => process.stderr.write(`[cleo-mcp] ${msg}\n`);

async function main() {
    if (process.env.CLEO_MCP_STANDALONE !== '1') {
        try {
            const host = await ensureHost({ log });
            log(`using the agent host (pid ${host.pid}, port ${host.port})`);
            return serve(new PeerBridge({ resolveHost: () => ensureHost({ log }), name: `${PKG.name} ${PKG.version}`, log }), async () => {});
        } catch (err) {
            log(`no agent host (${/** @type {any} */ (err)?.message ?? err}); opening the editor bridge here instead`);
        }
    }
    await standalone();
}

/** The original setup: this process owns the editor link itself. */
async function standalone() {
    const token = crypto.randomBytes(24).toString('base64url');
    const bridge = new EditorBridge({
        port: Number(process.env.CLEO_MCP_PORT) || DEFAULT_PORT,
        token,
        allowedOrigins: (process.env.CLEO_MCP_ALLOWED_ORIGINS ?? '').split(',').map(s => s.trim()).filter(Boolean),
        serverInfo: { name: PKG.name, version: PKG.version },
        log,
    });
    const port = await bridge.start();

    const discovery = discoveryFilePath();
    writeDiscovery(discovery, {
        port, token, pid: process.pid, version: PKG.version, startedAt: new Date().toISOString(),
    });
    log(`editor bridge on ws://127.0.0.1:${port} (discovery: ${discovery})`);

    bridge.on('connected', client => log(`ready: ${describeClient(client)}`));
    process.on('exit', () => removeDiscovery(discovery));
    await serve(bridge, async () => { removeDiscovery(discovery); await bridge.close(); });
}

/**
 * The MCP server itself, over stdio, running its tools through `caller`.
 * @param {import('./tools.mjs').Caller} caller @param {() => Promise<void>} cleanup
 */
async function serve(caller, cleanup) {
    const server = new McpServer({ name: PKG.name, version: PKG.version }, {
        instructions: INSTRUCTIONS,
        capabilities: { tools: {}, resources: {} },
    });
    registerTools(server, caller);
    registerResources(server, ENGINE_ROOT);

    let closing = false;
    const shutdown = async (/** @type {string} */ why) => {
        if (closing) return;
        closing = true;
        log(`shutting down (${why})`);
        await cleanup().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    // The client owns our lifetime: when it closes stdin, we are done.
    process.stdin.on('end', () => void shutdown('stdin closed'));

    await server.connect(new StdioServerTransport());
    log(`MCP server ${PKG.version} ready on stdio`);
}

main().catch(err => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
});
