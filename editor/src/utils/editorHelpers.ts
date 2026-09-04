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
  SoundNode,
  Vec,
  hullFromPositions,
  markEditorOnly,
} from 'cleo';
import { CameraGeometry } from './EditorModels';
import type { BodyDescription, ShapeDescription } from '../features/EngineContext';
import type { DebugVisibility, DebugChannel, DebugCategory } from '../features/DebugVisibilityContext';

/**
 * Editor-only visual helpers (light/probe icons, camera frustum gizmos, physics debug wireframes),
 * derived from the objects themselves. Every helper node's name must carry the `__editor__`/`__debug__`
 * prefix — that is what excludes it from selection, serialization, play and published builds.
 *
 * Every node built here is also marked `editorOnly` through {@link chrome}. That flag, not the name,
 * is what routes it into the renderer's overlay layer — composited AFTER the post chain, so a light
 * icon cannot throw a lens-flare ghost and a collider wireframe cannot bloom. The prefix would be the
 * obvious test and is the wrong one: `__editor__` also marks real content, such as the animation
 * editor's lit ground plane, which must stay in the scene the post chain sees.
 */

/** Mark a helper (and anything already under it) as renderer chrome. Returns it, so it can wrap a `new`. */
const chrome = <T extends Node>(node: T): T => { markEditorOnly(node); return node; };

const LIGHT_ICON = '__editor__LightSprite';
const CAMERA_GIZMO = '__debug__CameraModel';
const PROBE_HELPER = '__editor__ProbeHelper';
const SOUND_ICON = '__editor__SoundSprite';
const SOUND_RADIUS = '__debug__SoundRadius';
const BODY_PREFIX = '__debug__body_';
const TRIGGER_PREFIX = '__debug__trigger_';
const SHAPE_PREFIX = '__debug__shape_';
const AABB_PREFIX = '__debug__aabb_';
const TERRAIN_PREFIX = '__debug__terrain_';
const NAVMESH_PREFIX = '__debug__navmesh_';

// Per-scene cache of the last-built shapes signature for each body/trigger id.
const shapeSignatures = new WeakMap<Scene, Map<string, string>>();
const sigMapFor = (scene: Scene): Map<string, string> => {
  let m = shapeSignatures.get(scene);
  if (!m) { m = new Map(); shapeSignatures.set(scene, m); }
  return m;
};

const isHelperName = (name: string) => name.startsWith('__editor__') || name.startsWith('__debug__');

/**
 * Every mesh vertex of `root` *and its descendants*, in root-local space — the space collider shapes
 * are authored in. Editor helpers and gizmos are skipped.
 * `includeSkinned` must be false for a hull: a skinned bind pose does not follow the animation.
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

/** Fraction of vertices a fitted capsule's radius must cover. See `boundsFromPoints`. */
const RADIUS_PERCENTILE = 0.8;

/**
 * AABB of a point cloud, plus the radius a capsule around its Y axis should use.
 * `radius` must NOT be `max(halfX, halfZ)`: a T-posed character's X extent is the arm span, which would
 * collapse the capsule into a sphere. It is the RADIUS_PERCENTILEth percentile of the distance from the
 * vertical axis. GL-free so it can be exercised headless.
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
 * The size a new collider should start at, fitted to `root` and its descendants. Values are in
 * root-local (pre-scale) units; `setShapes` applies the owner's world scale on top.
 * Null when the subtree has no mesh, so the caller keeps its default.
 */
export function meshBounds(root: Node): { center: Vec.vec3; half: Vec.vec3; radius: number } | null {
  return boundsFromPoints(collectMeshPositions(root, true));
}

/**
 * Build a single wireframe mesh visualizing one physics shape, at unit size (planes get no wireframe).
 * `color` is red for bodies, green for triggers; `applyShapeTransform` supplies the transform per frame.
 * A capsule is the exception, baked at FINAL size from `scale` — its caps must stay spherical under a
 * non-uniform scale, so `shapesSignature` folds that scale into its entry.
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
      // Geometry.ConvexHull must fill normals/uvs as well as the gl.LINES index pairs: the VAO is
      // strided by the shader's attribute list, so a positions-only geometry scrambles.
      model = new Model(
        Geometry.ConvexHull(shape.vertices, shape.faces),
        Material.Basic({ color }, { wireframe: true })
      );
      break;
    case 'plane':
    default:
      model = null;
  }
  return model ? chrome(new ModelNode(SHAPE_PREFIX, model)) : null;
}

/**
 * A capsule's final scaled dimensions, mirroring `Shape.Capsule`: the radius grows by max(X, Z), the
 * total height follows Y, and the straight section is the remainder — possibly zero, leaving a sphere.
 */
function capsuleDims(shape: { radius: number, height: number }, scale: Vec.vec3): { radius: number, cylinder: number } {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);
  const radius = shape.radius * Math.max(sx, sz);
  return { radius, cylinder: Math.max(0, shape.height * sy - 2 * radius) };
}

/**
 * Place one wireframe exactly where the physics engine puts the collider it stands for. Dimensions and
 * offset are scaled by the owner's world scale and THEN rotated — the order `setShapes` and cannon use.
 * Scale resolves per shape type: a sphere takes the dominant axis, a cylinder max(X, Z) radially.
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
      // Already baked at final size by buildShapeDebugMesh; scaling again would double-apply.
      node.setUniformScale(1);
      break;
    case 'convex':
      node.setScale(Vec.vec3.fromValues(sx, sy, sz));
      break;
  }
}

/**
 * Cheap identity of a shape list. A convex hull contributes only its vertex count and transform.
 * Only a capsule folds in the owner's `scale` — it is the one mesh baked at final size; folding scale
 * into the others would rebuild their geometry on every drag of the scale gizmo.
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

// Attach a billboard light icon under a light, tinted to its current diffuse color.
function ensureLightIcon(light: LightNode) {
  if (light.getChildByName(LIGHT_ICON).length) return;
  const d = light.light.diffuse;
  // Icons use the synthetic 1x1 tileset, never the tileset library — no asset may appear in the explorer.
  const icon = chrome(new SpriteNode(LIGHT_ICON, Sprite.fromTexture('__editor__light_icon', {
    tint: [d[0], d[1], d[2]],
  })));
  icon.setUniformScale(0.5);
  light.addChild(icon);
}

/**
 * Billboard + falloff sphere under a Sound node.
 *
 * The sphere is drawn at `maxDistance`, which is where a `linear` emitter goes silent and where the other
 * two models are clamped — so it answers the one question a placed emitter raises that its numbers do
 * not: how far does this actually carry, relative to the level around it. Ambient emitters get only the
 * icon: their world position means nothing, so a radius drawn around it would be a lie.
 *
 * The sphere is rebuilt when the radius changes, because the geometry is a unit sphere scaled to it.
 */
function ensureSoundHelpers(node: SoundNode) {
  if (!node.getChildByName(SOUND_ICON).length) {
    // Tinted to match the sample slot's accent, and distinct from a light's warm icon.
    const icon = chrome(new SpriteNode(SOUND_ICON, Sprite.fromTexture('__editor__sound_icon', {
      tint: [0.5, 0.7, 0.85],
    })));
    icon.setUniformScale(0.5);
    node.addChild(icon);
  }

  const existing = node.getChildByName(SOUND_RADIUS)[0];
  if (node.mode !== 'spatial') {
    if (existing) node.removeChild(existing);
    return;
  }

  const radius = node.maxDistance;
  // Rebuilt rather than rescaled: the node's own scale would also drive the icon, and reusing the mesh
  // across radii is what left a stale sphere behind when maxDistance was dragged.
  if (existing) {
    if (Math.abs((existing as any).__soundRadius - radius) < 1e-4) return;
    node.removeChild(existing);
  }

  const model = new Model(Geometry.Sphere(10, 1), Material.Basic({ color: [0.35, 0.65, 0.9] }, { wireframe: true, castShadow: false }));
  const sphere = chrome(new ModelNode(SOUND_RADIUS, model));
  sphere.setUniformScale(radius);
  ;(sphere as any).__soundRadius = radius;
  node.addChild(sphere);
}

// Attach a camera frustum wireframe under a camera; the onUpdate cancels the parent's scale so the
// gizmo keeps a constant size.
function ensureCameraGizmo(camera: CameraNode) {
  if (camera.getChildByName(CAMERA_GIZMO).length) return;
  const model = new Model(
    new Geometry(CameraGeometry.positions, undefined, CameraGeometry.texCoords, undefined, undefined, CameraGeometry.indices, false),
    Material.Basic({ color: [0.2, 0.2, 0.75] }, { castShadow: false })
  );
  const gizmo = chrome(new ModelNode(CAMERA_GIZMO, model));
  gizmo.onUpdate = () => {
    if (!gizmo.parent) return;
    const scale = Vec.mat4.getScaling(Vec.vec3.create(), gizmo.parent.worldTransform);
    Vec.vec3.inverse(scale, scale);
    gizmo.setScale(scale);
  };
  camera.addChild(gizmo);
}

// Attach a billboard icon under a light probe so it is visible in the viewport (tinted cyan).
function ensureProbeHelper(probe: LightProbeNode) {
  if (probe.getChildByName(PROBE_HELPER).length) return;
  const icon = chrome(new SpriteNode(PROBE_HELPER, Sprite.fromTexture('__editor__probe_icon', {
    tint: [0.4, 0.8, 1],
  })));
  icon.setUniformScale(0.5);
  probe.addChild(icon);
}

/**
 * Ensure a top-level debug node that follows `target` and carries one wireframe per shape. The meshes
 * rebuild only when the shapes signature changes, but the per-frame `onUpdate` must be re-bound on every
 * reconcile: the group outlives an edit and a stale closure keeps drawing the previous offsets.
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
    group = chrome(new Node(debugName));
    scene.addNode(group);
  }

  // Both must run every frame: dragging the transform gizmo changes neither the shapes nor their
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

  // Rebuild from scratch so type/size/count changes and shrinks are all handled.
  for (const child of Array.from(debug.children)) debug.removeChild(child);
  shapes.forEach((shape, i) => {
    const mesh = buildShapeDebugMesh(shape, color, target.worldScale);
    if (mesh) { mesh.name = `${SHAPE_PREFIX}${i}`; debug.addChild(mesh); }
  });
  cache.set(debugName, sig);
}

const HULL_VERSION = 5;
/**
 * Rebuild any convex shape not stamped with HULL_VERSION from its node's current geometry. When the
 * geometry is gone the shape is still stamped, so the rebuild is not retried on every reconcile.
 */
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

// A per-node world-AABB wireframe (a unit cube stretched to the node's bounds each frame). Top-level so
// it inherits no transform: `getBoundingBox()` is already world-space. An empty geometry's zero extent
// is clamped so the cube stays a thin sliver rather than a degenerate scale.
function ensureAabbBox(scene: Scene, target: Node) {
  const name = `${AABB_PREFIX}${target.id}`;
  let group = scene.getNodesByName(name)[0] as ModelNode | undefined;
  if (!group) {
    const model = new Model(Geometry.Cube(1, 1, 1, true), Material.Basic({ color: [0.3, 0.9, 0.9] }, { wireframe: true, castShadow: false }));
    group = chrome(new ModelNode(name, model));
    scene.addNode(group);
  }
  const box = group;
  box.onUpdate = () => {
    const bb = target.getBoundingBox();
    const cx = (bb.min[0] + bb.max[0]) / 2, cy = (bb.min[1] + bb.max[1]) / 2, cz = (bb.min[2] + bb.max[2]) / 2;
    const sx = Math.max(bb.max[0] - bb.min[0], 1e-3), sy = Math.max(bb.max[1] - bb.min[1], 1e-3), sz = Math.max(bb.max[2] - bb.min[2], 1e-3);
    box.setPosition(Vec.vec3.fromValues(cx, cy, cz))
       .setRotation(Vec.vec3.fromValues(0, 0, 0))
       .setScale(Vec.vec3.fromValues(sx, sy, sz));
  };
}

/**
 * Wireframe of a terrain's collision heightfield, in terrain-local space (the debug group sits at the
 * landscape's world origin, where `Terrain.setOrigin` puts the physics body). Vertices must use
 * `Terrain._buildChunkGeometry`'s mapping: x = -half + c*e, z = -half + r*e, y = height.
 * Downsampled to ~64 quads per side.
 */
function buildTerrainDebugMesh(terrain: any): ModelNode | null {
  const R: number = terrain.resolution, size: number = terrain.size, e: number = terrain.elementSize;
  const H: Float32Array = terrain.heights;
  if (!R || !H || H.length < R * R) return null;
  const half = size / 2;
  const step = Math.max(1, Math.floor((R - 1) / 64));

  const idx: number[] = [];
  for (let c = 0; c < R; c += step) idx.push(c);
  if (idx[idx.length - 1] !== R - 1) idx.push(R - 1);

  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  for (const r of idx)
    for (const c of idx) {
      positions.push([-half + c * e, H[r * R + c], -half + r * e]);
      normals.push([0, 1, 0]);
      uvs.push([0, 0]);
    }

  const stride = idx.length;
  const indices: number[] = [];
  for (let i = 0; i < idx.length - 1; i++)
    for (let j = 0; j < idx.length - 1; j++) {
      const tl = i * stride + j, tr = tl + 1, bl = (i + 1) * stride + j, br = bl + 1;
      indices.push(tl, bl, tr, tr, bl, br);
    }

  const geometry = new Geometry(positions, normals, uvs, undefined, undefined, indices);
  return chrome(new ModelNode(TERRAIN_PREFIX, new Model(geometry, Material.Basic({ color: [1, 0, 0] }, { wireframe: true, castShadow: false }))));
}

// Cheap identity of a terrain's heights, so the wireframe rebuilds only when the surface is sculpted.
function terrainSignature(terrain: any): string {
  const R: number = terrain.resolution, H: Float32Array = terrain.heights;
  let sum = 0;
  const stepN = Math.max(1, Math.floor((H?.length ?? 1) / 512));
  for (let i = 0; i < (H?.length ?? 0); i += stepN) sum += H[i] * (i + 1);
  return `${R}|${terrain.size}|${terrain.elementSize}|${H?.length ?? 0}|${sum.toFixed(3)}`;
}

// Ensure a terrain heightfield wireframe following the landscape's world origin.
// `landscape` is a LandscapeNode, accessed structurally to avoid a hard type import.
function ensureTerrainDebug(scene: Scene, landscape: any) {
  const name = `${TERRAIN_PREFIX}${landscape.id}`;
  const sig = terrainSignature(landscape.terrain);
  const cache = sigMapFor(scene);

  let group = scene.getNodesByName(name)[0];
  const stale = !group || cache.get(name) !== sig;
  if (stale) {
    if (group) scene.removeNode(group);
    const mesh = buildTerrainDebugMesh(landscape.terrain);
    if (!mesh) return;
    mesh.name = name;
    scene.addNode(mesh);
    group = mesh;
    cache.set(name, sig);
  }
  const g = group;
  g.onUpdate = () => {
    g.setPosition(landscape.worldPosition).setRotation(Vec.vec3.fromValues(0, 0, 0));
  };
}

/**
 * Wireframe of a baked navigation mesh.
 *
 * Drawn at the WORLD ORIGIN with an identity transform, unlike the terrain wireframe which follows its
 * landscape: navmesh data is baked in world space precisely so that moving the node cannot invalidate
 * a path, and following the node here would smear the overlay away from the surface it describes.
 *
 * Each stored region is a convex contour, so a fan from its first vertex is a valid triangulation --
 * the same property that lets the funnel cross one in a straight line.
 */
function buildNavMeshDebugMesh(navMesh: any): ModelNode | null {
  const data = navMesh.data;
  const counts: Uint32Array = data.counts;
  const verts: Float32Array = data.vertices;
  if (!counts || counts.length === 0) return null;

  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  const indices: number[] = [];

  let read = 0;
  for (let r = 0; r < counts.length; r++) {
    const count = counts[r];
    if (count < 3 || (read + count) * 3 > verts.length) break;
    const base = positions.length;
    for (let i = 0; i < count; i++) {
      const b = (read + i) * 3;
      positions.push([verts[b], verts[b + 1], verts[b + 2]]);
      normals.push([0, 1, 0]);
      uvs.push([0, 0]);
    }
    for (let i = 1; i + 1 < count; i++) indices.push(base, base + i, base + i + 1);
    read += count;
  }
  if (indices.length === 0) return null;

  const geometry = new Geometry(positions, normals, uvs, undefined, undefined, indices);
  // Lifted a little so it does not z-fight the floor it was baked from -- the surface and the mesh are
  // the same plane by construction, so without this the overlay stipples.
  const node = chrome(new ModelNode(NAVMESH_PREFIX, new Model(
    geometry, Material.Basic({ color: [0.1, 0.85, 0.75] }, { wireframe: true, castShadow: false }))));
  node.setPosition(Vec.vec3.fromValues(0, 0.02, 0));
  return node;
}

/** Cheap identity of a bake, so the wireframe is rebuilt only when the mesh actually changes. */
function navMeshSignature(navMesh: any): string {
  const data = navMesh.data;
  const counts: Uint32Array = data.counts;
  const verts: Float32Array = data.vertices;
  if (!counts || counts.length === 0) return 'empty';
  // Length plus a few sampled coordinates: a re-bake that produced identical geometry should not
  // churn the mesh, and one that moved a region will differ in at least one of these.
  let hash = 0;
  for (let i = 0; i < verts.length; i += Math.max(3, Math.floor(verts.length / 96)) ) hash += verts[i] * (i + 1);
  return counts.length + '|' + verts.length + '|' + hash.toFixed(3);
}

function ensureNavMeshDebug(scene: Scene, navMesh: any) {
  const name = NAVMESH_PREFIX + navMesh.id;
  const sig = navMeshSignature(navMesh);
  const cache = sigMapFor(scene);

  const existing = scene.getNodesByName(name)[0];
  if (existing && cache.get(name) === sig) return;
  if (existing) scene.removeNode(existing);

  const mesh = buildNavMeshDebugMesh(navMesh);
  if (!mesh) { cache.delete(name); return; }
  mesh.name = name;
  scene.addNode(mesh);
  cache.set(name, sig);
}

export function reconcileEditorHelpers(
  scene: Scene,
  bodies: Map<string, BodyDescription>,
  triggers: Map<string, { shapes: ShapeDescription[] }>,
  visibility?: DebugVisibility,
  channel: DebugChannel = 'editor',
) {
  // With no settings supplied (or a category missing): everything on in the editor, off at runtime.
  const show = (cat: DebugCategory): boolean =>
    visibility ? visibility[cat][channel] : channel === 'editor';

  migrateConvexShapes(scene, bodies);
  migrateConvexShapes(scene, triggers);

  const nodes = Array.from(scene.nodes);
  // The camera the editor views through must not draw its own frustum; it would stick to the viewport.
  const viewCamera = scene.activeCamera;

  // 1-3 + spawn markers. Type-driven child icons/gizmos, added or removed to match the toggle.
  for (const node of nodes) {
    if (isHelperName(node.name)) continue;

    if (node instanceof LightNode) {
      const existing = node.getChildByName(LIGHT_ICON)[0];
      if (show('lights') && !existing) ensureLightIcon(node);
      else if (!show('lights') && existing) node.removeChild(existing);
    } else if (node instanceof LightProbeNode) {
      const existing = node.getChildByName(PROBE_HELPER)[0];
      if (show('probes') && !existing) ensureProbeHelper(node);
      else if (!show('probes') && existing) node.removeChild(existing);
    } else if (node instanceof SoundNode) {
      // Reconciled every pass rather than only on absence: the falloff sphere follows `maxDistance`,
      // which the inspector changes while the helper already exists.
      if (show('sounds')) ensureSoundHelpers(node);
      else for (const name of [SOUND_ICON, SOUND_RADIUS]) {
        const child = node.getChildByName(name)[0];
        if (child) node.removeChild(child);
      }
    } else if (node instanceof CameraNode) {
      // Reconcile both ways so a hijacked/active camera's stale gizmo is cleaned up too.
      const existing = node.getChildByName(CAMERA_GIZMO)[0];
      const shouldHave = show('cameras') && node !== viewCamera;
      if (shouldHave && !existing) ensureCameraGizmo(node);
      else if (!shouldHave && existing) node.removeChild(existing);
    }
  }

  // 4. Rigid-body wireframes (red), following the target's local transform.
  if (show('colliders')) {
    for (const [id, body] of bodies) {
      const target = scene.getNodeById(id);
      if (!target) continue;
      // The group carries only the body's transform; `applyShapeTransform` folds the owner's scale in.
      ensureShapeGroup(scene, target, `${BODY_PREFIX}${id}`, body.shapes, [1, 0, 0], (debug) => {
        debug.setPosition(target.position);
        debug.setRotation(target.rotation);
      });
    }
    // Terrain heightfield collision shapes (also red) live in scene.landscapes, not the bodies map.
    for (const landscape of scene.landscapes) {
      if ((landscape as any).markForRemoval) continue;
      ensureTerrainDebug(scene, landscape);
    }
  }

  // 4b. Navigation meshes. Independently toggled from colliders: a navmesh is DERIVED from them, and
  // the interesting question is usually where the two disagree.
  if (show('navMesh')) {
    for (const navMesh of scene.navMeshes) ensureNavMeshDebug(scene, navMesh);
  }

  // 5. Trigger wireframes (green), following the target's world transform.
  if (show('triggers')) {
    for (const [id, trigger] of triggers) {
      const target = scene.getNodeById(id);
      if (!target) continue;
      ensureShapeGroup(scene, target, `${TRIGGER_PREFIX}${id}`, trigger.shapes, [0, 1, 0], (debug) => {
        debug.setPosition(target.worldPosition);
        debug.setQuaternion(target.worldQuaternion);
      });
    }
  }

  // 6. Per-node world AABB boxes.
  if (show('boundingBoxes')) {
    for (const node of nodes) {
      if (node instanceof ModelNode && !isHelperName(node.name) && !(node as any).isGizmo)
        ensureAabbBox(scene, node);
    }
  }

  // 7. Remove stale or now-hidden top-level debug groups.
  const cache = sigMapFor(scene);
  const landscapeIds = new Set<string>();
  for (const landscape of scene.landscapes) landscapeIds.add((landscape as any).id);

  for (const node of nodes) {
    const drop = () => { scene.removeNode(node); cache.delete(node.name); };
    if (node.name.startsWith(BODY_PREFIX)) {
      const id = node.name.slice(BODY_PREFIX.length);
      if (!show('colliders') || !bodies.has(id) || !scene.getNodeById(id)) drop();
    } else if (node.name.startsWith(TRIGGER_PREFIX)) {
      const id = node.name.slice(TRIGGER_PREFIX.length);
      if (!show('triggers') || !triggers.has(id) || !scene.getNodeById(id)) drop();
    } else if (node.name.startsWith(TERRAIN_PREFIX)) {
      const id = node.name.slice(TERRAIN_PREFIX.length);
      if (!show('colliders') || !landscapeIds.has(id)) drop();
    } else if (node.name.startsWith(NAVMESH_PREFIX)) {
      const id = node.name.slice(NAVMESH_PREFIX.length);
      const owner = scene.getNodeById(id);
      // Dropped when hidden, when its node is gone, or when the bake was cleared -- otherwise a
      // stale wireframe outlives the mesh it described and reads as a navmesh that still works.
      if (!show('navMesh') || !owner || !(owner as any).isBaked) drop();
    } else if (node.name.startsWith(AABB_PREFIX)) {
      const id = node.name.slice(AABB_PREFIX.length);
      const owner = scene.getNodeById(id);
      if (!show('boundingBoxes') || !(owner instanceof ModelNode) || isHelperName(owner.name)) drop();
    }
  }
}
