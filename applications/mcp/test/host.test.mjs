// The agent host's pieces: peer relay, the SDK-message normalizer, and the chat manager driven end to end
// by its scripted stand-in agent against a fake editor.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import { EditorBridge } from '../src/bridge.mjs';
import { PeerBridge } from '../src/peer.mjs';
import { ChatManager, CHAT_SYSTEM_PROMPT, createNormalizer, flattenToolResult } from '../src/chat.mjs';

const TOKEN = 'host-test-token';

/** A fake editor: answers calls through `answer`, collects chat events, can send chat ops. */
function editor(port, answer) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'http://localhost:8080' });
        const events = [];
        const waiters = [];
        const api = {
            ws, events,
            chat: (op, extra = {}) => ws.send(JSON.stringify({ type: 'chat', op, ...extra })),
            /** Resolve with the first event (seen or future) matching `pred`. */
            waitFor: (pred, ms = 5000) => new Promise((res, rej) => {
                const hit = events.find(pred);
                if (hit) return res(hit);
                const timer = setTimeout(() => rej(new Error('timed out waiting for a chat event')), ms);
                waiters.push({ pred, res: ev => { clearTimeout(timer); res(ev); } });
            }),
        };
        ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', token: TOKEN, client: { app: 'cleo-editor', project: { id: 'p1', name: 'Test' } } })));
        ws.on('message', raw => {
            const msg = JSON.parse(String(raw));
            if (msg.type === 'welcome') resolve(api);
            else if (msg.type === 'call') {
                Promise.resolve().then(() => answer(msg.method, msg.params)).then(
                    result => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, result })),
                    err => ws.send(JSON.stringify({ type: 'result', id: msg.id, ok: false, error: { message: err.message } })));
            } else if (msg.type === 'chat-event') {
                const list = msg.event.kind === 'replay' ? [msg.event, ...msg.event.events] : [msg.event];
                for (const ev of list) {
                    events.push(ev);
                    for (const w of [...waiters]) if (w.pred(ev)) { waiters.splice(waiters.indexOf(w), 1); w.res(ev); }
                }
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

test('the normalizer turns streamed SDK messages into panel events', () => {
    const out = [];
    const n = createNormalizer(ev => out.push(ev));
    n.handle({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', apiKeySource: 'ANTHROPIC_API_KEY' });
    n.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'message_start', message: { id: 'm1' } } });
    n.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } });
    n.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } });
    n.handle({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 't1', name: 'mcp__cleo__scene_tree' } } });
    // Claude Code repeats the finished message: text already streamed must not be shown twice.
    n.handle({ type: 'assistant', parent_tool_use_id: null, message: { id: 'm1', content: [{ type: 'text', text: 'Hi' }, { type: 'tool_use', id: 't1', name: 'mcp__cleo__scene_tree', input: { depth: 2 } }] } });
    n.handle({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '/ (scene root)' }] }] } });
    n.handle({ type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'message_start', message: { id: 'sub1' } } });
    n.handle({ type: 'result', subtype: 'success', total_cost_usd: 0.0123, duration_ms: 900, num_turns: 2, is_error: false });
    assert.deepEqual(out.map(e => e.kind), ['session', 'assistant-start', 'block-start', 'delta', 'block-start', 'tool-input', 'tool-result', 'turn-end']);
    assert.equal(out.find(e => e.kind === 'tool-input').name, 'scene_tree');
    assert.equal(out.find(e => e.kind === 'tool-result').text, '/ (scene root)');
    assert.equal(out.at(-1).costUsd, 0.0123);
});

test('a replayed transcript shows the user turns and the unstreamed text', () => {
    const out = [];
    const n = createNormalizer(ev => out.push(ev), { replay: true });
    n.handle({ type: 'user', message: { role: 'user', content: 'add a cube' } });
    n.handle({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Done.' }] } });
    assert.deepEqual(out.map(e => [e.kind, e.text]), [['user', 'add a cube'], ['assistant-start', undefined], ['block-start', undefined], ['delta', 'Done.']]);
});

test('tool images come through to the panel', () => {
    const r = flattenToolResult([{ type: 'text', text: 'Capture' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'AAAA' } }]);
    assert.deepEqual(r, { text: 'Capture', images: [{ data: 'AAAA', mimeType: 'image/jpeg' }] });
});

test('the chat system prompt carries the engine conventions', () => {
    assert.match(CHAT_SYSTEM_PROMPT, /Euler DEGREES/);
    assert.match(CHAT_SYSTEM_PROMPT, /one undo step/);
});

test('chat: the scripted agent runs a turn through the real tools, asking first in ask mode', async () => {
    const bridge = await host();
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-chat-'));
    const calls = [];
    try {
        new ChatManager({ bridge, dataDir, version: 'test', mock: true });
        const ed = await editor(bridge.port, (method, params) => {
            calls.push(method);
            if (method === 'view.capture') return { text: 'Capture', images: [{ data: 'BBBB', mimeType: 'image/jpeg' }] };
            return { text: `${method} ok` };
        });
        ed.chat('attach');
        const replay = await ed.waitFor(e => e.kind === 'replay');
        assert.equal(replay.state.auth, 'mock');

        ed.chat('setMode', { mode: 'ask' });
        ed.chat('send', { text: 'Add a sphere called "Ball".' });
        const ask = await ed.waitFor(e => e.kind === 'permission');
        assert.equal(ask.tool, 'scene_edit');
        assert.equal(ask.input.ops[0].name, 'Ball');
        assert.deepEqual(calls, ['scene.tree'], 'reading needs no permission; the edit waits for one');
        ed.chat('permission', { requestId: ask.requestId, allow: true });

        const end = await ed.waitFor(e => e.kind === 'turn-end');
        assert.equal(end.isError, false);
        assert.deepEqual(calls, ['scene.tree', 'scene.edit', 'view.capture']);
        const image = ed.events.find(e => e.kind === 'tool-result' && e.images?.length);
        assert.equal(image.images[0].data, 'BBBB');
        assert.ok(ed.events.some(e => e.kind === 'delta' && /Ball/.test(e.text)));

        // A second editor attach (a reload) gets the whole conversation back.
        ed.ws.close();
        const again = await editor(bridge.port, () => ({ text: 'ok' }));
        again.chat('attach');
        const back = await again.waitFor(e => e.kind === 'replay');
        assert.ok(back.events.some(e => e.kind === 'user' && /Ball/.test(e.text)));
        assert.ok(back.events.some(e => e.kind === 'turn-end'));
    } finally { await bridge.close(); }
});

test('chat: a declined edit is reported to the agent and nothing runs', async () => {
    const bridge = await host();
    const calls = [];
    try {
        new ChatManager({ bridge, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-chat-')), version: 'test', mock: true });
        const ed = await editor(bridge.port, method => { calls.push(method); return { text: 'ok' }; });
        ed.chat('setMode', { mode: 'ask' });
        ed.chat('send', { text: 'hi' });
        const ask = await ed.waitFor(e => e.kind === 'permission');
        ed.chat('permission', { requestId: ask.requestId, allow: false });
        await ed.waitFor(e => e.kind === 'turn-end');
        assert.ok(!calls.includes('scene.edit'));
        assert.ok(ed.events.some(e => e.kind === 'tool-result' && e.isError && /declined/.test(e.text)));
    } finally { await bridge.close(); }
});

test('chat: without an API key the panel is told to add one', async () => {
    const bridge = await host();
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
        new ChatManager({ bridge, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-chat-')), version: 'test' });
        const ed = await editor(bridge.port, () => ({ text: 'ok' }));
        ed.chat('attach');
        assert.equal((await ed.waitFor(e => e.kind === 'replay')).state.auth, 'missing');
        ed.chat('send', { text: 'hello' });
        assert.match((await ed.waitFor(e => e.kind === 'error')).message, /API key/);
        ed.chat('setKey', { key: 'not-a-key' });
        assert.match((await ed.waitFor(e => e.kind === 'error' && /sk-ant-/.test(e.message))).message, /sk-ant-/);
    } finally {
        if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
        await bridge.close();
    }
});
