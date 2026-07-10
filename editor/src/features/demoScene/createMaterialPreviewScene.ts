import { Scene, LightNode, DirectionalLight } from 'cleo';
import { makeEditorCamera } from './createEmptyScene';

/**
 * Dedicated preview scene for the Material editor: a navigable editor camera framed on the origin plus
 * key + fill directional lights so Basic / Blinn-Phong / PBR materials all read well on the preview
 * sphere. The caller adds the sphere (a ModelNode) as the editable root. No light icons are created —
 * the editor-helper reconciler is skipped in material mode (see EngineContext), keeping the frame clean.
 */
export function createMaterialPreviewScene(scene: Scene): void {
  const cam = makeEditorCamera();
  cam.setPosition([2.4, 2.4, 2.4]); // closer than the default editor camera; same look-at-origin orientation
  scene.addNode(cam);

  // Key light. A touch of ambient keeps metallic PBR from going pitch-black without an environment map.
  const key = new LightNode('key', new DirectionalLight({ ambient: [0.18, 0.18, 0.20] }));
  key.setPosition([0, 5, 0]).setRotation([120, -35, 0]);
  key.castShadows = false;
  scene.addNode(key);

  // Dim fill from the opposite side to reveal the sphere's form.
  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.30, 0.32, 0.38], ambient: [0, 0, 0] }));
  fill.setPosition([0, 5, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);
}
