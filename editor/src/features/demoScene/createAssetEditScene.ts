import { Scene, LightNode, DirectionalLight } from 'cleo';
import { makeEditorCamera } from './createEmptyScene';
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
  scene.addNode(makeEditorCamera());

  const light = new LightNode(PREVIEW_LIGHT_NAME, new DirectionalLight({}));
  light.setPosition([0, 1, 0]).setRotation([100, 25, 0]);
  light.castShadows = true;
  scene.addNode(light);

  return applyPreviewEnvironment(scene, { silently });
}
