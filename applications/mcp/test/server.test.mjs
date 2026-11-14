// The stdio MCP server end to end, as Claude Code starts it, through the MCP SDK v2 client: what tools/list
// and resources/* advertise. Standalone and with its own discovery file, so it never touches a real host.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function connect() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-mcp-server-'));
    const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.join(HERE, '..', 'src', 'index.mjs')],
        env: { ...process.env, CLEO_MCP_STANDALONE: '1', CLEO_MCP_PORT: '0', CLEO_AGENT_BRIDGE_FILE: path.join(dir, 'agent-bridge.json') },
        stderr: 'ignore',
    });
    const client = new Client({ name: 'cleo-mcp-test', version: '0.0.0' });
    await client.connect(transport);
    return client;
}

test('tools/list advertises the catalog with its metadata and descriptions intact', async () => {
    const client = await connect();
    try {
        const { tools } = await client.listTools();
        const byName = Object.fromEntries(tools.map(t => [t.name, t]));
        assert.equal(tools.length, 16);
        // Every tool loads with the session: no tool-search turn before a first use.
        for (const t of tools) assert.equal(t._meta?.['anthropic/alwaysLoad'], true, t.name);
        // execute_js runs without a per-call prompt; the editor's Allow code execution switch gates it.
        assert.equal(byName.execute_js._meta?.['anthropic/requiresUserInteraction'], undefined);
        assert.equal(byName.scene_tree.annotations?.readOnlyHint, true);
        // Strict inputs: a field a tool does not take is refused, never dropped.
        assert.equal(byName.scene_save.inputSchema.additionalProperties, false);
        assert.equal(byName.execute_js.annotations?.destructiveHint, true);
        // Property descriptions survive the schema conversion (zod >= 4.2 with SDK v2).
        assert.match(String(byName.scene_tree.inputSchema.properties?.depth?.description), /Levels below root/);
        assert.match(client.getInstructions() ?? '', /Cleo MCP/);
    } finally { await client.close(); }
});

test('engine_api answers through the server without an editor', { skip: !fs.existsSync(path.join(HERE, '..', '..', '..', 'dist', 'cleo.d.ts')) && 'dist not built' }, async () => {
    const client = await connect();
    try {
        const res = await client.callTool({ name: 'engine_api', arguments: { symbol: 'Node.setPosition' } });
        assert.equal(res.isError, false);
        assert.match(res.content[0].text, /Node\.setPosition\(pos: vec3\): Node/);
    } finally { await client.close(); }
});

test('the docs are served as resources', async () => {
    const client = await connect();
    try {
        const { resources } = await client.listResources();
        const doc = resources.find(r => r.uri.startsWith('cleo://docs/') && r.uri.endsWith('.md'));
        assert.ok(doc, 'a docs resource is listed');
        const read = await client.readResource({ uri: doc.uri });
        assert.ok(String(read.contents[0]?.text ?? '').length > 0);
    } finally { await client.close(); }
});

test('a misspelt or retired argument is refused by the server, never silently dropped', async () => {
    const client = await connect();
    try {
        const res = await client.callTool({ name: 'scene_tree', arguments: { depth: 2, deepth: 3 } });
        assert.equal(res.isError, true);
        assert.match(res.content[0].text, /deepth/);
    } finally { await client.close(); }
});
