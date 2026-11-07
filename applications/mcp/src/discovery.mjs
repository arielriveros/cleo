// @ts-check
// The discovery file: how a Cleo editor finds this server. The editor cannot read the filesystem, so the
// editor's dev server (applications/app-kit/vite.preset.ts, agentBridgeDiscoveryPlugin) serves this file's
// contents back to its own origin at /__cleo/agent-bridge. Same path rule on both sides, so keep them in step.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Where the editor bridge listens unless CLEO_MCP_PORT says otherwise; any free port is taken if busy. */
export const DEFAULT_PORT = 47615;

/** `CLEO_AGENT_BRIDGE_FILE`, or `~/.cleo/agent-bridge.json`. */
export function discoveryFilePath(env = process.env) {
    return env.CLEO_AGENT_BRIDGE_FILE || path.join(os.homedir(), '.cleo', 'agent-bridge.json');
}

/**
 * Write `{port, token, pid, ...}` atomically (temp file + rename), so the editor never reads half a file.
 * @param {string} file
 * @param {Record<string, unknown>} info
 */
export function writeDiscovery(file, info) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
}

/**
 * Remove the discovery file, but only if it is still ours: a second server started later owns it now.
 * @param {string} file
 * @param {number} pid
 */
export function removeDiscovery(file, pid = process.pid) {
    try {
        const current = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (current?.pid === pid) fs.unlinkSync(file);
    } catch { /* gone already, or unreadable: nothing to clean up */ }
}
