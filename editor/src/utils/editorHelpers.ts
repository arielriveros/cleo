import {
  Scene,
  Node,
  Model,
  ModelNode,
  Geometry,
  Material,
  Sprite,
  SpriteNode,
  LightNode,
  CameraNode,
  LightProbeNode,
  Vec,
} from 'cleo';
import { CameraGeometry } from './EditorModels';
import type { BodyDescription, ShapeDescription } from '../features/EngineContext';

/**
 * Editor-only visual helpers (light/probe icons, camera frustum gizmos, physics debug wireframes)
 * are derived from the objects themselves rather than authored by hand. `reconcileEditorHelpers`
 * is idempotent: it adds any missing helper and removes any stale one, so it can be run on every
 * scene/physics change. All helper nodes are named with an `__editor__`/`__debug__` prefix, so they
 * are already excluded from selection, serialization, play and published builds.
 */

const LIGHT_ICON = '__editor__LightSprite';
const CAMERA_GIZMO = '__debug__CameraModel';
const PROBE_HELPER = '__editor__ProbeHelper';
const BODY_PREFIX = '__debug__body_';
const TRIGGER_PREFIX = '__debug__trigger_';
const SHAPE_PREFIX = '__debug__shape_';

// Per-scene cache of the last-built shapes signature for each body/trigger id, so unchanged debug
// subtrees aren't torn down and rebuilt on every SCENE_CHANGED.
const shapeSignatures = new WeakMap<Scene, Map<string, string>>();
const sigMapFor = (scene: Scene): Map<string, string> => {
  let m = shapeSignatures.get(scene);
  if (!m) { m = new Map(); shapeSignatures.set(scene, m); }
  return m;
};

const isHelperName = (name: string) => name.startsWith('__editor__') || name.startsWith('__debug__');

/**
 * Build a single wireframe mesh visualizing one physics shape, positioned at its local
 * offset/rotation. Geometry is built at unit size and scaled by the shape dimensions (planes get no
 * wireframe). `color` is red for bodies, green for triggers.
 */
export function buildShapeDebugMesh(shape: ShapeDescription, color: [number, number, number]): ModelNode | null {
  let model: Model | null;
  switch (shape.type) {
    case 'box':
      model = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({ color }, { wireframe: true }));
      break;
    case 'sphere':
      model = new Model(Geometry.Sphere(8, 1), Material.Basic({ color }, { wireframe: true }));
      break;
    case 'cylinder':
      model = new Model(Geometry.Cylinder(12, 1, 1), Material.Basic({ color }, { wireframe: true }));
      break;
    case 'plane':
    default:
      model = null;
  }
  if (!model) return null;

  const node = new ModelNode(SHAPE_PREFIX, model);
  node.setPosition(Vec.vec3.fromValues(shape.offset[0], shape.offset[1], shape.offset[2]))
      .setRotation(Vec.vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]));
  if (shape.type === 'box') node.setScale(Vec.vec3.fromValues(shape.width, shape.height, shape.depth));
  else if (shape.type === 'sphere') node.setUniformScale(shape.radius);
  else if (shape.type === 'cylinder') node.setScale(Vec.vec3.fromValues(shape.radius, shape.height, shape.radius));
  return node;
}

// Attach a billboard light icon under a light, tinted to the light's current diffuse color.
function ensureLightIcon(light: LightNode) {
  if (light.getChildByName(LIGHT_ICON).length) return;
  const d = light.light.diffuse;
  const icon = new SpriteNode(LIGHT_ICON, new Sprite(Material.Basic({
    color: [d[0], d[1], d[2]],
    texture: '__editor__light_icon',
  })));
  icon.setUniformScale(0.5);
  light.addChild(icon);
}

// Attach a camera frustum wireframe under a camera. The onUpdate cancels the parent's scale so the
// gizmo keeps a constant size regardless of the camera node's scale.
function ensureCameraGizmo(camera: CameraNode) {
  if (camera.getChildByName(CAMERA_GIZMO).length) return;
  const model = new Model(
    new Geometry(CameraGeometry.positions, undefined, CameraGeometry.texCoords, undefined, undefined, CameraGeometry.indices, false),
    Material.Basic({ color: [0.2, 0.2, 0.75] }, { castShadow: false })
  );
  const gizmo = new ModelNode(CAMERA_GIZMO, model);
  gizmo.onUpdate = (node) => {
    if (!node.parent) return;
    const scale = Vec.mat4.getScaling(Vec.vec3.create(), node.parent.worldTransform);
    Vec.vec3.inverse(scale, scale);
    node.setScale(scale);
  };
  camera.addChild(gizmo);
}

// Attach a wireframe sphere under a light probe so it is visible/selectable in the viewport.
function ensureProbeHelper(probe: LightProbeNode) {
  if (probe.getChildByName(PROBE_HELPER).length) return;
  const model = new Model(Geometry.Sphere(16), Material.Basic({ color: [0.4, 0.8, 1] }, { wireframe: true, castShadow: false }));
  const helper = new ModelNode(PROBE_HELPER, model);
  helper.setUniformScale(0.3);
  probe.addChild(helper);
}

// Ensure a top-level debug node that follows `target` and carries one wireframe per shape. Rebuilds
// its shape children only when the shapes signature changed (tracked per-scene).
function ensureShapeGroup(
  scene: Scene,
  target: Node,
  debugName: string,
  shapes: ShapeDescription[],
  color: [number, number, number],
  follow: (debug: Node) => void,
) {
  const sig = JSON.stringify(shapes);
  const cache = sigMapFor(scene);

  let group = scene.getNodesByName(debugName)[0];
  if (!group) {
    group = new Node(debugName);
    group.onUpdate = () => follow(group!);
    scene.addNode(group);
  } else if (cache.get(debugName) === sig) {
    return; // unchanged — keep existing children
  }

  // (Re)build shape children from scratch so type/size/count changes and shrinks are all handled.
  for (const child of Array.from(group.children)) group.removeChild(child);
  shapes.forEach((shape, i) => {
    const mesh = buildShapeDebugMesh(shape, color);
    if (mesh) { mesh.name = `${SHAPE_PREFIX}${i}`; group!.addChild(mesh); }
  });
  cache.set(debugName, sig);
}

/**
 * Reconcile all editor helper nodes on `scene` against its current contents and the physics
 * `bodies`/`triggers` maps. Adds missing helpers, rebuilds changed physics wireframes, and removes
 * stale ones. Idempotent — safe to call on every scene/physics change (in edit mode only).
 */
export function reconcileEditorHelpers(
  scene: Scene,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
) {
  const nodes = Array.from(scene.nodes);
  // The camera the editor views through (its own __editor__Camera, or whatever is active) must not
  // draw its own frustum model — it would appear stuck to the viewport.
  const viewCamera = scene.activeCamera;

  // 1-3. Type-driven icons/gizmos (skip editor/debug helper nodes themselves).
  for (const node of nodes) {
    if (node instanceof LightNode) {
      if (!isHelperName(node.name)) ensureLightIcon(node);
    } else if (node instanceof LightProbeNode) {
      if (!isHelperName(node.name)) ensureProbeHelper(node);
    } else if (node instanceof CameraNode) {
      // Every camera except the one being viewed through gets a frustum gizmo — reconcile both ways
      // so a hijacked/active camera's stale gizmo is also cleaned up.
      const existing = node.getChildByName(CAMERA_GIZMO)[0];
      const shouldHave = !isHelperName(node.name) && node !== viewCamera;
      if (shouldHave && !existing) ensureCameraGizmo(node);
      else if (!shouldHave && existing) node.removeChild(existing);
    }
  }

  // 4. Rigid-body wireframes (red), following the target's local transform.
  for (const [id, body] of bodies) {
    const target = scene.getNodeById(id);
    if (!target) continue;
    ensureShapeGroup(scene, target, `${BODY_PREFIX}${id}`, body.shapes, [1, 0, 0], (debug) => {
      debug.setPosition(target.position);
      debug.setRotation(target.rotation);
    });
  }

  // 5. Trigger wireframes (green), following the target's world transform.
  for (const [id, trigger] of triggers) {
    const target = scene.getNodeById(id);
    if (!target) continue;
    ensureShapeGroup(scene, target, `${TRIGGER_PREFIX}${id}`, trigger.shapes, [0, 1, 0], (debug) => {
      debug.setPosition(target.worldPosition);
      debug.setQuaternion(target.worldQuaternion);
    });
  }

  // 6. Remove stale debug groups whose body/trigger (or target node) no longer exists.
  const cache = sigMapFor(scene);
  for (const node of nodes) {
    let id: string | null = null;
    if (node.name.startsWith(BODY_PREFIX)) id = node.name.slice(BODY_PREFIX.length);
    else if (node.name.startsWith(TRIGGER_PREFIX)) id = node.name.slice(TRIGGER_PREFIX.length);
    if (id === null) continue;

    const map = node.name.startsWith(BODY_PREFIX) ? bodies : triggers;
    if (!map.has(id) || !scene.getNodeById(id)) {
      scene.removeNode(node);
      cache.delete(node.name);
    }
  }
}
