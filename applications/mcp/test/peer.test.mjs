// The agent host's peer relay: the stdio MCP server each Claude Code session runs connects to the host as a
// peer, and the host runs its calls through its one editor link. Real sockets, a fake editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { EditorBridge } from '../src/bridge.mjs';
import { PeerBridge } from '../src/peer.mjs';

const TOKEN = 'host-test-token';

/** A fake editor: says hello and answers calls through `answer`. */
function editor(port, answer) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'http://localhost:8080' });
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, client: { app: 'cleo-editor', project: { id: 'p1', name: 'Test' } } })));
        ws.on('message', raw => {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'welcome') resolve(ws);
            else if (msg.type === 'call') {
                Promise.resolve().then(() => answer(msg.method, msg.params)).then(
                    result => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result })),
                    err => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: { message: err.message } })));
            }
        });
        ws.on('error', reject);
    });
}

async function host() {
    const bridge = new EditorBridge({ port: 0, token: TOKEN });
    await bridge.start();
    return bridge;
}

test('a peer runs editor commands through the host', async () => {
    const bridge = await host();
    try {
        await editor(bridge.port, (method, params) => ({ text: `${method}:${params.n}` }));
        const peer = new PeerBridge({ resolveHost: async () => ({ port: bridge.port, token: TOKEN }) });
        assert.deepEqual(await peer.call('ping', { n: 3 }), { text: 'ping:3' });
        assert.equal(bridge.peers.size, 1);
        await peer.close();
    } finally { await bridge.close(); }
});

test('a peer with no editor behind the host gets the how-to-connect message', async () => {
    const bridge = await host();
    try {
        const peer = new PeerBridge({ resolveHost: async () => ({ port: bridge.port, token: TOKEN }) });
        await assert.rejects(peer.call('status', {}, { waitForEditorMs: 50 }), /No Cleo editor is connected/);
        await peer.close();
    } finally { await bridge.close(); }
});
