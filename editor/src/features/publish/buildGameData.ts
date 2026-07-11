import type { Scene, RenderSettings } from 'cleo';
import { Logger } from 'cleo';
import type { BodyDescription, ShapeDescription } from '../EngineContext';

// Sources needed to assemble a complete, self-contained game JSON.
export interface GameDataSources {
  scene: Scene;
  scripts: Map<string, string>;
  bodies: Map<string, BodyDescription>;
  triggers: Map<string, { shapes: ShapeDescription[] }>;
  ui: { version: number; elements: any[] };
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

// Re-attach physics bodies and triggers (editor-side maps keyed by node id) onto the serialized tree.
export function injectBodies(
  scene: any,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
): void {
  const iterate = (children: any[]) => (children ?? []).forEach((child: any) => {
    const b = bodies.get(child.id);
    if (b) child.body = b;
    const t = triggers.get(child.id);
    if (t) child.trigger = t;
    iterate(child.children ?? []);
  });
  iterate(scene.children ?? []);
}

// Single source of truth for the runtime scene JSON, shared by editor play mode and publishing.
// Produces the exact object shape Scene.parse consumes: { scene, textures?, ui }.
export async function buildGameData(sources: GameDataSources): Promise<any> {
  const json = await sources.scene.serialize(sources.useCache ?? false);
  clearDebuggingNodes(json.scene);
  injectScripts(json.scene, sources.scripts);
  injectBodies(json.scene, sources.bodies, sources.triggers);
  json.ui = { version: sources.ui.version, elements: sources.ui.elements };
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
