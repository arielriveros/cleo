// @ts-check
// The tool catalog. Schemas and descriptions live HERE, so `tools/list` answers even while no editor is
// connected; every handler relays to the editor (applications/editor/src/features/agentBridge/commands.ts),
// which runs it against the live project. Method names below must match that file's registry.
//
// Written for few round trips: the core tools load up front (no tool-search turn before their first use),
// a create takes everything a node needs (material included) and a change can return a screenshot, so a
// request like "add a red cube and show me" is one call. The schemas stay small, because every always-loaded
// tool's schema is in every request; the node-ref grammar and the conventions live once, in INSTRUCTIONS.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BridgeError } from './bridge.mjs';
import { discoveryFilePath } from './discovery.mjs';
import { EngineApi } from './engineApi.mjs';

/** This checkout's root: applications/mcp/src -> the engine repo. */
const ENGINE_ROOT = process.env.CLEO_ENGINE_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The engine_api index for an engine checkout, cached in the agent host's data folder. */
export function createEngineApi(/** @type {{ engineRoot?: string, dataDir?: string, log?: (m: string) => void }} */ opts = {}) {
    return new EngineApi({
        engineRoot: opts.engineRoot ?? ENGINE_ROOT,
        cacheDir: path.join(opts.dataDir ?? path.dirname(discoveryFilePath()), 'engine-api'),
        log: opts.log,
    });
}

const vec3 = z.array(z.number()).length(3);
const unit = z.number().min(0).max(1);
const ref = z.string().min(1).describe('Node ref');

/** Text results past this are cut, with a note: under Claude Code's 50,000 characters, past which a result is spilled to a file. */
const MAX_TEXT = 40_000;

/** @param {string} s */
function clip(s) {
    return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}\n… [cut: ${s.length - MAX_TEXT} more characters; narrow the request]`;
}

/**
 * What the editor returned, as MCP content: `{text?, data?, images?, isError?}`. Data is compact JSON: the
 * model reads it as well as an indented copy, at two thirds of the tokens.
 * @param {any} r
 */
export function toToolResult(r) {
    /** @type {any[]} */
    const content = [];
    if (typeof r?.text === 'string' && r.text) content.push({ type: 'text', text: clip(r.text) });
    if (r?.data !== undefined) content.push({ type: 'text', text: clip(JSON.stringify(r.data)) });
    for (const img of r?.images ?? []) content.push({ type: 'image', data: img.data, mimeType: img.mimeType });
    if (!content.length) content.push({ type: 'text', text: 'OK' });
    return { content, isError: !!r?.isError };
}

/** @param {unknown} err */
export function toErrorResult(err) {
    const message = err instanceof BridgeError || err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: message }], isError: true };
}

const READ = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
/** Loaded with the session instead of found through tool search: the tools nearly every request uses. */
const CORE = { 'anthropic/alwaysLoad': true };

/** The tools that load up front (CORE); tests hold their size down. */
export const CORE_TOOLS = ['editor_status', 'scene_tree', 'node_get', 'scene_edit', 'script_write', 'view_capture', 'play_control', 'engine_api'];

/** A screenshot taken after the change, in the same call. */
const capture = z.union([z.boolean(), z.object({
    focus: z.string().optional(),
    yaw: z.number().optional(),
    pitch: z.number().optional(),
    maxSize: z.number().int().optional(),
})]).optional().describe('Screenshot afterwards: true = the view as it is; {focus:"$alias"} frames that node first.');

const pbr = {
    baseColor: vec3.optional(),
    metallic: unit.optional(),
    roughness: unit.optional(),
    emissive: vec3.optional(),
    emissiveIntensity: z.number().min(0).optional(),
    opacity: unit.optional(),
    transparent: z.boolean().optional(),
};

/** Add-catalog ids a create op takes as `type`. */
const TYPES = 'empty, trigger, character, controller, navMesh, perspectiveCamera, orthographicCamera, cameraRig, directionalLight, '
    + 'pointLight, spotlight, skyLight, cube, sphere, capsule, cylinder, cone, torus, pyramid, quad, plane, circle, triangle, ramp, '
    + 'cornerRamp, stairs, spiralStairs, arch, tube, hollowBox, skybox, skyAtmosphere, lightProbe, exposureVolume, volumetricFog, '
    + 'waterVolume, occlusionVolume, wind, weather, volumetricClouds, landscape, decal, particleSystem, forceField, cloth, spatialSound, '
    + 'ambientSound, sprite, animatedSprite, tilemap, uiCanvas, uiWorldRoot, uiStackColumn, uiStackRow, uiSpacer, uiPanel, uiText, '
    + 'uiImage, uiButton, uiProgressBar, uiSlider, uiToggle, uiTextInput';

/**
 * @typedef {{ name: string, config: { title: string, description: string, inputSchema: Record<string, any>,
 *   annotations: Record<string, boolean>, _meta?: Record<string, unknown> }, handler: (args: any) => Promise<any> }} ToolDef
 */

/** Anything that can run an editor command: the editor bridge itself, or a peer of the host that owns it. */
/** @typedef {{ call(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<any> }} Caller */

/**
 * Register every tool on an MCP server (the stdio server Claude Code launches). The input shapes are wrapped
 * in `z.object` here (MCP SDK v2's form), always, so a handler is always called with its arguments first.
 * @param {import('@modelcontextprotocol/server').McpServer} server @param {Caller} bridge
 * @param {{ engineApi?: EngineApi }} [opts]
 */
export function registerTools(server, bridge, opts = {}) {
    for (const d of toolDefinitions(bridge, opts)) {
        server.registerTool(d.name, { ...d.config, inputSchema: z.object(d.config.inputSchema) }, (/** @type {any} */ args) => d.handler(args));
    }
}

/** Extra time a call needs when it also captures (frames settle) or stops the game afterwards. */
const extraMs = (/** @type {any} */ a) => (a?.capture ? 10_000 : 0) + (a?.stopAfter ? 20_000 : 0);

/**
 * The tool catalog as plain definitions (tests read them without a server). Each handler relays to the
 * editor and maps the answer to MCP content, except engine_api, which answers in-process (no editor needed).
 * @param {Caller} bridge
 * @param {{ engineApi?: EngineApi }} [opts]
 * @returns {ToolDef[]}
 */
export function toolDefinitions(bridge, opts = {}) {
    /** @type {ToolDef[]} */
    const defs = [];
    // Built lazily: nothing is read until the first lookup (or index.mjs's warm-up).
    const engineApi = opts.engineApi ?? createEngineApi();
    /**
     * A tool answered here, without the editor.
     * @param {string} name @param {any} config @param {(args: any) => Promise<any>} fn
     */
    const local = (name, config, fn) => defs.push({ name, config, handler: async (/** @type {any} */ args) => {
        try { return toToolResult(await fn(args ?? {})); } catch (err) { return toErrorResult(err); }
    } });
    /**
     * @param {string} name @param {string} method @param {any} config
     * @param {{ timeoutMs?: number | ((args: any) => number) }} [opts]
     */
    const relay = (name, method, config, opts = {}) => defs.push({ name, config, handler: async (/** @type {any} */ args) => {
        try {
            const timeoutMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs(args) : opts.timeoutMs;
            return toToolResult(await bridge.call(method, args ?? {}, { timeoutMs }));
        } catch (err) {
            return toErrorResult(err);
        }
    } });

    relay('editor_status', 'status', {
        title: 'Editor status',
        description: 'Whether a Cleo editor is connected and what it has open: the project, its scenes (open, main), the active '
            + 'tab and editor mode, play state, unsaved changes, the selected node, the renderer. Cheap. Other tools already '
            + 'say when no editor is connected, so call this when you need those facts.',
        inputSchema: {},
        annotations: READ,
        _meta: CORE,
    }, { timeoutMs: 10000 });

    relay('scene_tree', 'scene.tree', {
        title: 'Scene tree',
        description: 'The open scene (during Play, the running game) as an outline: one line per node with its name, [type] and '
            + 'flags (script=, body, trigger, material=, hidden, template=, model=); indentation is nesting. The header names '
            + 'the selection and unsaved state. `root`/`depth` zoom into a subtree; `type`/`name` search the whole scene and '
            + 'return full paths.',
        inputSchema: {
            root: ref.optional().describe('Subtree to outline (default: the scene root).'),
            depth: z.number().int().min(1).max(32).optional().describe('Levels below root to show (default 4).'),
            type: z.string().optional().describe('Only nodes of this type (e.g. "model", "light", "camera").'),
            name: z.string().optional().describe('Only names containing this (case-insensitive).'),
            limit: z.number().int().min(10).max(2000).optional().describe('Maximum lines (default 300).'),
        },
        annotations: READ,
        _meta: CORE,
    });

    relay('node_get', 'node.get', {
        title: 'Get node',
        description: 'One node: path, id, type, transform (metres, Euler degrees), world position and world bounds (center, '
            + 'size, min, max of it and its children), children, script and its field values, body, trigger, variables, '
            + 'material, and `props`: its settable properties with current values, by the names scene_edit `props` takes '
            + '(dotted paths reach into objects, e.g. "light.intensity"). `json: true` adds the serialized node.',
        inputSchema: {
            node: ref,
            json: z.boolean().optional(),
        },
        annotations: READ,
        _meta: CORE,
    });

    const op = z.object({
        op: z.enum(['create', 'update', 'delete', 'move', 'attachScript', 'detachScript', 'select']),
        node: z.string().nullable().optional().describe('Target of every op but create (select null clears).'),
        type: z.string().optional().describe(`create: ${TYPES}.`),
        template: z.string().optional().describe('create: a template (prefab) by name instead.'),
        model: z.string().optional().describe('create: an imported model by name instead.'),
        as: z.string().optional().describe('create: "$alias" for later ops and capture.focus.'),
        parent: z.string().optional().describe('create/move (default: scene root).'),
        index: z.number().int().optional().describe('move: position among siblings.'),
        script: z.string().optional().describe('create/attachScript: script asset name.'),
        name: z.string().optional(),
        position: vec3.optional().describe('Local metres.'),
        rotation: vec3.optional().describe('Local Euler DEGREES.'),
        scale: vec3.optional(),
        visible: z.boolean().optional(),
        props: z.record(z.string(), z.any()).optional().describe('By node_get `props` names, e.g. {"light.intensity": 800}.'),
        scriptFields: z.record(z.string(), z.any()).optional().describe('The attached script\'s public fields.'),
        material: z.union([z.string(), z.object({ name: z.string().optional(), ...pbr })]).optional()
            .describe('Asset name, or a PBR spec (linear RGB) making one named after the node.'),
        body: z.record(z.string(), z.any()).nullable().optional().describe('Rigid body merged over the current one; null removes. '
            + 'mass (0 = static), friction, restitution, linearDamping, angularDamping, linearConstraints/angularConstraints '
            + '[x,y,z] 1 free 0 locked, shapes [{type: box|sphere|capsule|cylinder, width/height/depth or radius/height, offset}] '
            + '(default: a box fitted to the mesh).'),
        trigger: z.record(z.string(), z.any()).nullable().optional().describe('{shapes, enabled?}; null removes. '
            + 'Scripts get onTriggerEnter/Exit.'),
    });

    relay('scene_edit', 'scene.edit', {
        title: 'Edit scene',
        description: 'Change the open scene: a list of ops applied in order as ONE undo step, stopping at the first failure. '
            + 'create (a catalog type, template or model, and every field update takes: material, body, script, scriptFields, '
            + 'props), update, delete, move, attachScript, detachScript, select. Node refs: "/A/B" path, "#id", unique name, '
            + '"$alias" from an earlier create, "@selected". Batch a whole build in one call, and add `capture` to see the '
            + 'result. Returns each op\'s result with created paths and ids. Refused during Play.',
        inputSchema: {
            ops: z.array(op).min(1).max(500),
            label: z.string().optional().describe('Undo label.'),
            capture,
        },
        annotations: WRITE,
        _meta: CORE,
    }, { timeoutMs: a => 60000 + extraMs(a) });

    relay('script_write', 'script.write', {
        title: 'Write script',
        description: 'Create or replace a script asset (by name) with TypeScript, optionally attach it, and check it: the runtime '
            + 'compile and the editor\'s type-check against the engine API. Returns diagnostics (line:col message) and the '
            + 'public fields. A script with errors is still saved: fix it and call again. The class extends the type of the node '
            + 'it attaches to (Node attaches anywhere). Updating a script re-seeds every node using it. To see it run, follow '
            + 'with play_control {action:"simulate", capture:true, stopAfter:true}.',
        inputSchema: {
            name: z.string().min(1).describe('Script asset name.'),
            source: z.string().min(1),
            attach: z.array(ref).optional().describe('Nodes to attach it to (replacing their script), e.g. ["@selected"].'),
            check: z.boolean().optional().describe('Run the type-check (default true).'),
        },
        annotations: WRITE,
        _meta: CORE,
    }, { timeoutMs: 90000 });

    local('engine_api', {
        title: 'Engine API',
        description: 'Look up the Cleo scripting API (what `import ... from \'cleo\'` gives a script, read from the engine\'s type '
            + 'declarations) and its docs, in small answers: much cheaper than reading doc files. query: words ("play animation '
            + 'action") -> matching classes, members and doc sections. symbol: "Animator" (its members) or "Animator.playAction" '
            + '(signatures and full doc). doc: one docs section ("scripting/node-api.md#transform"), or a file to list its sections.',
        inputSchema: {
            query: z.string().optional(),
            symbol: z.string().optional(),
            doc: z.string().optional(),
            limit: z.number().int().min(1).max(40).optional().describe('query: most symbols to list (default 12).'),
        },
        annotations: READ,
        _meta: CORE,
    }, args => engineApi.answer(args));

    relay('script_read', 'script.read', {
        title: 'Read script',
        description: 'The source of a script asset, its base type, its public fields and the nodes in the open scene that use it.',
        inputSchema: { name: z.string().min(1) },
        annotations: READ,
    });

    relay('material_write', 'material.write', {
        title: 'Write material',
        description: 'Create or update a PBR material asset by name and optionally link it to nodes. Colours are linear RGB 0..1; '
            + 'opacity below 1 needs transparent: true. Updating a material re-applies it to every node in the open scene that '
            + 'links it. (A create or update op in scene_edit can also make a material inline.)',
        inputSchema: {
            name: z.string().min(1),
            ...pbr,
            assignTo: z.array(ref).optional(),
            capture,
        },
        annotations: WRITE,
    }, { timeoutMs: a => 30000 + extraMs(a) });

    relay('asset_list', 'asset.list', {
        title: 'List assets',
        description: 'The project\'s asset libraries by name: templates (prefabs), models, materials, scripts, animations, '
            + 'animation controllers, AI brains, particle systems, sounds, textures, tilesets. Filter by kind and/or name.',
        inputSchema: {
            kind: z.enum(['template', 'model', 'material', 'script', 'animation', 'animController', 'aiBrain', 'particleSystem', 'sound', 'texture', 'tileset']).optional(),
            query: z.string().optional().describe('Only names containing this text (case-insensitive).'),
        },
        annotations: READ,
    });

    relay('view_capture', 'view.capture', {
        title: 'Capture viewport',
        description: 'A screenshot of the editor viewport as rendered (during Play: the game view). Optionally frame a node first '
            + '(moves the EDITOR camera, not the game camera). Changing tools take `capture` too, which saves this call.',
        inputSchema: {
            focus: ref.optional().describe('Frame this node first.'),
            yaw: z.number().optional().describe('Orbit angle in degrees around it (0 = looking along +Z, default 35).'),
            pitch: z.number().optional().describe('Degrees above the horizon (default 25).'),
            maxSize: z.number().int().min(128).max(2048).optional().describe('Longest side in pixels (default 1024).'),
            format: z.enum(['jpeg', 'png']).optional(),
        },
        annotations: READ,
        _meta: CORE,
    }, { timeoutMs: 20000 });

    relay('logs_read', 'logs.read', {
        title: 'Read logs',
        description: 'The editor console: script errors, Logger output, warnings. Pass the `cursor` from a previous call (or from '
            + 'play_control) to get only what arrived since. Repeated lines are collapsed. Script errors carry the scope "Script".',
        inputSchema: {
            since: z.number().int().optional().describe('Cursor from an earlier call: only newer entries.'),
            level: z.enum(['all', 'warn', 'error']).optional().describe('Minimum level (default all).'),
            scope: z.string().optional().describe('Only this scope (e.g. "Script", "Editor", "Runtime").'),
            limit: z.number().int().min(1).max(500).optional().describe('Most recent N (default 60).'),
        },
        annotations: READ,
    });

    relay('play_control', 'play.control', {
        title: 'Play / stop',
        description: 'Run the game in the editor to test it. play = the player possessed; simulate = physics and scripts run with '
            + 'the editor camera free; pause; stop returns to editing (edits made during play are discarded). play/simulate run '
            + '`runSeconds` (returning early on the first error) and report the new log lines and a cursor; with `capture` and '
            + '`stopAfter` one call is a whole test run.',
        inputSchema: {
            action: z.enum(['play', 'simulate', 'pause', 'stop', 'status']),
            runSeconds: z.number().min(0).max(30).optional().describe('How long to run before answering (default 1.5).'),
            capture,
            stopAfter: z.boolean().optional().describe('Stop the game before answering.'),
        },
        annotations: WRITE,
        _meta: CORE,
    }, { timeoutMs: (/** @type {any} */ a) => 20000 + (a?.runSeconds ?? 1.5) * 1000 + extraMs(a) });

    relay('history', 'history', {
        title: 'Undo / redo',
        description: 'Undo or redo steps on the active tab\'s history. Each scene_edit call is one step.',
        inputSchema: {
            action: z.enum(['undo', 'redo', 'status']),
            steps: z.number().int().min(1).max(50).optional(),
        },
        annotations: WRITE,
    });

    relay('scene_save', 'scene.save', {
        title: 'Save',
        description: 'Save the active tab (the open scene, or the asset being edited) to the project, like Ctrl+S.',
        inputSchema: {},
        annotations: WRITE,
    }, { timeoutMs: 60000 });

    relay('execute_js', 'execute', {
        title: 'Execute JavaScript in the editor',
        description: 'Escape hatch: run an async JavaScript function body inside the editor page, for anything the other tools do '
            + 'not cover. In scope: `cleo` (the whole engine module: Node, Material, Logger, Input...), `engine` (the CleoEngine), '
            + '`scene` (the open scene, or the play scene during Play), `editor` (the editor context: libraries, scripts/bodies/'
            + 'triggers maps, actions), `find(ref)` (resolve a node ref), `log(...args)`. `return` a JSON-serialisable value. '
            + 'Structure changes (add/remove) made here are undoable as one step; property changes are not. Plain JavaScript, not '
            + 'TypeScript. The user approves every run, so prefer the dedicated tools when they fit.',
        inputSchema: {
            code: z.string().min(1).describe('Function body, e.g. `const n = find("/Player"); return n.position;`'),
            timeoutMs: z.number().int().min(100).max(120000).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
        // Claude Code asks the user on every call, even in a bypass-permissions session.
        _meta: { 'anthropic/requiresUserInteraction': true },
    }, { timeoutMs: (/** @type {any} */ a) => (a?.timeoutMs ?? 30000) + 5000 });
    return defs;
}
