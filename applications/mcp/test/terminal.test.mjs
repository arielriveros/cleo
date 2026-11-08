// Claude Code hosted in the editor (terminal.mjs): how it is found and started, the screen mirror that an
// editor re-attaching gets back, and the environment it is given. One test runs a real pseudo-terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { TERMINAL_PROMPT, TerminalManager, claudeCommand, findClaude } from '../src/terminal.mjs';
import { olderThan, withoutClaudeSession } from '../src/env.mjs';

const XTERM = { Terminal: headless.Terminal, SerializeAddon: serialize.SerializeAddon };

/** Stands in for the EditorBridge: the frames the editor would get, and `term` ops as the editor sends them. */
class FakeBridge extends EventEmitter {
    constructor() { super(); this.frames = []; }
    sendToEditor(frame) { this.frames.push(frame); return true; }
    op(op, extra = {}) { this.emit('term', { type: 'term', op, ...extra }); }
    events(kind) { return this.frames.filter(f => f.type === 'term-event' && f.event.kind === kind).map(f => f.event); }
}

/** A node-pty stand-in that records what it was asked to do. */
function fakePty() {
    const spawned = [];
    const module = {
        spawn(file, args, opts) {
            const p = {
                pid: 4242, file, args, opts, written: [], sizes: [], killed: false, dataCb: null, exitCb: null,
                write(d) { this.written.push(d); },
                resize(c, r) { this.sizes.push([c, r]); },
                kill() { this.killed = true; setTimeout(() => this.exitCb?.({ exitCode: 0 }), 0); },
                onData(cb) { this.dataCb = cb; },
                onExit(cb) { this.exitCb = cb; },
                emit(d) { this.dataCb?.(d); },
            };
            spawned.push(p);
            return p;
        },
    };
    return { spawned, module };
}

async function until(pred, ms = 3000) {
    const end = Date.now() + ms;
    while (Date.now() < end) { const v = pred(); if (v) return v; await new Promise(r => setTimeout(r, 10)); }
    throw new Error('timed out');
}

function tmp() { return fs.mkdtempSync(path.join(os.tmpdir(), 'cleo-term-')); }

function manager({ env = { PATH: '' }, pty = fakePty() } = {}) {
    const bridge = new FakeBridge();
    const dataDir = tmp();
    const mgr = new TerminalManager({
        bridge, dataDir, discoveryFile: path.join(dataDir, 'agent-bridge.json'), env, cwd: dataDir,
        modules: { pty: pty.module, ...XTERM }, claudePath: process.execPath,
    });
    return { bridge, mgr, pty, dataDir };
}

test('the session markers of a parent Claude Code are dropped, a plain shell keeps its settings', () => {
    const fromSession = withoutClaudeSession({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_PID: '9', CLAUDE_CODE_MESSAGING_SOCKET: 'x', PATH: '/bin', HOME: '/h' });
    assert.deepEqual(fromSession, { PATH: '/bin', HOME: '/h' });
    const shell = withoutClaudeSession({ CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin', GONE: undefined });
    assert.deepEqual(shell, { CLAUDE_CODE_USE_BEDROCK: '1', PATH: '/bin' });
});

test('versions compare by number', () => {
    assert.equal(olderThan('0.1.0', '0.2.0'), true);
    assert.equal(olderThan('0.10.0', '0.9.0'), false);
    assert.equal(olderThan('0.2.0', '0.2.0'), false);
    assert.equal(olderThan(undefined, '0.2.0'), true);
});

test('claude is found on the PATH, or where CLEO_CLAUDE_PATH says', () => {
    const dir = tmp();
    const name = process.platform === 'win32' ? 'claude.exe' : 'claude';
    fs.writeFileSync(path.join(dir, name), '');
    assert.equal(findClaude({ PATH: `${tmp()}${path.delimiter}${dir}` }), path.join(dir, name));
    assert.equal(findClaude({ CLEO_CLAUDE_PATH: path.join(dir, name), PATH: '' }), path.join(dir, name));
    assert.equal(findClaude({ CLEO_CLAUDE_PATH: path.join(dir, 'missing'), PATH: dir }), null);
});

test('a .cmd install runs through cmd.exe, a binary directly', { skip: process.platform !== 'win32' }, () => {
    assert.deepEqual(claudeCommand('C:\\bin\\claude.exe', ['--version']), { file: 'C:\\bin\\claude.exe', args: ['--version'] });
    const viaCmd = claudeCommand('C:\\npm\\claude.cmd', ['--append-system-prompt', 'two words']);
    assert.match(String(viaCmd.file), /cmd(\.exe)?$/i);
    assert.equal(viaCmd.args, '/d /s /c "C:\\npm\\claude.cmd --append-system-prompt "two words""');
});

test('start runs claude with the cleo MCP server, a clean environment and the editor size', async () => {
    const { bridge, mgr, pty, dataDir } = manager({ env: { PATH: '/bin', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'parent' } });
    await mgr.init();
    bridge.op('start', { cols: 120, rows: 40 });
    const p = await until(() => pty.spawned[0]);
    assert.equal(p.file, process.execPath);
    assert.deepEqual(p.args.slice(0, 1), ['--mcp-config']);
    assert.deepEqual(p.args.slice(2), ['--append-system-prompt', TERMINAL_PROMPT]);
    const config = JSON.parse(fs.readFileSync(p.args[1], 'utf8'));
    assert.match(config.mcpServers.cleo.args[0], /index\.mjs$/);
    assert.equal(config.mcpServers.cleo.env.CLEO_AGENT_BRIDGE_FILE, path.join(dataDir, 'agent-bridge.json'));
    assert.equal(p.opts.cols, 120);
    assert.equal(p.opts.rows, 40);
    assert.equal(p.opts.cwd, dataDir);
    assert.equal(p.opts.env.CLAUDECODE, undefined);
    assert.equal(p.opts.env.CLAUDE_CODE_SESSION_ID, undefined);
    assert.equal(p.opts.env.TERM, 'xterm-256color');
    assert.equal(p.opts.env.PATH, '/bin');
    // The editor's screen is cleared for the new session.
    assert.deepEqual(bridge.events('snapshot').map(e => e.data), ['']);
    assert.equal(bridge.events('snapshot')[0].state.running, true);

    bridge.op('start', { cols: 80, rows: 24 });
    await new Promise(r => setTimeout(r, 20));
    assert.equal(pty.spawned.length, 1, 'a second start while running only reports the state');

    mgr.stop('test');
    await until(() => bridge.events('state').some(s => !s.running));
});

test('output streams in batches, input and resizes reach the terminal, and an exit is reported', async () => {
    const { bridge, mgr, pty } = manager();
    await mgr.init();
    bridge.op('start', { cols: 80, rows: 24 });
    const p = await until(() => pty.spawned[0]);
    p.emit('one ');
    p.emit('two');
    const out = await until(() => bridge.events('output')[0]);
    assert.equal(out.data, 'one two', 'writes that arrive together go as one frame');

    bridge.op('input', { data: 'hi\r' });
    bridge.op('resize', { cols: 90, rows: 30 });
    bridge.op('resize', { cols: 90, rows: 30 });
    await until(() => p.written.length && p.sizes.length);
    assert.deepEqual(p.written, ['hi\r']);
    assert.deepEqual(p.sizes, [[90, 30]], 'an unchanged size is not passed on');

    p.exitCb({ exitCode: 3 });
    const st = await until(() => bridge.events('state').find(s => !s.running));
    assert.equal(st.exitCode, 3);
    assert.equal(st.started, true);
    bridge.op('input', { data: 'ignored' });
    assert.deepEqual(p.written, ['hi\r']);
});

test('an editor that attaches mid-session gets the screen, and nothing twice', async () => {
    const { bridge, mgr, pty } = manager();
    await mgr.init();
    bridge.op('start', { cols: 60, rows: 10 });
    const p = await until(() => pty.spawned[0]);
    p.emit('\x1b[1mWelcome to Claude Code\x1b[0m\r\n> ');
    await until(() => bridge.events('output').length === 1);

    p.emit('during');                    // not flushed yet when the snapshot is taken
    bridge.op('attach');
    const snap = await until(() => bridge.events('snapshot')[1]);
    assert.match(snap.data, /Welcome to Claude Code/);
    assert.match(snap.data, /during/);
    assert.equal(snap.state.running, true);

    p.emit('after');
    await until(() => bridge.events('output').some(e => e.data.includes('after')));
    assert.ok(!bridge.events('output').some(e => e.data.includes('during')), 'what the snapshot holds is not streamed again');
    mgr.dispose();
});

test('without claude the state says so, and start only reports it', async () => {
    const bridge = new FakeBridge();
    const dataDir = tmp();
    const pty = fakePty();
    const mgr = new TerminalManager({ bridge, dataDir, discoveryFile: path.join(dataDir, 'd.json'), env: { CLEO_CLAUDE_PATH: path.join(dataDir, 'nope') },
        modules: { pty: pty.module, ...XTERM } });
    await mgr.init();
    assert.equal(mgr.state().available, false);
    assert.equal(mgr.state().problem?.code, 'no-claude');
    bridge.op('start');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(pty.spawned.length, 0);
    assert.equal(bridge.events('state').at(-1)?.problem?.code, 'no-claude');
});

test('a real pseudo-terminal carries the program output and its exit code', async () => {
    // node stands in for claude: it rejects the --mcp-config option and exits 9, through a real node-pty.
    const bridge = new FakeBridge();
    const dataDir = tmp();
    const mgr = new TerminalManager({ bridge, dataDir, discoveryFile: path.join(dataDir, 'd.json'), env: process.env, cwd: dataDir, claudePath: process.execPath });
    await mgr.init();
    assert.equal(mgr.state().problem, null);
    bridge.op('start', { cols: 100, rows: 20 });
    const st = await until(() => bridge.events('state').find(s => !s.running && s.started), 15000);
    assert.equal(st.exitCode, 9);
    assert.match(bridge.events('output').map(e => e.data).join(''), /bad option: --mcp-config/);
    bridge.op('attach');
    const snap = await until(() => bridge.events('snapshot')[1]);
    assert.match(snap.data, /bad option/, 'the mirror keeps the last screen after the exit');
    mgr.dispose();
});
