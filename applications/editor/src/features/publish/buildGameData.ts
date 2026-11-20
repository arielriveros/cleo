import type { Scene, RenderSettings, NodeTemplate, InputMap } from 'cleo';
import { Logger, isDefaultInputMap, isEditorOwnedName } from 'cleo';
import { projectSettingsConfig } from '../options/projectSettings';
import type { ProjectSettings } from '../options/projectSettings';
import { fanOutScripts, parseScriptVariables, saveFieldNames, SCRIPT_ID_VAR, type ScriptAsset } from '../../utils/scripts';
import { buildScriptGraphCtx, importClosure, resolveScriptVariables, type ScriptGraphCtx } from '../../utils/scriptGraph';
import type { Template } from '../../utils/templates';
import { resolveMaterialRefs, type MaterialAsset } from '../../utils/materials';
import { deepClone } from '@cleo/app-kit/utils/deepClone';
import { MODEL_ID_VAR, LEGACY_MODEL_ID_VAR } from '../../utils/models';
import { resolveModelAnimations } from '../../utils/animationResolve';
import type { AnimationAsset } from '../../utils/animationAssets';
import { reembedMachine, type AnimControllerAsset, type MachineLibs } from '../../utils/animationControllers';

// Sources needed to assemble a complete, self-contained game JSON.
export interface GameDataSources {
  scene: Scene;
  scripts: Map<string, string>;
  // The shared script asset library: resolves each node's __scriptId link to the asset's source (into
  // `scripts`) and injects the node's native script-field values as `scriptVars`.
  scriptAssets?: ScriptAsset[];
  // Script asset id -> VFS path. Turns on SCRIPT MODULES: each scripted node is stamped with its script's
  // project path (`scriptPath`, what `./` imports resolve against) and every script module the shipped
  // scripts import — helpers and base classes, transitively — is written to `json.modules`. Passed by
  // the RUNTIME builders (play + publish) only; saving a scene leaves it out, so neither field is ever
  // persisted.
  scriptPaths?: ReadonlyMap<string, string>;
  // Baked into `json.templates` so scripts can `scene.instantiate('Name')` at runtime. Passed only by the
  // RUNTIME builders (play + publish); saving a scene leaves it out.
  templates?: Template[];
  // Re-resolves each template's __materialId links so an instance created at runtime gets the CURRENT
  // material, not the copy frozen in when the template was saved.
  materials?: MaterialAsset[];
  // The model and animation libraries, for baking each character's SHARED clips into the JSON — see
  // `attachSharedClips`. Passed by editor PLAY only. The publish path deliberately leaves them out: it
  // ships the clips once at the top level and the player retargets them at load, so baking them here
  // as well would put every clip on every character twice.
  models?: { id: string; nodeJson: any; rigId?: string }[];
  animations?: AnimationAsset[];
  // Play mode passes `true` (textures already live in TextureManager, skip re-serializing them).
  // Publishing passes `false` so every texture is embedded as base64 in the output.
  useCache?: boolean;
  // Snapshot of Renderer.getRenderSettings, serialized into `config` so a published game reproduces the
  // editor's look instead of falling back to renderer defaults.
  settings?: RenderSettings;
  // The project's input action map. PROJECT-wide, unlike `render` above, which each scene carries its
  // own copy of — two scenes disagreeing about what `Jump` is bound to would be inexplicable to a
  // player. Written only when it differs from the shipped defaults, so an untouched project's build
  // gains no bytes.
  input?: InputMap;
  /** Engine runtime + publish-window options; merged into `config` (see options/projectSettings). */
  projectSettings?: ProjectSettings;
}

// Remove editor-only and debug helper nodes so they never ship in a play scene or published game.
// Serialized JSON, so the test is the NAME contract (`isEditorOwnedName`); the `editorOwned` flag is
// never serialized, and `Node.serialize` has already dropped self-owned children by flag.
export function clearDebuggingNodes(scene: any): void {
  const iterate = (children: any[]): any[] => children.filter((child: any) => {
    if (isEditorOwnedName(child.name)) {
      const kind = child.name.includes('__debug__') ? 'debugging' : 'editor';
      Logger.info(`Removing ${kind} node ${child.name}`, 'Publish');
      return false;
    }
    child.children = iterate(child.children ?? []);
    return true;
  });
  scene.children = iterate(scene.children ?? []);
}

// Re-attach node scripts (an editor-side map keyed by node id) onto the serialized tree.
// Scene.parse reads `json.script` per node; Node.serialize emits them under `scripts` instead.
export function injectScripts(scene: any, scripts: Map<string, string>): void {
  const root = scripts.get(scene.id);
  if (root) scene.script = root;
  const iterate = (children: any[]) => (children ?? []).forEach((child: any) => {
    const s = scripts.get(child.id);
    if (s) child.script = s;
    iterate(child.children ?? []);
  });
  iterate(scene.children ?? []);
}

// Re-attach class-script native field values (nodeId -> { name: value }) onto the serialized tree, so the
// engine restores them as native own properties in _commonParse.
export function injectScriptVars(scene: any, scriptVars: Map<string, Record<string, any>>): void {
  const root = scriptVars.get(scene.id);
  if (root) scene.scriptVars = root;
  const iterate = (children: any[]) => (children ?? []).forEach((child: any) => {
    const v = scriptVars.get(child.id);
    if (v) child.scriptVars = v;
    iterate(child.children ?? []);
  });
  iterate(scene.children ?? []);
}

/**
 * Put a LEGACY template's id-keyed bodies and triggers back on its nodes, for the runtime to convert as
 * it parses them. The editor converts its library on load (physicsMigration.ts), so only a template
 * that has not been through it yet still has any.
 */
function inlineLegacyPhysics(root: any, bodies: Record<string, any> = {}, triggers: Record<string, any> = {}): void {
  if (!Object.keys(bodies).length && !Object.keys(triggers).length) return;
  const apply = (node: any) => {
    if (bodies[node.id]) node.body = bodies[node.id];
    if (triggers[node.id]) node.trigger = triggers[node.id];
    (node.children ?? []).forEach(apply);
  };
  apply(root);
}

/**
 * Bake the template library into the self-contained form the runtime registry takes: one JSON blob per
 * template, materials re-resolved and scripts inlined into the nodes themselves.
 * Node ids inside a baked template stay as-is: they key the published build's script registry, and
 * `Scene.instantiate` records the original as `__sourceId` when it renumbers a copy.
 */
export function bakeTemplates(
  templates: Template[], materials?: MaterialAsset[], scriptAssets?: ScriptAsset[],
  machineLibs?: MachineLibs & { controllers: AnimControllerAsset[] },
): NodeTemplate[] {
  const assetById = new Map((scriptAssets ?? []).map(a => [a.id, a]));

  // A template subtree has no live nodes to read __scriptId off, so resolve the link from the serialized
  // `variables`. Declared script FIELDS are not carried; attachClassScript applies the class defaults.
  const resolveSharedScripts = (json: any, out: Map<string, string>): void => {
    const id = json?.variables?.[SCRIPT_ID_VAR]?.value;
    const asset = typeof id === 'string' ? assetById.get(id) : undefined;
    if (asset && !out.has(json.id)) out.set(json.id, asset.source);
    for (const child of (json?.children ?? [])) resolveSharedScripts(child, out);
  };

  // A template holds RESOLVED copies of its characters' machines, as a scene's nodes do; one saved before a pose
  // (or a controller, a mask, a blend space) it links was edited would otherwise ship it as it was then. A scene is
  // re-resolved by resyncScene; a template, here.
  const reembed = (json: any): void => {
    if (!json || typeof json !== 'object') return;
    if (json.stateMachine?.parameters && machineLibs) {
      const next = reembedMachine(json.stateMachine, machineLibs);
      if (next) json.stateMachine = next;
    }
    for (const child of json.children ?? []) reembed(child);
  };

  return templates.map(template => {
    const node = deepClone(template.nodeJson);
    if (machineLibs) reembed(node);
    if (materials) resolveMaterialRefs(node, materials);
    // The template's own inline sources first; shared script assets fill in whatever they do not cover.
    const scripts = new Map(Object.entries(template.scripts ?? {}));
    resolveSharedScripts(node, scripts);
    injectScripts(node, scripts);
    inlineLegacyPhysics(node, template.bodies, template.triggers);
    return { id: template.id, name: template.name, node };
  });
}

/**
 * Write every character's SHARED clips into a serialized subtree, and report how many models got some.
 *
 * Two things conspire to make this necessary, and neither reports anything when it goes wrong:
 *
 *  - `AnimatedModel.serialize` DROPS a clip carrying an `assetId`. That is correct — an asset-backed clip
 *    must never be written into a scene file, or it would be a second copy that drifts. But it means the
 *    JSON handed to `Scene.parse` for play mode has no clips on any character whose model owns them
 *    through a rig, and the character T-poses.
 *  - A TEMPLATE is never in the parsed scene at all. It is JSON in the global registry that
 *    `Scene.instantiate` deep-copies later, so nothing that runs at load can reach a spawned enemy.
 *
 * Both are fixed by resolving here, once, against the model asset each node names. `__modelId` is
 * inherited down the subtree exactly as `modelInstanceRootOf` walks up it: the id sits on the holder,
 * and the skinned sub-mesh is its child.
 */
export function attachSharedClips(
  nodeJson: any,
  models: NonNullable<GameDataSources['models']>,
  animations: AnimationAsset[],
): number {
  if (!models.length || !animations.length) return 0;
  // model asset id -> clips, resolved once however many placements or templates use it. The retarget is
  // the expensive half and it is per (asset, skeleton), not per node.
  const perModel = new Map<string, any[]>();
  let attached = 0;

  const walk = (json: any, inherited?: string): void => {
    if (!json || typeof json !== 'object') return;
    const own = json.variables?.[MODEL_ID_VAR]?.value ?? json.variables?.[LEGACY_MODEL_ID_VAR]?.value;
    const modelId = (typeof own === 'string' && own) ? own : inherited;

    if (json.model?.skin && modelId) {
      let clips = perModel.get(modelId);
      if (!clips) {
        const asset = models.find(m => m.id === modelId);
        clips = asset ? resolveModelAnimations(asset, animations) : [];
        perModel.set(modelId, clips);
      }
      if (clips.length) {
        // Replace by NAME, never append: a subtree that still embeds a clip the rig also owns would
        // otherwise reach `addAnimation`'s de-dupe and come back as "Walk (2)", which no state machine
        // and no blend-space sample names. The embedded copy wins — it is the more specific answer.
        const embedded = (json.model.animations ?? []).filter((c: any) => !c.assetId);
        json.model.animations = [
          ...embedded,
          ...clips.filter(c => !embedded.some((e: any) => e.name === c.name)).map(c => ({ ...c })),
        ];
        attached++;
      }
    }
    for (const child of json.children ?? []) walk(child, modelId);
  };

  walk(nodeJson);
  return attached;
}

/**
 * Stamp `scriptPath` on every scripted node of a serialized tree (from its `__scriptId` link) and collect
 * `{ source, path }` roots for the import closure. Inline scripts with no asset get no path: they can use
 * `@/` imports but not relative ones.
 */
function stampScriptPaths(tree: any, pathOf: (assetId: string) => string | undefined, roots: { source: string, path?: string }[]): void {
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.script === 'string' && node.script) {
      const id = node.variables?.[SCRIPT_ID_VAR]?.value;
      const path = typeof id === 'string' ? pathOf(id) : undefined;
      if (path) node.scriptPath = path;
      roots.push({ source: node.script, path });
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

/**
 * Ship the script modules a game needs: the transitive import closure of every script in the scene and
 * in the baked templates, keyed by module id. A module nothing imports is not shipped. An import that
 * resolves to no script is reported here, before Play, as well as at runtime with the exact message.
 */
export function attachScriptModules(json: any, scriptAssets: ScriptAsset[], scriptPaths: ReadonlyMap<string, string>): void {
  const ctx = buildScriptGraphCtx(scriptPaths, scriptAssets);
  const roots: { source: string, path?: string }[] = [];
  stampScriptPaths(json.scene, ctx.pathOf, roots);
  for (const template of json.templates ?? []) stampScriptPaths((template as any).node, ctx.pathOf, roots);
  const { modules, missing } = importClosure(roots, ctx);
  if (modules.size) json.modules = Object.fromEntries([...modules].map(([id, asset]) => [id, asset.source]));
  for (const id of missing)
    Logger.warn(`A script imports '@${id}', but no script lives at ${id}.script — check the path in the Assets panel.`, 'Script');
}

/**
 * List each scripted node's `@save` fields on it as `saveFields`, which the engine's save system reads (a
 * published game ships no script schema). From the script's SOURCE, the one the node will run, so a script
 * saved before `@save` existed, or one inheriting tagged fields from a base-class script, still counts. Once
 * per distinct script. Must run after the scripts are inlined (`json.script`) and, for inherited fields,
 * after their paths are stamped.
 */
export function injectSaveFields(tree: any, ctx?: ScriptGraphCtx): void {
  const cache = new Map<string, string[]>();
  const fieldsOf = (source: string, path: string | undefined): string[] => {
    const key = `${path ?? ''}\u0000${source}`;
    let fields = cache.get(key);
    if (!fields) {
      try { fields = saveFieldNames(ctx ? resolveScriptVariables(source, path, ctx) : parseScriptVariables(source)); }
      catch { fields = []; }
      cache.set(key, fields);
    }
    return fields;
  };
  const visit = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.script === 'string' && node.script) {
      const fields = fieldsOf(node.script, typeof node.scriptPath === 'string' ? node.scriptPath : undefined);
      if (fields.length) node.saveFields = fields;
      else delete node.saveFields;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(tree);
}

// Single source of truth for the runtime scene JSON, shared by editor play mode and publishing.
// Produces the exact object shape Scene.parse consumes: { scene, textures?, ui }.
export async function buildGameData(sources: GameDataSources): Promise<any> {
  // Resolve every node's __scriptId link to its shared asset: source into `scripts`, native field values
  // for injectScriptVars. Reads the LIVE nodes — serialize does not capture native fields.
  const anyScene = sources.scene as any;
  const scriptVars = sources.scriptAssets
    ? fanOutScripts([anyScene.root, ...(anyScene.nodes ?? [])], sources.scriptAssets, sources.scripts)
    : new Map<string, Record<string, any>>();

  const json = await sources.scene.serialize(sources.useCache ?? false);
  clearDebuggingNodes(json.scene);
  injectScripts(json.scene, sources.scripts);
  injectScriptVars(json.scene, scriptVars);
  // Every template in the library is baked in, not just the placed ones: a script may instantiate any of
  // them by name. Their geometry is interned against the scene's in packGameBin.
  if (sources.templates?.length)
    json.templates = bakeTemplates(sources.templates, sources.materials, sources.scriptAssets);
  // Play mode only — see the `models`/`animations` fields. The scene AND the templates, because a
  // spawned character is never in the scene this is about to hand to `Scene.parse`.
  if (sources.models?.length && sources.animations?.length) {
    attachSharedClips(json.scene, sources.models, sources.animations);
    for (const template of json.templates ?? [])
      attachSharedClips((template as any).node, sources.models, sources.animations);
  }
  if (sources.scriptPaths && sources.scriptAssets)
    attachScriptModules(json, sources.scriptAssets, sources.scriptPaths);
  // What a save keeps of each script: its `@save` fields, scene and templates alike (a spawned copy saves
  // too). Runtime builds only, like the script paths: a saved scene file never carries them.
  if (sources.scriptPaths && sources.scriptAssets) {
    const graph = buildScriptGraphCtx(sources.scriptPaths, sources.scriptAssets);
    injectSaveFields(json.scene, graph);
    for (const template of json.templates ?? []) injectSaveFields((template as any).node, graph);
  }
  // `graphics` seeds the engine constructor (clear color from frame one); `render` is the full snapshot
  // the player re-applies to its renderer after boot; `input` is the action map the player installs
  // before the first frame. Scene.parse ignores `config`.
  const config: Record<string, any> = {};
  if (sources.settings) {
    config.graphics = { clearColor: sources.settings.clearColor };
    config.render = sources.settings;
  }
  if (sources.input && !isDefaultInputMap(sources.input)) config.input = sources.input;
  if (sources.projectSettings) Object.assign(config, projectSettingsConfig(sources.projectSettings));
  if (Object.keys(config).length > 0) json.config = config;
  return json;
}
