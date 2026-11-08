// @ts-check
// Environment hygiene for the processes the agent host starts.
//
// A Claude Code session marks the processes it launches: CLAUDECODE=1, its session id, a messaging socket
// back to itself, its pid. The agent host is often started by one of them (the stdio MCP server a session
// runs calls ensureHost), yet it outlives that session and serves others. Those markers must not leak into
// the host, and above all not into a Claude Code it hosts, which would take itself for a child of a session
// that may be long gone.

/** Variables a Claude Code session sets for its children. */
const SESSION_VAR = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|CLAUDE_CODE_.*|CLAUDE_AGENT_SDK.*)$/;

/**
 * `env` without the variables of the Claude Code session it came from, if any. An environment from a plain
 * shell (no CLAUDECODE) is returned as is, so a user's own CLAUDE_CODE_* settings survive.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function withoutClaudeSession(env) {
    const fromSession = Object.keys(env).some(k => k.toUpperCase() === 'CLAUDECODE');
    /** @type {Record<string, string>} */
    const out = {};
    for (const [k, v] of Object.entries(env)) {
        if (v === undefined) continue;
        if (fromSession && SESSION_VAR.test(k.toUpperCase())) continue;
        out[k] = v;
    }
    return out;
}

/**
 * Is version `a` older than `b`? Dotted numbers; anything unparsable counts as 0.
 * @param {string | undefined} a @param {string | undefined} b
 */
export function olderThan(a, b) {
    const pa = String(a ?? '0').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b ?? '0').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] ?? 0) - (pb[i] ?? 0);
        if (d !== 0) return d < 0;
    }
    return false;
}
