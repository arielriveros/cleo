// Set dressing for the Valley's hamlet, applied to the SHIPPED Valley (build.mjs cannot run any more; see
// bundleOps.ts): a well on the hamlet square, and street lamps along both sides of the stone trail in place of
// the three standing torches, so that at night the hamlet is lit by its lamps.
//
//   NODE_OPTIONS=--max-old-space-size=16384 npx vite-node --config vitest.config.ts tools/valley/applyHamletDressing.ts [--reimport] [--dry]
//
// The two models come from build/additional_valley_props (gitignored), both Sketchfab GLBs in centimetres,
// CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/):
//   - "Light Pole" by Arkikon (https://sketchfab.com/ragnar),
//     https://sketchfab.com/3d-models/light-pole-4d3388e65a324342b6a13b1bff16b3ed
//     A 3.2 m timber post on four braces sunk into the ground (its own ground plane at y 0; the post's foot
//     48 cm under it, the braces' 31 cm), an arm 2.6 m up and a wire-cage lantern hung 60 cm out along +Z
//     with a candle in it. Its flame is a static alpha card (a second primitive and material, 24 triangles,
//     two 256 px maps): dropped. The fire is the Valley's own instead, the shipped torches' animated flame,
//     embers and flickering light, burning where the card did.
//   - "Well" by FlukierJupiter (https://sketchfab.com/FlukierJupiter),
//     https://sketchfab.com/3d-models/well-d8442bc92f224f0ebfa8446a1bca836d
//     A round mossy stone well (1.85 m across, 0.88 m high), two timber posts, a pitched plank roof 2.68 m
//     up, a windlass with its rope and a bucket. Four materials (the well, the bucket, the rope, the roof),
//     kept as four parts of one model.
// Each becomes ONE library model under /Props/Hamlet through the part pipeline the furniture takes
// (interiorProps.ts: uv v flipped, no tangents, numbers rounded), its maps JPEGs at most 1k a side
// (re-encoded at quality 90 by Pillow, `python -I`). A model already in the library is reused as it is unless
// `reimport` is asked for, so a re-run needs neither the sources nor Python and changes nothing.
//
// The scene: the three standing `Torch`es go from `Torches` (the four wall torches stay), and with them the
// Torch template, its Standing Torch material and maps, which nothing else used (bundleOps `prune`, which
// must find nothing else to take). `Light Poles` stands beside `Torches`: linked copies of the pole
// (`__modelId`), each with the Valley's fire in its lantern (the Wall Torch template's Flame, Embers and
// Light, which are the standing torch's but for the flame's softness and the lumens, both set here), the
// ValleyFireLight script on its root, a static cylinder round its post and a draw distance. Then `Well`, a
// linked copy of the well on the hamlet square (layout.mjs HAMLET), with a static body.
//
// Where the poles stand: along the main road (layout.mjs ROADS[0], the Catmull-Rom the Trail slot was
// painted along), ROAD_OFFSET off its centreline on the graded edge beyond its 2.6 m core, each turned so
// its lantern hangs toward the road; densest through the hamlet, sparser beyond it; and three more round
// the well, their lanterns toward it. Each spot was chosen clear of what is around it: the Valley Tour's
// camera (tests/valleyHamletDressing.test.ts measures each pole against every shot), the houses' walls,
// the footpaths to their doors, the lesser dirt roads, the trees and bushes, the campfire, and ground too
// steep for the braces to stay buried. A pole stands on the landscape: its origin on the surface at its post.
//
// GI: the poles and the well stand inside Hamlet GI, whose bake signature keys the static geometry it can
// see, so the shipped Hamlet GI bake is stale until `node tools/valley/bakeGI.cjs` bakes it again.

import path from 'path'
import fs from 'fs'
import { partsOf, mergeByMaterial, boundsOf } from './meshes.mjs'
import { ROADS, HAMLET, catmullRom, distanceToPolyline } from './layout.mjs'
import { ROOT, VALLEY_SCENE, id, log, child, nodes, prune, checkNodeRefs, attach } from './bundleOps'
import { SOURCE_DIR, TEXTURE_CONFIG, readSource, shippedImage, geometryOf, pub, upsert, type Source } from './interiorProps'
import { terrainHeightSampler } from './cinematic/terrainHeight'

const FOLDER = '/Props/Hamlet'

/** Past this distance from the camera (to its origin) a pole is not drawn, nor its fire lit. */
export const LIGHT_POLE_DRAW_DISTANCE = 150
export const WELL_DRAW_DISTANCE = 150

// ---------------------------------------------------------------------------------------------------
// The models
// ---------------------------------------------------------------------------------------------------

interface PartSpec {
  /** The source's material index: its primitives become this part. */
  material: number
  key: string
  /** The part node's name, and its library material's. */
  name: string
}
interface PropSpec {
  key: string
  name: string
  file: string
  /** Into metres. */
  scale: number
  /** The parts kept, one per material, in this order; a material not listed is dropped. */
  parts: PartSpec[]
  /** Where the model's origin goes, from its scaled parts (by material). */
  origin: (parts: Map<number, any>) => number[]
}

/**
 * The lantern, in the pole model's frame (the post's axis at the origin, its ground at y 0, the arm toward
 * +Z): the root of the source's flame card (on the candle's wick, in the middle of the cage) and the lowest
 * of the lantern (a ring hung under its dish). Checked against the card whenever the pole is imported.
 */
export const LANTERN = { x: 0.042, y: 2.251, z: 0.601, bottom: 2.103 }

const bounds = (p: any) => boundsOf([p])

export const PROPS: PropSpec[] = [
  {
    key: 'light-pole', name: 'Light Pole', file: 'light_pole.glb', scale: 0.01,
    parts: [{ material: 0, key: 'light-pole', name: 'Light Pole' }],
    // The post's axis (its bounds between the braces' collar and the cross bar), on the model's own ground.
    origin: (parts) => {
      const P = parts.get(0).positions
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity
      for (let i = 0; i < P.length; i += 3) if (P[i + 1] > 0.6 && P[i + 1] < 1.8) {
        x0 = Math.min(x0, P[i]); x1 = Math.max(x1, P[i]); z0 = Math.min(z0, P[i + 2]); z1 = Math.max(z1, P[i + 2])
      }
      return [(x0 + x1) / 2, 0, (z0 + z1) / 2]
    },
  },
  {
    key: 'well', name: 'Well', file: 'well.glb', scale: 0.01,
    parts: [
      { material: 1, key: 'well', name: 'Well' },
      { material: 3, key: 'well-roof', name: 'Well Roof' },
      { material: 0, key: 'well-bucket', name: 'Well Bucket' },
      { material: 2, key: 'well-rope', name: 'Well Rope' },
    ],
    // The middle of the roof's footprint (the ring's centre: the crank handle reaches out further on one
    // side), on the foot of the stone ring and the posts.
    origin: (parts) => {
      const roof = bounds(parts.get(3))
      const base = Math.min(...[...parts.values()].map(p => bounds(p).min[1]))
      return [(roof.min[0] + roof.max[0]) / 2, base, (roof.min[2] + roof.max[2]) / 2]
    },
  },
]

export const modelIdOf = (key: string) => id(`hamlet:model:${key}`)
const materialIdOf = (part: string) => id(`hamlet:material:${part}`)
const textureIdOf = (part: string, slot: string) => id(`hamlet:texture:${part}:${slot}`)

/** One source material as a library material and its maps (base colour, ORM, normal), as the furniture's. */
function materialOf(src: Source, file: string, spec: PartSpec) {
  const { gltf } = src
  const m = gltf.materials[spec.material]
  const pbr = m.pbrMetallicRoughness ?? {}
  const textures: any[] = []
  const names: { id: string, name: string }[] = []
  const map = (texIndex: number | undefined, slot: string, label: string) => {
    if (texIndex === undefined) return undefined
    const bytes = shippedImage(src.image(gltf.textures[texIndex].source), `${file} ${spec.name} ${label}`)
    const texId = textureIdOf(spec.key, slot)
    textures.push({ id: texId, mime: 'image/jpeg', config: { ...TEXTURE_CONFIG }, bytes: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) })
    names.push({ id: texId, name: `${spec.name} ${label}` })
    return texId
  }
  const base = map(pbr.baseColorTexture?.index, 'base', 'Base Color')
  const orm = map(pbr.metallicRoughnessTexture?.index, 'orm', 'ORM')
  const normal = map(m.normalTexture?.index, 'normal', 'Normal')
  const sameAsOrm = m.occlusionTexture && gltf.textures[m.occlusionTexture.index].source === gltf.textures[pbr.metallicRoughnessTexture?.index]?.source
  if (m.occlusionTexture && !sameAsOrm) throw new Error(`${file} ${spec.name}: an occlusion map of its own is not handled`)
  const maps: any = {}
  if (base) maps.baseColorTexture = base
  if (orm) { maps.metallicRoughnessTexture = orm; if (sameAsOrm) maps.occlusionMap = orm }
  if (normal) maps.normalMap = normal
  const color = pbr.baseColorFactor ?? [1, 1, 1, 1]
  const material = {
    type: 'pbr', baseColor: [color[0], color[1], color[2]],
    metallic: orm ? 0 : pbr.metallicFactor ?? 1, roughness: orm ? 1 : pbr.roughnessFactor ?? 1,
    reflectance: 0.5, opacity: 1, emissiveFactor: [0, 0, 0], emissiveIntensity: 1,
    textures: maps,
    config: { side: m.doubleSided ? 'double' : 'front', wireframe: false, transparent: false, castShadow: true, probeable: true },
  }
  const textureIds = [...new Set(Object.values(maps) as string[])]
  return { asset: { id: materialIdOf(spec.key), name: spec.name, material, textureIds, thumbnail: '' }, textures, names }
}

/** The library model, its materials and their textures (with their Assets names) for one prop. */
function importProp(spec: PropSpec) {
  const src = readSource(path.join(SOURCE_DIR, spec.file))
  const byMaterial = new Map<number, any>(mergeByMaterial(partsOf(src)).map((p: any) => [p.material, p]))
  for (const p of byMaterial.values()) for (let k = 0; k < p.positions.length; k++) p.positions[k] *= spec.scale
  const origin = spec.origin(byMaterial)
  for (const p of byMaterial.values()) for (let k = 0; k < p.positions.length; k += 3) {
    p.positions[k] -= origin[0]; p.positions[k + 1] -= origin[1]; p.positions[k + 2] -= origin[2]
  }
  if (spec.key === 'light-pole') {
    // The dropped flame card is where the fire burns: LANTERN must still say so.
    const card = bounds(byMaterial.get(1))
    const at = [(card.min[0] + card.max[0]) / 2, card.min[1], (card.min[2] + card.max[2]) / 2]
    if (Math.abs(at[0] - LANTERN.x) > 0.01 || Math.abs(at[1] - LANTERN.y) > 0.01 || Math.abs(at[2] - LANTERN.z) > 0.01)
      throw new Error(`${spec.file}: its flame card is at (${at.map(v => v.toFixed(3)).join(', ')}), not LANTERN`)
  }

  const materials: any[] = [], textures: any[] = [], names: { id: string, name: string }[] = []
  const children = spec.parts.map(ps => {
    const part = byMaterial.get(ps.material)
    if (!part) throw new Error(`${spec.file}: no primitives use material ${ps.material}`)
    const m = materialOf(src, spec.file, ps)
    materials.push(m.asset); textures.push(...m.textures); names.push(...m.names)
    return {
      id: id(`hamlet:model:${spec.key}:${ps.key}`), name: ps.name, type: 'model',
      position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
      variables: { __materialId: pub(m.asset.id) }, spawnOnStart: true,
      model: { geometry: geometryOf(part), material: structuredClone(m.asset.material) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    }
  })
  const dropped = [...byMaterial.keys()].filter(k => !spec.parts.some(p => p.material === k))
  const kept = spec.parts.map(p => byMaterial.get(p.material))
  const nodeJson = {
    id: id(`hamlet:model:${spec.key}:root`), name: spec.name, type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children, variables: {}, spawnOnStart: true,
  }
  const textureIds = [...new Set(materials.flatMap(m => m.textureIds))]
  const model = { id: modelIdOf(spec.key), name: spec.name, nodeJson, textureIds, materialIds: materials.map(m => m.id), thumbnail: '' }
  const triangles = kept.reduce((n, p) => n + p.indices.length / 3, 0)
  return { model, materials, textures, names, triangles, size: boundsOf(kept).size, dropped }
}

/** The library side: what the library already holds, and the rest (or all) imported afresh. */
function libraryProps(bundle: any, reimport: boolean) {
  const L = bundle.libraries
  const wanted = reimport ? PROPS : PROPS.filter(p => !L.models.some((m: any) => m.id === modelIdOf(p.key)))
  if (!wanted.length) {
    log('hamlet: the library already holds the light pole and the well; reusing them (--reimport rebuilds them from build/additional_valley_props)')
    return
  }
  const missing = wanted.filter(p => !fs.existsSync(path.join(SOURCE_DIR, p.file)))
  if (missing.length) throw new Error(`hamlet: ${missing.map(p => p.file).join(', ')} not in ${path.relative(ROOT, SOURCE_DIR)}`)

  const created = bundle.manifest.createdAt
  let bytes = 0
  for (const spec of wanted) {
    const prop = importProp(spec)
    upsert(L.models, prop.model)
    for (const m of prop.materials) upsert(L.materials, m)
    for (const t of prop.textures) { upsert(bundle.textures, t); bytes += t.bytes.byteLength }
    const ids = new Set([prop.model.id, ...prop.materials.map(m => m.id), ...prop.textures.map(t => t.id)])
    bundle.vfs.entries = bundle.vfs.entries.filter((e: any) => !ids.has(e.assetId))
    bundle.vfs.entries.push({ path: `${FOLDER}/Models/${spec.name}.model`, kind: 'model', assetId: prop.model.id, created })
    for (const m of prop.materials) bundle.vfs.entries.push({ path: `${FOLDER}/Materials/${m.name}.mat`, kind: 'material', assetId: m.id, created })
    for (const t of prop.names) bundle.vfs.entries.push(
      { path: `${FOLDER}/Textures/${t.name}.tex`, kind: 'texture', assetId: t.id, created },
      { path: `${FOLDER}/Textures/Source/${t.name}.jpg`, kind: 'image', assetId: t.id, created },
    )
    log(`  ${spec.name}: ${prop.triangles} triangles, ${prop.size.map((v: number) => v.toFixed(2)).join(' x ')} m, `
      + `${prop.materials.length} material(s), ${prop.textures.length} maps${prop.dropped.length ? `, source material(s) ${prop.dropped.join(', ')} dropped` : ''}`)
  }
  for (const f of ['/Props', FOLDER, `${FOLDER}/Models`, `${FOLDER}/Materials`, `${FOLDER}/Textures`, `${FOLDER}/Textures/Source`])
    if (!bundle.vfs.folders.includes(f)) bundle.vfs.folders.push(f)
  log(`hamlet: ${wanted.length} model(s) imported, ${(bytes / 1048576).toFixed(2)} MB of maps`)
}

// ---------------------------------------------------------------------------------------------------
// Where the poles stand
// ---------------------------------------------------------------------------------------------------

export type Side = 'west' | 'east'
/** A pole beside the main road: `s` metres along it from its spawn end, on one side, `offset` off its centreline. */
export interface RoadPole { s: number, side: Side, offset?: number }
/** A pole round the well: at `angle` degrees about it (0 toward +X, 90 toward +Z), `radius` metres out. */
export interface SquarePole { angle: number, radius: number }

/** Off the main road's centreline: past its graded core (2.6 m), on the edge its blend grades into. */
export const ROAD_OFFSET = 3.5

/**
 * Along the main road (s metres from its spawn end at (-12, 82); the road runs north, west on the left).
 * From the campfire (one pole where the bank flattens enough for the braces) down through the hamlet
 * (s 21..75, z 62..12), where a pole stands every 6 to 10 m on a side, the two sides staggered, except
 * where something else needs the roadside:
 *   - east, s 19..43: the Drizzle shot's low dolly runs along that edge at head height;
 *   - west, s 30..36: the Cloudy shot's camera, two metres up;
 *   - west, s 41..55: the footpaths to the Old House and the Granary join the road; the three poles round
 *     the well light that side instead;
 *   - east, s 55.5..62: the dirt road to the pond leaves the main road.
 */
export const ROAD_POLES: RoadPole[] = [
  { s: 5, side: 'east', offset: 3.3 },
  { s: 23, side: 'west' },
  { s: 29, side: 'west' },
  { s: 37.5, side: 'west' },
  { s: 44, side: 'east' },
  { s: 49.5, side: 'east' },
  { s: 55, side: 'east' },
  { s: 57, side: 'west' },
  { s: 63.5, side: 'east' },
  { s: 66, side: 'west' },
  { s: 72, side: 'east' },
  { s: 75.5, side: 'west' },
]

/** Round the well: north-west and west of it, and south across the Old House's footpath. */
export const SQUARE_POLES: SquarePole[] = [
  { angle: 240, radius: 5.5 },
  { angle: 165, radius: 5.5 },
  { angle: 75, radius: 6.5 },
]

/** The well: on the hamlet square, its crank to the north (local -Z), away from the Old House's footpath. */
export const WELL = { x: HAMLET.x, z: HAMLET.z, yaw: 0 }

/** The main road's centreline as the Trail slot was painted along it (landscape.mjs), with arc length. */
export function mainRoad() {
  const line: number[][] = catmullRom(ROADS.find((r: any) => r.key === 'main').points, 0.5)
  const at = [0]
  for (let i = 1; i < line.length; i++) at.push(at[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]))
  const pointAt = (s: number) => {
    let i = 1
    while (i < line.length - 1 && at[i] < s) i++
    const t = (s - at[i - 1]) / ((at[i] - at[i - 1]) || 1)
    return [line[i - 1][0] + t * (line[i][0] - line[i - 1][0]), line[i - 1][1] + t * (line[i][1] - line[i - 1][1])]
  }
  /** The point at `s`, and the unit normal on its west side (the road runs north here: west is its left). */
  const frameAt = (s: number) => {
    const a = pointAt(s - 1), b = pointAt(s + 1)
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    const t = [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
    return { point: pointAt(s), west: [t[1], -t[0]] }
  }
  return { line, length: at[at.length - 1], pointAt, frameAt }
}

const r3 = (v: number) => Math.round(v * 1000) / 1000
const r2 = (v: number) => Math.round(v * 100) / 100
const deg = (r: number) => r * 180 / Math.PI

export interface PolePlacement {
  key: string
  name: string
  kind: 'road' | 'square'
  side?: Side
  position: number[]
  /** Degrees about +Y; the lantern (the model's +Z) points along (sin, cos) of it. */
  yaw: number
}

/** Every pole's spot and turn, on the landscape (`heightAt`). */
export function polePlacements(heightAt: (x: number, z: number) => number): PolePlacement[] {
  const road = mainRoad()
  const out: PolePlacement[] = []
  ROAD_POLES.forEach((p, i) => {
    const { point, west } = road.frameAt(p.s)
    const sign = p.side === 'west' ? 1 : -1, offset = p.offset ?? ROAD_OFFSET
    const x = point[0] + sign * offset * west[0], z = point[1] + sign * offset * west[1]
    out.push({ key: `road-${i + 1}`, name: `Light Pole ${i + 1}`, kind: 'road', side: p.side,
      position: [r3(x), r3(heightAt(x, z)), r3(z)], yaw: r2(deg(Math.atan2(-sign * west[0], -sign * west[1]))) })
  })
  SQUARE_POLES.forEach((p, i) => {
    const a = p.angle * Math.PI / 180
    const x = WELL.x + p.radius * Math.cos(a), z = WELL.z + p.radius * Math.sin(a)
    out.push({ key: `square-${i + 1}`, name: `Square Light Pole ${i + 1}`, kind: 'square',
      position: [r3(x), r3(heightAt(x, z)), r3(z)], yaw: r2(deg(Math.atan2(-Math.cos(a), -Math.sin(a)))) })
  })
  return out
}

// ---------------------------------------------------------------------------------------------------
// The scene
// ---------------------------------------------------------------------------------------------------

/** A pole's light: brighter and further-reaching than the torches' (1,000 lm, 7 m), so the lamps carry the hamlet. */
export const POLE_LIGHT = { intensity: 1600, range: 11 }
/** The flame in the lantern, metres tall: a candle's, a little larger so it reads down the road. */
const FLAME_HEIGHT = 0.16
/** Torch Fire's proportions (build.mjs TORCH_FLAME): its sprite 0.75 as wide as tall, its root 10 % up it. */
const FLAME_WIDTH = 0.75, FLAME_ROOT = 0.1

/** A linked copy of `asset` (instantiateModelAsset's plain shape), ids derived from `key`. */
function linkedCopy(asset: any, key: string, name: string, position: number[], yaw: number) {
  const copy = structuredClone(asset.nodeJson)
  let n = 0
  const rekey = (j: any) => { j.id = id(`${key}:${n++}`); for (const c of j.children ?? []) rekey(c) }
  rekey(copy)
  return {
    ...copy, name, position, rotation: [0, yaw, 0], scale: [1, 1, 1],
    variables: { __modelId: pub(asset.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') },
    spawnOnStart: true,
  }
}

const staticBody = (shapes: any[]) => ({
  mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
  friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0, motionSmoothing: 0,
  shapes,
})
const cylinder = (radius: number, height: number, offset: number[]) =>
  ({ type: 'cylinder', radius, height, numSegments: 8, offset, rotation: [0, 0, 0] })

/**
 * The fire in a pole's lantern, from the Wall Torch template's: the Torch Fire flame on the wick, the embers
 * rising off it and out through the cage, and the light at the flame. The light's size is the lantern's,
 * which is also what keeps the lantern's own cage and dish out of its shadow map (the point shadow's near
 * plane is the light's source radius, shadows.ts), so they do not throw a dark disc on the road under it.
 */
function lanternFire(fx: Record<string, any>, key: string) {
  const at = (dy: number) => [LANTERN.x, r3(LANTERN.y + dy), LANTERN.z]
  const flame = structuredClone(fx.Flame)
  flame.id = id(`${key}:flame`)
  flame.position = at(FLAME_HEIGHT * (0.5 - FLAME_ROOT))
  flame.scale = [r3(FLAME_HEIGHT * FLAME_WIDTH), FLAME_HEIGHT, 1]
  flame.sprite.softness = r2(Math.min(0.15, FLAME_HEIGHT * 0.25))
  const embers = structuredClone(fx.Embers)
  embers.id = id(`${key}:embers`)
  embers.position = at(0.06)
  const light = structuredClone(fx.Light)
  light.id = id(`${key}:light`)
  light.position = at(0.05)
  light.castShadows = true
  light.light.intensity = POLE_LIGHT.intensity
  light.light.range = POLE_LIGHT.range
  light.light.sourceRadius = r2(light.position[1] - LANTERN.bottom + 0.01)
  return [flame, embers, light]
}

/** The standing torches' template and what only it used, the one thing removing them may let `prune` take. */
const TORCH_LEFTOVERS = (kind: string, name: string) =>
  (kind === 'template' && name === 'Torch') || (kind === 'material' && name === 'Standing Torch')
  || (kind === 'texture' && name.startsWith('Standing Torch '))

/** Add or replace the hamlet's dressing: the library models, the `Light Poles` and the `Well`. Idempotent. */
export function applyHamletDressing(bundle: any, options: { reimport?: boolean } = {}) {
  const data = bundle.scenes[VALLEY_SCENE]
  if (!data) throw new Error('no Valley scene')
  const root = data.scene
  const torches = child(root, 'Torches')
  if (!torches) throw new Error('the Valley has no Torches')

  libraryProps(bundle, !!options.reimport)
  const models = new Map<string, any>(bundle.libraries.models.map((m: any) => [m.id, m]))
  const pole = models.get(modelIdOf('light-pole')), well = models.get(modelIdOf('well'))
  if (!pole || !well) throw new Error('hamlet: the library lacks the light pole or the well')
  const script = bundle.libraries.scripts.find((s: any) => s.id === id('script:ValleyFireLight'))
  if (!script) throw new Error('hamlet: no Fire Light script in the library')
  const wallTorch = bundle.libraries.templates.find((t: any) => t.name === 'Wall Torch')
  const fx = Object.fromEntries(['Flame', 'Embers', 'Light'].map(n => [n, child(wallTorch?.nodeJson, n)]))
  if (!fx.Flame || !fx.Embers || !fx.Light) throw new Error('hamlet: the Wall Torch template has no Flame, Embers and Light to copy')

  // ----- the standing torches out (the wall torches stay)
  const standing = torches.children.filter((c: any) => c.name === 'Torch')
  torches.children = torches.children.filter((c: any) => c.name !== 'Torch')
  checkNodeRefs(root, standing, 'hamlet')

  // ----- the poles
  const heightAt = terrainHeightSampler(root)
  const road = mainRoad()
  const placements = polePlacements(heightAt)
  for (const p of placements) {
    const off = distanceToPolyline(p.position[0], p.position[2], road.line)
    if (off < 3) throw new Error(`hamlet: ${p.name} stands ${off.toFixed(2)} m from the road's centreline, on its core`)
  }
  const poles = placements.map(p => {
    const key = `hamlet:light-pole:${p.key}`
    const copy = linkedCopy(pole, key, p.name, p.position, p.yaw)
    const n: any = {
      ...copy,
      children: [...copy.children, ...lanternFire(fx, key)],
      script: '', scriptVars: {},
      body: staticBody([cylinder(0.1, 2.6, [0, 1.3, 0])]),
      drawDistance: LIGHT_POLE_DRAW_DISTANCE,
    }
    attach(n, script, {})
    log(`  ${p.name}: ${p.kind === 'road' ? `${p.side} of the road` : 'by the well'} at (${p.position.join(', ')}), turned ${p.yaw}°`)
    return n
  })
  const group = {
    id: id('hamlet:light-poles'), name: 'Light Poles', type: 'node',
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
    children: poles, variables: {}, spawnOnStart: true,
  }

  // ----- the well
  const wellNode = {
    ...linkedCopy(well, 'hamlet:well', 'Well', [WELL.x, r3(heightAt(WELL.x, WELL.z)), WELL.z], WELL.yaw),
    // The stone ring (0.92 m out, 0.88 m high) and the two posts (2.54 m, at z +-0.84).
    body: staticBody([cylinder(0.92, 0.88, [0, 0.44, 0]), cylinder(0.1, 2.54, [0, 1.27, 0.84]), cylinder(0.1, 2.54, [0, 1.27, -0.84])]),
    drawDistance: WELL_DRAW_DISTANCE,
  }

  // ----- into the scene: the poles beside the torches, the well after them
  let changed = standing.length > 0
  const place = (n: any, after: any) => {
    const at = root.children.findIndex((c: any) => c.id === n.id)
    if (at >= 0) { changed ||= JSON.stringify(root.children[at]) !== JSON.stringify(n); root.children[at] = n }
    else { changed = true; root.children.splice(root.children.indexOf(after) + 1, 0, n) }
    return n
  }
  place(wellNode, place(group, torches))

  // ----- what only the standing torches used: their template, its material and maps
  const { removed } = prune(bundle)
  const unexpected = Object.entries(removed).flatMap(([kind, names]) => names.filter(n => !TORCH_LEFTOVERS(kind, n)).map(n => `${kind} ${n}`))
  if (unexpected.length) throw new Error(`hamlet: pruning would also remove ${unexpected.join(', ')}`)

  // ----- the scene names the new models now: its refs list them, as the editor's own save would
  for (const meta of bundle.manifest.sceneMetas) {
    if (meta.id !== VALLEY_SCENE) continue
    const refs = (meta.refs ??= {})
    refs.modelIds = [...new Set([...(refs.modelIds ?? []), pole.id, well.id])]
    refs.materialIds = [...new Set([...(refs.materialIds ?? []), ...pole.materialIds, ...well.materialIds])]
    refs.textureIds = [...new Set([...(refs.textureIds ?? []), ...pole.textureIds, ...well.textureIds])]
  }

  const lights = [...nodes(group)].filter(n => n.type === 'light').length
  log(`hamlet: ${poles.length} light poles (${placements.filter(p => p.kind === 'road').length} along the trail, `
    + `${placements.filter(p => p.kind === 'square').length} round the well), ${lights} lights, and the well`
    + (standing.length ? `; ${standing.length} standing torches removed` : '')
    + (Object.keys(removed).length ? `; pruned ${Object.entries(removed).map(([k, v]) => `${v.length} ${k}`).join(', ')}` : '')
    + (changed ? '; the Hamlet GI bake is stale until `node tools/valley/bakeGI.cjs` bakes it again' : '; unchanged'))
  return bundle
}
