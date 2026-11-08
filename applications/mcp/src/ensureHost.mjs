// @ts-check
// Find the Cleo agent host, or start it. Shared by the stdio MCP server (index.mjs) and the editor's dev
// server (app-kit vite.preset.ts imports this module to start the host when the chat panel opens), so both
// agree on what "running" means: the discovery file names a host whose process is alive and whose port
// answers.

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { discoveryFilePath } from './discovery.mjs';
import { olderThan, withoutClaudeSession } from './env.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOST_ENTRY = path.join(HERE, 'host.mjs');
/** This checkout's host version: an older host found running is replaced when the caller asks. */
export const HOST_VERSION = String(JSON.parse(fs.readFileSync(path.join(HERE, '..', 'package.json'), 'utf8')).version);
const sleep = (/** @type {number} */ ms) => new Promise(r => setTimeout(r, ms));

/** @param {number} pid */
function alive(pid) {
    try { process.kill(pid, 0); return true; } catch (err) { return /** @type {any} */ (err).code === 'EPERM'; }
}

/** @param {number} port */
function answers(port) {
    return new Promise(resolve => {
        const s = net.connect({ host: '127.0.0.1', port });
        const done = (/** @type {boolean} */ ok) => { s.destroy(); resolve(ok); };
        s.once('connect', () => done(true));
        s.once('error', () => done(false));
        s.setTimeout(800, () => done(false));
    });
}

/**
 * The live host's discovery record, or null.
 * @param {string} [file]
 * @returns {Promise<{ port: number, token: string, pid: number, role: string, version?: string } | null>}
 */
export async function findHost(file = discoveryFilePath()) {
    let info;
    try { info = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
    if (info?.role !== 'host' || typeof info.port !== 'number' || typeof info.pid !== 'number') return null;
    if (!alive(info.pid) || !(await answers(info.port))) return null;
    return info;
}

/**
 * The running host, starting one (detached, so it outlives whoever asked) when there is none.
 *
 * `replaceOutdated`: a host OLDER than this checkout is stopped and replaced, so an editor that needs a newer
 * capability (the hosted terminal) is not stuck with the host an earlier version left running. Never a newer
 * one, so two checkouts settle on the newest rather than taking turns.
 * @param {{ file?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, log?: (m: string) => void, replaceOutdated?: boolean }} [opts]
 */
export async function ensureHost(opts = {}) {
    const file = opts.file ?? discoveryFilePath(opts.env ?? process.env);
    let found = await findHost(file);
    if (found && opts.replaceOutdated && olderThan(found.version, HOST_VERSION)) {
        opts.log?.(`replacing the agent host ${found.version ?? '?'} (pid ${found.pid}) with ${HOST_VERSION}`);
        try { process.kill(found.pid); } catch { /* gone already */ }
        for (let i = 0; i < 50 && alive(found.pid); i++) await sleep(100);
        found = null;
    }
    if (found) return found;
    opts.log?.('starting the Cleo agent host');
    // The host outlives whoever starts it, often a Claude Code session's MCP server: none of that session's
    // markers go with it (env.mjs).
    const child = spawn(process.execPath, [HOST_ENTRY], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...withoutClaudeSession(opts.env ?? process.env), CLEO_AGENT_BRIDGE_FILE: file },
    });
    child.unref();
    const deadline = Date.now() + (opts.timeoutMs ?? 20000);
    while (Date.now() < deadline) {
        await sleep(250);
        const info = await findHost(file);
        if (info) return info;
        if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`The agent host exited at start (code ${child.exitCode}). See ${path.join(path.dirname(file), 'agent-host.log')}.`);
    }
    throw new Error(`The agent host did not come up within ${Math.round((opts.timeoutMs ?? 20000) / 1000)} s. See ${path.join(path.dirname(file), 'agent-host.log')}.`);
}
