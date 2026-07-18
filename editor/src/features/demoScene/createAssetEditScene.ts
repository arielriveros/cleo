import { Scene, LightNode, DirectionalLight } from 'cleo';
import { makeEditorCamera } from './createEmptyScene';
import { applyPreviewEnvironment } from './previewEnvironment';

/**
 * The viewing light for an asset-edit tab. `__editor__` prefixed, which is what makes it invisible
 * everywhere it should be: the scene tree filters the prefix, the editor-helper reconciler skips it (so it
 * gets no light icon), selection ignores it, and `buildGameData` strips it from published builds.
 */
export const PREVIEW_LIGHT_NAME = '__editor__previewLight';

/**
 * Build the common environment for an asset-edit tab (mesh, template) — the scene the user edits an asset
 * *in*, as opposed to a scene they author.
 *
 * Mesh and template tabs previously assembled this by hand from `createEmptyScene` + a separate
 * `applyPreviewEnvironment` call, which left them sharing everything except the one thing that mattered:
 * `createEmptyScene`'s light is a plain `LightNode` named `light`, i.e. **authored content**. In an
 * asset-edit tab that is wrong — it showed up in the scene tree as if it belonged to the mesh, collected
 * an editor light icon, and was one more thing the user could select and delete out of a scene they never
 * asked for. It exists only so the asset is visible, so it is editor chrome and named accordingly.
 *
 * The light is a scene-root sibling of the edited subtree, never a child of it, so no save path can pick
 * it up: mesh saves serialize from the session's level roots and template saves from the template root.
 *
 * @param silently EngineContext's `withoutDirty`. The environment attaches asynchronously and its
 *   `SkyboxNode` insert emits `SCENE_CHANGED` when it lands — well after the opening settle window has
 *   re-armed dirty-tracking — so without this a freshly-opened tab marks itself unsaved on its own.
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
