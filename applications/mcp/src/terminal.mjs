// @ts-check
// Claude Code, hosted inside the editor. The agent host runs the user's own `claude` CLI, unmodified, in a
// pseudo-terminal (node-pty) and streams it to the terminal panel in the editor
// (applications/editor/src/features/agentChat/ClaudeCodeView.tsx).
//
// It signs in the way Claude Code always does, through its own login with Anthropic, so it runs on the
// user's Claude plan. Nothing here reads, stores or passes on a credential, and nothing limits how Claude
// Code signs in. The `cleo` MCP server goes in with --mcp-config, so the session works on the open project
// through the same tools as Claude Code anywhere else.
//
// A headless terminal mirrors the screen, so an editor that reloads (or a second tab) gets the exact
// screen back as a snapshot instead of a replay of the raw stream.
//
// Wire protocol, on the editor's bridge socket (bridge.mjs):
//   editor -> host   {type:'term', op:'attach'}                       the screen as a snapshot, then live output
//   editor -> host   {type:'term', op:'start', cols, rows, resume?, auto?}   start Claude Code (see start())
//   editor -> host   {type:'term', op:'input', data} | {op:'resize', cols, rows} | {op:'stop'}
//   editor -> host   {type:'term', op:'sessions', reqId}               the saved conversations, for the picker
//   host -> editor   {type:'term-event', event: {kind:'snapshot', data, state} | {kind:'output', data}
//                                                | {kind:'state', ...state}
//                                                | {kind:'sessions', reqId, sessions, error?}}
//
// The conversation a session is on is followed (claudeSessions.mjs) and remembered in the host's data folder,
// so a host that starts again (the editor's dev server restarted, the machine rebooted) picks the panel's
// conversation back up instead of opening a blank one.

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { withoutClaudeSession } from './env.mjs';
import {
    SESSION_ID, claudeConfigDir, isClaudeProcess, isSaved, listConversations, liveSessions, openElsewhere, processRecord,
} from './claudeSessions.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MCP_ENTRY = path.join(HERE, 'index.mjs');
const PACKAGE_DIR = path.dirname(HERE);
/** The engine checkout this host runs from: where Claude Code starts, so it sees the docs and the code. */
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');

const SCROLLBACK = 10000;
/** Output is batched this long before it goes to the editor: a redraw arrives as many small writes. */
const FLUSH_MS = 8;
const IS_WIN = process.platform === 'win32';
/** How often the running session's record is read: it names the conversation (/clear moves to a new one). */
const SESSION_POLL_MS = 1500;
/** The panel's own conversations remembered for the picker (the newest). */
const HOSTED_KEPT = 300;

/**
 * Appended to Claude Code's own system prompt (an ordinary CLI flag). Kept free of characters cmd.exe
 * treats specially, since a .cmd install runs through it.
 */
export const TERMINAL_PROMPT = 'You are running in a terminal panel inside the Cleo game editor. The cleo MCP '
    + 'tools act on the project open in that editor, live, and the user watches each change in the viewport '
    + 'as you make it. Prefer those tools for anything in the project; the files in this folder are the '
    + 'engine and its docs.';

/**
 * The hosted session runs the Cleo tools without asking (an ordinary CLI permission flag): each change is one
 * undo step in the editor the user is watching. execute_js included: the editor's Allow code execution switch
 * (the Agent chip) is what gates it.
 */
export const ALLOWED_TOOLS = 'mcp__cleo__*';

/**
 * Where the user's `claude` is: CLEO_CLAUDE_PATH, then PATH, then where the native installer puts it.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 * @returns {string | null}
 */
export function findClaude(env = process.env) {
    const override = env.CLEO_CLAUDE_PATH;
    if (override) return isFile(override) ? override : null;
    const names = IS_WIN ? ['claude.exe', 'claude.cmd', 'claude.bat'] : ['claude'];
    const pathVar = env.PATH ?? env.Path ?? Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] ?? '';
    const dirs = String(pathVar).split(path.delimiter).filter(Boolean);
    dirs.push(path.join(os.homedir(), '.local', 'bin'), path.join(os.homedir(), '.claude', 'local'));
    for (const dir of dirs) {
        for (const name of names) {
            const file = path.join(dir, name);
            if (isFile(file)) return file;
        }
    }
    return null;
}

/** @param {string} file */
function isFile(file) {
    try { return fs.statSync(file).isFile(); } catch { return false; }
}

/** @param {string} s cmd.exe quoting: our arguments never hold a double quote (see TERMINAL_PROMPT). */
const cmdQuote = s => /[\s&|<>^()]/.test(s) ? `"${s}"` : s;

/**
 * How to run `claude` with `args`. A .cmd shim (an npm install) has to go through cmd.exe; node-pty takes a
 * ready command line on Windows, so it gets one.
 * @param {string} claude @param {string[]} args
 * @returns {{ file: string, args: string[] | string }}
 */
export function claudeCommand(claude, args) {
    if (IS_WIN && /\.(cmd|bat)$/i.test(claude)) {
        return { file: process.env.ComSpec || 'cmd.exe', args: `/d /s /c "${[claude, ...args].map(cmdQuote).join(' ')}"` };
    }
    return { file: claude, args };
}

/**
 * @typedef {{ code: 'not-installed' | 'no-claude' | 'start-failed' | 'resume-failed', message: string }} Problem
 * @typedef {{ available: boolean, problem: Problem | null, running: boolean, pid: number | null, started: boolean,
 *   exitCode: number | null, cols: number, rows: number, cwd: string, claude: { path: string, version: string | null } | null,
 *   windowsBuild: number | null, sessionId: string | null, resumable: boolean, busy: boolean, title: string | null }} TerminalState
 * @typedef {{ spawn: (file: string, args: string[] | string, opts: object) => any }} PtyModule
 * @typedef {{ pty: PtyModule, Terminal: any, SerializeAddon: any }} TerminalModules
 */

export class TerminalManager {
    /**
     * @param {{ bridge: import('./bridge.mjs').EditorBridge, dataDir: string, discoveryFile: string,
     *   log?: (m: string) => void, cwd?: string, env?: NodeJS.ProcessEnv, modules?: TerminalModules,
     *   claudePath?: string, claudeDir?: string }} opts
     *   `modules`, `claudePath` and `claudeDir` replace the real node-pty / xterm, the PATH lookup and
     *   Claude Code's configuration folder (tests).
     */
    constructor(opts) {
        this.bridge = opts.bridge;
        this.dataDir = opts.dataDir;
        this.discoveryFile = opts.discoveryFile;
        this.log = opts.log ?? (() => {});
        this.env = opts.env ?? process.env;
        this.cwd = opts.cwd ?? this.env.CLEO_CLAUDE_CWD ?? REPO_ROOT;
        /** @type {TerminalModules | null} */
        this.modules = opts.modules ?? null;
        this.fixedClaudePath = opts.claudePath ?? null;
        /** @type {string | null} */
        this.claudePath = null;
        /** @type {string | null} */
        this.claudeVersion = null;
        /** @type {Problem | null} */
        this.problem = null;
        /** @type {any} the node-pty process */
        this.proc = null;
        /** @type {any} the headless mirror of the screen */
        this.mirror = null;
        /** @type {any} */
        this.serializer = null;
        this.cols = 100;
        this.rows = 30;
        this.started = false;
        /** @type {number | null} */
        this.exitCode = null;
        this.pending = '';
        /** @type {NodeJS.Timeout | null} */
        this.flushTimer = null;
        /** @type {string[] | null} output that arrived while a snapshot was being taken */
        this.held = null;
        /** @type {Promise<void>} snapshots one at a time */
        this.snapshots = Promise.resolve();
        /** Claude Code's configuration folder: its per-process records and saved conversations. */
        this.claudeDir = opts.claudeDir ?? claudeConfigDir(this.env);
        this.sessionFile = path.join(this.dataDir, 'claude-code-session.json');
        /** @type {string | null} the conversation the session is on, or was on when it ended */
        this.sessionId = null;
        /** @type {Set<string>} the conversations this panel ran, oldest first, for the picker */
        this.hosted = new Set();
        this.loadSession();
        /** @type {number | null} the process whose record names the conversation (Claude Code's own pid) */
        this.recordPid = null;
        /** Claude Code is working on a turn (its record says busy), not waiting for the user. */
        this.busy = false;
        /** @type {string | null} the terminal title Claude Code set last: the editor's header after a reload */
        this.title = null;
        /** @type {NodeJS.Timeout | null} */
        this.sessionTimer = null;
        this.bridge.on('term', msg => {
            this.onMessage(msg).catch(err => this.log(`terminal: ${err?.stack ?? err}`));
        });
    }

    /** Load node-pty and the headless terminal, and find `claude`. Never throws: problems go in the state. */
    async init() {
        if (!this.modules) {
            try {
                const ptyMod = await import('node-pty');
                const headless = await import('@xterm/headless');
                const serialize = await import('@xterm/addon-serialize');
                this.modules = {
                    pty: /** @type {any} */ (ptyMod).default ?? ptyMod,
                    Terminal: (/** @type {any} */ (headless).default ?? headless).Terminal,
                    SerializeAddon: (/** @type {any} */ (serialize).default ?? serialize).SerializeAddon,
                };
            } catch (err) {
                this.problem = { code: 'not-installed', message: `The terminal packages are not installed (${/** @type {any} */ (err)?.message ?? err}). Run "npm install" in ${PACKAGE_DIR}.` };
                this.log(`terminal unavailable: ${this.problem.message}`);
                return;
            }
        }
        this.locateClaude();
    }

    /** (Re)find `claude`; a user who installs it while the editor is open just presses Check again. */
    locateClaude() {
        if (!this.modules) return;
        this.claudePath = this.fixedClaudePath ?? findClaude(this.env);
        if (!this.claudePath) {
            this.problem = { code: 'no-claude', message: 'Claude Code is not installed on this machine: there is no "claude" on the PATH.' };
            return;
        }
        if (this.problem?.code === 'no-claude') this.problem = null;
        const found = this.claudePath;
        const { file, args } = claudeCommand(found, ['--version']);
        execFile(file, typeof args === 'string' ? [args] : args,
            { windowsHide: true, timeout: 15000, env: withoutClaudeSession(this.env), windowsVerbatimArguments: typeof args === 'string' },
            (err, stdout) => {
                if (err || this.claudePath !== found) return;
                const v = /(\d+\.\d+\.\d+)/.exec(String(stdout))?.[1] ?? null;
                if (v && v !== this.claudeVersion) { this.claudeVersion = v; this.sendState(); }
            });
    }

    get running() { return !!this.proc; }

    /** @returns {TerminalState} */
    state() {
        return {
            available: !!this.modules && !!this.claudePath,
            problem: this.problem,
            running: !!this.proc,
            pid: this.proc?.pid ?? null,
            started: this.started,
            exitCode: this.exitCode,
            cols: this.cols,
            rows: this.rows,
            cwd: this.cwd,
            claude: this.claudePath ? { path: this.claudePath, version: this.claudeVersion } : null,
            // The editor's terminal adapts to a ConPTY (its reflow and wrapping differ): xterm's windowsPty.
            windowsBuild: IS_WIN ? Number(os.release().split('.')[2]) || null : null,
            sessionId: this.sessionId,
            resumable: isSaved(this.claudeDir, this.cwd, this.sessionId),
            busy: !!this.proc && this.busy,
            title: this.title,
        };
    }

    /** @param {any} msg */
    async onMessage(msg) {
        switch (msg?.op) {
            case 'attach': await this.snapshot(); return;
            case 'start': this.start({ cols: msg.cols, rows: msg.rows, resume: msg.resume, auto: !!msg.auto }); return;
            case 'input': if (this.proc && typeof msg.data === 'string') this.proc.write(msg.data); return;
            case 'resize': this.resize(msg.cols, msg.rows); return;
            case 'stop': this.stop('stopped from the editor'); return;
            case 'sessions': await this.sendSessions(msg.reqId); return;
            default: return;
        }
    }

    /** Send the editor the whole screen, then go on streaming. */
    snapshot() {
        this.snapshots = this.snapshots.then(() => this._snapshot(), () => this._snapshot());
        return this.snapshots;
    }

    async _snapshot() {
        const mirror = this.mirror;
        if (!mirror) { this.send({ kind: 'snapshot', data: '', state: this.state() }); return; }
        // Hold new output while the mirror catches up, so nothing is both in the snapshot and sent again.
        this.held = [];
        this.pending = '';
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        try {
            await new Promise(resolve => mirror.write('', resolve));
            const data = mirror === this.mirror ? this.serializer.serialize({ scrollback: SCROLLBACK }) : '';
            this.send({ kind: 'snapshot', data, state: this.state() });
        } finally {
            const held = this.held ?? [];
            this.held = null;
            for (const d of held) this.onOutput(d);
        }
    }

    /** @param {string} data */
    onOutput(data) {
        if (this.held) { this.held.push(data); return; }
        this.mirror?.write(data);
        this.pending += data;
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flush(), FLUSH_MS);
    }

    flush() {
        if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
        if (!this.pending) return;
        const data = this.pending;
        this.pending = '';
        // No editor: dropped from the stream, but the mirror has it for the next attach.
        this.send({ kind: 'output', data });
    }

    /**
     * Start Claude Code, on a fresh conversation unless told otherwise:
     * - `resume: true`: the conversation the panel was last on (Continue last);
     * - `resume: '<session id>'`: that saved conversation (the picker);
     * - `auto`: the last one if it can be picked up, else a fresh one. The editor asks this of a host that
     *   has not run a session yet, so a host that started again carries on where the panel was.
     * A conversation open in another Claude Code is not picked up: two programs would write it at once.
     * @param {{ cols?: unknown, rows?: unknown, resume?: unknown, auto?: boolean }} opts
     */
    start(opts = {}) {
        if (this.proc) { this.sendState(); return; }
        if (this.modules && (!this.claudePath || this.problem?.code === 'no-claude')) this.locateClaude();
        if (!this.modules || !this.claudePath) { this.sendState(); return; }
        this.cols = size(opts.cols, 20, 500, this.cols);
        this.rows = size(opts.rows, 5, 300, this.rows);

        const asked = typeof opts.resume === 'string' || opts.resume === true;
        const wanted = typeof opts.resume === 'string' ? opts.resume : asked || opts.auto ? this.sessionId : null;
        let resumeId = /** @type {string | null} */ (null);
        if (wanted) {
            const elsewhere = SESSION_ID.test(wanted) ? openElsewhere(this.claudeDir, wanted) : null;
            const why = !isSaved(this.claudeDir, this.cwd, wanted) ? 'That conversation is not saved, so it cannot be picked up.'
                : elsewhere ? `That conversation is open in another Claude Code (process ${elsewhere.pid}): close it there first.`
                : null;
            if (!why) resumeId = wanted;
            else if (asked) { this.refuse(why); return; }
        } else if (asked) {
            this.refuse('There is no earlier conversation to pick up.');
            return;
        }
        const sessionId = resumeId ?? crypto.randomUUID();

        this.mirror?.dispose();
        this.mirror = new this.modules.Terminal({ cols: this.cols, rows: this.rows, scrollback: SCROLLBACK, allowProposedApi: true });
        this.serializer = new this.modules.SerializeAddon();
        this.mirror.loadAddon(this.serializer);

        const args = ['--mcp-config', this.writeMcpConfig(), '--allowedTools', ALLOWED_TOOLS, '--append-system-prompt', TERMINAL_PROMPT];
        // An id the host chose for a fresh one: it knows which conversation the session is on from the start.
        args.push(resumeId ? '--resume' : '--session-id', sessionId);
        const { file, args: argv } = claudeCommand(this.claudePath, args);
        const env = {
            ...withoutClaudeSession(this.env),
            TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_HYPERLINK: '1',
            CLEO_AGENT_BRIDGE_FILE: this.discoveryFile,
        };
        let proc;
        try {
            proc = this.modules.pty.spawn(file, argv, { name: 'xterm-256color', cols: this.cols, rows: this.rows, cwd: this.cwd, env });
        } catch (err) {
            this.problem = { code: 'start-failed', message: `Could not start Claude Code: ${/** @type {any} */ (err)?.message ?? err}` };
            this.log(this.problem.message);
            this.sendState();
            return;
        }
        this.proc = proc;
        this.started = true;
        this.exitCode = null;
        this.problem = null;
        this.pending = '';
        this.busy = false;
        this.title = null;
        this.recordPid = null;
        this.mirror.onTitleChange?.((/** @type {string} */ t) => { this.title = t; });
        this.onSession(sessionId);
        this.watchSession(proc);
        this.log(`Claude Code started (pid ${proc.pid}, ${this.cols}x${this.rows}) in ${this.cwd}: ${args.filter(a => a !== TERMINAL_PROMPT).join(' ')}`);
        proc.onData((/** @type {string} */ d) => { if (this.proc === proc) this.onOutput(d); });
        proc.onExit((/** @type {{ exitCode: number }} */ e) => {
            releaseExited(proc);
            if (this.proc !== proc) return;
            this.flush();
            this.unwatchSession();
            this.proc = null;
            this.exitCode = e?.exitCode ?? null;
            this.log(`Claude Code exited (code ${this.exitCode})`);
            this.sendState();
        });
        // A clean screen for the new session, then its output.
        this.send({ kind: 'snapshot', data: '', state: this.state() });
    }

    /** @param {unknown} cols @param {unknown} rows */
    resize(cols, rows) {
        const c = size(cols, 20, 500, this.cols), r = size(rows, 5, 300, this.rows);
        if (c === this.cols && r === this.rows) return;
        this.cols = c;
        this.rows = r;
        try { this.proc?.resize(c, r); } catch { /* it just exited */ }
        this.mirror?.resize(c, r);
    }

    /** @param {string} why */
    stop(why) {
        if (!this.proc) return;
        this.log(`stopping Claude Code (${why})`);
        try { this.proc.kill(); } catch { /* gone already */ }
    }

    dispose() {
        this.stop('the agent host is shutting down');
        this.unwatchSession();
        this.proc = null;
        this.mirror?.dispose();
        this.mirror = null;
    }

    /**
     * The `cleo` server for the hosted session: this checkout's stdio server, talking to this host.
     * CLEO_HOSTED_BY tells it so: it must never replace the host it runs inside (index.mjs).
     */
    writeMcpConfig() {
        const file = path.join(this.dataDir, 'claude-code-mcp.json');
        const env = { CLEO_AGENT_BRIDGE_FILE: this.discoveryFile, CLEO_HOSTED_BY: String(process.pid) };
        const config = { mcpServers: { cleo: { type: 'stdio', command: process.execPath, args: [MCP_ENTRY], env } } };
        fs.writeFileSync(file, JSON.stringify(config, null, 2));
        return file;
    }

    sendState() { this.send({ kind: 'state', ...this.state() }); }

    /** A start that cannot go ahead: said in the state, nothing started. @param {string} message */
    refuse(message) {
        this.problem = { code: 'resume-failed', message };
        this.log(`not started: ${message}`);
        this.sendState();
    }

    /** Follow the running session's record: /clear and /resume move it to another conversation. @param {any} proc */
    watchSession(proc) {
        this.unwatchSession();
        this.sessionTimer = setInterval(() => { if (this.proc === proc) this.readRecord(proc); }, SESSION_POLL_MS);
        this.sessionTimer.unref?.();
    }

    unwatchSession() {
        if (this.sessionTimer) { clearInterval(this.sessionTimer); this.sessionTimer = null; }
    }

    /**
     * Read the session's record. It is filed under Claude Code's pid, which is the terminal's own process
     * unless claude runs through a shim (cmd.exe): then the record naming the conversation the host gave it
     * is found once, and followed by its pid from then on.
     * @param {any} proc
     */
    readRecord(proc) {
        let record = processRecord(this.claudeDir, this.recordPid ?? proc.pid);
        if (!record && this.recordPid === null && this.sessionId) {
            const found = liveSessions(this.claudeDir).get(this.sessionId);
            if (found && isClaudeProcess(found.pid)) record = found;
        }
        if (!record) return;
        this.recordPid = record.pid;
        const busy = record.status === 'busy';
        const moved = record.sessionId !== this.sessionId && SESSION_ID.test(record.sessionId);
        if (moved) this.onSession(record.sessionId);
        if (moved || busy !== this.busy) { this.busy = busy; this.sendState(); }
    }

    /** The session is on conversation `id` now: remembered, so a host that starts again picks it up. @param {string} id */
    onSession(id) {
        this.sessionId = id;
        this.hosted.delete(id);
        this.hosted.add(id);
        while (this.hosted.size > HOSTED_KEPT) this.hosted.delete(/** @type {string} */ (this.hosted.values().next().value));
        try {
            fs.writeFileSync(this.sessionFile, JSON.stringify({ cwd: this.cwd, sessionId: id, hosted: [...this.hosted] }, null, 2));
        } catch (err) {
            this.log(`could not remember the conversation: ${/** @type {any} */ (err)?.message ?? err}`);
        }
    }

    /** What an earlier host remembered, when it ran Claude Code in the same folder. */
    loadSession() {
        try {
            const saved = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
            if (!saved || !samePath(String(saved.cwd ?? ''), this.cwd)) return;
            if (Array.isArray(saved.hosted)) for (const id of saved.hosted) if (SESSION_ID.test(String(id))) this.hosted.add(String(id));
            if (SESSION_ID.test(String(saved.sessionId ?? ''))) this.sessionId = String(saved.sessionId);
        } catch { /* none yet */ }
    }

    /** The saved conversations of the folder Claude Code runs in, for the editor's picker. @param {unknown} reqId */
    async sendSessions(reqId) {
        try {
            const sessions = await listConversations({
                configDir: this.claudeDir, cwd: this.cwd, hosted: this.hosted,
                ownPid: this.proc ? (this.recordPid ?? this.proc.pid) : null,
            });
            this.send({ kind: 'sessions', reqId, sessions });
        } catch (err) {
            this.send({ kind: 'sessions', reqId, sessions: [], error: String(/** @type {any} */ (err)?.message ?? err) });
        }
    }

    /** @param {object} event */
    send(event) { this.bridge.sendToEditor({ type: 'term-event', event }); }
}

/**
 * Free what a pty holds once its program has exited. On Windows node-pty keeps the pseudo console and a
 * reader thread until kill(), and kill() after an exit also hunts for the gone process tree: it forks a
 * helper that fails, waits 5 s, then signals the old pid, which by then may belong to another process. So
 * the console and the reader are closed directly when node-pty's internals are the expected ones.
 * @param {any} proc
 */
function releaseExited(proc) {
    if (!IS_WIN || !proc || released.has(proc)) return; // elsewhere the pty closes with its program
    released.add(proc);
    const agent = proc._agent;
    if (agent && typeof agent._ptyNative?.kill === 'function' && agent._conoutSocketWorker) {
        try { agent._ptyNative.kill(agent._pty, agent._useConptyDll); } catch { /* closed already */ }
        try { agent._conoutSocketWorker.dispose(); } catch { /* ditto */ }
        try { agent._inSocket?.destroy(); } catch { /* ditto */ }
        return;
    }
    try { proc.kill(); } catch { /* gone */ }
}
const released = new WeakSet();

/** @param {string} a @param {string} b */
function samePath(a, b) {
    if (!a || !b) return false;
    const [pa, pb] = [path.resolve(a), path.resolve(b)];
    return IS_WIN ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

/** @param {unknown} v @param {number} min @param {number} max @param {number} fallback */
function size(v, min, max, fallback) {
    const n = Math.round(Number(v));
    return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : fallback;
}
