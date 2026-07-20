import {
  Scene,
  Node,
  Model,
  ModelNode,
  AnimatedModel,
  Geometry,
  Material,
  Sprite,
  SpriteNode,
  LightNode,
  CameraNode,
  LightProbeNode,
  Vec,
  hullFromPositions,
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
 * Every mesh vertex of `root` *and its descendants*, expressed in root-local space — the space
 * collider shapes are authored in. A prop imported as several child meshes must contribute all of
 * them, or the hull only wraps the parent's own geometry and visibly cuts through the rest.
 * Editor helpers and gizmos are always skipped.
 *
 * `includeSkinned` is the only thing that varies between callers: a hull must exclude skinned meshes
 * (their bind pose doesn't follow the animation, so the hull would be wrong the moment the character
 * moves), while fitting a primitive's starting size to the bind pose is perfectly reasonable.
 */
function collectMeshPositions(root: Node, includeSkinned: boolean): number[][] {
  const out: number[][] = [];
  const rootInv = Vec.mat4.invert(Vec.mat4.create(), root.worldTransform);
  if (!rootInv) return out;

  const visit = (node: Node) => {
    if (isHelperName(node.name) || (node as any).isGizmo) return;
    if (node instanceof ModelNode) {
      const model = node.model;
      const skinned = model instanceof AnimatedModel && model.hasSkin;
      const positions = skinned && !includeSkinned ? null : model.geometry?.positions;
      if (positions && positions.length) {
        // Geometry stores positions flat: component c of vertex i is positions[i * 3 + c].
        if (node === root) {
          for (let i = 0; i < positions.length; i += 3)
            out.push([positions[i], positions[i + 1], positions[i + 2]]);
        } else {
          const rel = Vec.mat4.multiply(Vec.mat4.create(), rootInv, node.worldTransform);
          const v = Vec.vec3.create();
          for (let i = 0; i < positions.length; i += 3) {
            Vec.vec3.transformMat4(v, Vec.vec3.fromValues(positions[i], positions[i + 1], positions[i + 2]), rel);
            out.push([v[0], v[1], v[2]]);
          }
        }
      }
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return out;
}

/** Vertices to hull, or null when there is nothing usable. Skinned meshes are excluded — see above. */
export function collectHullPositions(root: Node): number[][] | null {
  const out = collectMeshPositions(root, false);
  return out.length >= 4 ? out : null;
}

/**
 * Fraction of vertices a fitted capsule's radius must cover. See `boundsFromPoints`.
 */
const RADIUS_PERCENTILE = 0.8;

/**
 * AABB of a point cloud, plus the radius a capsule around its Y axis should use.
 *
 * `radius` is deliberately NOT `max(halfX, halfZ)`. Characters are authored in a T- or A-pose, so the
 * X extent is the ARM SPAN (~0.9) rather than the torso (~0.2); a capsule fitted that way would have
 * `height <= 2 * radius` and collapse into a sphere — exactly the case this is meant to serve. So it
 * is the RADIUS_PERCENTILEth percentile of each vertex's distance from the vertical axis, which the
 * torso dominates and outstretched limbs cannot inflate.
 *
 * Split out from `meshBounds` so it can be exercised without a GL context (Model allocates buffers on
 * construction, so a real ModelNode can't be built headless).
 */
export function boundsFromPoints(points: number[][]): { center: Vec.vec3; half: Vec.vec3; radius: number } | null {
  if (!points.length) return null;

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of points)
    for (let i = 0; i < 3; i++) { min[i] = Math.min(min[i], p[i]); max[i] = Math.max(max[i], p[i]); }

  const center = Vec.vec3.fromValues((min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
  const half = Vec.vec3.fromValues((max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2);

  const radial = points.map(p => Math.hypot(p[0] - center[0], p[2] - center[2])).sort((a, b) => a - b);
  const radius = radial[Math.min(radial.length - 1, Math.floor(radial.length * RADIUS_PERCENTILE))];

  return { center, half, radius };
}

/**
 * The size a new collider should start at, fitted to `root` and its descendants. All values are in
 * root-local (pre-scale) units, which is what shape descriptors are authored in — `setShapes` applies
 * the owner's world scale on top. Null when the subtree has no mesh, so the caller keeps its default.
 */
export function meshBounds(root: Node): { center: Vec.vec3; half: Vec.vec3; radius: number } | null {
  return boundsFromPoints(collectMeshPositions(root, true));
}

/**
 * Build a single wireframe mesh visualizing one physics shape, at unit size (planes get no
 * wireframe). `color` is red for bodies, green for triggers. The transform is applied separately by
 * `applyShapeTransform`, which has to run every frame to track the owner's scale.
 *
 * A capsule is the exception and is baked at FINAL size from `scale`: its caps stay spherical under a
 * non-uniform owner scale while only the straight section stretches, which a scaled unit mesh cannot
 * express — it would shear the caps into ellipsoids. `shapesSignature` therefore folds the owner's
 * scale into a capsule's entry, so the mesh is rebuilt whenever that scale changes.
 */
export function buildShapeDebugMesh(shape: ShapeDescription, color: [number, number, number], scale: Vec.vec3): ModelNode | null {
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
    case 'capsule': {
      const { radius, cylinder } = capsuleDims(shape, scale);
      model = new Model(Geometry.Capsule(shape.numSegments, radius, cylinder), Material.Basic({ color }, { wireframe: true }));
      break;
    }
    case 'convex':
      // Geometry.ConvexHull emits each hull edge once as a gl.LINES pair AND fills normals/uvs —
      // both are required: wireframe materials consume the index buffer as line pairs, and the VAO
      // is strided by the shader's attribute list, so a positions-only geometry scrambles.
      model = new Model(
        Geometry.ConvexHull(shape.vertices, shape.faces),
        Material.Basic({ color }, { wireframe: true })
      );
      break;
    case 'plane':
    default:
      model = null;
  }
  return model ? new ModelNode(SHAPE_PREFIX, model) : null;
}

/**
 * A capsule's final scaled dimensions, mirroring `Shape.Capsule` exactly: the radius grows radially
 * by max(X, Z) while the total height follows Y, and the straight section is whatever is left over
 * once the two caps are accounted for — which a lopsided scale can drive to zero, leaving a sphere.
 */
function capsuleDims(shape: { radius: number, height: number }, scale: Vec.vec3): { radius: number, cylinder: number } {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);
  const radius = shape.radius * Math.max(sx, sz);
  return { radius, cylinder: Math.max(0, shape.height * sy - 2 * radius) };
}

/**
 * Place one wireframe exactly where the physics engine puts the collider it stands for. A node's TRS
 * applies scale before rotation, which is the same order `setShapes` (node.ts) and cannon use: the
 * shape's dimensions and offset are scaled by the owner's world scale, then rotated. Getting this
 * wrong is invisible on an unrotated, unscaled node and badly wrong on any other.
 *
 * Scale is resolved per shape type to mirror `Shape.*` in the engine — a sphere has no ellipsoid
 * form in cannon, so it takes the dominant axis, and a cylinder takes max(X, Z) radially.
 */
function applyShapeTransform(node: ModelNode, shape: ShapeDescription, scale: Vec.vec3) {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);

  node.setPosition(Vec.vec3.fromValues(shape.offset[0] * sx, shape.offset[1] * sy, shape.offset[2] * sz))
      .setRotation(Vec.vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]));

  switch (shape.type) {
    case 'box':
      node.setScale(Vec.vec3.fromValues(shape.width * sx, shape.height * sy, shape.depth * sz));
      break;
    case 'sphere':
      node.setUniformScale(shape.radius * Math.max(sx, sy, sz));
      break;
    case 'cylinder': {
      const radial = Math.max(sx, sz);
      node.setScale(Vec.vec3.fromValues(shape.radius * radial, shape.height * sy, shape.radius * radial));
      break;
    }
    case 'capsule':
      // Already baked at final size by buildShapeDebugMesh — scaling it again would double-apply.
      node.setUniformScale(1);
      break;
    case 'convex':
      node.setScale(Vec.vec3.fromValues(sx, sy, sz));
      break;
  }
}

/**
 * Cheap identity of a shape list. A baked convex hull carries hundreds of numbers, so hashing the
 * whole descriptor on every scene change would be wasteful — its vertex count and transform are
 * enough to notice a regenerate.
 *
 * Only a capsule folds in the owner's `scale`, because it is the only mesh baked at final size; every
 * other type is a unit mesh that `applyShapeTransform` rescales per frame, and including scale for
 * those would rebuild their geometry on every drag of the scale gizmo for no gain.
 */
function shapesSignature(shapes: ShapeDescription[], scale: Vec.vec3): string {
  return shapes.map((s) => {
    const common = `${s.type}|${s.offset.join(',')}|${s.rotation.join(',')}`;
    switch (s.type) {
      case 'box': return `${common}|${s.width},${s.height},${s.depth}`;
      case 'sphere': return `${common}|${s.radius}`;
      case 'cylinder': return `${common}|${s.radius},${s.height},${s.numSegments}`;
      case 'capsule': {
        const { radius, cylinder } = capsuleDims(s, scale);
        return `${common}|${s.numSegments}|${radius},${cylinder}`;
      }
      case 'convex': return `${common}|${s.quality},${s.vertices.length},${s.faces.length},v${s.v ?? 1}`;
      default: return common;
    }
  }).join(';');
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
  gizmo.onUpdate = () => {
    if (!gizmo.parent) return;
    const scale = Vec.mat4.getScaling(Vec.vec3.create(), gizmo.parent.worldTransform);
    Vec.vec3.inverse(scale, scale);
    gizmo.setScale(scale);
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

/**
 * Ensure a top-level debug node that follows `target` and carries one wireframe per shape. The
 * meshes are rebuilt only when the shapes signature changes, but the per-frame `onUpdate` is
 * re-bound on every reconcile so it closes over the *current* shape list — the group outlives any
 * given edit, and a stale closure would keep drawing the previous offsets.
 */
function ensureShapeGroup(
  scene: Scene,
  target: Node,
  debugName: string,
  shapes: ShapeDescription[],
  color: [number, number, number],
  follow: (debug: Node) => void,
) {
  const sig = shapesSignature(shapes, target.worldScale);
  const cache = sigMapFor(scene);

  let group = scene.getNodesByName(debugName)[0];
  const isNew = !group;
  if (!group) {
    group = new Node(debugName);
    scene.addNode(group);
  }

  // Track the owner's transform, and place each wireframe exactly where its collider will be. Both
  // have to run every frame: dragging the transform gizmo changes neither the shapes nor their
  // signature, but it does move and rescale every collider.
  const debug = group;
  debug.onUpdate = () => {
    follow(debug);
    for (const child of debug.children) {
      if (!(child instanceof ModelNode) || !child.name.startsWith(SHAPE_PREFIX)) continue;
      const shape = shapes[Number(child.name.slice(SHAPE_PREFIX.length))];
      if (shape) applyShapeTransform(child, shape, target.worldScale);
    }
  };

  if (!isNew && cache.get(debugName) === sig) return; // shapes unchanged — keep existing children

  // (Re)build shape children from scratch so type/size/count changes and shrinks are all handled.
  for (const child of Array.from(debug.children)) debug.removeChild(child);
  shapes.forEach((shape, i) => {
    const mesh = buildShapeDebugMesh(shape, color, target.worldScale);
    if (mesh) { mesh.name = `${SHAPE_PREFIX}${i}`; debug.addChild(mesh); }
  });
  cache.set(debugName, sig);
}

/**
 * Reconcile all editor helper nodes on `scene` against its current contents and the physics
 * `bodies`/`triggers` maps. Adds missing helpers, rebuilds changed physics wireframes, and removes
 * stale ones. Idempotent — safe to call on every scene/physics change (in edit mode only).
 */
/**
 * Upgrade legacy convex hulls in place. v1 hulled a sampled vertex subset (can cut inside the
 * mesh); v2's half-space clipper had numerical failures on vertices lying exactly on a cutting
 * plane. v3 is the AABB-anchored carve with an absolute containment audit. Rebuild any convex
 * shape without the v3 marker from the node's current geometry; if the geometry is gone, just
 * stamp it so the rebuild isn't retried every reconcile.
 */
const HULL_VERSION = 5; // 5 = greedy deepest-cut plane selection (angular FPS could fill the budget with box-parallel planes)
function migrateConvexShapes(scene: Scene, shapeLists: Map<string, { shapes: ShapeDescription[] }>) {
  for (const [id, entry] of shapeLists) {
    if (!entry.shapes.some((s) => s.type === 'convex' && s.v !== HULL_VERSION)) continue;
    const target = scene.getNodeById(id);
    if (!target) continue;

    const positions = collectHullPositions(target);
    entry.shapes = entry.shapes.map((s) => {
      if (s.type !== 'convex' || s.v === HULL_VERSION) return s;
      const hull = positions ? hullFromPositions(positions, s.quality) : null;
      console.log(`[hull] migrate v${s.v ?? 1}->v${HULL_VERSION} node='${target.name}' quality=${s.quality} -> ${hull ? `${hull.vertices.length} vertices, ${hull.faces.length} faces` : 'kept as-is (no geometry)'}`);
      return hull
        ? { ...s, vertices: hull.vertices, faces: hull.faces, offset: hull.center, v: HULL_VERSION }
        : { ...s, v: HULL_VERSION };
    });
    shapeLists.set(id, entry);
  }
}

export function reconcileEditorHelpers(
  scene: Scene,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
) {
  migrateConvexShapes(scene, bodies);
  migrateConvexShapes(scene, triggers);

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
    // The group carries only the body's transform; the owner's scale is folded into each shape by
    // `applyShapeTransform`, exactly as `setShapes` folds it into the collider.
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
