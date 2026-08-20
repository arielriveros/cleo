import type { Scene, RenderSettings, NodeTemplate } from 'cleo';
import { Logger } from 'cleo';
import type { BodyDescription, ShapeDescription } from '../EngineContext';
import { fanOutScripts, SCRIPT_ID_VAR, type ScriptAsset } from '../../utils/scripts';
import type { Template } from '../../utils/templates';
import { resolveMaterialRefs, type MaterialAsset } from '../../utils/materials';

// Sources needed to assemble a complete, self-contained game JSON.
export interface GameDataSources {
  scene: Scene;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
  // The shared script asset library. Given it, buildGameData resolves each node's __scriptId link to the
  // asset's source (into `scripts`) and injects the node's native script-field values as `scriptVars`.
  scriptAssets?: ScriptAsset[];
  // The template library, baked into `json.templates` so scripts can `scene.instantiate('Name')` at runtime.
  // Passed only by the RUNTIME builders (play + publish); saving a scene leaves it out, because there the
  // templates live in the library as assets in their own right.
  templates?: Template[];
  // Material library, used to re-resolve each template's __materialId links so an instance created at
  // runtime gets the CURRENT material rather than the copy frozen in when the template was saved. Mirrors
  // what instantiateTemplate already does for editor-time placement.
  materials?: MaterialAsset[];
  // Play mode passes `true` (textures already live in TextureManager, skip re-serializing them).
  // Publishing passes `false` so every texture is embedded as base64 in the output.
  useCache?: boolean;
  // Snapshot of the live renderer's look settings (Renderer.getRenderSettings). Serialized into
  // `config` so a standalone/published game reproduces the exact look the editor was showing —
  // otherwise its fresh renderer falls back to defaults (black clear color, default post/SSAO/blur).
  settings?: RenderSettings;
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

// Re-attach node scripts (kept in an editor-side map keyed by node id) onto the serialized tree.
// Scene.parse reads `json.script` per node, so scripts must be injected here rather than relied on
// from Node.serialize (which emits them under a different `scripts` field).
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
// engine restores them as native own properties in _commonParse. Mirrors injectScripts.
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
  // The root too, exactly like injectScripts: a scene root never has a body, but a TEMPLATE root very often
  // does, and templates are baked through this same function. Skipping it dropped the collider off every
  // single-node template.
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
 * template with its materials re-resolved and its scripts/bodies/triggers — which the editor keeps in maps
 * beside the subtree — inlined into the nodes themselves.
 *
 * Node ids inside a baked template stay as-is. They are the keys the published build's script registry is
 * built on (extractScripts walks these too), and `Scene.instantiate` records the original as `__sourceId`
 * when it renumbers a copy, which is how an instantiated node still finds its precompiled script.
 */
export function bakeTemplates(templates: Template[], materials?: MaterialAsset[], scriptAssets?: ScriptAsset[]): NodeTemplate[] {
  const assetById = new Map((scriptAssets ?? []).map(a => [a.id, a]));

  // The JSON counterpart of fanOutScripts: a template subtree has no live nodes to read __scriptId off, so
  // resolve the link straight from the serialized `variables`. Declared script FIELDS are not carried — the
  // template stores no per-node values for them — so an instantiated node gets the class's own defaults,
  // which attachClassScript applies (see applyFieldDefaults).
  const resolveSharedScripts = (json: any, out: Map<string, string>): void => {
    const id = json?.variables?.[SCRIPT_ID_VAR]?.value;
    const asset = typeof id === 'string' ? assetById.get(id) : undefined;
    if (asset && !out.has(json.id)) out.set(json.id, asset.source);
    for (const child of (json?.children ?? [])) resolveSharedScripts(child, out);
  };

  return templates.map(template => {
    const node = JSON.parse(JSON.stringify(template.nodeJson));
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

// Single source of truth for the runtime scene JSON, shared by editor play mode and publishing.
// Produces the exact object shape Scene.parse consumes: { scene, textures?, ui }.
export async function buildGameData(sources: GameDataSources): Promise<any> {
  // Resolve every node's __scriptId link to its shared asset: cache the source into `scripts` (so
  // injectScripts emits node.script as before) and gather native field values for injectScriptVars. Reads
  // the LIVE nodes (native fields aren't captured by serialize), so it runs against sources.scene.
  const anyScene = sources.scene as any;
  const scriptVars = sources.scriptAssets
    ? fanOutScripts([anyScene.root, ...(anyScene.nodes ?? [])], sources.scriptAssets, sources.scripts)
    : new Map<string, Record<string, any>>();

  const json = await sources.scene.serialize(sources.useCache ?? false);
  clearDebuggingNodes(json.scene);
  injectScripts(json.scene, sources.scripts);
  injectScriptVars(json.scene, scriptVars);
  injectBodies(json.scene, sources.bodies, sources.triggers);
  // Every template in the library is baked in, not just the ones some node already places: a script may
  // instantiate any of them by name, and there is no way to know which statically. Their geometry is
  // interned against the scene's in packGameBin, so identical meshes cost nothing extra.
  if (sources.templates?.length)
    json.templates = bakeTemplates(sources.templates, sources.materials, sources.scriptAssets);
  // Persist the renderer look. `graphics` seeds the engine constructor (clear color from frame one);
  // `render` is the full snapshot the player re-applies to its renderer after boot. Scene.parse ignores
  // `config`, so it's inert for in-editor play (which reuses the live renderer anyway).
  if (sources.settings) {
    json.config = {
      graphics: { clearColor: sources.settings.clearColor },
      render: sources.settings,
    };
  }
  return json;
}
