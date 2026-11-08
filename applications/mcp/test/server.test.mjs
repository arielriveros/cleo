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
        assert.equal(tools.length, 14);
        assert.equal(byName.editor_status._meta?.['anthropic/alwaysLoad'], true);
        assert.equal(byName.scene_edit._meta?.['anthropic/alwaysLoad'], true);
        assert.equal(byName.asset_list._meta?.['anthropic/alwaysLoad'], undefined);
        assert.equal(byName.execute_js._meta?.['anthropic/requiresUserInteraction'], true);
        assert.equal(byName.scene_tree.annotations?.readOnlyHint, true);
        assert.equal(byName.execute_js.annotations?.destructiveHint, true);
        // Property descriptions survive the schema conversion (zod >= 4.2 with SDK v2).
        assert.match(String(byName.scene_tree.inputSchema.properties?.depth?.description), /Levels below root/);
        assert.match(client.getInstructions() ?? '', /Cleo MCP/);
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
