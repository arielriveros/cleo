// @ts-check
// Claude Code's saved conversations, as the hosted session needs them (terminal.mjs):
//   - which conversation a running Claude Code is on. It keeps a small record per process in
//     <config>/sessions/<pid>.json, rewritten when /clear or /resume moves it to another conversation and
//     removed when it exits;
//   - the conversations it saved for a folder, <config>/projects/<folder>/<session id>.jsonl (one JSON object
//     per line), for the Claude panel's conversation picker. `claude --resume <id>` picks one up.
//
// Both are Claude Code's own files: read here, never written. Their layout is not a published interface, so
// everything reads defensively, and what it does not understand is left out rather than failing the list.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How much of a conversation's start is read for its first prompt, and of its end for its title. */
const HEAD_BYTES = 128 * 1024;
const TAIL_BYTES = 256 * 1024;

/**
 * Claude Code's configuration folder: CLAUDE_CONFIG_DIR, or ~/.claude.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} [env]
 */
export function claudeConfigDir(env = process.env) {
    return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * The folder Claude Code saves the conversations of `cwd` in: the path with every character other than a
 * letter or a digit made '-'. A case-insensitive match is taken when the exact name is not there (the
 * drive letter of the same Windows folder comes in either case).
 * @param {string} configDir @param {string} cwd
 */
export function projectDir(configDir, cwd) {
    const root = path.join(configDir, 'projects');
    const name = cwd.replace(/[^a-zA-Z0-9]/g, '-');
    const exact = path.join(root, name);
    if (fs.existsSync(exact)) return exact;
    try {
        const match = fs.readdirSync(root).find(n => n.toLowerCase() === name.toLowerCase());
        if (match) return path.join(root, match);
    } catch { /* no conversations saved yet */ }
    return exact;
}

/**
 * Whether the conversation `id` of `cwd` is saved, so `--resume` can pick it up. Claude Code writes the
 * file with the first message: a session nobody typed in has none.
 * @param {string} configDir @param {string} cwd @param {string | null | undefined} id
 */
export function isSaved(configDir, cwd, id) {
    if (!id || !SESSION_ID.test(id)) return false;
    try { return fs.statSync(path.join(projectDir(configDir, cwd), `${id}.jsonl`)).isFile(); } catch { return false; }
}

/** @param {number} pid */
function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return /** @type {any} */ (err).code === 'EPERM'; }
}

const IS_WIN = process.platform === 'win32';
/** What Claude Code runs as: its native build, or Node or Bun running the npm package. */
const CLAUDE_IMAGE = /claude|node|bun/i;

/** @param {string} out tasklist's CSV @returns {Map<number, string>} pid -> image name */
function parseTasklist(out) {
    /** @type {Map<number, string>} */
    const images = new Map();
    for (const line of out.split(/\r?\n/)) {
        const m = /^"([^"]+)","(\d+)"/.exec(line);
        if (m) images.set(Number(m[2]), m[1]);
    }
    return images;
}

/**
 * Whether `pid` still is a Claude Code. A record outlives a Claude Code that was killed or crashed, and
 * Windows hands its pid to another program soon after (a browser tab, say): there the program's image name
 * is checked too. Elsewhere pids come round slowly enough that a live one is taken as it.
 * @param {number} pid @param {Map<number, string> | null} [images] the running programs, when already read
 */
export function isClaudeProcess(pid, images = null) {
    if (!alive(pid)) return false;
    if (!IS_WIN) return true;
    if (!images) {
        try {
            images = parseTasklist(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 }));
        } catch { return true; }
    }
    const image = images.get(pid);
    return image !== undefined && CLAUDE_IMAGE.test(image);
}

/** The running programs, read once for a whole list (Windows only; null elsewhere or when it fails). */
function runningImages() {
    if (!IS_WIN) return Promise.resolve(null);
    return new Promise(resolve => {
        execFile('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024 },
            (err, out) => resolve(err ? null : parseTasklist(String(out))));
    });
}

/**
 * @typedef {{ pid: number, sessionId: string, cwd?: string, status?: string, entrypoint?: string }} ProcessRecord
 */

/**
 * The record of the Claude Code running as `pid`, or null.
 * @param {string} configDir @param {number} pid @returns {ProcessRecord | null}
 */
export function processRecord(configDir, pid) {
    try {
        const r = JSON.parse(fs.readFileSync(path.join(configDir, 'sessions', `${pid}.json`), 'utf8'));
        return typeof r?.sessionId === 'string' && typeof r?.pid === 'number' ? r : null;
    } catch { return null; }
}

/**
 * The Claude Codes running on this machine by their records, by the conversation each is on: every record
 * whose process is alive. A pid can have gone to another program since: check one with isClaudeProcess
 * before acting on it.
 * @param {string} configDir @returns {Map<string, ProcessRecord>}
 */
export function liveSessions(configDir) {
    /** @type {Map<string, ProcessRecord>} */
    const out = new Map();
    let names = /** @type {string[]} */ ([]);
    try { names = fs.readdirSync(path.join(configDir, 'sessions')); } catch { return out; }
    for (const name of names) {
        const m = /^(\d+)\.json$/.exec(name);
        if (!m) continue;
        const r = processRecord(configDir, Number(m[1]));
        if (r && alive(r.pid)) out.set(r.sessionId, r);
    }
    return out;
}

/**
 * The Claude Code that has conversation `id` open now, other than `ownPid`, or null.
 * @param {string} configDir @param {string} id @param {number | null} [ownPid]
 */
export function openElsewhere(configDir, id, ownPid = null) {
    const r = liveSessions(configDir).get(id);
    return r && r.pid !== ownPid && isClaudeProcess(r.pid) ? r : null;
}

/**
 * @typedef {{ id: string, title: string, prompt: string | null, modifiedAt: number, createdAt: number | null,
 *   entrypoint: string | null, branch: string | null, hosted: boolean, livePid: number | null }} Conversation
 * @typedef {{ title: string, prompt: string | null, createdAt: number | null, entrypoint: string | null,
 *   branch: string | null }} ConversationMeta
 */

/** file -> what was read from it, kept while its size and time stay the same. @type {Map<string, { size: number, mtimeMs: number, meta: ConversationMeta | null }>} */
const metaCache = new Map();

/**
 * The conversations saved for `cwd`, the most recently used first: up to `limit` that have something typed
 * in them. `hosted`: the ids the Claude panel ran, flagged as its own. `livePid`: the process that has one
 * open now, other than `ownPid` (resuming it there too would have two programs writing one conversation).
 * @param {{ configDir: string, cwd: string, limit?: number, hosted?: Set<string>, ownPid?: number | null }} opts
 * @returns {Promise<Conversation[]>}
 */
export async function listConversations({ configDir, cwd, limit = 100, hosted = new Set(), ownPid = null }) {
    const dir = projectDir(configDir, cwd);
    let names = /** @type {string[]} */ ([]);
    try { names = await fsp.readdir(dir); } catch { return []; }
    /** @type {{ id: string, file: string, size: number, mtimeMs: number }[]} */
    const files = [];
    await Promise.all(names.map(async name => {
        const id = name.endsWith('.jsonl') ? name.slice(0, -6) : '';
        if (!SESSION_ID.test(id)) return;
        const file = path.join(dir, name);
        try {
            const st = await fsp.stat(file);
            if (st.isFile() && st.size > 0) files.push({ id, file, size: st.size, mtimeMs: st.mtimeMs });
        } catch { /* removed meanwhile */ }
    }));
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const live = liveSessions(configDir);
    const images = live.size ? await runningImages() : null;
    for (const [id, r] of live) if (!isClaudeProcess(r.pid, images ?? undefined)) live.delete(id);

    /** @type {Conversation[]} */
    const out = [];
    // A few files at a time, in order, until the list is full: most of a long history is never read.
    for (let i = 0; i < files.length && out.length < limit; i += 8) {
        const batch = files.slice(i, i + 8);
        const metas = await Promise.all(batch.map(f => conversationMeta(f).catch(() => null)));
        batch.forEach((f, k) => {
            const meta = metas[k];
            if (!meta || out.length >= limit) return;
            const pid = live.get(f.id)?.pid ?? null;
            out.push({ id: f.id, ...meta, modifiedAt: Math.round(f.mtimeMs), hosted: hosted.has(f.id), livePid: pid !== null && pid !== ownPid ? pid : null });
        });
    }
    return out;
}

/**
 * A conversation's title and first prompt, from the start and the end of its file, or null when nothing
 * was typed in it (only a /clear, say).
 * @param {{ file: string, size: number, mtimeMs: number }} f
 */
async function conversationMeta(f) {
    const hit = metaCache.get(f.file);
    if (hit && hit.size === f.size && hit.mtimeMs === f.mtimeMs) return hit.meta;
    const fh = await fsp.open(f.file, 'r');
    try {
        const read = async (/** @type {number} */ start, /** @type {number} */ length) => {
            const buf = Buffer.alloc(length);
            const { bytesRead } = await fh.read(buf, 0, length, start);
            return buf.subarray(0, bytesRead).toString('utf8');
        };
        const head = await read(0, Math.min(f.size, HEAD_BYTES));
        const tailStart = Math.max(HEAD_BYTES, f.size - TAIL_BYTES);
        const tail = f.size > tailStart ? await read(tailStart, f.size - tailStart) : '';
        const meta = parseConversation(head, tail);
        metaCache.set(f.file, { size: f.size, mtimeMs: f.mtimeMs, meta });
        return meta;
    } finally {
        await fh.close();
    }
}

const TITLE_LINE = /"type":\s*"(custom-title|ai-title|summary|last-prompt)"/;
const USER_LINE = /"type":\s*"user"/;

/**
 * What the picker shows of a conversation, from the text at its start and at its end (either may begin or
 * end part-way through a line: those lines are skipped). The title is the one given with /rename, else the
 * one Claude Code wrote for it, else its first prompt. Exported for the tests.
 * @param {string} head @param {string} tail @returns {ConversationMeta | null}
 */
export function parseConversation(head, tail = '') {
    let prompt = /** @type {string | null} */ (null);
    let createdAt = /** @type {number | null} */ (null);
    let entrypoint = /** @type {string | null} */ (null);
    let branch = /** @type {string | null} */ (null);
    for (const line of head.split('\n')) {
        if (!USER_LINE.test(line)) continue;
        const j = parseLine(line);
        if (!j || j.type !== 'user' || j.isMeta || j.isSidechain) continue;
        if (entrypoint === null && typeof j.entrypoint === 'string') entrypoint = j.entrypoint;
        if (createdAt === null && typeof j.timestamp === 'string') createdAt = Date.parse(j.timestamp) || null;
        if (branch === null && typeof j.gitBranch === 'string' && j.gitBranch) branch = j.gitBranch;
        prompt = promptText(j.message?.content);
        if (prompt) break;
    }
    // Titles are written again as a conversation goes on: the last of each kind is the current one.
    let custom = null, ai = null, summary = null, lastPrompt = null;
    for (const chunk of [head, tail]) {
        for (const line of chunk.split('\n')) {
            if (!TITLE_LINE.test(line)) continue;
            const j = parseLine(line);
            if (!j) continue;
            if (j.type === 'custom-title' && typeof j.customTitle === 'string') custom = j.customTitle;
            else if (j.type === 'ai-title' && typeof j.aiTitle === 'string') ai = j.aiTitle;
            else if (j.type === 'summary' && typeof j.summary === 'string') summary = j.summary;
            else if (j.type === 'last-prompt' && typeof j.lastPrompt === 'string') lastPrompt = j.lastPrompt;
        }
    }
    const title = clip(custom) ?? clip(ai) ?? clip(summary) ?? prompt ?? promptText(lastPrompt);
    if (!title) return null;
    return { title, prompt, createdAt, entrypoint, branch };
}

/** @param {string} line */
function parseLine(line) {
    try { return JSON.parse(line); } catch { return null; }
}

/**
 * The words of a prompt: its text without what the client wrapped around it (reminders, attached context,
 * a local command's output), on one line, clipped. Null when nothing is left.
 * @param {unknown} content
 */
export function promptText(content) {
    let text = typeof content === 'string' ? content
        : Array.isArray(content) ? content.filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')
        : '';
    // Pasted text is the user's own words: only its markers go.
    text = text.replace(/<\/?pasted_content(\s[^>]*)?>/gi, ' ');
    let before;
    do {
        before = text;
        text = text.replace(/<([a-z][\w-]*)(\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ');
    } while (text !== before);
    return clip(text);
}

/** @param {string | null} text */
function clip(text) {
    const t = (text ?? '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    return t.length > 160 ? `${t.slice(0, 159)}…` : t;
}
