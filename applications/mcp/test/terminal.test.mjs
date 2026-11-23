// Claude Code hosted in the editor (terminal.mjs): how it is found and started, the screen mirror that an
// editor re-attaching gets back, and the environment it is given. One test runs a real pseudo-terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import headless from '@xterm/headless';
import serialize from '@xterm/addon-serialize';
import { ALLOWED_TOOLS, TERMINAL_PROMPT, TerminalManager, claudeCommand, findClaude } from '../src/terminal.mjs';
import { olderThan, withoutClaudeSession } from '../src/env.mjs';
import { parseConversation, promptText } from '../src/claudeSessions.mjs';

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

function manager({ env = { PATH: '' }, pty = fakePty(), dataDir = tmp(), claudeDir = path.join(dataDir, 'claude') } = {}) {
    const bridge = new FakeBridge();
    const mgr = new TerminalManager({
        bridge, dataDir, discoveryFile: path.join(dataDir, 'agent-bridge.json'), env, cwd: dataDir,
        modules: { pty: pty.module, ...XTERM }, claudePath: process.execPath, claudeDir,
    });
    return { bridge, mgr, pty, dataDir, claudeDir };
}

/** @param {string[]} args @param {string} name */
const flagOf = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

/** A conversation Claude Code saved for `cwd`, as lines of its transcript. */
function saveConversation(claudeDir, cwd, id, lines, mtime) {
    const dir = path.join(claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n');
    if (mtime) fs.utimesSync(file, mtime, mtime);
    return file;
}

/** Claude Code's record of a running process. */
function recordProcess(claudeDir, pid, sessionId, extra = {}) {
    fs.mkdirSync(path.join(claudeDir, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, entrypoint: 'cli', status: 'idle', ...extra }));
}

const prompt = (text, extra = {}) => ({ type: 'user', message: { role: 'user', content: text }, entrypoint: 'cli', timestamp: '2026-11-20T10:00:00.000Z', ...extra });

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
    const flag = (/** @type {string} */ name) => p.args[p.args.indexOf(name) + 1];
    // The Cleo tools run without a permission prompt each (execute_js still asks: requiresUserInteraction).
    assert.equal(flag('--allowedTools'), ALLOWED_TOOLS);
    assert.equal(ALLOWED_TOOLS, 'mcp__cleo__*');
    assert.equal(flag('--append-system-prompt'), TERMINAL_PROMPT);
    const config = JSON.parse(fs.readFileSync(flag('--mcp-config'), 'utf8'));
    assert.match(config.mcpServers.cleo.args[0], /index\.mjs$/);
    assert.equal(config.mcpServers.cleo.env.CLEO_AGENT_BRIDGE_FILE, path.join(dataDir, 'agent-bridge.json'));
    // A session the host runs must never replace that host (index.mjs reads this).
    assert.equal(config.mcpServers.cleo.env.CLEO_HOSTED_BY, String(process.pid));
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

test('a fresh session gets an id the host chose, and the host follows it through /clear', async () => {
    const { bridge, mgr, pty, claudeDir, dataDir } = manager();
    await mgr.init();
    bridge.op('start', { cols: 80, rows: 24 });
    const p = await until(() => pty.spawned[0]);
    const id = flagOf(p.args, '--session-id');
    assert.match(String(id), /^[0-9a-f-]{36}$/);
    assert.equal(flagOf(p.args, '--resume'), undefined);
    assert.equal(mgr.state().sessionId, id);
    assert.equal(mgr.state().resumable, false, 'nothing typed yet: nothing saved to pick up');

    // Claude Code files its record under its pid; /clear moves it to a new conversation, and work marks it busy.
    const cleared = '7abeff40-b554-4f2b-b1ef-3c3b04c7df5c';
    recordProcess(claudeDir, p.pid, cleared, { status: 'busy' });
    const moved = await until(() => bridge.events('state').find(s => s.sessionId === cleared), 4000);
    assert.equal(moved.busy, true);
    const remembered = JSON.parse(fs.readFileSync(path.join(dataDir, 'claude-code-session.json'), 'utf8'));
    assert.equal(remembered.sessionId, cleared);
    assert.deepEqual(remembered.hosted, [id, cleared]);
    mgr.dispose();
});

test('a host that starts again picks the panel\'s conversation back up, and Continue last does too', async () => {
    const dataDir = tmp();
    const first = manager({ dataDir });
    await first.mgr.init();
    first.bridge.op('start', {});
    const id = flagOf((await until(() => first.pty.spawned[0])).args, '--session-id');
    saveConversation(first.claudeDir, dataDir, id, [prompt('make the cube spin')]);
    first.mgr.dispose();

    // A new host (the dev server restarted): the editor's first start is `auto`.
    const again = manager({ dataDir });
    await again.mgr.init();
    assert.equal(again.mgr.state().sessionId, id);
    assert.equal(again.mgr.state().resumable, true);
    again.bridge.op('start', { auto: true });
    const p = await until(() => again.pty.spawned[0]);
    assert.equal(flagOf(p.args, '--resume'), id);
    assert.equal(flagOf(p.args, '--session-id'), undefined);
    assert.ok(!p.args.includes('--continue'), 'never the folder\'s most recent conversation: it may be another program\'s');
    p.exitCb({ exitCode: 0 });
    await until(() => again.bridge.events('state').some(s => !s.running));

    again.bridge.op('start', { resume: true });
    assert.equal(flagOf((await until(() => again.pty.spawned[1])).args, '--resume'), id);
    again.mgr.dispose();
});

test('auto starts fresh when there is nothing to pick up; asking for a conversation that cannot be had says why', async () => {
    const { bridge, mgr, pty, claudeDir, dataDir } = manager();
    await mgr.init();
    bridge.op('start', { resume: true });
    await until(() => bridge.events('state').some(s => s.problem?.code === 'resume-failed'));
    assert.equal(pty.spawned.length, 0);

    bridge.op('start', { auto: true });
    const p = await until(() => pty.spawned[0]);
    assert.ok(flagOf(p.args, '--session-id'));
    assert.equal(mgr.state().problem, null);
    p.exitCb({ exitCode: 0 });
    await until(() => bridge.events('state').some(s => !s.running));

    // Open in another Claude Code (this test's own process stands in for it: a pid that is alive).
    const other = 'c38208c2-d337-4637-8ef7-08e368d3dca4';
    saveConversation(claudeDir, dataDir, other, [prompt('the other one')]);
    recordProcess(claudeDir, process.pid, other);
    bridge.op('start', { resume: other });
    const refused = await until(() => bridge.events('state').find(s => /another Claude Code/.test(s.problem?.message ?? '')));
    assert.match(refused.problem.message, new RegExp(String(process.pid)));
    bridge.op('start', { resume: 'not-an-id' });
    await until(() => bridge.events('state').some(s => /not saved/.test(s.problem?.message ?? '')));
    assert.equal(pty.spawned.length, 1);
    mgr.dispose();
});

test('the picker lists the folder\'s conversations, newest first, with their titles and where they run', async () => {
    const { bridge, mgr, pty, claudeDir, dataDir } = manager();
    await mgr.init();
    bridge.op('start', {});
    const own = flagOf((await until(() => pty.spawned[0])).args, '--session-id');
    const t = (/** @type {number} */ h) => new Date(Date.UTC(2026, 10, 20, h));
    saveConversation(claudeDir, dataDir, own, [prompt('build a door')], t(9));
    const vscode = '01d36ca5-d040-4bda-a4bc-3ae9aea94ff4';
    saveConversation(claudeDir, dataDir, vscode, [
        { type: 'mode', mode: 'normal', sessionId: vscode },
        prompt([{ type: 'text', text: '<browser_instruction>use the browser</browser_instruction>' }, { type: 'text', text: 'fix the  water\nshader' }], { entrypoint: 'claude-vscode', gitBranch: 'development' }),
        { type: 'ai-title', aiTitle: 'Water shader fix', sessionId: vscode },
        { type: 'custom-title', customTitle: 'Water, renamed', sessionId: vscode },
        { type: 'ai-title', aiTitle: 'Water shader fix again', sessionId: vscode },
    ], t(12));
    // Only a local command: nothing was asked, so it is not listed.
    saveConversation(claudeDir, dataDir, '344bccc7-59c1-420e-9695-d20cb5c8fb24', [prompt('<command-name>/clear</command-name><command-message>clear</command-message>')], t(11));
    const live = 'ac5364d7-ac33-4895-a8c1-24fa1b2c274f';
    saveConversation(claudeDir, dataDir, live, [prompt('<local-command-caveat>x</local-command-caveat>'), prompt('mouse input')], t(10));
    recordProcess(claudeDir, process.pid, live);

    bridge.op('sessions', { reqId: 7 });
    const ev = await until(() => bridge.events('sessions')[0], 15000); // tasklist runs for it: slow under a loaded suite
    assert.equal(ev.reqId, 7);
    assert.deepEqual(ev.sessions.map(s => s.id), [vscode, live, own]);
    const [v, l, o] = ev.sessions;
    assert.equal(v.title, 'Water, renamed', 'a /rename wins over the title Claude Code wrote');
    assert.equal(v.prompt, 'fix the water shader', 'the wrapped-in context is not the prompt');
    assert.equal(v.entrypoint, 'claude-vscode');
    assert.equal(v.branch, 'development');
    assert.equal(v.hosted, false);
    assert.equal(l.title, 'mouse input');
    assert.equal(l.livePid, process.pid);
    assert.equal(o.title, 'build a door');
    assert.equal(o.hosted, true);
    assert.equal(o.livePid, null);
    mgr.dispose();
});

test('a record left by a Claude Code that was killed does not hold its conversation once Windows reuses the pid', { skip: process.platform !== 'win32' }, async () => {
    const { bridge, mgr, pty, claudeDir, dataDir } = manager();
    await mgr.init();
    const id = '9d655794-7aa9-4795-9d83-6ddf28a42ef1';
    saveConversation(claudeDir, dataDir, id, [prompt('the killed one')]);
    // Another program now runs under the dead Claude Code's pid.
    const other = spawn('ping', ['-n', '30', '127.0.0.1'], { windowsHide: true, stdio: 'ignore' });
    try {
        recordProcess(claudeDir, other.pid, id);
        bridge.op('sessions', { reqId: 1 });
        const listed = (await until(() => bridge.events('sessions')[0], 15000)).sessions;
        assert.equal(listed.find(s => s.id === id)?.livePid, null);
        bridge.op('start', { resume: id });
        assert.equal(flagOf((await until(() => pty.spawned[0])).args, '--resume'), id);
    } finally {
        other.kill();
        mgr.dispose();
    }
});

test('a long conversation is read at its two ends only', () => {
    const big = 'x'.repeat(300_000);
    const head = JSON.stringify(prompt('first question')) + '\n' + JSON.stringify({ type: 'assistant', text: big.slice(0, 50) }) + '\n{"type":"assist';
    const tail = 'ant","cut":"' + big.slice(0, 20) + '"}\n' + JSON.stringify({ type: 'ai-title', aiTitle: 'Late title' }) + '\n';
    assert.deepEqual(parseConversation(head, tail), { title: 'Late title', prompt: 'first question', createdAt: Date.parse('2026-11-20T10:00:00.000Z'), entrypoint: 'cli', branch: null });
    assert.equal(parseConversation(JSON.stringify({ type: 'mode', mode: 'normal' })), null);
    assert.equal(promptText([{ type: 'text', text: '<system-reminder>a <b>c</b></system-reminder> real  words ' }, { type: 'image' }]), 'real words');
    assert.equal(promptText('<pasted_content id="33f0">In the sandbox</pasted_content> add a car'), 'In the sandbox add a car');
});

test('without claude the state says so, and start only reports it', async () => {
    const bridge = new FakeBridge();
    const dataDir = tmp();
    const pty = fakePty();
    const mgr = new TerminalManager({ bridge, dataDir, discoveryFile: path.join(dataDir, 'd.json'), env: { CLEO_CLAUDE_PATH: path.join(dataDir, 'nope') }, claudeDir: path.join(dataDir, 'claude'),
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
    const mgr = new TerminalManager({ bridge, dataDir, discoveryFile: path.join(dataDir, 'd.json'), env: process.env, cwd: dataDir, claudePath: process.execPath, claudeDir: path.join(dataDir, 'claude') });
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
