// @ts-check
// The in-editor chat: Claude, run through the Claude Agent SDK inside the agent host, with the Cleo tools as
// an in-process MCP server. The editor's chat panel talks to this over the bridge's socket:
//
//   editor -> host   {type:'chat', op:'attach'|'send'|'interrupt'|'permission'|'new'|'history'|'load'|
//                                     'setModel'|'setMode'|'setKey', ...}
//   host -> editor   {type:'chat-event', event:{kind, ...}}
//
// Every event of the open conversation is kept here as well as sent, so an editor that reloads (HMR, a
// project switch) re-attaches and rebuilds the transcript from a replay, while the agent keeps working.
//
// AUTH: an Anthropic API key only (ANTHROPIC_API_KEY, or one saved from the panel into
// ~/.cleo/agent-host.json). Anthropic does not allow third-party products to offer claude.ai login, and the
// SDK runs the Claude Code binary, which would otherwise fall back to whatever login that machine has; so the
// key is passed explicitly and a session that reports any other credential source is stopped.

import fs from 'node:fs';
import path from 'node:path';
import { INSTRUCTIONS } from './instructions.mjs';
import { toolDefinitions } from './tools.mjs';

export const CHAT_MODELS = [
    { id: 'claude-opus-5-5', label: 'Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
    { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
    { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
export const DEFAULT_MODEL = 'claude-opus-5-5';

const SERVER = 'cleo';
const PREFIX = `mcp__${SERVER}__`;
/** Looking never needs permission. */
export const READ_ONLY_TOOLS = new Set(['editor_status', 'scene_tree', 'node_get', 'script_read', 'asset_list', 'view_capture', 'logs_read']);
/** Asked for every time, whatever the mode: it runs code in the editor page. */
const ALWAYS_ASK = new Set(['execute_js']);
const MAX_EVENTS = 5000;

export const CHAT_SYSTEM_PROMPT = `You are Claude, the assistant built into the Cleo game editor. The user is looking at the editor while you work: every tool acts live on the project they have open, and they watch the scene change.

How to work
- Understand before changing: check editor_status and the scene tree, read the nodes and scripts you will touch.
- Batch related edits into one scene_edit call; each call is one undo step the user can revert with Ctrl+Z.
- After visible changes, look at the result with view_capture and fix what is wrong before you report. For gameplay, run it with play_control and read the logs; stop the game afterwards.
- Scripts: write them with script_write and fix every type error it reports.
- Do not save (scene_save) unless the user asks. Do not delete things the user made unless asked.
- Keep replies short: say what you changed and anything the user should check. Use Markdown sparingly.

${INSTRUCTIONS}`;

/** An async iterable the SDK reads user turns from (streaming input mode). */
class AsyncQueue {
    constructor() {
        /** @type {any[]} */ this.items = [];
        /** @type {((v: IteratorResult<any>) => void) | null} */ this.waiting = null;
        this.ended = false;
    }
    /** @param {any} item */
    push(item) {
        if (this.ended) return;
        if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: item, done: false }); }
        else this.items.push(item);
    }
    end() {
        this.ended = true;
        if (this.waiting) { const w = this.waiting; this.waiting = null; w({ value: undefined, done: true }); }
    }
    [Symbol.asyncIterator]() {
        return {
            next: () => {
                if (this.items.length) return Promise.resolve({ value: this.items.shift(), done: false });
                if (this.ended) return Promise.resolve({ value: undefined, done: true });
                return new Promise(resolve => { this.waiting = resolve; });
            },
        };
    }
}

/** A stored user turn without the editor context the panel appended to it. @param {string} text */
const stripContext = text => text.replace(/\n*<editor_context>[\s\S]*?<\/editor_context>\s*$/, '');

/** @param {string | undefined} name */
const shortName = name => (name && name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name ?? '');

/** A tool_result's content as text plus images, for the panel. @param {any} content */
export function flattenToolResult(content) {
    if (typeof content === 'string') return { text: content.slice(0, 6000), images: [] };
    const texts = [];
    const images = [];
    for (const b of Array.isArray(content) ? content : []) {
        if (b?.type === 'text') texts.push(b.text);
        else if (b?.type === 'image' && b.source?.type === 'base64') images.push({ data: b.source.data, mimeType: b.source.media_type });
    }
    const text = texts.join('\n');
    return { text: text.length > 6000 ? `${text.slice(0, 6000)}\n…` : text, images };
}

/**
 * Turns the SDK's message stream into the panel's events. `replay` is for a transcript read back from disk,
 * where user text must be shown (live, the panel already shows what the user typed).
 * @param {(ev: any) => void} emit
 * @param {{ replay?: boolean }} [opts]
 */
export function createNormalizer(emit, opts = {}) {
    const streamed = new Set();
    const started = new Set();
    const tools = new Set();
    /** @type {Map<string, number>} */
    const counters = new Map();
    let current = '';
    const start = (/** @type {string} */ id) => {
        if (started.has(id)) return;
        started.add(id);
        emit({ kind: 'assistant-start', messageId: id });
    };
    const nextIndex = (/** @type {string} */ id) => {
        const n = (counters.get(id) ?? 1000) + 1;
        counters.set(id, n);
        return n;
    };
    return {
        /** @param {any} m */
        handle(m) {
            if (m?.parent_tool_use_id) return; // a subagent's inner traffic
            switch (m?.type) {
                case 'system':
                    if (m.subtype === 'init') emit({ kind: 'session', sessionId: m.session_id, model: m.model, authSource: m.apiKeySource });
                    return;
                case 'stream_event': {
                    const e = m.event;
                    if (e?.type === 'message_start') {
                        current = e.message?.id ?? `msg-${Date.now()}`;
                        streamed.add(current);
                        start(current);
                    } else if (e?.type === 'content_block_start') {
                        const b = e.content_block ?? {};
                        const block = b.type === 'tool_use' ? 'tool' : b.type === 'thinking' ? 'thinking' : b.type === 'text' ? 'text' : null;
                        if (!block) return;
                        if (block === 'tool') tools.add(b.id);
                        emit({ kind: 'block-start', messageId: current, index: e.index, block, toolUseId: b.id, name: shortName(b.name) });
                    } else if (e?.type === 'content_block_delta') {
                        const d = e.delta ?? {};
                        if (d.type === 'text_delta') emit({ kind: 'delta', messageId: current, index: e.index, text: d.text });
                        else if (d.type === 'thinking_delta') emit({ kind: 'delta', messageId: current, index: e.index, text: d.thinking });
                    }
                    return;
                }
                case 'assistant': {
                    const msg = m.message ?? {};
                    const id = msg.id ?? `msg-${Date.now()}`;
                    const wasStreamed = streamed.has(id);
                    start(id);
                    for (const b of msg.content ?? []) {
                        if (b.type === 'tool_use') {
                            if (!tools.has(b.id)) { tools.add(b.id); emit({ kind: 'block-start', messageId: id, index: nextIndex(id), block: 'tool', toolUseId: b.id, name: shortName(b.name) }); }
                            emit({ kind: 'tool-input', toolUseId: b.id, name: shortName(b.name), input: b.input });
                        } else if (!wasStreamed && b.type === 'text' && b.text) {
                            const index = nextIndex(id);
                            emit({ kind: 'block-start', messageId: id, index, block: 'text' });
                            emit({ kind: 'delta', messageId: id, index, text: b.text });
                        } else if (!wasStreamed && b.type === 'thinking' && b.thinking) {
                            const index = nextIndex(id);
                            emit({ kind: 'block-start', messageId: id, index, block: 'thinking' });
                            emit({ kind: 'delta', messageId: id, index, text: b.thinking });
                        }
                    }
                    if (m.error) emit({ kind: 'error', message: `The model call failed: ${m.error}` });
                    return;
                }
                case 'user': {
                    const content = m.message?.content;
                    if (typeof content === 'string') { if (opts.replay && !m.isSynthetic) emit({ kind: 'user', text: stripContext(content) }); return; }
                    for (const b of Array.isArray(content) ? content : []) {
                        if (b?.type === 'tool_result') emit({ kind: 'tool-result', toolUseId: b.tool_use_id, isError: !!b.is_error, ...flattenToolResult(b.content) });
                        else if (b?.type === 'text' && opts.replay && !m.isSynthetic) emit({ kind: 'user', text: stripContext(b.text) });
                    }
                    return;
                }
                case 'result':
                    emit({
                        kind: 'turn-end', costUsd: m.total_cost_usd ?? 0, durationMs: m.duration_ms ?? 0, turns: m.num_turns ?? 0,
                        isError: !!m.is_error, error: m.subtype && m.subtype !== 'success' ? (m.errors?.join('; ') || m.subtype) : null,
                    });
                    return;
                default:
                    return;
            }
        },
    };
}

export class ChatManager {
    /**
     * @param {{ bridge: import('./bridge.mjs').EditorBridge, dataDir: string, version: string,
     *           log?: (m: string) => void, mock?: boolean }} opts
     */
    constructor(opts) {
        this.bridge = opts.bridge;
        this.dataDir = opts.dataDir;
        this.version = opts.version;
        this.log = opts.log ?? (() => {});
        this.mock = !!opts.mock;
        this.model = DEFAULT_MODEL;
        /** 'auto': edits run without asking (each is an undo step); 'ask': every change asks first. */
        this.mode = 'auto';
        /** @type {any[]} */
        this.events = [];
        /** @type {{ queue: AsyncQueue, q: any, abort: AbortController } | null} */
        this.session = null;
        this.sessionId = null;
        /** @type {string | null} */
        this.resumeId = null;
        this.busy = false;
        this.cost = 0;
        /** Tools the user said "always allow" for, in this conversation. */
        this.alwaysAllow = new Set();
        /** @type {Map<string, { resolve: (r: any) => void, tool: string }>} */
        this.pendingPermissions = new Map();
        this.nextPermission = 1;
        /** @type {Map<string, (args: any) => Promise<any>>} */
        this.handlers = new Map(toolDefinitions(this.bridge).map(d => [d.name, d.handler]));

        this.bridge.on('chat', msg => { this.onMessage(msg).catch(err => this.emit({ kind: 'error', message: err?.message ?? String(err) })); });
    }

    // --- plumbing ------------------------------------------------------------------------------------------

    /** @param {any} ev */
    emit(ev) {
        if (!['state', 'replay', 'history'].includes(ev.kind)) {
            this.events.push(ev);
            if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
        }
        this.bridge.sendToEditor({ type: 'chat-event', event: ev });
    }

    state() {
        return {
            kind: 'state', busy: this.busy, model: this.model, mode: this.mode, sessionId: this.sessionId,
            auth: this.mock ? 'mock' : process.env.ANTHROPIC_API_KEY ? 'env' : this._savedKey() ? 'saved' : 'missing',
            models: CHAT_MODELS, cost: this.cost, mock: this.mock,
        };
    }

    sendState() { this.emit(this.state()); }

    _configFile() { return path.join(this.dataDir, 'agent-host.json'); }
    _savedKey() {
        try { return JSON.parse(fs.readFileSync(this._configFile(), 'utf8')).apiKey || null; } catch { return null; }
    }
    _apiKey() { return process.env.ANTHROPIC_API_KEY || this._savedKey(); }

    /** One working directory per project, so each project gets its own session history. */
    _cwd() {
        const id = String(this.bridge.client?.project?.id ?? 'default').replace(/[^A-Za-z0-9_-]/g, '_');
        const dir = path.join(this.dataDir, 'agent', id);
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    }

    _setBusy(b) { if (this.busy !== b) { this.busy = b; this.sendState(); } }

    // --- messages from the panel -----------------------------------------------------------------------------

    /** @param {any} msg */
    async onMessage(msg) {
        switch (msg.op) {
            case 'attach':
                this.bridge.sendToEditor({ type: 'chat-event', event: { kind: 'replay', events: this.events, state: this.state() } });
                return;
            case 'send':
                if (msg.model) this.model = String(msg.model);
                if (msg.mode === 'ask' || msg.mode === 'auto') this.mode = msg.mode;
                return this.send(String(msg.text ?? ''), typeof msg.context === 'string' ? msg.context : '');
            case 'interrupt':
                return this.interrupt();
            case 'permission':
                return this._resolvePermission(String(msg.requestId), !!msg.allow, !!msg.always);
            case 'new':
                await this._closeSession();
                this.events = [];
                this.resumeId = null;
                this.sessionId = null;
                this.cost = 0;
                this.alwaysAllow.clear();
                this.bridge.sendToEditor({ type: 'chat-event', event: { kind: 'replay', events: [], state: this.state() } });
                return;
            case 'setModel':
                this.model = String(msg.model || DEFAULT_MODEL);
                if (this.session && !this.mock) await this.session.q.setModel(this.model).catch(() => {});
                return this.sendState();
            case 'setMode':
                if (msg.mode === 'ask' || msg.mode === 'auto') this.mode = msg.mode;
                return this.sendState();
            case 'setKey':
                return this._saveKey(String(msg.key ?? ''));
            case 'history':
                return this._history();
            case 'load':
                return this._load(String(msg.sessionId));
            default:
                return;
        }
    }

    /**
     * @param {string} text what the user typed (shown in the transcript)
     * @param {string} [context] what the editor adds about its state (the open scene, the selection); sent to
     *   Claude with the message but not shown as part of it, like the IDE extensions' "current file"
     */
    async send(text, context = '') {
        if (!text.trim()) return;
        if (!this.mock && !this._apiKey()) {
            this.emit({ kind: 'error', message: 'Add an Anthropic API key first (the key field in the chat panel, or ANTHROPIC_API_KEY).' });
            return this.sendState();
        }
        this.emit({ kind: 'user', text });
        this._setBusy(true);
        try {
            if (!this.session) await this._start();
            const content = context ? `${text}\n\n<editor_context>\n${context}\n</editor_context>` : text;
            this.session?.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null });
        } catch (err) {
            this.emit({ kind: 'error', message: `Could not start Claude: ${err?.message ?? err}` });
            this._setBusy(false);
        }
    }

    async interrupt() {
        for (const id of [...this.pendingPermissions.keys()]) this._resolvePermission(id, false, false);
        if (!this.session) return;
        if (this.mock) this.session.abort.abort();
        else await this.session.q.interrupt().catch(() => {});
        this.emit({ kind: 'info', message: 'Stopped.' });
    }

    // --- sessions ----------------------------------------------------------------------------------------------

    async _start() {
        if (this.mock) { this._startMock(); return; }
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const key = this._apiKey();
        const cleo = sdk.createSdkMcpServer({
            name: SERVER, version: this.version,
            tools: toolDefinitions(this.bridge).map(d => sdk.tool(d.name, d.config.description, d.config.inputSchema, d.handler, { annotations: /** @type {any} */ (d.config.annotations) })),
        });
        // The nested Claude Code must not think it is part of the session that may have launched this host,
        // nor pick up that machine's login: a clean environment plus the key.
        /** @type {Record<string, string | undefined>} */
        const env = {};
        for (const [k, v] of Object.entries(process.env)) {
            if (/^CLAUDE_CODE_|^CLAUDECODE$|^CLAUDE_AGENT_SDK|^CLAUDE_PID$|^CLAUDE_EFFORT$/.test(k)) continue;
            env[k] = v;
        }
        env.ANTHROPIC_API_KEY = key ?? undefined;
        const queue = new AsyncQueue();
        const abort = new AbortController();
        const q = sdk.query({
            prompt: queue,
            options: {
                model: this.model,
                effort: 'high',
                thinking: { type: 'adaptive', display: 'summarized' },
                systemPrompt: CHAT_SYSTEM_PROMPT,
                tools: [],
                mcpServers: { [SERVER]: cleo },
                allowedTools: [...READ_ONLY_TOOLS].map(n => PREFIX + n),
                settingSources: [],
                includePartialMessages: true,
                canUseTool: (name, input, o) => this._canUseTool(name, input, o),
                cwd: this._cwd(),
                env,
                resume: this.resumeId ?? undefined,
                maxTurns: 100,
                abortController: abort,
                stderr: data => this.log(`[agent] ${String(data).trimEnd()}`),
            },
        });
        this.session = { queue, q, abort };
        void this._pump(q);
    }

    /** @param {AsyncIterable<any>} q */
    async _pump(q) {
        const norm = createNormalizer(ev => this.emit(ev));
        try {
            for await (const m of q) {
                if (m.type === 'system' && m.subtype === 'init') {
                    this.sessionId = m.session_id;
                    this.resumeId = m.session_id;
                    if (!this.mock && m.apiKeySource !== 'ANTHROPIC_API_KEY') {
                        this.emit({ kind: 'error', message: `Stopped: the session signed in with "${m.apiKeySource}" instead of the API key. This chat only uses an Anthropic API key.` });
                        await this._closeSession();
                        return;
                    }
                }
                norm.handle(m);
                if (m.type === 'result') {
                    if (typeof m.total_cost_usd === 'number') this.cost = m.total_cost_usd;
                    this._setBusy(false);
                    this.sendState();
                }
            }
        } catch (err) {
            if (!/abort/i.test(String(err?.message ?? err))) this.emit({ kind: 'error', message: `Claude stopped: ${err?.message ?? err}` });
        } finally {
            if (this.session?.q === q) this.session = null;
            this._setBusy(false);
        }
    }

    async _closeSession() {
        const s = this.session;
        this.session = null;
        for (const id of [...this.pendingPermissions.keys()]) this._resolvePermission(id, false, false);
        if (!s) return;
        s.queue.end();
        try { s.abort.abort(); } catch { /* already gone */ }
        try { s.q.close?.(); } catch { /* already gone */ }
        this._setBusy(false);
    }

    async _history() {
        let sessions = [];
        if (!this.mock) {
            try {
                const sdk = await import('@anthropic-ai/claude-agent-sdk');
                sessions = (await sdk.listSessions({ dir: this._cwd(), limit: 30 }))
                    .map(s => ({ sessionId: s.sessionId, title: s.customTitle || s.summary || s.sessionId, lastModified: s.lastModified }));
            } catch (err) { this.log(`history: ${err?.message ?? err}`); }
        }
        this.bridge.sendToEditor({ type: 'chat-event', event: { kind: 'history', sessions } });
    }

    /** Reopen a saved conversation: show its transcript, and resume it on the next message. @param {string} sessionId */
    async _load(sessionId) {
        await this._closeSession();
        this.events = [];
        this.cost = 0;
        this.alwaysAllow.clear();
        this.resumeId = sessionId;
        this.sessionId = sessionId;
        const sdk = await import('@anthropic-ai/claude-agent-sdk');
        const norm = createNormalizer(ev => { this.events.push(ev); }, { replay: true });
        try {
            for (const m of await sdk.getSessionMessages(sessionId, { dir: this._cwd() })) {
                if (m.type === 'user' || m.type === 'assistant') norm.handle({ type: m.type, message: m.message, parent_tool_use_id: m.parent_tool_use_id });
            }
        } catch (err) {
            this.events.push({ kind: 'error', message: `Could not read that conversation: ${err?.message ?? err}` });
        }
        this.bridge.sendToEditor({ type: 'chat-event', event: { kind: 'replay', events: this.events, state: this.state() } });
    }

    /** @param {string} key */
    _saveKey(key) {
        const trimmed = key.trim();
        if (!trimmed) {
            try { fs.unlinkSync(this._configFile()); } catch { /* none saved */ }
        } else {
            if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(trimmed)) {
                this.emit({ kind: 'error', message: 'That does not look like an Anthropic API key (they start with "sk-ant-").' });
                return;
            }
            fs.mkdirSync(this.dataDir, { recursive: true });
            fs.writeFileSync(this._configFile(), JSON.stringify({ apiKey: trimmed }, null, 2), { mode: 0o600 });
        }
        this.sendState();
    }

    // --- permissions -------------------------------------------------------------------------------------------

    /** @param {string} name @param {Record<string, unknown>} input @param {{ signal: AbortSignal, toolUseID?: string, title?: string }} o */
    _canUseTool(name, input, o) {
        const tool = shortName(name);
        if (!name.startsWith(PREFIX)) return Promise.resolve({ behavior: 'deny', message: 'This chat can only use the Cleo editor tools.' });
        if (READ_ONLY_TOOLS.has(tool)) return Promise.resolve({ behavior: 'allow' });
        if (!ALWAYS_ASK.has(tool) && (this.mode === 'auto' || this.alwaysAllow.has(tool))) return Promise.resolve({ behavior: 'allow' });
        const requestId = `perm-${this.nextPermission++}`;
        this.emit({ kind: 'permission', requestId, toolUseId: o.toolUseID, tool, input, title: o.title, canAlways: !ALWAYS_ASK.has(tool) });
        return new Promise(resolve => {
            this.pendingPermissions.set(requestId, { resolve, tool });
            o.signal?.addEventListener('abort', () => this._resolvePermission(requestId, false, false), { once: true });
        });
    }

    /** @param {string} requestId @param {boolean} allow @param {boolean} always */
    _resolvePermission(requestId, allow, always) {
        const p = this.pendingPermissions.get(requestId);
        if (!p) return;
        this.pendingPermissions.delete(requestId);
        if (allow && always && !ALWAYS_ASK.has(p.tool)) this.alwaysAllow.add(p.tool);
        p.resolve(allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'The user declined this action. Ask what they would like instead.' });
        this.emit({ kind: 'permission-resolved', requestId, allow });
    }

    // --- the scripted stand-in (CLEO_AGENT_MOCK=1) ------------------------------------------------------------

    /**
     * A scripted agent with the same message shapes as the SDK, for exercising the panel, the permissions and
     * the tools end to end without an API key. Each turn: look at the scene, add a sphere, look at it.
     */
    _startMock() {
        const queue = new AsyncQueue();
        const abort = new AbortController();
        const self = this;
        let n = 0;
        async function* run() {
            yield { type: 'system', subtype: 'init', session_id: 'mock-session', model: self.model, apiKeySource: 'none' };
            for await (const turn of queue) {
                const prompt = String(turn.message?.content ?? '');
                const t0 = Date.now();
                const say = async function* (/** @type {string} */ text) {
                    const id = `mock-msg-${++n}`;
                    yield { type: 'stream_event', event: { type: 'message_start', message: { id } } };
                    yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text' } } };
                    for (const chunk of text.match(/.{1,12}/gs) ?? []) { await new Promise(r => setTimeout(r, 15)); yield { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } } }; }
                    yield { type: 'assistant', message: { id, content: [{ type: 'text', text }] } };
                };
                const use = async function* (/** @type {string} */ tool, /** @type {any} */ input) {
                    const id = `mock-msg-${++n}`;
                    const toolUseId = `mock-tool-${n}`;
                    yield { type: 'stream_event', event: { type: 'message_start', message: { id } } };
                    yield { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: PREFIX + tool } } };
                    yield { type: 'assistant', message: { id, content: [{ type: 'tool_use', id: toolUseId, name: PREFIX + tool, input }] } };
                    const decision = await self._canUseTool(PREFIX + tool, input, { signal: abort.signal, toolUseID: toolUseId });
                    if (abort.signal.aborted) return;
                    const result = decision.behavior === 'allow'
                        ? await self.handlers.get(tool)?.(input)
                        : { content: [{ type: 'text', text: decision.message }], isError: true };
                    const content = (result?.content ?? []).map((/** @type {any} */ c) => c.type === 'image'
                        ? { type: 'image', source: { type: 'base64', media_type: c.mimeType, data: c.data } } : c);
                    yield { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content, is_error: !!result?.isError }] } };
                };
                const name = (prompt.match(/called\s+"?([\w ]+?)"?(?:$|[.,!])/i)?.[1] ?? 'Mock Sphere').trim();
                const steps = [
                    say(`I'll look at the scene, then add a sphere called "${name}".`),
                    use('scene_tree', { depth: 2 }),
                    use('scene_edit', { label: 'Chat: add sphere', ops: [{ op: 'create', type: 'sphere', name, position: [0, 1, 0] }] }),
                    use('view_capture', { focus: name }),
                    say(`Added **${name}** at the origin, one metre up. It is one undo step, so Ctrl+Z removes it.`),
                ];
                for (const step of steps) {
                    for await (const m of step) { if (abort.signal.aborted) break; yield m; }
                    if (abort.signal.aborted) break;
                }
                yield { type: 'result', subtype: abort.signal.aborted ? 'error_during_execution' : 'success', total_cost_usd: 0, duration_ms: Date.now() - t0, num_turns: 4, is_error: abort.signal.aborted, errors: abort.signal.aborted ? ['interrupted'] : [] };
                if (abort.signal.aborted) return;
            }
        }
        const q = run();
        this.session = { queue, q, abort };
        void this._pump(q);
    }
}
