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
  ExposureVolumeNode,
  DecalNode,
  SoundNode,
  Vec,
  hullFromPositions,
  markEditorOnly,
  isEditorOwnedName,
  NavMeshNode,
  ParticleSystemNode,
  ForceFieldNode,
  WaterVolumeNode,
  OccluderNode,
  foliageColliderPose,
} from 'cleo';
import type { FoliageCollision } from 'cleo';
import type { NavObstacle, TriangleSoup } from 'cleo';
import { CameraGeometry } from './EditorModels';
import { gatherNavSoup } from './navBakeSources';
import { boundedBox, navPreviewSignature, planNavOverlays } from './navOverlayPlan';
import type { NavOverlayBox, NavOverlayPlan } from './navOverlayPlan';
import { decalBoxFrame, decalBoxLines, planDecalBox } from './decalOverlayPlan';
import type { DecalOverlayFrame } from './decalOverlayPlan';
import type { BodyDescription, ShapeDescription } from '../features/EngineContext';
import type { DebugVisibility, DebugChannel, DebugCategory } from '../features/DebugVisibilityContext';
import { shapeScaleFactors } from '../features/gizmo/collisionGizmoMath';
import { selectedCollisionShape, type CollisionChannel } from '../features/gizmo/collisionSelection';

/**
 * Editor-only visual helpers (light/probe icons, camera frustum gizmos, physics debug wireframes),
 * derived from the objects themselves. Every helper node's name must carry the `__editor__`/`__debug__`
 * marker ({@link isEditorOwnedName}) — that is what excludes it from selection, serialization, play and
 * published builds, and it makes the node `Node.isEditorOwned`, so its churn stays off the tab's dirty
 * flag and out of the undo history.
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
const EXPOSURE_HELPER = '__editor__ExposureVolumeHelper';
const SOUND_ICON = '__editor__SoundSprite';
const SOUND_RADIUS = '__debug__SoundRadius';
const BODY_PREFIX = '__debug__body_';
const TRIGGER_PREFIX = '__debug__trigger_';
const SHAPE_PREFIX = '__debug__shape_';
/** An owner's shapes merged into one wireframe (see buildMergedShapeWire). */
const MERGED_SHAPES = '__debug__shapes';
const AABB_PREFIX = '__debug__aabb_';
const TERRAIN_PREFIX = '__debug__terrain_';
const FOLIAGE_PREFIX = '__debug__foliage_';
/** Foliage colliders in orange, apart from node colliders (red) and triggers (green). */
export const FOLIAGE_COLLIDER_COLOR: [number, number, number] = [1, 0.55, 0.1];
/**
 * How far a coplanar overlay is pulled toward the camera, in NDC depth.
 *
 * Replaces the world-space lifts these used to carry. A fixed lift cannot work: depth resolution
 * falls off as z-squared, so 2 cm stopped separating anything past roughly 180 metres on a
 * `far: 10000` editor scene, and TAA jitter made the boundary shimmer well before that. This is
 * constant in NDC, so it holds at 5 metres and at 5 kilometres alike. See `MaterialConfig.depthNudge`.
 */
const COPLANAR_NUDGE = 1e-4;

const NAVMESH_PREFIX = '__debug__navmesh_';
const NAVVOLUME_PREFIX = '__debug__navvolume_';
const NAVPREVIEW_PREFIX = '__debug__navpreview_';

const DECAL_ICON = '__editor__DecalHelper';
const DECALBOX_PREFIX = '__debug__decalbox_';
const EFFECT_ICON = '__editor__EffectIcon';
const EFFECTSHAPE_PREFIX = '__debug__effectshape_';

// Per-scene cache of the last-built shapes signature for each body/trigger id.
const shapeSignatures = new WeakMap<Scene, Map<string, string>>();
const sigMapFor = (scene: Scene): Map<string, string> => {
  let m = shapeSignatures.get(scene);
  if (!m) { m = new Map(); shapeSignatures.set(scene, m); }
  return m;
};

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
    if (isEditorOwnedName(node.name) || (node as any).isGizmo) return;
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

/** Every mesh vertex under `root`, skinned meshes included, in root-local space: what a fitted primitive covers. */
export function meshPositions(root: Node): number[][] {
  return collectMeshPositions(root, true);
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
 * Build a single wireframe mesh visualizing one physics shape, at unit size. `color` is red for bodies,
 * green for triggers; `applyShapeTransform` supplies the transform per frame. A capsule is the exception,
 * baked at FINAL size from `scale` — its caps must stay spherical under a non-uniform scale, so
 * `shapesSignature` folds that scale into its entry. A plane is infinite, so it is drawn as a 4 m grid
 * square on its own XY (the side cannon's plane faces, +Z) with a stub along that normal.
 */
export function buildShapeDebugMesh(shape: ShapeDescription, color: [number, number, number], scale: Vec.vec3): ModelNode | null {
  if (shape.type === 'plane') return wireModel(SHAPE_PREFIX, planeLines(), color);
  const geometry = shapeDebugGeometry(shape, scale);
  return geometry ? chrome(new ModelNode(SHAPE_PREFIX, new Model(geometry, Material.Basic({ color }, { wireframe: true })))) : null;
}

/** The unit-size line geometry `buildShapeDebugMesh` draws for one shape (see there for the capsule). */
function shapeDebugGeometry(shape: ShapeDescription, scale: Vec.vec3): Geometry | null {
  switch (shape.type) {
    case 'box': return Geometry.Cube(1, 1, 1, true);
    case 'sphere': return Geometry.Sphere(8, 1);
    // The collider's own segment count: cannon's cylinder IS that prism, not a smooth one.
    case 'cylinder': return Geometry.Cylinder(Math.max(3, Math.round(shape.numSegments || 12)), 1, 1);
    case 'capsule': {
      const { radius, cylinder } = capsuleDims(shape, scale);
      return Geometry.Capsule(shape.numSegments, radius, cylinder);
    }
    // Geometry.ConvexHull must fill normals/uvs as well as the gl.LINES index pairs: the VAO is
    // strided by the shader's attribute list, so a positions-only geometry scrambles.
    case 'convex': return Geometry.ConvexHull(shape.vertices, shape.faces);
    case 'plane': return lineGeometry(planeLines());
    default: return null;
  }
}

/**
 * Every shape of one owner as ONE line mesh, each baked where `applyShapeTransform` puts its own mesh.
 * What an owner shows while none of its shapes is being edited: a generated level carries thousands of
 * colliders, and a mesh per shape (a draw, a material and a transform to update every frame) cost the
 * editor more than the level itself.
 */
function buildMergedShapeWire(shapes: ShapeDescription[], color: [number, number, number], scale: Vec.vec3): ModelNode | null {
  const positions: number[] = [];
  const indices: number[] = [];
  const place = new Node('__debug__place');
  const p = Vec.vec3.create();
  for (const shape of shapes) {
    const geometry = shapeDebugGeometry(shape, scale);
    if (!geometry) continue;
    applyShapeTransform(place, shape, scale);
    place.updateTransforms(null);
    const base = positions.length / 3;
    const src = geometry.positions;
    for (let i = 0; i < src.length; i += 3) {
      Vec.vec3.transformMat4(p, Vec.vec3.set(p, src[i], src[i + 1], src[i + 2]), place.localTransform);
      positions.push(p[0], p[1], p[2]);
    }
    for (const index of geometry.indices) indices.push(base + index);
  }
  if (!indices.length) return null;
  const count = positions.length / 3;
  const normals = new Float32Array(count * 3);
  for (let i = 1; i < normals.length; i += 3) normals[i] = 1;
  // Normals and uvs only to satisfy the VAO stride — see ensureDecalBox.
  const geometry = new Geometry(new Float32Array(positions), normals, new Float32Array(count * 2), undefined, undefined, indices, false);
  return chrome(new ModelNode(MERGED_SHAPES, new Model(geometry, Material.Basic({ color }, { wireframe: true }))));
}

/**
 * What the merged mesh depends on: every shape's type, size, offset and rotation, and the owner's scale.
 * Built when the helpers reconcile (an edit, a drag's end), never per frame.
 */
function bakedShapesSignature(shapes: ShapeDescription[], scale: Vec.vec3): string {
  return `${shapesSignature(shapes, scale)}#${scale[0]},${scale[1]},${scale[2]}#` + shapes.map((s) => {
    const sized = s as Partial<{ width: number, height: number, depth: number, radius: number }>;
    return `${s.offset.join(',')}|${s.rotation.join(',')}|${sized.width},${sized.height},${sized.depth},${sized.radius}`;
  }).join(';');
}

/** A 4 m square grid on the XY plane, 1 m cells, plus a 1 m stub along the +Z normal. */
function planeLines(): { positions: [number, number, number][]; indices: number[] } {
  const positions: [number, number, number][] = [];
  const indices: number[] = [];
  const line = (a: [number, number, number], b: [number, number, number]) => {
    indices.push(positions.length, positions.length + 1);
    positions.push(a, b);
  };
  for (let i = -2; i <= 2; i++) {
    line([i, -2, 0], [i, 2, 0]);
    line([-2, i, 0], [2, i, 0]);
  }
  line([0, 0, 0], [0, 0, 1]);
  return { positions, indices };
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
 * Scale resolves per shape type through `shapeScaleFactors`, which the viewport handles share, so the
 * two can never disagree: a sphere takes the dominant axis, a cylinder max(X, Z) radially.
 */
function applyShapeTransform(node: Node, shape: ShapeDescription, scale: Vec.vec3) {
  const sx = Math.abs(scale[0]), sy = Math.abs(scale[1]), sz = Math.abs(scale[2]);
  const f = shapeScaleFactors(shape, scale);

  node.setPosition(Vec.vec3.fromValues(shape.offset[0] * sx, shape.offset[1] * sy, shape.offset[2] * sz))
      .setRotation(Vec.vec3.fromValues(shape.rotation[0], shape.rotation[1], shape.rotation[2]));

  switch (shape.type) {
    case 'box':
      node.setScale(Vec.vec3.fromValues(shape.width * f[0], shape.height * f[1], shape.depth * f[2]));
      break;
    case 'sphere':
      node.setUniformScale(shape.radius * f[0]);
      break;
    case 'cylinder':
      node.setScale(Vec.vec3.fromValues(shape.radius * f[0], shape.height * f[1], shape.radius * f[2]));
      break;
    case 'capsule':
    case 'plane':
      // A capsule is already baked at final size by buildShapeDebugMesh; scaling again would double-apply.
      // A plane is infinite, and its grid is a fixed-size marker.
      node.setUniformScale(1);
      break;
    case 'convex':
      node.setScale(Vec.vec3.fromValues(f[0], f[1], f[2]));
      break;
  }
}

/**
 * Cheap identity of a shape list: what the MESHES depend on, not where they go. Offsets, rotations and
 * the size of a box, sphere or cylinder are applied per frame by `applyShapeTransform` onto a unit mesh,
 * so they stay out — with them in, a handle drag rebuilt every wireframe on every pointer move. A
 * cylinder's segment count and a convex hull's identity are geometry. Only a capsule folds in the owner's
 * `scale`, because it is the one mesh baked at final size.
 */
function shapesSignature(shapes: ShapeDescription[], scale: Vec.vec3): string {
  return shapes.map((s) => {
    switch (s.type) {
      case 'cylinder': return `cylinder|${s.numSegments}`;
      case 'capsule': {
        const { radius, cylinder } = capsuleDims(s, scale);
        return `capsule|${s.numSegments}|${radius},${cylinder}`;
      }
      case 'convex': return `convex|${s.quality},${s.vertices.length},${s.faces.length},v${s.v ?? 1}`;
      default: return s.type;
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
 * not: how far does this actually carry, relative to the level around it. Drawn only while the emitter is
 * SELECTED; the icon stays always. Ambient emitters get only the icon: their world position means
 * nothing, so a radius drawn around it would be a lie.
 *
 * The sphere is rebuilt when the radius changes, because the geometry is a unit sphere scaled to it.
 */
function ensureSoundHelpers(node: SoundNode, selected: boolean) {
  if (!node.getChildByName(SOUND_ICON).length) {
    // Tinted to match the sample slot's accent, and distinct from a light's warm icon.
    const icon = chrome(new SpriteNode(SOUND_ICON, Sprite.fromTexture('__editor__sound_icon', {
      tint: [0.5, 0.7, 0.85],
    })));
    icon.setUniformScale(0.5);
    node.addChild(icon);
  }

  const existing = node.getChildByName(SOUND_RADIUS)[0];
  // Only while this emitter is selected: a level full of carry spheres hides the level they describe.
  if (node.mode !== 'spatial' || !selected) {
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
  // Tangents are generated even though nothing here is normal-mapped: the lit program declares them, and
  // `getData` drops an absent attribute, so without them the buffer packs to 32 bytes while the WebGPU
  // pipeline reads it at the program's 56-byte stride, scattering the triangles.
  const geometry = new Geometry(CameraGeometry.positions, undefined, CameraGeometry.texCoords, undefined, undefined, CameraGeometry.indices);
  // Lit (Blinn-Phong), so the body reads as a solid camera rather than a flat silhouette. The source
  // mesh ships no normals; they are derived from its faces.
  geometry.computeNormals();
  const model = new Model(
    geometry,
    Material.Default({ diffuse: [0.2, 0.2, 0.75], specular: [0.35, 0.35, 0.4], shininess: 24 }, { castShadow: false })
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

// The same billboard under an exposure volume, tinted warm so it is not read as a probe.
function ensureExposureHelper(volume: ExposureVolumeNode) {
  if (volume.getChildByName(EXPOSURE_HELPER).length) return;
  const icon = chrome(new SpriteNode(EXPOSURE_HELPER, Sprite.fromTexture('__editor__probe_icon', {
    tint: [1, 0.8, 0.3],
  })));
  icon.setUniformScale(0.5);
  volume.addChild(icon);
}

/** A box volume whose extent the selection shows as an oriented wireframe: an exposure volume, a bounded probe. */
const isOrientedVolume = (node: unknown): node is ExposureVolumeNode | LightProbeNode =>
  node instanceof ExposureVolumeNode || (node instanceof LightProbeNode && node.bounded);

// Attach a billboard icon under a decal, so a decal that projects nothing visible yet (no material, or
// nothing inside its box) still shows where it is. Tinted amber, like its selection box. It is also what
// a click selects the decal BY: the raycaster skips `__editor__` children, and picks a decal through
// `DecalNode.pickBox` — a small box at exactly this spot — never through its volume, which encloses the
// ground and meshes the decal lands on and would swallow every click and drop aimed at them.
//
// It sits on the box's TOP face rather than at the node like a probe's: a decal's centre is normally ON
// the surface it projects onto, and helpers are depth-tested, so an icon there is half buried. Followed
// per frame because a Size edit in the inspector does not trigger a reconcile.
function ensureDecalIcon(decal: DecalNode) {
  if (decal.getChildByName(DECAL_ICON).length) return;
  const icon = chrome(new SpriteNode(DECAL_ICON, Sprite.fromTexture('__editor__decal_icon', {
    tint: [1, 0.68, 0.25],
  })));
  icon.setUniformScale(0.5);
  icon.onUpdate = () => {
    const top = decal.size[1] * 0.5;
    // A tolerance, not `!==`: the position is float32, so most heights never compare equal to the double.
    if (Math.abs(icon.position[1] - top) > 1e-5) icon.setPosition([0, top, 0]);
  };
  decal.addChild(icon);
}

// A billboard under a particle system or force field: neither draws anything of its own while idle (or
// ever, for a field), so this is how you see — and click — where one is. Picked through the node's
// `pickBox`, a small box at exactly this spot, never through its bounds.
function ensureEffectIcon(node: ParticleSystemNode | ForceFieldNode) {
  if (node.getChildByName(EFFECT_ICON).length) return;
  const particle = node instanceof ParticleSystemNode;
  const icon = chrome(new SpriteNode(EFFECT_ICON, Sprite.fromTexture(
    particle ? '__editor__particle_icon' : '__editor__forcefield_icon',
    { tint: particle ? [1, 0.55, 0.3] : [0.45, 0.85, 1] })));
  icon.setUniformScale(0.5);
  node.addChild(icon);
}

/** Line pairs for a unit box (half extent 0.5) and for three unit-radius great circles. */
function unitBoxLines(): { positions: [number, number, number][]; indices: number[] } {
  const positions: [number, number, number][] = [];
  for (let i = 0; i < 8; i++) positions.push([(i & 1) ? 0.5 : -0.5, (i & 2) ? 0.5 : -0.5, (i & 4) ? 0.5 : -0.5]);
  const indices: number[] = [];
  for (let i = 0; i < 8; i++) for (const bit of [1, 2, 4]) if (!(i & bit)) indices.push(i, i | bit);
  return { positions, indices };
}

function unitSphereLines(segments = 48): { positions: [number, number, number][]; indices: number[] } {
  const positions: [number, number, number][] = [];
  const indices: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const base = positions.length;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
      positions.push(axis === 0 ? [0, c, s] : axis === 1 ? [c, 0, s] : [c, s, 0]);
      indices.push(base + i, base + (i + 1) % segments);
    }
  }
  return { positions, indices };
}

/** A line-list wireframe node (editor-only overlay), from arbitrary line pairs. */
export function wireModel(name: string, lines: { positions: [number, number, number][]; indices: number[] },
                   color: [number, number, number]): ModelNode {
  return chrome(new ModelNode(name, new Model(lineGeometry(lines), Material.Basic({ color }, { wireframe: true, castShadow: false }))));
}

function lineGeometry(lines: { positions: [number, number, number][]; indices: number[] }): Geometry {
  // Normals and uvs only to satisfy the VAO stride — see ensureDecalBox.
  return new Geometry(lines.positions, lines.positions.map(() => [0, 1, 0] as [number, number, number]),
    lines.positions.map(() => [0, 0] as [number, number]), undefined, undefined, lines.indices, false);
}

/**
 * The SELECTED effect's extent: a particle system's fixed bounds (what culling and selection use — the
 * one thing an author must size by eye), or a force field's sphere or box. Top-level and re-placed every
 * frame, like the decal box, so the transform gizmo and inspector edits are followed.
 */
function ensureEffectShape(scene: Scene, node: ParticleSystemNode | ForceFieldNode | WaterVolumeNode | OccluderNode | ExposureVolumeNode | LightProbeNode) {
  const sphere = node instanceof ForceFieldNode && node.shape === 'sphere';
  const name = `${EFFECTSHAPE_PREFIX}${node.id}:${sphere ? 's' : 'b'}`;
  let existing = scene.getNodesByName(name)[0] as ModelNode | undefined;
  if (!existing) {
    existing = wireModel(name, sphere ? unitSphereLines() : unitBoxLines(),
      node instanceof ParticleSystemNode ? [1, 0.55, 0.3] : node instanceof WaterVolumeNode ? [0.3, 0.6, 1]
        : node instanceof OccluderNode ? [0.75, 0.45, 1] : node instanceof ExposureVolumeNode ? [1, 0.8, 0.3]
        : node instanceof LightProbeNode ? [0.4, 0.8, 1] : [0.45, 0.85, 1]);
    scene.addNode(existing);
  }
  const helper = existing;
  const place = () => {
    // A water volume's box is world-aligned whatever the node's rotation; its top face is the water.
    if (node instanceof ParticleSystemNode || node instanceof WaterVolumeNode) {
      const { min, max } = node.getBoundingBox();
      helper.setPosition([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2])
            .setScale([max[0] - min[0], max[1] - min[1], max[2] - min[2]]);
      return;
    }
    const m = node.worldTransform;
    // An occluder box follows the node's FULL transform, rotation included: it is what the culling uses.
    // So do the exposure volume and light probe boxes: both are oriented boxes under the node transform.
    if (node instanceof OccluderNode || node instanceof ExposureVolumeNode || node instanceof LightProbeNode) {
      helper.setPosition(node.worldPosition).setQuaternion(node.worldQuaternion)
            .setScale([node.size[0] * Math.hypot(m[0], m[1], m[2]), node.size[1] * Math.hypot(m[4], m[5], m[6]),
                       node.size[2] * Math.hypot(m[8], m[9], m[10])]);
      return;
    }
    const scale = Math.max(Math.hypot(m[0], m[1], m[2]), Math.hypot(m[4], m[5], m[6]), Math.hypot(m[8], m[9], m[10]));
    helper.setPosition(node.worldPosition);
    if (sphere) helper.setUniformScale(node.radius * scale);
    else helper.setScale([node.extents[0] * 2 * Math.hypot(m[0], m[1], m[2]),
                          node.extents[1] * 2 * Math.hypot(m[4], m[5], m[6]),
                          node.extents[2] * 2 * Math.hypot(m[8], m[9], m[10])]);
  };
  place();
  helper.onUpdate = place;
}

/** The shape being edited (the ragdoll editor's selection orange), and how far its siblings fade. */
const SELECTED_SHAPE_COLOR: [number, number, number] = [1, 0.6, 0.2];
const UNSELECTED_SHAPE_DIM = 0.35;

/** What an owner's debug group is drawing, and what each of its meshes was built from. */
interface ShapeGroupState {
  /** All the shapes in one mesh, and the list, scale and signature it baked. */
  merged: ModelNode | null;
  mergedFrom: ShapeDescription[] | null;
  mergedScale: string;
  mergedSig: string;
  /** One mesh per shape, while one of the owner's shapes is being edited; and their signature. */
  meshes: ModelNode[];
  meshesSig: string;
}
const shapeGroupStates = new WeakMap<Node, ShapeGroupState>();

/**
 * Ensure a top-level debug node that follows `target` and draws its shapes' wireframes. The per-frame
 * `onUpdate` must be re-bound on every reconcile: the group outlives an edit and a stale closure keeps
 * drawing the previous offsets.
 *
 * Two ways to draw them. Normally all of an owner's shapes are ONE merged mesh (see
 * `buildMergedShapeWire`), rebuilt when the list or the owner's scale changes. While one of its shapes is
 * being edited, the owner switches to a mesh per shape, built then: those are placed every frame from the
 * shapes read LIVE through `read` — the viewport handles rewrite them on every pointer move and only ask
 * for a reconcile when the drag ends — and they tint: the edited shape in {@link SELECTED_SHAPE_COLOR},
 * the rest faded to {@link UNSELECTED_SHAPE_DIM} of their channel colour. A shape whose type no longer
 * matches the mesh built for it (a convert or a removal in flight) keeps the reconciled one until the
 * next reconcile rebuilds.
 */
function ensureShapeGroup(
  scene: Scene,
  target: Node,
  debugName: string,
  channel: CollisionChannel,
  shapes: ShapeDescription[],
  read: () => ShapeDescription[] | undefined,
  color: [number, number, number],
  follow: (debug: Node) => void,
) {
  let group = scene.getNodesByName(debugName)[0];
  if (!group) {
    group = chrome(new Node(debugName));
    scene.addNode(group);
  }
  const debug = group;
  let state = shapeGroupStates.get(debug);
  if (!state) {
    state = { merged: null, mergedFrom: null, mergedScale: '', mergedSig: '', meshes: [], meshesSig: '' };
    shapeGroupStates.set(debug, state);
  }
  const st = state;

  const merge = (list: ShapeDescription[]) => {
    const scale = target.worldScale;
    const key = `${scale[0]},${scale[1]},${scale[2]}`;
    if (list === st.mergedFrom && key === st.mergedScale) return;
    st.mergedFrom = list;
    st.mergedScale = key;
    const sig = bakedShapesSignature(list, scale);
    if (st.merged && sig === st.mergedSig) return;
    // Owned outright (built here, never shared), so its buffers go with it: a scale drag rebuilds per frame.
    if (st.merged) { debug.removeChild(st.merged); st.merged.dispose(); }
    st.merged = buildMergedShapeWire(list, color, scale);
    st.mergedSig = sig;
    if (st.merged) debug.addChild(st.merged);
  };
  const dropMeshes = () => {
    for (const mesh of st.meshes) { debug.removeChild(mesh); mesh.dispose(); }
    st.meshes = [];
  };

  // The per-shape meshes no longer match the list: drop them, the next edit builds them afresh.
  const meshesSig = shapesSignature(shapes, target.worldScale);
  if (st.meshes.length && st.meshesSig !== meshesSig) dropMeshes();
  merge(shapes);

  const dimmed = color.map(c => c * UNSELECTED_SHAPE_DIM) as [number, number, number];
  // Every frame: dragging the transform gizmo changes neither the shapes nor their signature, but it
  // does move and rescale every collider.
  debug.onUpdate = () => {
    follow(debug);
    const live = read() ?? shapes;
    const selected = selectedCollisionShape();
    const editing = selected && selected.nodeId === target.id && selected.channel === channel ? selected.index : -1;
    if (editing < 0) {
      // Edits arrive as new lists (and a drag's end reconciles), so this rebuilds once per change.
      merge(live);
      if (st.merged) st.merged.visible = true;
      if (st.meshes.length) dropMeshes();
      return;
    }
    if (st.merged) st.merged.visible = false;
    if (!st.meshes.length) {
      shapes.forEach((shape, i) => {
        const mesh = buildShapeDebugMesh(shape, color, target.worldScale);
        if (mesh) { mesh.name = `${SHAPE_PREFIX}${i}`; debug.addChild(mesh); st.meshes.push(mesh); }
      });
      st.meshesSig = meshesSig;
    }
    for (const child of st.meshes) {
      const i = Number(child.name.slice(SHAPE_PREFIX.length));
      const shape = live[i]?.type === shapes[i]?.type ? live[i] : shapes[i];
      if (shape) applyShapeTransform(child, shape, target.worldScale);
      child.model.material.properties.set('color', i === editing ? SELECTED_SHAPE_COLOR : dimmed);
    }
  };
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
  // Coplanar with the heightfield it traces, so it needs the same nudge the navmesh overlays take.
  // This one never had any separation at all and stippled from the first frame.
  return chrome(new ModelNode(TERRAIN_PREFIX, new Model(geometry, Material.Basic({ color: [1, 0, 0] },
    { wireframe: true, castShadow: false, depthNudge: COPLANAR_NUDGE }))));
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
/** Line pairs for a unit cylinder (radius 0.5, height 1, centred): two rings and eight uprights. */
function unitCylinderLines(segments = 24): { positions: [number, number, number][]; indices: number[] } {
  const positions: [number, number, number][] = [];
  const indices: number[] = [];
  for (const y of [-0.5, 0.5]) {
    const base = positions.length;
    for (let i = 0; i < segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      positions.push([Math.cos(a) * 0.5, y, Math.sin(a) * 0.5]);
      indices.push(base + i, base + (i + 1) % segments);
    }
  }
  // Eight uprights, every `segments / 8` steps (segments is a multiple of 8, so the index is whole).
  for (let i = 0; i < segments; i += segments / 8) indices.push(i, i + segments);
  return { positions, indices };
}

/**
 * A wireframe of one foliage collider at UNIT size (full extent 1 on every axis), placed and sized with
 * {@link placeFoliageColliderWire}. Shared by the viewport overlay and the collider editor's preview.
 */
export function buildFoliageColliderWire(shape: FoliageCollision['shape'], color = FOLIAGE_COLLIDER_COLOR): ModelNode {
  const lines = shape === 'box' ? unitBoxLines()
    : shape === 'sphere' ? (() => { const l = unitSphereLines(); return { positions: l.positions.map(p => [p[0] * 0.5, p[1] * 0.5, p[2] * 0.5] as [number, number, number]), indices: l.indices }; })()
    : unitCylinderLines();
  return wireModel(`__debug__fcol_${shape}`, lines, color);
}

/**
 * Put a collider wireframe where the physics puts the body: the instance at (x, y, z) turned by `yaw`
 * (radians, as stored), lifted by the pose's centre height and sized to its full extents. `pose` is
 * `foliageColliderPose(collision, instanceScale)` — the very function the body is built from.
 */
export function placeFoliageColliderWire(node: Node, pose: ReturnType<typeof foliageColliderPose>,
                                         x: number, y: number, z: number, yaw: number): void {
  node.setPosition([x, y + pose.offsetY, z]);
  node.setRotation([0, yaw * 180 / Math.PI, 0]);
  node.setScale([pose.size[0], pose.size[1], pose.size[2]]);
}

/** The instances whose colliders the overlay draws: those of collidable layers within `radius`, nearest first, capped. */
export function nearestFoliageColliders(
  layers: readonly { collision: FoliageCollision | null; count: number;
                     forEachInstanceNear(x: number, z: number, r: number, cb: (i: number, x: number, y: number, z: number, yaw: number, scale: number) => void): void }[],
  camX: number, camZ: number, radius: number, cap: number,
): { collision: FoliageCollision; x: number; y: number; z: number; yaw: number; scale: number }[] {
  const out: { collision: FoliageCollision; x: number; y: number; z: number; yaw: number; scale: number; d2: number }[] = [];
  const r2 = radius * radius;
  for (const layer of layers) {
    const collision = layer.collision;
    if (!collision || layer.count === 0) continue;
    layer.forEachInstanceNear(camX, camZ, radius, (_i, x, y, z, yaw, scale) => {
      const d2 = (x - camX) * (x - camX) + (z - camZ) * (z - camZ);
      if (d2 <= r2) out.push({ collision, x, y, z, yaw, scale, d2 });
    });
  }
  out.sort((a, b) => a.d2 - b.d2);
  return out.slice(0, Math.max(0, cap));
}

/**
 * The foliage collider overlay of one landscape: a top-level group whose children are pooled wireframes,
 * re-placed from its own `onUpdate` — a scatter or erase stroke emits no structural event, so the
 * reconcile alone would never see the instances move. Rebuilt only when the camera has moved a couple
 * of metres or a layer's instances or collider changed.
 */
function ensureFoliageColliderOverlay(scene: Scene, landscape: any) {
  const name = `${FOLIAGE_PREFIX}${landscape.id}`;
  let group = scene.getNodesByName(name)[0];
  if (!group) { group = chrome(new Node(name)); scene.addNode(group); }
  const g = group;
  const state: { key: string; pool: Map<string, ModelNode[]> } =
    ((g as any).__foliageOverlay ??= { key: '', pool: new Map() });
  g.onUpdate = () => {
    const terrain = landscape.terrain;
    const cam = scene.activeCamera?.worldPosition;
    if (!terrain || !cam) return;
    const layers = (terrain.foliage as any[]).filter(l => l.collision && l.count > 0);
    const key = `${landscape.visible}|${Math.round(cam[0] / 2)},${Math.round(cam[2] / 2)}|` +
      layers.map(l => `${l.key}:${l.version}:${JSON.stringify(l.collision)}`).join(';');
    if (key === state.key) return;
    state.key = key;

    const settings = terrain.foliageColliders ?? { radius: 40, maxBodies: 256 };
    const wanted = landscape.visible ? nearestFoliageColliders(layers, cam[0], cam[2], settings.radius, settings.maxBodies) : [];
    const used = new Map<string, number>();
    for (const w of wanted) {
      const pose = foliageColliderPose(w.collision, w.scale);
      const pool = state.pool.get(pose.shape) ?? [];
      state.pool.set(pose.shape, pool);
      const k = used.get(pose.shape) ?? 0;
      used.set(pose.shape, k + 1);
      let wire = pool[k];
      if (!wire) { wire = buildFoliageColliderWire(pose.shape); pool.push(wire); g.addChild(wire); }
      wire.visible = true;
      placeFoliageColliderWire(wire, pose, w.x, w.y, w.z, w.yaw);
    }
    for (const [shape, pool] of state.pool)
      for (let k = used.get(shape) ?? 0; k < pool.length; k++) pool[k].visible = false;
    g.updateTransforms();
  };
}

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
  // `depthNudge` instead of a world-space lift: this mesh and the floor it was baked from are the same
  // plane by construction, and a fixed lift only separates them near the camera.
  return chrome(new ModelNode(NAVMESH_PREFIX, new Model(
    geometry, Material.Basic({ color: [0.1, 0.85, 0.75] },
      { wireframe: true, castShadow: false, depthNudge: COPLANAR_NUDGE }))));
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

/**
 * The navmesh bake VOLUME, and a live preview of what it currently captures.
 *
 * Two overlays for one node, because they answer two different questions. The wireframe box says
 * "here is what I am asking to be navigable"; the cyan surface says "here is what you would actually
 * get". An author moving the box needs both at once — the whole reason a bake volume is hard to place
 * blind is that a box is a claim about geometry you cannot see inside it.
 *
 * Both are drawn ONLY for the selected navmesh node. A level with a small-agent bake and an ogre bake
 * would otherwise paint two overlapping translucent sheets, and the sum of two 35%-opacity surfaces is
 * not a reading of either.
 */

/**
 * The level's collider + terrain soup, cached per scene.
 *
 * Gathering walks every body and triangulates every heightfield, which is far too much to redo while
 * someone drags a gizmo. The volume clip and the slope filter run against this on every reconcile;
 * only {@link invalidateNavSoup} forces the walk again.
 */
const navSoupCache = new WeakMap<Scene, { soup: TriangleSoup; obstacles: NavObstacle[] }>();

/**
 * Drop the cached soup, so the next preview re-walks the scene.
 *
 * Called for the three things that actually change the level's walkable geometry: a collider edit, a
 * structural scene change, and the end of a transform drag. Deliberately NOT called for a payload-less
 * `SCENE_CHANGED`, which is what an inspector slider emits — re-gathering the whole level on every
 * frame of a "max slope" drag would be a lot of work to produce the same soup.
 */
export function invalidateNavSoup(scene: Scene | null | undefined) {
  if (scene) navSoupCache.delete(scene);
}

/** What an unselected navmesh's plan is given: planNavOverlays returns before reading it. */
const EMPTY_SOUP = { positions: new Float32Array(0) } as unknown as TriangleSoup;
const EMPTY_GATHER = { soup: EMPTY_SOUP, obstacles: [] as NavObstacle[] };

function navSoupFor(scene: Scene, bodies: Map<string, BodyDescription>): { soup: TriangleSoup; obstacles: NavObstacle[] } {
  let gathered = navSoupCache.get(scene);
  if (!gathered) {
    const { soup, obstacles } = gatherNavSoup(scene.root, { bodies });
    gathered = { soup, obstacles };
    navSoupCache.set(scene, gathered);
  }
  return gathered;
}

/**
 * Wireframe of the bake box, following the plan's transform every frame.
 *
 * `onUpdate` rather than a one-shot placement is what makes the box track the transform gizmo with no
 * further wiring: the gizmo writes the node's position and never emits an event this reconciler
 * listens to, exactly as the collider wireframes at `ensureShapeGroup` already rely on. It re-reads
 * the PLAN each frame rather than closing over one, so a resize in the inspector lands immediately
 * and an unbounded box keeps tracking the level's extent.
 *
 * Top-level, so it inherits nothing and can carry a world transform directly.
 */
function ensureNavVolumeBox(scene: Scene, navMesh: NavMeshNode, box: NavOverlayBox) {
  const name = `${NAVVOLUME_PREFIX}${navMesh.id}`;
  let existing = scene.getNodesByName(name)[0] as ModelNode | undefined;
  if (!existing) {
    existing = chrome(new ModelNode(name, new Model(
      Geometry.Cube(1, 1, 1, true),
      Material.Basic({ color: [0, 0.9, 1] }, { wireframe: true, castShadow: false }))));
    scene.addNode(existing);
  }
  const node = existing;

  // Dimmed means "this box is the whole level, not a volume anyone authored" — see `unboundedBox`.
  // Set every pass rather than at creation: the same node survives its owner being given a size.
  node.model.material.properties.set('color', box.dimmed ? [0, 0.45, 0.55] : [0, 0.9, 1]);

  const place = (b: NavOverlayBox) => {
    node.setPosition(b.center)
        .setQuaternion(b.quaternion)
        .setScale(Vec.vec3.fromValues(b.half[0] * 2, b.half[1] * 2, b.half[2] * 2));
  };

  if (box.dimmed) {
    // An unbounded box is the level's axis-aligned extent, which does NOT follow the node — moving an
    // unbounded navmesh changes nothing about what it covers, and a box that tracked it would say
    // otherwise. So it is placed once per reconcile, and any stale `onUpdate` is cleared.
    node.onUpdate = () => {};
    place(box);
    return;
  }

  // Bounded: re-read the node every frame so the box tracks the transform gizmo, which writes the
  // transform directly and emits nothing this reconciler listens for. Recomputed from the node alone
  // rather than by re-running the plan — the plan walks the level's triangle soup, which is not
  // something to do once a frame.
  node.onUpdate = () => place(boundedBox(navMesh));
}

/**
 * The selected decal's volume as an amber wireframe box, with an arrow down its local -Y axis — the
 * direction it projects in. The shape is `decalBoxLines` (unit-box space), placed by `decalBoxFrame`.
 *
 * Top-level and re-placed from the decal every frame, for the reason `ensureNavVolumeBox` is: the
 * transform gizmo and the inspector's Size fields change the volume without emitting anything the
 * reconciler listens to. The closure is re-bound on every reconcile so it always reads the live node.
 */
function ensureDecalBox(scene: Scene, decal: DecalNode, frame: DecalOverlayFrame) {
  const name = `${DECALBOX_PREFIX}${decal.id}`;
  let existing = scene.getNodesByName(name)[0] as ModelNode | undefined;
  if (!existing) {
    const lines = decalBoxLines();
    // Every vertex needs a normal and a uv even though the basic program reads neither: the VAO is
    // strided by the program's attribute list, and `getData()` skips empty arrays.
    const geometry = new Geometry(lines.positions, lines.positions.map(() => [0, 1, 0] as [number, number, number]),
      lines.positions.map(() => [0, 0] as [number, number]), undefined, undefined, lines.indices, false);
    existing = chrome(new ModelNode(name, new Model(geometry,
      Material.Basic({ color: [1, 0.68, 0.25] }, { wireframe: true, castShadow: false }))));
    scene.addNode(existing);
  }
  const node = existing;
  const place = (f: DecalOverlayFrame) => { node.setPosition(f.center).setQuaternion(f.quaternion).setScale(f.scale); };
  place(frame);
  node.onUpdate = () => place(decalBoxFrame(decal.volumeMatrix));
}

/**
 * The cyan surface: every triangle the plan says is walkable inside the volume.
 *
 * The triangles come from `walkableSoup`, the SAME predicate `bakeNavMesh` filters with — that
 * sharing is the point of the whole overlay. A preview computed from its own copy of the slope
 * arithmetic could disagree with the bake, and the disagreement would only ever show up as an agent
 * refusing to walk somewhere painted walkable.
 *
 * Double-sided: a surface the author is looking at from below is still one they need to see.
 * `_cullFor` maps `side: 'double'` to `cullMode: 'none'` on the overlay pipeline, so this is honoured.
 */
function buildNavPreviewMesh(walkable: TriangleSoup): ModelNode | null {
  const count = walkable.positions.length / 3;
  if (count < 3) return null;

  const positions: [number, number, number][] = [];
  const normals: [number, number, number][] = [];
  const uvs: [number, number][] = [];
  const indices: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = i * 3;
    positions.push([walkable.positions[b], walkable.positions[b + 1], walkable.positions[b + 2]]);
    // Flat up, like the baked wireframe: this is an unlit overlay, so a real normal buys nothing and
    // computing one per triangle would only slow the rebuild down.
    normals.push([0, 1, 0]);
    uvs.push([0, 0]);
    indices.push(i);
  }

  // `calculateTangents: false` — the last argument, and not an oversight. It defaults to true, and
  // with every UV at [0,0] the tangent solve is both wasted work on every rebuild and a source of
  // NaNs. The basic program declares only position and texCoord, so it never reads them.
  const geometry = new Geometry(positions, normals, uvs, undefined, undefined, indices, false);

  const node = chrome(new ModelNode(NAVPREVIEW_PREFIX, new Model(
    geometry,
    // No `transparent: true`. The alpha comes from the OVERLAY PASS, which declares `OVERLAY_BLEND`
    // on every helper pipeline regardless; and an `editorOnly` node is diverted into `helperNodes`
    // before the renderer's transparent/opaque split ever runs, so the flag could not route it
    // anywhere different even if it wanted to. Setting it would only send the next reader looking
    // for a transparent queue this never enters.
    Material.Basic({ color: [0, 0.9, 1], opacity: 0.35 },
      { castShadow: false, side: 'double', depthNudge: COPLANAR_NUDGE }))));
  return node;
}

/**
 * Why the last plan declined to paint a preview, per navmesh id, or absent when it did paint one.
 *
 * Read by the Nav Mesh inspector so a level too big to fill says so. The reconciler already computes
 * the plan every pass, and this is a single number — cheaper and more honest than having the panel
 * re-walk the level to answer the same question, and far better than a cyan sheet that silently does
 * not appear on exactly the levels most likely to need it.
 */
const navPreviewSkipped = new Map<string, number>();

/** Triangles the preview refused to draw for this navmesh, or null when it drew (or drew nothing). */
export function navPreviewSkippedFor(id: string): number | null {
  return navPreviewSkipped.get(id) ?? null;
}

function ensureNavPreview(scene: Scene, navMesh: NavMeshNode, plan: NavOverlayPlan) {
  if (plan.previewSkipped) navPreviewSkipped.set(navMesh.id, plan.previewSkipped);
  else navPreviewSkipped.delete(navMesh.id);

  const name = `${NAVPREVIEW_PREFIX}${navMesh.id}`;
  const sig = navPreviewSignature(plan);
  const cache = sigMapFor(scene);

  const existing = scene.getNodesByName(name)[0];
  if (existing && cache.get(name) === sig) return;
  if (existing) scene.removeNode(existing);

  const mesh = plan.preview ? buildNavPreviewMesh(plan.preview) : null;
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
  /**
   * The selected node's id. Only the navmesh overlays, the decal box and a sound's falloff sphere read
   * it — a bake volume, its cyan preview, a decal's projection box and an emitter's reach are authoring
   * aids for the node you are placing, not permanent scene furniture.
   */
  selectedId: string | null = null,
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
    if (isEditorOwnedName(node.name)) continue;

    if (node instanceof LightNode) {
      const existing = node.getChildByName(LIGHT_ICON)[0];
      if (show('lights') && !existing) ensureLightIcon(node);
      else if (!show('lights') && existing) node.removeChild(existing);
    } else if (node instanceof LightProbeNode) {
      const existing = node.getChildByName(PROBE_HELPER)[0];
      if (show('probes') && !existing) ensureProbeHelper(node);
      else if (!show('probes') && existing) node.removeChild(existing);
    } else if (node instanceof ExposureVolumeNode) {
      const existing = node.getChildByName(EXPOSURE_HELPER)[0];
      if (show('exposureVolumes') && !existing) ensureExposureHelper(node);
      else if (!show('exposureVolumes') && existing) node.removeChild(existing);
    } else if (node instanceof DecalNode) {
      const existing = node.getChildByName(DECAL_ICON)[0];
      if (show('decals') && !existing) ensureDecalIcon(node);
      else if (!show('decals') && existing) node.removeChild(existing);
    } else if (node instanceof ParticleSystemNode || node instanceof ForceFieldNode) {
      const existing = node.getChildByName(EFFECT_ICON)[0];
      if (show('effects') && !existing) ensureEffectIcon(node);
      else if (!show('effects') && existing) node.removeChild(existing);
    } else if (node instanceof SoundNode) {
      // Reconciled every pass rather than only on absence: the falloff sphere follows `maxDistance`,
      // which the inspector changes while the helper already exists.
      if (show('sounds')) ensureSoundHelpers(node, node.id === selectedId);
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
      ensureShapeGroup(scene, target, `${BODY_PREFIX}${id}`, 'body', body.shapes, () => bodies.get(id)?.shapes, [1, 0, 0], (debug) => {
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
  // 4a. Foliage colliders (orange) on the scattered instances near the camera.
  if (show('foliageColliders')) {
    for (const landscape of scene.landscapes) {
      if ((landscape as any).markForRemoval) continue;
      ensureFoliageColliderOverlay(scene, landscape);
    }
  }

  // 4b. Navigation meshes. The BAKED wireframe is independently toggled from colliders: a navmesh is
  // DERIVED from them, and the interesting question is usually where the two disagree.
  if (show('navMesh')) {
    for (const navMesh of scene.navMeshes) ensureNavMeshDebug(scene, navMesh);
  }

  // 4c. The bake volume and its cyan preview, for the SELECTED navmesh only.
  //
  // Deliberately NOT behind `show('navMesh')`, unlike the wireframe above. These are authoring aids
  // for the node being placed — the same category as the selection outline and the transform gizmo,
  // neither of which is in the eye menu either. Selecting the node IS the request to see them, and
  // the first version of this shipped invisible precisely because it hid a feature's only feedback
  // behind a toggle that is off by default and that an author has to already know exists.
  for (const navMesh of scene.navMeshes) {
    // The soup only when the plan will use it: re-gathering the whole level's colliders for an UNSELECTED
    // navmesh — on every structural change, which in play mode is every spawned effect — was pure waste.
    const selected = navMesh.id === selectedId;
    const gathered = selected ? navSoupFor(scene, bodies) : EMPTY_GATHER;
    const plan = planNavOverlays(navMesh, gathered.soup, selected, gathered.obstacles);
    if (plan.box) ensureNavVolumeBox(scene, navMesh, plan.box);
    ensureNavPreview(scene, navMesh, plan);
  }

  // 4d. The SELECTED decal's volume and projection arrow. Selection-scoped and outside the eye menu for
  // the reason 4c is: the box is the only way to see what a decal covers, and selecting the node is the
  // request to see it. The menu's `decals` switch governs the icon billboards above.
  const selected = selectedId ? scene.getNodeById(selectedId) : null;
  const decalFrame = planDecalBox(selected);
  if (decalFrame) ensureDecalBox(scene, selected as DecalNode, decalFrame);

  // 4e. The SELECTED particle system's bounds, or force field's shape — selection-scoped like 4d. A
  // global field has no extent to draw.
  if (selected instanceof ParticleSystemNode || selected instanceof WaterVolumeNode || selected instanceof OccluderNode
      || isOrientedVolume(selected) || (selected instanceof ForceFieldNode && selected.shape !== 'global'))
    ensureEffectShape(scene, selected);

  // 5. Trigger wireframes (green), following the target's world transform.
  if (show('triggers')) {
    for (const [id, trigger] of triggers) {
      const target = scene.getNodeById(id);
      if (!target) continue;
      ensureShapeGroup(scene, target, `${TRIGGER_PREFIX}${id}`, 'trigger', trigger.shapes, () => triggers.get(id)?.shapes, [0, 1, 0], (debug) => {
        debug.setPosition(target.worldPosition);
        debug.setQuaternion(target.worldQuaternion);
      });
    }
  }

  // 6. Per-node world AABB boxes.
  if (show('boundingBoxes')) {
    for (const node of nodes) {
      if (node instanceof ModelNode && !isEditorOwnedName(node.name) && !(node as any).isGizmo)
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
    } else if (node.name.startsWith(FOLIAGE_PREFIX)) {
      const id = node.name.slice(FOLIAGE_PREFIX.length);
      if (!show('foliageColliders') || !landscapeIds.has(id)) drop();
    } else if (node.name.startsWith(NAVVOLUME_PREFIX) || node.name.startsWith(NAVPREVIEW_PREFIX)) {
      const prefix = node.name.startsWith(NAVVOLUME_PREFIX) ? NAVVOLUME_PREFIX : NAVPREVIEW_PREFIX;
      const id = node.name.slice(prefix.length);
      // Selection is the only gate, matching 4c — NOT `show('navMesh')`, which governs the baked
      // wireframe. Dropped the moment the selection moves on or the node goes away; a box left behind
      // reads as a second volume that is quietly baking nothing.
      if (id !== selectedId || !(scene.getNodeById(id) instanceof NavMeshNode)) drop();
    } else if (node.name.startsWith(DECALBOX_PREFIX)) {
      // Selection-gated like 4d: gone the moment the decal is deselected, deleted or converted.
      const id = node.name.slice(DECALBOX_PREFIX.length);
      if (id !== selectedId || !planDecalBox(scene.getNodeById(id))) drop();
    } else if (node.name.startsWith(EFFECTSHAPE_PREFIX)) {
      // Selection-gated like 4e. The suffix records which shape was built, so a field switched between
      // sphere and box drops its old wireframe instead of rescaling the wrong one.
      const [id, kind] = node.name.slice(EFFECTSHAPE_PREFIX.length).split(':');
      const owner = scene.getNodeById(id);
      const want = owner instanceof ParticleSystemNode || owner instanceof WaterVolumeNode || owner instanceof OccluderNode
        || isOrientedVolume(owner) ? 'b'
        : owner instanceof ForceFieldNode && owner.shape !== 'global' ? (owner.shape === 'sphere' ? 's' : 'b') : null;
      if (id !== selectedId || want !== kind) drop();
    } else if (node.name.startsWith(NAVMESH_PREFIX)) {
      const id = node.name.slice(NAVMESH_PREFIX.length);
      const owner = scene.getNodeById(id);
      // Dropped when hidden, when its node is gone, or when the bake was cleared -- otherwise a
      // stale wireframe outlives the mesh it described and reads as a navmesh that still works.
      if (!show('navMesh') || !owner || !(owner as any).isBaked) drop();
    } else if (node.name.startsWith(AABB_PREFIX)) {
      const id = node.name.slice(AABB_PREFIX.length);
      const owner = scene.getNodeById(id);
      if (!show('boundingBoxes') || !(owner instanceof ModelNode) || isEditorOwnedName(owner.name)) drop();
    }
  }
}
