// @ts-check
// The tool catalog. Schemas and descriptions live HERE, so `tools/list` answers even while no editor is
// connected; every handler relays to the editor (applications/editor/src/features/agentBridge/commands.ts),
// which runs it against the live project. Method names below must match that file's registry.
//
// Written for few round trips: every tool loads up front (the whole catalog is a few thousand tokens, less
// than one tool-search turn costs), a create takes everything a node needs (material included) and a change
// can return a screenshot, so a request like "add a red cube and show me" is one call. The schemas stay
// small, because every tool's schema is in every request; the node-ref grammar and the conventions live
// once, in INSTRUCTIONS. Inputs are strict: a field a tool does not take is an error, never silently dropped.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { BridgeError } from './bridge.mjs';
import { discoveryFilePath } from './discovery.mjs';
import { EngineApi } from './engineApi.mjs';
import { ASSET_KINDS, addTypesText } from './catalog.mjs';

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
/**
 * Loaded with the session instead of found through tool search. On every tool: the whole catalog costs less
 * than the extra turn a deferred tool's first use takes, and an agent at work here uses most of them.
 */
const LOAD = { 'anthropic/alwaysLoad': true };

/** Up to four angles around the framed node, composited into one image. */
const views = z.union([
    z.literal('quad'),
    z.array(z.strictObject({ yaw: z.number(), pitch: z.number().optional() })).min(1).max(4),
]);

/** A screenshot taken after the change, in the same call. */
const capture = z.union([z.boolean(), z.strictObject({
    focus: z.string().optional(),
    yaw: z.number().optional(),
    pitch: z.number().optional(),
    views: views.optional(),
    pane: z.enum(['editing', 'all']).optional(),
    maxSize: z.number().int().optional(),
})]).optional().describe('Screenshot afterwards: true = the view as it is; {focus:"$alias"} frames that node first; {focus, views:"quad"} shows it from four sides in one image.');

/** A material as the tools describe it; material_write documents the fields. */
const materialFields = {
    type: z.enum(['pbr', 'cel', 'foliage', 'unlit']).optional(),
    baseColor: vec3.optional(),
    metallic: unit.optional(),
    roughness: unit.optional(),
    emissive: vec3.optional(),
    emissiveIntensity: z.number().min(0).optional(),
    opacity: unit.optional(),
    transparent: z.boolean().optional(),
    textures: z.record(z.string(), z.string().nullable()).optional(),
    props: z.record(z.string(), z.any()).optional(),
};

/** Asset kinds workspace openAsset opens, and asset_list lists. */
const assetKind = z.enum(/** @type {[string, ...string[]]} */ (ASSET_KINDS));

/**
 * @typedef {{ name: string, config: { title: string, description: string, inputSchema: Record<string, any>,
 *   annotations: Record<string, boolean>, _meta?: Record<string, unknown> }, handler: (args: any, ctx?: any) => Promise<any> }} ToolDef
 */

/** Anything that can run an editor command: the editor bridge itself, or a peer of the host that owns it. */
/** @typedef {{ call(method: string, params: unknown, opts?: { timeoutMs?: number, signal?: AbortSignal }): Promise<any> }} Caller */

/**
 * Register every tool on an MCP server (the stdio server Claude Code launches). The input shapes are wrapped
 * in a STRICT `z.object` here (MCP SDK v2's form): the SDK hands a handler the parsed arguments, and a plain
 * object would drop a misspelt or retired field without a word, so the agent never learns its edit missed.
 * The handler gets the request context too: its abort signal cancels the editor-side work.
 * @param {import('@modelcontextprotocol/server').McpServer} server @param {Caller} bridge
 * @param {{ engineApi?: EngineApi }} [opts]
 */
export function registerTools(server, bridge, opts = {}) {
    for (const d of toolDefinitions(bridge, opts)) {
        server.registerTool(d.name, { ...d.config, inputSchema: z.strictObject(d.config.inputSchema) },
            (/** @type {any} */ args, /** @type {any} */ ctx) => d.handler(args, ctx));
    }
}

/** Extra time a call needs when it also captures (frames settle) or stops the game afterwards. */
const extraMs = (/** @type {any} */ a) => (a?.capture ? (a.capture?.views ? 20_000 : 10_000) : 0) + (a?.stopAfter ? 20_000 : 0);

/** How long a play run lasts: runSeconds, or until the last input has been let go. */
export function runLengthSeconds(/** @type {any} */ a) {
    let end = a?.runSeconds ?? 1.5;
    for (const e of a?.input ?? []) end = Math.max(end, (e.at ?? 0) + (e.hold ?? 0.1) + 0.3);
    return end;
}

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
    const local = (name, config, fn) => defs.push({ name, config: { ...config, _meta: LOAD }, handler: async (/** @type {any} */ args) => {
        try { return toToolResult(await fn(args ?? {})); } catch (err) { return toErrorResult(err); }
    } });
    /**
     * @param {string} name @param {string} method @param {any} config
     * @param {{ timeoutMs?: number | ((args: any) => number) }} [opts]
     */
    const relay = (name, method, config, opts = {}) => defs.push({ name, config: { _meta: LOAD, ...config }, handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
        try {
            const timeoutMs = typeof opts.timeoutMs === 'function' ? opts.timeoutMs(args) : opts.timeoutMs;
            return toToolResult(await bridge.call(method, args ?? {}, { timeoutMs, signal: ctx?.mcpReq?.signal }));
        } catch (err) {
            return toErrorResult(err);
        }
    } });

    relay('editor_status', 'status', {
        title: 'Editor status',
        description: 'Whether a Cleo editor is connected and what it has open: the project, its scenes (open, main), the active '
            + 'tab and editor mode, the scene\'s dimension (2D/3D), play state (and a game running in its own window), the '
            + 'viewport\'s panes, unsaved changes, the selected node, the renderer. Cheap. Other tools already say when no '
            + 'editor is connected, so call this when you need those facts.',
        inputSchema: {},
        annotations: READ,
    }, { timeoutMs: 10000 });

    relay('scene_tree', 'scene.tree', {
        title: 'Scene tree',
        description: 'The open scene (during Play, the running game) as an outline: one line per node with its name, [type] and '
            + 'flags (script=, mass=/static, material=, tileset=, hidden, template=, model=); indentation is nesting. The header '
            + 'names the selection, the dimension and unsaved state. `root`/`depth` zoom into a subtree; `type`/`name` search '
            + 'the whole scene and return full paths; `with` adds world position or size to each line.',
        inputSchema: {
            root: ref.optional().describe('Subtree to outline (default: the scene root).'),
            depth: z.number().int().min(1).max(32).optional().describe('Levels below root to show (default 4).'),
            type: z.string().optional().describe('Only nodes of this type (e.g. "model", "light", "camera").'),
            name: z.string().optional().describe('Only names containing this (case-insensitive).'),
            with: z.array(z.enum(['pos', 'size', 'id'])).optional().describe('Per line: world position, world bounds size, id.'),
            limit: z.number().int().min(10).max(2000).optional().describe('Maximum lines (default 300).'),
        },
        annotations: READ,
    });

    relay('node_get', 'node.get', {
        title: 'Get node',
        description: 'One node or several: path, id, type, transform (metres, Euler degrees), world position and world bounds '
            + '(center, size, min, max of it and its children), children, script and its field values, shapes, variables, '
            + 'material (type, properties, textures), linked assets, sprite clips, and `props`: its settable properties with '
            + 'current values, by the names scene_edit `props` takes (dotted paths reach into objects, e.g. "light.intensity"). '
            + '`fields` picks parts (cheaper for many nodes); `json: true` adds the serialized node.',
        inputSchema: {
            node: ref.optional(),
            nodes: z.array(ref).min(1).max(50).optional().describe('Several at once, instead of node.'),
            fields: z.array(z.enum(['transform', 'bounds', 'children', 'script', 'material', 'shapes', 'variables', 'props', 'assets']))
                .optional().describe('Only these parts (default all).'),
            json: z.boolean().optional(),
        },
        annotations: READ,
    });

    const op = z.looseObject({
        op: z.enum(['create', 'update', 'delete', 'move', 'attachScript', 'detachScript', 'select', 'makeTemplate', 'unpack', 'revertOverrides', 'makeVariant']),
        node: z.string().nullable().optional().describe('Target of every op but create (select null clears).'),
        type: z.string().optional().describe(`create, by category: ${addTypesText()}`),
        template: z.string().optional().describe('create: a template (prefab) by name instead.'),
        model: z.string().optional().describe('create: an imported model by name instead.'),
        as: z.string().optional().describe('create: "$alias" for later ops and capture.focus.'),
        parent: z.string().optional().describe('create/move (default: scene root).'),
        index: z.number().int().optional().describe('move: position among siblings.'),
        script: z.string().optional().describe('create/attachScript: script asset name.'),
        name: z.string().optional().describe('Also makeTemplate/makeVariant: the new template\'s name.'),
        position: vec3.optional().describe('Local metres (2D: units).'),
        rotation: vec3.optional().describe('Local Euler DEGREES.'),
        scale: vec3.optional(),
        visible: z.boolean().optional(),
        props: z.record(z.string(), z.any()).optional().describe('By node_get `props` names, e.g. {"light.intensity": 800}.'),
        scriptFields: z.record(z.string(), z.any()).optional().describe('The attached script\'s public fields. A Material, Texture, Sound or Tileset field takes the asset\'s name or id; a node field (typed Node, LightNode, ...) takes a node ref; a Color takes [r, g, b] (0..1).'),
        material: z.union([z.string(), z.strictObject({ name: z.string().optional(), ...materialFields })]).optional()
            .describe('Asset name, or a spec as material_write takes (linear RGB) making one named after the node.'),
        shapes: z.union([z.literal('fit'), z.array(z.record(z.string(), z.any()))]).optional().describe('collider/trigger '
            + 'only: [{type: box|sphere|capsule|cylinder|plane, width/height/depth or radius/height, offset}], or "fit" (a box '
            + 'around the meshes under it). A collider is the rigid body: what is under it moves with it; props mass (0 = '
            + 'static), friction, layer, mask. A trigger fires onTriggerEnter/Exit on itself; in 2D it takes props size/offset.'),
        assets: z.strictObject({
            tileset: z.string().nullable().optional(),
            sequence: z.string().nullable().optional(),
            particleSystem: z.string().nullable().optional(),
        }).optional().describe('Link library assets by name (null unlinks): a sprite\'s tileset, a sequence node\'s sequence, a particle system\'s effect.'),
        replace: z.boolean().optional().describe('makeTemplate: swap the node for an instance of the new template (default true).'),
        field: z.string().optional().describe('revertOverrides: one script field or "name" (default all).'),
    });

    relay('scene_edit', 'scene.edit', {
        title: 'Edit scene',
        description: 'Change the open scene (or the template/model tab): a list of ops applied in order as ONE undo step. If '
            + 'an op fails, nothing is changed. Ops: create (a catalog type, template or model, plus every field update takes: '
            + 'material, shapes, script, scriptFields, props, assets), update, delete, move, attachScript, detachScript, select; '
            + 'templates: makeTemplate (a node becomes a new template; later creates in the call can place it), unpack (an '
            + 'instance becomes plain nodes), revertOverrides, makeVariant. Node refs: "/A/B" path, "#id", unique name, '
            + '"$alias" from an earlier create, "@selected". Inside a placed template instance is read-only: open the template '
            + 'with workspace openAsset, edit it there, then scene_save. Batch a whole build in one call and add `capture`: '
            + '{"ops":[{"op":"create","type":"collider","as":"$b","position":[0,2,0],"props":{"mass":1}},{"op":"create",'
            + '"type":"cube","parent":"$b","material":{"baseColor":[0.8,0.1,0.1]}},{"op":"update","node":"$b","shapes":"fit"}],'
            + '"capture":{"focus":"$b"}}. Returns each op\'s result with paths and ids. Refused during Play.',
        inputSchema: {
            ops: z.array(op).min(1).max(500),
            label: z.string().optional().describe('Undo label.'),
            atomic: z.boolean().optional().describe('false: on a failure, keep the ops before it.'),
            capture,
        },
        annotations: WRITE,
    }, { timeoutMs: a => 60000 + extraMs(a) });

    relay('script_write', 'script.write', {
        title: 'Write script',
        description: 'Create or replace a script asset (by name) with TypeScript, or patch it with `edits`, optionally attach it, '
            + 'and check it: the runtime compile and the editor\'s type-check against the engine API. Returns diagnostics '
            + '(line:col message) and the public fields. A script with errors is still saved: fix it and call again. The class '
            + 'extends the type of the node it attaches to (Node attaches anywhere). Updating a script re-seeds every node using '
            + 'it. To see it run, follow with play_control {action:"simulate", capture:true, stopAfter:true}.',
        inputSchema: {
            name: z.string().min(1).describe('Script asset name.'),
            source: z.string().min(1).optional().describe('The whole source.'),
            edits: z.array(z.strictObject({ old: z.string().min(1), new: z.string() })).min(1).max(50).optional()
                .describe('Instead of source: exact replacements in the saved source, each `old` found exactly once.'),
            attach: z.array(ref).optional().describe('Nodes to attach it to (replacing their script), e.g. ["@selected"].'),
            check: z.boolean().optional().describe('Run the type-check (default true).'),
        },
        annotations: WRITE,
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
    }, args => engineApi.answer(args));

    relay('script_read', 'script.read', {
        title: 'Read script',
        description: 'The source of a script asset, its base type, its public fields and the nodes in the open scene that use it.',
        inputSchema: { name: z.string().min(1) },
        annotations: READ,
    });

    relay('material_write', 'material.write', {
        title: 'Write material',
        description: 'Create or update a material asset by name and optionally link it to nodes. type: pbr (default), cel (toon '
            + 'bands), foliage (PBR that sways in the wind), unlit; an existing material keeps its type unless one is given. '
            + 'Colours are linear RGB 0..1; opacity below 1 needs transparent: true. textures: slot -> texture asset name (null '
            + 'clears): pbr baseColor, normal, metallicRoughness, metallic, roughness, occlusion, emissive, displacement, mask; '
            + 'cel base, ramp, emissive, normal. props: any other property by name. Answers with every property and its value. '
            + 'Updating a material re-applies it everywhere it is used. (scene_edit create/update can also make one inline.)',
        inputSchema: {
            name: z.string().min(1),
            ...materialFields,
            assignTo: z.array(ref).optional(),
            capture,
        },
        annotations: WRITE,
    }, { timeoutMs: a => 30000 + extraMs(a) });

    relay('asset_list', 'asset.list', {
        title: 'List assets',
        description: 'The project\'s asset libraries by name: templates (prefabs), models, materials, landscape materials, scripts, '
            + 'animations, animation fields, animation controllers, rigs, AI brains, particle systems, sequences, sounds, '
            + 'textures, tilesets. Filter by kind and/or name.',
        inputSchema: {
            kind: assetKind.optional(),
            query: z.string().optional().describe('Only names containing this text (case-insensitive).'),
            ids: z.boolean().optional().describe('Add each asset\'s id.'),
        },
        annotations: READ,
    });

    relay('view_capture', 'view.capture', {
        title: 'Capture viewport',
        description: 'A screenshot of the editor viewport as rendered (during Play: the game view). A split viewport gives its '
            + 'editing pane (pane:"all" for every pane). Optionally frame a node first (moves the EDITOR camera, not the game '
            + 'camera; in an orthographic pane it keeps its axis), from up to four angles in one image. Changing tools take '
            + '`capture` too, which saves this call.',
        inputSchema: {
            focus: ref.optional().describe('Frame this node first.'),
            yaw: z.number().optional().describe('Orbit angle in degrees around it (0 = looking along +Z, default 35).'),
            pitch: z.number().optional().describe('Degrees above the horizon (default 25).'),
            views: views.optional().describe('With focus: "quad" (four sides) or [{yaw, pitch}] x4, in one 2x2 image.'),
            pane: z.enum(['editing', 'all']).optional(),
            maxSize: z.number().int().min(128).max(2048).optional().describe('Longest side in pixels (default 1024).'),
            format: z.enum(['jpeg', 'png']).optional(),
        },
        annotations: READ,
    }, { timeoutMs: a => (a?.views ? 40000 : 20000) });

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

    const inputEvent = z.strictObject({
        at: z.number().min(0).max(60).describe('Seconds into this run.'),
        key: z.string().optional().describe('KeyboardEvent.code: "KeyW", "Space", "ShiftLeft", "ArrowUp"...'),
        action: z.string().optional().describe('A project input action ("Jump"): its first key or mouse binding.'),
        mouse: z.enum(['left', 'right', 'middle']).optional(),
        hold: z.number().min(0).max(60).optional().describe('Seconds held (default 0.1).'),
        move: z.array(z.number()).length(2).optional().describe('Mouse movement [dx, dy] in pixels, spread over hold.'),
        wheel: z.number().optional(),
    });

    relay('play_control', 'play.control', {
        title: 'Play / stop',
        description: 'Run the game in the editor to test it (always in the editor, whatever the Play target; a game in its own '
            + 'window is only stopped or paused from here). play = the player possessed; simulate = physics and scripts with '
            + 'the editor camera free; run = keep a running game going (more input, watch, capture); pause; stop (edits '
            + 'made during play are discarded). play/simulate/run last `runSeconds` (or until the last input ends), return '
            + 'early on the first error, and report new log lines and a cursor. `input` drives the player (play only), '
            + '`watch` samples nodes as numbers, so one call is a test: {"action":"play","input":[{"at":0.2,"key":"KeyW",'
            + '"hold":1.5}],"watch":["/Player"],"stopAfter":true}.',
        inputSchema: {
            action: z.enum(['play', 'simulate', 'run', 'pause', 'stop', 'status']),
            runSeconds: z.number().min(0).max(60).optional().describe('How long to run before answering (default 1.5).'),
            input: z.array(inputEvent).max(200).optional(),
            watch: z.array(z.union([ref, z.strictObject({ node: ref, props: z.array(z.string()).min(1).max(8) })])).max(8).optional()
                .describe('Sampled 4x a second: world position, yaw, velocity, grounded, animation state, and props.'),
            capture,
            stopAfter: z.boolean().optional().describe('Stop the game before answering.'),
        },
        annotations: WRITE,
    }, { timeoutMs: (/** @type {any} */ a) => 20000 + runLengthSeconds(a) * 1000 + extraMs(a) });

    relay('workspace', 'workspace', {
        title: 'Scenes and tabs',
        description: 'The project\'s scenes and the editor\'s tabs. listScenes; openScene (clears that tab\'s undo history); '
            + 'newScene (made and opened; open:false only makes it); renameScene; setMainScene (where the game starts); '
            + 'duplicateScene; setDimension ("2D"/"3D", of the open scene); openAsset (kind + name in its own tab: in a template '
            + 'or model tab scene_edit edits its nodes); switchTab ("scene" or a tab title); closeTab. Leaving unsaved work '
            + 'needs unsaved: "save" or "discard". Answers with the editor status afterwards.',
        inputSchema: {
            action: z.enum(['listScenes', 'openScene', 'newScene', 'renameScene', 'setMainScene', 'duplicateScene', 'setDimension', 'openAsset', 'switchTab', 'closeTab']),
            scene: z.string().optional().describe('Scene name or id (default: the open scene).'),
            name: z.string().optional().describe('newScene/renameScene: the new name; openAsset: the asset.'),
            kind: assetKind.optional().describe('openAsset: what kind of asset.'),
            tab: z.string().optional().describe('switchTab/closeTab: "scene" or a tab title.'),
            dimension: z.enum(['2D', '3D']).optional(),
            open: z.boolean().optional(),
            unsaved: z.enum(['save', 'discard']).optional(),
        },
        annotations: WRITE,
    }, { timeoutMs: 90000 });

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
            + '`scene` (the open scene, or the play scene during Play), `editor` (the editor context: libraries, the scripts '
            + 'map, actions), `find(ref)` (resolve a node ref), `track(node)` (await it before changing a node, and the change '
            + 'is undoable), `log(...args)`. `return` a JSON-serialisable value. The run is one undo step; adds and removes are '
            + 'always recorded. Plain JavaScript, not TypeScript. Prefer the dedicated tools when they fit.',
        inputSchema: {
            code: z.string().min(1).describe('Function body, e.g. `const n = find("/Player"); await track(n); n.setPosition([0, 1, 0]); return n.position;`'),
            timeoutMs: z.number().int().min(100).max(120000).optional(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    }, { timeoutMs: (/** @type {any} */ a) => (a?.timeoutMs ?? 30000) + 5000 });
    return defs;
}
