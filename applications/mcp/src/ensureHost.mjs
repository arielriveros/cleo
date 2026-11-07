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

const HOST_ENTRY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'host.mjs');

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
 * @param {{ file?: string, timeoutMs?: number, env?: NodeJS.ProcessEnv, log?: (m: string) => void }} [opts]
 */
export async function ensureHost(opts = {}) {
    const file = opts.file ?? discoveryFilePath(opts.env ?? process.env);
    const found = await findHost(file);
    if (found) return found;
    opts.log?.('starting the Cleo agent host');
    const child = spawn(process.execPath, [HOST_ENTRY], {
        detached: true, stdio: 'ignore', windowsHide: true,
        env: { ...(opts.env ?? process.env), CLEO_AGENT_BRIDGE_FILE: file },
    });
    child.unref();
    const deadline = Date.now() + (opts.timeoutMs ?? 20000);
    while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 250));
        const info = await findHost(file);
        if (info) return info;
        if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`The agent host exited at start (code ${child.exitCode}). See ${path.join(path.dirname(file), 'agent-host.log')}.`);
    }
    throw new Error(`The agent host did not come up within ${Math.round((opts.timeoutMs ?? 20000) / 1000)} s. See ${path.join(path.dirname(file), 'agent-host.log')}.`);
}
