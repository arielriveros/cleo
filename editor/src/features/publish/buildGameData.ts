import type { Scene, RenderSettings, NodeTemplate, InputMap } from 'cleo';
import { Logger, isDefaultInputMap } from 'cleo';
import type { BodyDescription, ShapeDescription } from '../EngineContext';
import { fanOutScripts, SCRIPT_ID_VAR, type ScriptAsset } from '../../utils/scripts';
import type { Template } from '../../utils/templates';
import { resolveMaterialRefs, type MaterialAsset } from '../../utils/materials';
import { deepClone } from '../../utils/deepClone';
import { MODEL_ID_VAR, LEGACY_MODEL_ID_VAR } from '../../utils/models';
import { resolveModelAnimations } from '../../utils/animationResolve';
import type { AnimationAsset } from '../../utils/animationAssets';

// Sources needed to assemble a complete, self-contained game JSON.
export interface GameDataSources {
  scene: Scene;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
  // The shared script asset library: resolves each node's __scriptId link to the asset's source (into
  // `scripts`) and injects the node's native script-field values as `scriptVars`.
  scriptAssets?: ScriptAsset[];
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
  models?: { id: string; nodeJson: any; rigId?: string; animationIds?: string[] }[];
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
}

// Remove editor-only and debug helper nodes so they never ship in a play scene or published game.
export function clearDebuggingNodes(scene: any): void {
  const iterate = (children: any[]): any[] => children.filter((child: any) => {
    if (child.name?.includes('__debug__')) {
      Logger.info(`Removing debugging node ${child.name}`, 'Publish');
      return false;
    }
    if (child.name?.includes('__editor__')) {
      Logger.info(`Removing editor node ${child.name}`, 'Publish');
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

// Re-attach physics bodies and triggers (editor-side maps keyed by node id) onto the serialized tree.
export function injectBodies(
  scene: any,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
): void {
  // The root too: a scene root never has a body, but a TEMPLATE root often does, and templates are baked
  // through this same function.
  const apply = (node: any) => {
    const b = bodies.get(node.id);
    if (b) node.body = b;
    const t = triggers.get(node.id);
    if (t) node.trigger = t;
  };
  const iterate = (children: any[]) => (children ?? []).forEach((child: any) => {
    apply(child);
    iterate(child.children ?? []);
  });
  apply(scene);
  iterate(scene.children ?? []);
}

/**
 * Bake the template library into the self-contained form the runtime registry takes: one JSON blob per
 * template, materials re-resolved and scripts/bodies/triggers inlined into the nodes themselves.
 * Node ids inside a baked template stay as-is: they key the published build's script registry, and
 * `Scene.instantiate` records the original as `__sourceId` when it renumbers a copy.
 */
export function bakeTemplates(templates: Template[], materials?: MaterialAsset[], scriptAssets?: ScriptAsset[]): NodeTemplate[] {
  const assetById = new Map((scriptAssets ?? []).map(a => [a.id, a]));

  // A template subtree has no live nodes to read __scriptId off, so resolve the link from the serialized
  // `variables`. Declared script FIELDS are not carried; attachClassScript applies the class defaults.
  const resolveSharedScripts = (json: any, out: Map<string, string>): void => {
    const id = json?.variables?.[SCRIPT_ID_VAR]?.value;
    const asset = typeof id === 'string' ? assetById.get(id) : undefined;
    if (asset && !out.has(json.id)) out.set(json.id, asset.source);
    for (const child of (json?.children ?? [])) resolveSharedScripts(child, out);
  };

  return templates.map(template => {
    const node = deepClone(template.nodeJson);
    if (materials) resolveMaterialRefs(node, materials);
    // The template's own inline sources first; shared script assets fill in whatever they do not cover.
    const scripts = new Map(Object.entries(template.scripts ?? {}));
    resolveSharedScripts(node, scripts);
    injectScripts(node, scripts);
    injectBodies(
      node,
      new Map(Object.entries(template.bodies ?? {})),
      new Map(Object.entries(template.triggers ?? {})),
    );
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
  injectBodies(json.scene, sources.bodies, sources.triggers);
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
  // `graphics` seeds the engine constructor (clear color from frame one); `render` is the full snapshot
  // the player re-applies to its renderer after boot; `input` is the action map the player installs
  // before the first frame. Scene.parse ignores `config`.
  const config: Record<string, any> = {};
  if (sources.settings) {
    config.graphics = { clearColor: sources.settings.clearColor };
    config.render = sources.settings;
  }
  if (sources.input && !isDefaultInputMap(sources.input)) config.input = sources.input;
  if (Object.keys(config).length > 0) json.config = config;
  return json;
}
