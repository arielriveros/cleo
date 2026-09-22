import { Geometry, ModelNode, Model, LandscapeNode, Scene, TerrainMaterial } from 'cleo'
import type { Terrain } from 'cleo'
import { PREVIEW_SPHERE_TILING, PREVIEW_TERRAIN_SIZE, PREVIEW_TERRAIN_RADIUS, previewSphereGeometry } from './previewFraming'
import { previewRigOf } from './createMaterialPreviewScene'

// What a material preview is drawn on: a sphere, a plane, or — for a landscape material — a small hill.
//
// The sphere shows every angle a surface can face, which is what makes it the default and the thumbnail
// shape; the plane shows how a material tiles on flat ground, which a sphere hides; the hill is ground
// with real slopes and real elevation, so a landscape material's slope and elevation rules can be seen
// doing what they will do on a landscape. A landscape material's sphere shows its rules too — slope
// runs 0° at the top to 90° at the equator — with elevation mapped onto the sphere's height.

export type PreviewShape = 'sphere' | 'plane' | 'hill'
export type PreviewKind = 'material' | 'terrainMaterial'

/** The shapes each preview offers, in toolbar order. */
export const PREVIEW_SHAPES: Record<PreviewKind, readonly PreviewShape[]> = {
  material: ['sphere', 'plane'],
  terrainMaterial: ['sphere', 'plane', 'hill'],
}

const STORAGE_KEY = 'cleo_preview_shape_v1'

/** The shape last chosen for this kind of preview (per browser), or the sphere. */
export function loadPreviewShape(kind: PreviewKind): PreviewShape {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}')?.[kind]
    return PREVIEW_SHAPES[kind].includes(saved) ? saved : 'sphere'
  } catch { return 'sphere' }
}

export function savePreviewShape(kind: PreviewKind, shape: PreviewShape): void {
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') ?? {}
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...all, [kind]: shape }))
  } catch { /* storage unavailable: the choice just does not persist */ }
}

// --- geometry -----------------------------------------------------------------------------------

/** The material-preview plane's side, metres. About the sphere's diameter, so the two frame alike. */
export const PREVIEW_PLANE_SIZE = 2.6

/**
 * A flat plane with its UVs repeated so one texture repeat covers the SAME metres it does on the preview
 * sphere — `2 * PI * r / PREVIEW_SPHERE_TILING` for a unit sphere. Switching shapes then changes the
 * surface, never the apparent scale of the material on it. Subdivided, so displacement has vertices.
 */
export function previewPlaneGeometry(): Geometry {
  const g = Geometry.Plane(PREVIEW_PLANE_SIZE, PREVIEW_PLANE_SIZE, 48, 48)
  const metresPerRepeat = (2 * Math.PI) / PREVIEW_SPHERE_TILING
  const k = PREVIEW_PLANE_SIZE / metresPerRepeat
  const uvs = g.uvs
  for (let i = 0; i < uvs.length; i++) uvs[i] *= k
  return g
}

/**
 * Heights for the landscape-material hill: a broad mound with a steeper knoll on its flank, over a
 * `resolution`² grid spanning `size` metres. Slopes run from flat to about 65°, and elevation from 0 to
 * `HILL_HEIGHT`, so both kinds of rule have something to act on.
 */
export const HILL_HEIGHT = 3.6
export function hillHeights(resolution: number, size: number): Float32Array {
  const out = new Float32Array(resolution * resolution)
  const half = size / 2, e = size / Math.max(1, resolution - 1)
  for (let r = 0; r < resolution; r++) {
    const z = -half + r * e
    for (let c = 0; c < resolution; c++) {
      const x = -half + c * e
      const mound = 2.9 * Math.exp(-((x - 0.4) ** 2 + (z + 0.3) ** 2) / (2 * 1.35 ** 2))
      const knoll = 1.3 * Math.exp(-((x + 2.1) ** 2 + (z - 1.9) ** 2) / (2 * 0.55 ** 2))
      out[r * resolution + c] = Math.min(HILL_HEIGHT, mound + knoll)
    }
  }
  return out
}

// --- elevation --------------------------------------------------------------------------------------

/**
 * The span of elevations a landscape material's rules act over, fades included, or null when no rule
 * uses elevation. What the preview maps its subject's height onto, so every transition is visible.
 */
export function ruleElevationSpan(tm: TerrainMaterial): [number, number] | null {
  let lo = Infinity, hi = -Infinity
  for (const rule of [tm.rule, ...tm.slots.map(s => s.rule)]) {
    const e = rule.elevation
    if (!e.enabled) continue
    lo = Math.min(lo, e.min - e.falloff)
    hi = Math.max(hi, e.max + e.falloff)
  }
  if (!isFinite(lo) || !isFinite(hi)) return null
  // Some room either side, so the lowest and highest bands both show an edge.
  const pad = Math.max((hi - lo) * 0.15, 1)
  return [lo - pad, hi + pad]
}

/**
 * The `(scale, offset)` that maps world Y from `yLo..yHi` onto `span` — the terrain's `elevationRemap`.
 * Null when there is no span to show (the preview then measures metres above the subject's base).
 */
export function elevationRemapFor(yLo: number, yHi: number, span: [number, number] | null): [number, number] | null {
  if (!span || yHi - yLo < 1e-6) return null
  const scale = (span[1] - span[0]) / (yHi - yLo)
  return [scale, span[0] - yLo * scale]
}

// --- applying a shape -------------------------------------------------------------------------------

/**
 * Put an ordinary material preview on `shape`: swap the subject's geometry IN PLACE (the node id is
 * what the tab saves and selects by) and re-frame the camera.
 */
export function applyMaterialPreviewShape(scene: Scene, subject: ModelNode, shape: PreviewShape): void {
  const plane = shape === 'plane'
  // The preview subject is always a plain Model; a skinned model has no geometry to swap.
  if (subject.model instanceof Model) subject.model.setGeometry(plane ? previewPlaneGeometry() : previewSphereGeometry())
  previewRigOf(scene)?.frame(plane
    ? { subjectRadius: PREVIEW_PLANE_SIZE * 0.72, pitch: 38, minPitch: 5 }
    : { subjectRadius: 1, pitch: -18, distance: 3.2, minDistance: 1.8, maxDistance: 12 })
}

/** The radius and centre height of a landscape material's preview sphere. */
export const TERRAIN_SPHERE_RADIUS = PREVIEW_TERRAIN_SIZE / 2

/** The pieces of a landscape-material preview. */
export interface TerrainPreview {
  /** The patch that carries the stack; always in the scene, shown for plane and hill. */
  landscape: LandscapeNode
  /** A sphere drawn with the landscape's own composite material; shown for sphere. */
  sphere: ModelNode
  material: TerrainMaterial
  /** Size of the landscape the material is judged against (the scene's own, or the reference). */
  referenceSize: number
}

/** Build the sphere half of a landscape-material preview: the patch's composite material on a sphere. */
export function terrainPreviewSphere(terrain: Terrain): ModelNode {
  const sphere = new ModelNode('preview_sphere', new Model(previewSphereGeometry(), terrain.material))
  sphere.setScale([TERRAIN_SPHERE_RADIUS, TERRAIN_SPHERE_RADIUS, TERRAIN_SPHERE_RADIUS])
  sphere.setPosition([0, TERRAIN_SPHERE_RADIUS, 0])
  return sphere
}

/**
 * Put a landscape-material preview on `shape`, and bring its scale and elevation mapping in line with
 * the material as it is NOW (call again after a rule edit).
 *
 * Tiling is rescaled, never the material's own: one repeat must cover the same metres here as on the
 * landscape the material is for (`previewTerrainSubject.ts` explains why that is the whole point).
 */
export function applyTerrainPreviewShape(scene: Scene, p: TerrainPreview, shape: PreviewShape): void {
  const terrain = p.landscape.terrain
  const showSphere = shape === 'sphere'
  p.sphere.visible = showSphere
  // Hidden, not removed: the renderer syncs the layer stack of every landscape IN the scene, visible or
  // not, and the sphere draws with this landscape's material.
  p.landscape.visible = !showSphere

  const res = terrain.resolution
  terrain.setHeights(shape === 'hill' ? hillHeights(res, terrain.size) : new Float32Array(res * res))
  updateTerrainPreviewMapping(p, shape)

  previewRigOf(scene)?.frame(showSphere
    ? { subjectRadius: TERRAIN_SPHERE_RADIUS, pitch: 22, target: [0, TERRAIN_SPHERE_RADIUS, 0] }
    : { subjectRadius: PREVIEW_TERRAIN_RADIUS, pitch: 42, target: [0, shape === 'hill' ? HILL_HEIGHT * 0.3 : 0, 0], minPitch: 5 })
}

/**
 * Re-derive the preview's tiling scale and elevation mapping from the material as it is now — what a
 * rule or tiling edit needs, without rebuilding the subject.
 */
export function updateTerrainPreviewMapping(p: TerrainPreview, shape: PreviewShape): void {
  const terrain = p.landscape.terrain
  const span = ruleElevationSpan(p.material)
  if (shape === 'sphere') {
    const circumference = 2 * Math.PI * TERRAIN_SPHERE_RADIUS
    terrain.tilingScale = circumference / (PREVIEW_SPHERE_TILING * Math.max(p.referenceSize, 1e-6))
    terrain.elevationRemap = elevationRemapFor(0, 2 * TERRAIN_SPHERE_RADIUS, span)
  } else {
    terrain.tilingScale = PREVIEW_TERRAIN_SIZE / Math.max(p.referenceSize, 1e-6)
    terrain.elevationRemap = shape === 'hill' ? elevationRemapFor(0, HILL_HEIGHT, span) : null
  }
  terrain.refreshLayers()
}

/** The legend a landscape-material preview shows under its shape switch: what its height means. */
export function elevationLegend(p: TerrainPreview, shape: PreviewShape): string | null {
  const remap = p.landscape.terrain.elevationRemap
  if (!remap) return null
  const top = shape === 'sphere' ? 2 * TERRAIN_SPHERE_RADIUS : HILL_HEIGHT
  const at = (y: number) => Math.round(y * remap[0] + remap[1])
  return `Elevation ${at(0)} m at the bottom → ${at(top)} m at the top`
}
