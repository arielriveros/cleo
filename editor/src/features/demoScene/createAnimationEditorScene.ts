import { Scene, Camera, CameraNode, LightNode, DirectionalLight, ModelNode, Model, Geometry, Material } from 'cleo';

// Dedicated scene for the Animation Editor tab: an editor camera auto-framed to the skinned model
// (which the caller has already added), a shadow-casting key light + fill, and a ground plane so the
// ANIMATED-pose shadow is visible while previewing. Mirrors createMeshPreviewScene's framing but keeps
// shadows on. The '__editor__' names keep these helpers out of selection/serialization (the scene is
// throwaway anyway). Free-fly navigation is wired by the CHANGE_DIMENSION '3D' handler onto the camera.

const DIAG = 1 / Math.sqrt(3); // camera forward for rotation [30,-135,0] is -normalize([1,1,1])
const FOV = 55;

export function createAnimationEditorScene(scene: Scene, center: [number, number, number], radius: number): void {
  const r = Math.max(radius, 0.001);
  const dist = (r / Math.sin((FOV / 2) * Math.PI / 180)) * 1.6;

  const cam = new CameraNode('__editor__Camera', new Camera({ fov: FOV, far: 100000 }));
  cam.active = true;
  cam.setPosition([center[0] + DIAG * dist, center[1] + DIAG * dist, center[2] + DIAG * dist]);
  cam.setRotation([30, -135, 0]);
  scene.addNode(cam);

  // Key light casts shadows so the animated pose's shadow shows on the ground.
  const key = new LightNode('key', new DirectionalLight({ ambient: [0.20, 0.20, 0.22] }));
  key.setPosition([0, 1, 0]).setRotation([115, -30, 0]);
  key.castShadows = true;
  scene.addNode(key);

  // Dim fill from the opposite side to reveal form (no shadow).
  const fill = new LightNode('fill', new DirectionalLight({ diffuse: [0.25, 0.27, 0.32], ambient: [0, 0, 0] }));
  fill.setPosition([0, 1, 0]).setRotation([55, 150, 0]);
  fill.castShadows = false;
  scene.addNode(fill);

  // Ground plane at the model's feet to catch the shadow.
  const size = Math.max(r * 20, 4);
  const ground = new ModelNode('__editor__ground',
    new Model(Geometry.Cube(size, Math.max(r * 0.02, 0.01), size),
      Material.Default({ diffuse: [0.32, 0.33, 0.38] }, { castShadow: false })));
  ground.setPosition([center[0], center[1] - r, center[2]]);
  scene.addNode(ground);
}
