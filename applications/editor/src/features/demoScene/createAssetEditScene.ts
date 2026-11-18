import { Scene, LightNode, DirectionalLight } from 'cleo';
import type { Node } from 'cleo';
import { ensureEditorCamera } from './createEmptyScene';
import { applyPreviewEnvironment } from './previewEnvironment';

/**
 * The viewing light for an asset-edit tab. The `__editor__` prefix keeps it out of the scene tree,
 * the helper reconciler, selection, and published builds.
 */
export const PREVIEW_LIGHT_NAME = '__editor__previewLight';

/**
 * Build the common environment for an asset-edit tab (mesh, template): editor camera, chrome light and
 * preview cubemap. The light must stay a scene-root sibling of the edited subtree, never a child of it,
 * or asset saves will serialize it.
 *
 * @param silently EngineContext's `withoutDirty`; suppresses the `SCENE_CHANGED` the async cubemap
 *   attach would otherwise emit, which marks an untouched tab unsaved.
 * @returns A promise resolving once the cubemap has attached.
 */
export function createAssetEditScene(scene: Scene, silently?: <T>(fn: () => T) => T): Promise<void> {
  ensureEditorCamera(scene);

  const light = new LightNode(PREVIEW_LIGHT_NAME, new DirectionalLight({}));
  light.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  light.castShadows = true;
  scene.addNode(light);

  return applyPreviewEnvironment(scene, { silently });
}

/**
 * Take the viewing light out of an asset-edit scene whose content has a sun of its own (an Environment template):
 * the first directional light is the one the sky and the shadows use, and the viewing light was added first.
 */
export function yieldPreviewLight(scene: Scene, content: Node | null | undefined): void {
  if (!content) return;
  const stack: Node[] = [content];
  let sun = false;
  while (stack.length && !sun) {
    const n = stack.pop()!;
    if (n instanceof LightNode && n.light instanceof DirectionalLight) sun = true;
    stack.push(...(n.children as Node[]));
  }
  if (!sun) return;
  const light = scene.root.children.find(n => n.name === PREVIEW_LIGHT_NAME);
  if (light) scene.removeNode(light);
}
