#!/usr/bin/env node
// @ts-check
// cleo-mcp: a Model Context Protocol server (stdio) that lets an LLM agent drive a running Cleo editor.
//
//   Claude Code:   claude mcp add cleo -- node <engine>/applications/mcp/src/index.mjs
//
// It opens the editor bridge (a loopback WebSocket, see bridge.mjs), advertises it in the discovery file
// (discovery.mjs) for the editor to find, and serves the tool catalog (tools.mjs) plus the engine docs as
// resources (resources.mjs). stdout carries the MCP protocol, so everything else goes to stderr.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { EditorBridge, describeClient } from './bridge.mjs';
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

    const server = new McpServer({ name: PKG.name, version: PKG.version }, {
        instructions: INSTRUCTIONS,
        capabilities: { tools: {}, resources: {} },
    });
    registerTools(server, bridge);
    registerResources(server, ENGINE_ROOT);

    bridge.on('connected', client => log(`ready: ${describeClient(client)}`));

    let closing = false;
    const shutdown = async (/** @type {string} */ why) => {
        if (closing) return;
        closing = true;
        log(`shutting down (${why})`);
        removeDiscovery(discovery);
        await bridge.close().catch(() => {});
        process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
    // The client owns our lifetime: when it closes stdin, we are done.
    process.stdin.on('end', () => void shutdown('stdin closed'));
    process.on('exit', () => removeDiscovery(discovery));

    await server.connect(new StdioServerTransport());
    log(`MCP server ${PKG.version} ready on stdio`);
}

main().catch(err => {
    log(`fatal: ${err?.stack ?? err}`);
    process.exit(1);
});
