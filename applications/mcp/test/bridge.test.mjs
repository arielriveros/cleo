// The editor bridge's security gates and relay, against real sockets on loopback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { CLOSE, EditorBridge, isAllowedOrigin, isLoopbackHost } from '../src/bridge.mjs';
import { removeDiscovery, writeDiscovery } from '../src/discovery.mjs';
import { INSTRUCTIONS } from '../src/instructions.mjs';
import { toToolResult } from '../src/tools.mjs';

const TOKEN = 'test-token-123';

async function bridge() {
    const b = new EditorBridge({ port: 0, token: TOKEN, helloTimeoutMs: 500 });
    await b.start();
    return b;
}

/** A fake editor: connects, says hello, answers calls with `answer`. */
function editor(port, { token = TOKEN, origin, answer } = {}) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, origin ? { origin } : {});
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token, client: { app: 'cleo-editor', project: { name: 'Test' } } })));
        ws.on('message', raw => {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'welcome') resolve(ws);
            if (msg.type === 'call') {
                Promise.resolve().then(() => answer?.(msg.method, msg.params)).then(
                    result => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result })),
                    err => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: { message: err.message } })));
            }
        });
        ws.on('unexpected-response', (_req, res) => reject(new Error(`HTTP ${res.statusCode}`)));
        ws.on('close', code => reject(Object.assign(new Error(`closed ${code}`), { code })));
        ws.on('error', () => {});
    });
}

test('origin allowlist: local dev servers and the desktop app only', () => {
    assert.equal(isAllowedOrigin('http://localhost:8080'), true);
    assert.equal(isAllowedOrigin('http://127.0.0.1:8090'), true);
    assert.equal(isAllowedOrigin('http://[::1]:8080'), true);
    assert.equal(isAllowedOrigin('app://editor'), true);
    assert.equal(isAllowedOrigin(undefined), true, 'non-browser clients still need the token');
    assert.equal(isAllowedOrigin('https://evil.example'), false);
    assert.equal(isAllowedOrigin('http://localhost.evil.example'), false);
    assert.equal(isAllowedOrigin('null'), false);
    assert.equal(isAllowedOrigin('https://cleo.example', ['https://cleo.example']), true);
});

test('host check rejects DNS-rebound names', () => {
    assert.equal(isLoopbackHost('127.0.0.1:5000', 5000), true);
    assert.equal(isLoopbackHost('localhost:5000', 5000), true);
    assert.equal(isLoopbackHost('evil.example:5000', 5000), false);
    assert.equal(isLoopbackHost('127.0.0.1:5001', 5000), false);
    assert.equal(isLoopbackHost(undefined, 5000), false);
});

test('a foreign web origin is refused at the upgrade', async () => {
    const b = await bridge();
    try {
        await assert.rejects(editor(b.port, { origin: 'https://evil.example' }), /HTTP 403/);
        assert.equal(b.connected, false);
    } finally { await b.close(); }
});

test('a wrong token is closed with 4401', async () => {
    const b = await bridge();
    try {
        await assert.rejects(editor(b.port, { token: 'nope' }), err => err.code === CLOSE.BAD_TOKEN);
        assert.equal(b.connected, false);
    } finally { await b.close(); }
});

test('calls relay to the editor and back, errors included', async () => {
    const b = await bridge();
    try {
        const ws = await editor(b.port, {
            origin: 'http://localhost:8080',
            answer: (method, params) => {
                if (method === 'boom') throw new Error('no such node');
                return { text: `${method}:${params.x}` };
            },
        });
        assert.equal(b.client.project.name, 'Test');
        assert.deepEqual(await b.call('echo', { x: 7 }), { text: 'echo:7' });
        await assert.rejects(b.call('boom', {}), /no such node/);
        ws.close();
    } finally { await b.close(); }
});

test('a newer editor replaces the old one, which is told why', async () => {
    const b = await bridge();
    try {
        const first = await editor(b.port, { answer: () => ({ text: 'first' }) });
        const closed = new Promise(resolve => first.on('close', code => resolve(code)));
        await editor(b.port, { answer: () => ({ text: 'second' }) });
        assert.equal(await closed, CLOSE.REPLACED);
        assert.deepEqual(await b.call('who', {}), { text: 'second' });
    } finally { await b.close(); }
});

test('no editor: a call waits briefly, then explains how to connect one', async () => {
    const b = await bridge();
    try {
        await assert.rejects(b.call('status', {}, { waitForEditorMs: 50 }), /No Cleo editor is connected/);
    } finally { await b.close(); }
});

test('a call that the editor never answers times out with a reason', async () => {
    const b = await bridge();
    try {
        await editor(b.port, { answer: () => new Promise(() => {}) });
        await assert.rejects(b.call('slow', {}, { timeoutMs: 100 }), /did not answer "slow"/);
    } finally { await b.close(); }
});

test('the discovery file is only removed by the server that wrote it', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-mcp-')), 'agent-bridge.json');
    writeDiscovery(file, { port: 1, token: 't', pid: 999999 });
    removeDiscovery(file, process.pid);
    assert.equal(fs.existsSync(file), true, 'another server owns it');
    removeDiscovery(file, 999999);
    assert.equal(fs.existsSync(file), false);
});

test('results map to MCP content; images pass through', () => {
    const r = toToolResult({ text: 'hi', images: [{ data: 'AAAA', mimeType: 'image/png' }] });
    assert.deepEqual(r.content, [{ type: 'text', text: 'hi' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
    assert.equal(r.isError, false);
    assert.equal(toToolResult({ data: { a: 1 }, isError: true }).isError, true);
});

test('server instructions fit the 4,096 characters Claude Code loads up front', () => {
    assert.ok(INSTRUCTIONS.length < 4096, `${INSTRUCTIONS.length} characters`);
});
