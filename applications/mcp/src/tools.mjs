// @ts-check
// The tool catalog. Schemas and descriptions live HERE, so `tools/list` answers even while no editor is
// connected; every handler relays to the editor (applications/editor/src/features/agentBridge/commands.ts),
// which runs it against the live project. Method names below must match that file's registry.

import { z } from 'zod';
import { BridgeError } from './bridge.mjs';

const vec3 = z.array(z.number()).length(3);
const nodeRef = z.string().min(1).describe('A node: "/Parent/Child" path from the scene root, "#<id>", a unique bare name, or a "$alias" set by an earlier create op in the same call.');

/** Text results past this are cut, with a note; the editor already pages its big answers. */
const MAX_TEXT = 60_000;

/** @param {string} s */
function clip(s) {
    return s.length <= MAX_TEXT ? s : `${s.slice(0, MAX_TEXT)}\n… [cut: ${s.length - MAX_TEXT} more characters; narrow the request]`;
}

/**
 * What the editor returned, as MCP content: `{text?, data?, images?, isError?}`.
 * @param {any} r
 */
export function toToolResult(r) {
    /** @type {any[]} */
    const content = [];
    if (typeof r?.text === 'string' && r.text) content.push({ type: 'text', text: clip(r.text) });
    if (r?.data !== undefined) content.push({ type: 'text', text: clip(JSON.stringify(r.data, null, 1)) });
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
 * @typedef {{ name: string, config: { title: string, description: string, inputSchema: Record<string, any>,
 *   annotations: Record<string, boolean>, _meta?: Record<string, unknown> }, handler: (args: any) => Promise<any> }} ToolDef
 */

/** Anything that can run an editor command: the editor bridge itself, or a peer of the host that owns it. */
/** @typedef {{ call(method: string, params: unknown, opts?: { timeoutMs?: number }): Promise<any> }} Caller */

/**
 * Register every tool on an MCP server (the stdio server Claude Code launches). The input shapes are wrapped
 * in `z.object` here (MCP SDK v2's form), always, so a handler is always called with its arguments first.
 */
export function registerTools(/** @type {import('@modelcontextprotocol/server').McpServer} */ server, /** @type {Caller} */ bridge) {
    for (const d of toolDefinitions(bridge)) {
        server.registerTool(d.name, { ...d.config, inputSchema: z.object(d.config.inputSchema) }, (/** @type {any} */ args) => d.handler(args));
    }
}

/**
 * The tool catalog as plain definitions (tests read them without a server). Each handler relays to the
 * editor and maps the answer to MCP content.
 * @param {Caller} bridge
 * @returns {ToolDef[]}
 */
export function toolDefinitions(bridge) {
    /** @type {ToolDef[]} */
    const defs = [];
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
        description: 'Start here. Reports whether a Cleo editor is connected and what it has open: the project, its scenes '
            + '(which is open, which is the main one), the active tab and editor mode, play state, unsaved changes, the '
            + 'selected node and the renderer backend. Cheap; call it again after a project switch or a reload.',
        inputSchema: {},
        annotations: READ,
        _meta: { 'anthropic/alwaysLoad': true },
    }, { timeoutMs: 10000 });

    relay('scene_tree', 'scene.tree', {
        title: 'Scene tree',
        description: 'An outline of the open scene (or, during Play, the running game scene): one line per node with its '
            + 'name, [type] and flags (script=<name>, body, trigger, hidden, template=<name>, model=<name>). '
            + 'Indentation is nesting; paths are built from the names. Editor helpers are left out. '
            + 'Use `root` and `depth` to zoom into a subtree, and `type`/`name` to search the whole scene (a search returns '
            + 'full paths instead of an outline). Large scenes are cut at `limit` lines.',
        inputSchema: {
            root: nodeRef.optional().describe('Subtree to outline (default: the scene root).'),
            depth: z.number().int().min(1).max(32).optional().describe('Levels below root to show (default 4).'),
            type: z.string().optional().describe('Only nodes of this type (e.g. "model", "light", "camera", "character").'),
            name: z.string().optional().describe('Only nodes whose name contains this text (case-insensitive).'),
            limit: z.number().int().min(10).max(2000).optional().describe('Maximum lines (default 300).'),
        },
        annotations: READ,
    });

    relay('node_get', 'node.get', {
        title: 'Get node',
        description: 'Everything about one node: path, id, type, transform (position metres, rotation Euler degrees, scale), '
            + 'visibility, children, its script (asset name + per-node field values), physics body, trigger, variables, '
            + 'material link, and `props`: the node\'s settable properties with their current values. Those prop names are '
            + 'exactly what scene_edit update `props` accepts (dotted paths reach into objects, e.g. "light.intensity"). '
            + 'Set `json: true` to also get the serialized node (vertex buffers and images elided).',
        inputSchema: {
            node: nodeRef,
            json: z.boolean().optional().describe('Include the serialized node JSON (default false).'),
        },
        annotations: READ,
    });

    const createOp = z.object({
        op: z.literal('create'),
        type: z.string().optional().describe('An Add-catalog id. Gameplay: empty, trigger, character, controller, navMesh. '
            + 'Cameras: perspectiveCamera, orthographicCamera, cameraRig. Lights: directionalLight, pointLight, spotlight, skyLight. '
            + 'Primitives: cube, sphere, capsule, cylinder, cone, torus, pyramid, quad, plane, circle, triangle. '
            + 'Complex: ramp, cornerRamp, stairs, spiralStairs, arch, tube, hollowBox. Environment: skybox, skyAtmosphere, '
            + 'lightProbe, exposureVolume, volumetricFog, waterVolume, occlusionVolume, wind, weather, volumetricClouds, landscape. '
            + 'Effects: decal, particleSystem, forceField, cloth. Audio: spatialSound, ambientSound. Sprites: sprite, animatedSprite, tilemap. '
            + 'UI: uiCanvas, uiWorldRoot, uiStackColumn, uiStackRow, uiSpacer, uiPanel, uiText, uiImage, uiButton, uiProgressBar, uiSlider, uiToggle, uiTextInput.'),
        template: z.string().optional().describe('Instead of `type`: instantiate the template (prefab) with this name. See asset_list.'),
        model: z.string().optional().describe('Instead of `type`: instantiate the imported model asset with this name. See asset_list.'),
        parent: nodeRef.optional().describe('Parent node (default: the scene root; UI elements go under a UI canvas automatically).'),
        name: z.string().optional(),
        position: vec3.optional().describe('Local position in metres.'),
        rotation: vec3.optional().describe('Local Euler rotation in DEGREES.'),
        scale: vec3.optional(),
        as: z.string().regex(/^\$[A-Za-z0-9_]+$/).optional().describe('Alias ("$coin") later ops in this call can use as a node ref.'),
    });
    const updateOp = z.object({
        op: z.literal('update'),
        node: nodeRef,
        name: z.string().optional(),
        position: vec3.optional(),
        rotation: vec3.optional().describe('Euler DEGREES.'),
        scale: vec3.optional(),
        visible: z.boolean().optional(),
        props: z.record(z.string(), z.any()).optional().describe('Property assignments by name, as listed in node_get `props` '
            + '(e.g. {"light.intensity": 800, "castShadows": true}).'),
        scriptFields: z.record(z.string(), z.any()).optional().describe('Per-node values of the attached script\'s public fields.'),
        material: z.string().optional().describe('Link the material asset with this name (see asset_list / material_write).'),
        body: z.record(z.string(), z.any()).nullable().optional().describe('Rigid body, merged over the current one; null removes it. '
            + 'Fields: mass (0 = static), friction, restitution, linearDamping, angularDamping, linearConstraints [x,y,z] (1 free, 0 locked), '
            + 'angularConstraints, simulatePhysics, groundProbeDistance, canSleep, shapes: [{type:"box", width, height, depth, offset:[0,0,0], rotation:[0,0,0]} | '
            + '{type:"sphere", radius, ...} | {type:"capsule", radius, height, numSegments:12, ...} | {type:"cylinder", radius, height, numSegments:12, ...}]. '
            + 'Shapes are in the node\'s local units. A body with no shapes gets a box fitted to the node\'s mesh, or a 1 m box.'),
        trigger: z.record(z.string(), z.any()).nullable().optional().describe('Trigger volume {shapes:[...], enabled?, detectTriggers?}; null removes it. '
            + 'Scripts receive onTriggerEnter(other)/onTriggerExit(other).'),
    });
    const op = z.discriminatedUnion('op', [
        createOp,
        updateOp,
        z.object({ op: z.literal('delete'), node: nodeRef }),
        z.object({ op: z.literal('move'), node: nodeRef, parent: nodeRef, index: z.number().int().min(0).optional().describe('Position among the parent\'s children (default: last).') }),
        z.object({ op: z.literal('attachScript'), node: nodeRef, script: z.string().describe('Script asset name.') }),
        z.object({ op: z.literal('detachScript'), node: nodeRef }),
        z.object({ op: z.literal('select'), node: nodeRef.nullable() }),
    ]);

    relay('scene_edit', 'scene.edit', {
        title: 'Edit scene',
        description: 'Apply a list of edits to the open scene as ONE undo step (the editor\'s Undo, or the history tool, reverts the '
            + 'whole call). Ops run in order and stop at the first failure; earlier ops of that call stay applied and are still one '
            + 'undo step. Ops: create (from the Add catalog, a template or a model), update (name, transform, visible, props, '
            + 'scriptFields, material, body, trigger), delete, move (reparent/reorder), attachScript, detachScript, select. '
            + 'Batch related edits into one call: build a whole level in a single scene_edit. Returns each op\'s result, '
            + 'including created nodes\' paths and ids. Refused while the game is playing.',
        inputSchema: {
            ops: z.array(op).min(1).max(500),
            label: z.string().optional().describe('Undo label shown in the editor (default "Claude edit").'),
        },
        annotations: WRITE,
    }, { timeoutMs: 60000 });

    relay('script_write', 'script.write', {
        title: 'Write script',
        description: 'Create or replace a script asset (by name) with TypeScript source, optionally attaching it to nodes, and check it: '
            + 'the runtime compile (syntax, module shape) and the editor\'s TypeScript type-check against the engine API. Returns the '
            + 'diagnostics (line:col message) and the public fields the inspector will show. A script with errors is still saved, so '
            + 'fix and call again. Form: `import { Node } from \'cleo\'; export default class Name extends Node { public speed = 2; '
            + 'onUpdate(delta: number, time: number) { ... } }`. Extend the class of the node type it attaches to (Node attaches '
            + 'anywhere; ModelNode only to models, CharacterNode to characters, ...). Updating a script re-seeds every node using it.',
        inputSchema: {
            name: z.string().min(1).describe('Script asset name (also its class name\'s source of truth in the explorer).'),
            source: z.string().min(1),
            attach: z.array(nodeRef).optional().describe('Nodes to attach the script to (replacing their current script).'),
            check: z.boolean().optional().describe('Run the TypeScript type-check (default true; the first one loads the checker, ~5 s).'),
        },
        annotations: WRITE,
    }, { timeoutMs: 90000 });

    relay('script_read', 'script.read', {
        title: 'Read script',
        description: 'The source of a script asset, its base type, its public fields and the nodes in the open scene that use it.',
        inputSchema: { name: z.string().min(1) },
        annotations: READ,
    });

    relay('material_write', 'material.write', {
        title: 'Write material',
        description: 'Create or update a PBR material asset by name and optionally link it to nodes. Colours are linear RGB 0..1. '
            + 'Updating an existing material re-applies it to every node in the open scene that links it.',
        inputSchema: {
            name: z.string().min(1),
            baseColor: vec3.optional(),
            metallic: z.number().min(0).max(1).optional(),
            roughness: z.number().min(0).max(1).optional(),
            emissive: vec3.optional().describe('Emissive colour.'),
            emissiveIntensity: z.number().min(0).optional(),
            opacity: z.number().min(0).max(1).optional().describe('Below 1 needs transparent: true.'),
            transparent: z.boolean().optional(),
            assignTo: z.array(nodeRef).optional(),
        },
        annotations: WRITE,
    }, { timeoutMs: 30000 });

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
        description: 'A screenshot of the editor viewport exactly as rendered (during Play: the game view). Use it to check your '
            + 'work visually. Optionally frame a node first (moves the EDITOR camera, not the game camera) from a viewing angle.',
        inputSchema: {
            focus: nodeRef.optional().describe('Frame this node before capturing.'),
            yaw: z.number().optional().describe('With focus: orbit angle in degrees around the node (0 = looking along +Z, default 35).'),
            pitch: z.number().optional().describe('With focus: degrees above the horizon (default 25).'),
            maxSize: z.number().int().min(128).max(2048).optional().describe('Longest side in pixels (default 1024).'),
            format: z.enum(['jpeg', 'png']).optional().describe('Default jpeg.'),
        },
        annotations: READ,
    }, { timeoutMs: 20000 });

    relay('logs_read', 'logs.read', {
        title: 'Read logs',
        description: 'The editor console: script errors, Logger output, warnings. Pass the `cursor` from a previous call (or from '
            + 'play_control) to get only what arrived since. Script errors carry the scope "Script".',
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
        description: 'Run the game in the editor to test it. play = the game with the player possessed; simulate = physics and '
            + 'scripts run while the editor camera stays free; pause; stop returns to editing (edits made during play are '
            + 'discarded). With play/simulate, `runSeconds` lets it run before answering, then returns the log entries that '
            + 'appeared plus a cursor. Combine with view_capture to see the game.',
        inputSchema: {
            action: z.enum(['play', 'simulate', 'pause', 'stop', 'status']),
            runSeconds: z.number().min(0).max(30).optional().describe('After play/simulate, wait this long before answering (default 1.5).'),
        },
        annotations: WRITE,
    }, { timeoutMs: (/** @type {any} */ a) => 20000 + (a?.runSeconds ?? 1.5) * 1000 });

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
            + 'TypeScript. Prefer the dedicated tools when they fit.',
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
