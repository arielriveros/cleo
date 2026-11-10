// Firing Line: the warehouse annex, the real props, and the match size (eleven bots and the player).
//
// Applied by ingest.mjs to every pack, like eventActions.mjs, and idempotent: it does nothing to a bundle whose scene
// already holds a `Warehouse` node (a project exported from the editor after this ran carries it all).
//
// The GLBs are read from build/ (abandoned_warehouse, cement_bags_low-poly, propane_and_gas_tanks_set_-_game_ready,
// utility_shelves). What it adds:
//
//   library    four models with their materials and textures (stored as the files carry them)
//   scene      the warehouse as an annex north of the yard: 1.4 x scale, so the doors are 2.1 m and the office a room a
//              person fits in; boxes for its colliders; gates and walls of the yard opened and closed to meet it;
//              lights, GI volumes, light probes and exposure volumes of its own; shelves, cement, tanks and crates;
//              spawn and cover points; real props swapped in for some of the placeholders
//   navmesh    baked again over the whole map, cut down to what a bot can reach, with links on the stairs and ramps
//   bots       each bot template respawns as itself; the manager's game type has its new name and a larger score limit
//
// Everything the scene gets is placed in WORLD metres through W(), the warehouse's own frame (the GLB's) scaled and moved.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { quat, vec3 } from 'gl-matrix'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'
import { stableId } from '../exampleKit/bundle.mjs'
import { headlessNavBaker } from '../navBakeHeadless.mjs'
import { readGltf, partsOf, decimate, geometryJson } from '../valley/meshes.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..', '..')
const BUILD = path.join(ROOT, 'build')

// ---------------------------------------------------------------------------------------------------
// Where the warehouse stands
// ---------------------------------------------------------------------------------------------------

/** Scale and origin of the GLB's frame in the world. */
const SCALE = 1.4
const ORIGIN = [16, 0, 76]
/** The GLB's local (x, z) to the world's, and a local height. */
const wx = (x) => ORIGIN[0] + SCALE * x
const wz = (z) => ORIGIN[2] + SCALE * z
const wy = (y) => SCALE * y
const W = (x, y, z) => [wx(x), wy(y), wz(z)]

const r3 = (v) => Math.round(v * 1000) / 1000
const r3v = (a) => a.map(r3)

// ---------------------------------------------------------------------------------------------------
// Small JSON helpers
// ---------------------------------------------------------------------------------------------------

const MODELS = [
  { file: 'abandoned_warehouse.glb', name: 'abandoned_warehouse', folder: '/Warehouse', keepParts: true, decimate: [[/^Windows_/, 0.18], [/^ConcreteSteps/, 0.5]] },
  { file: 'cement_bags_low-poly.glb', name: 'cement_bags_low-poly', folder: '/Props', merge: true },
  { file: 'propane_and_gas_tanks_set_-_game_ready.glb', name: 'propane_and_gas_tanks', folder: '/Props', merge: true, drop: /^Plane/ },
  { file: 'utility_shelves.glb', name: 'utility_shelves', folder: '/Props', merge: true, decimate: [[/./, 0.14]] },
]

const TEXTURE_CONFIG = {
  flipY: false, usage: 'color', wrapping: 'repeat', wrapU: 'repeat', wrapV: 'repeat', wrapW: 'repeat',
  mipMap: true, mipMapFilter: 'linear', minFilter: 'linear', magFilter: 'linear', anisotropy: 1,
  precision: 'low', format: 'rgba8unorm', target: 'texture2D',
}

const arrayBufferOf = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)

/** A deep copy that shares typed arrays (a geometry is stored once, however many nodes name it). */
function clone(v) {
  if (ArrayBuffer.isView(v)) return v
  if (Array.isArray(v)) return v.map(clone)
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v)) o[k] = clone(v[k]); return o }
  return v
}

/** A copy with every node id replaced by a stable one derived from `key` and the node's position in the tree. */
function reid(n, key) {
  let i = 0
  const walk = (x) => { x.id = stableId(`${key}:${i++}`); for (const c of x.children ?? []) walk(c) }
  walk(n)
  return n
}

const pub = (value) => ({ type: 'string', value, access: 'public' })

// ---------------------------------------------------------------------------------------------------
// Part 1: the library
// ---------------------------------------------------------------------------------------------------

/** One GLB as library assets: { model, materials, textures }. */
function importGlb(spec) {
  const doc = readGltf(path.join(BUILD, spec.file))
  const { gltf, bin } = doc
  const tag = `fps:wh:${spec.name}`

  // ----- textures and materials
  const textures = new Map()
  const imageTexture = (texIndex) => {
    if (texIndex === undefined) return null
    const imageIndex = gltf.textures[texIndex].source
    const id = stableId(`${tag}:tex:${imageIndex}`)
    if (!textures.has(id)) {
      const image = gltf.images[imageIndex]
      const view = gltf.bufferViews[image.bufferView]
      textures.set(id, { id, mime: image.mimeType ?? 'image/png', config: { ...TEXTURE_CONFIG }, bytes: arrayBufferOf(Buffer.from(bin.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength))) })
    }
    return id
  }
  const materials = (gltf.materials ?? [{ name: spec.name }]).map((m, i) => {
    const p = m.pbrMetallicRoughness ?? {}
    const base = imageTexture(p.baseColorTexture?.index)
    const arm = imageTexture(p.metallicRoughnessTexture?.index)
    const normal = imageTexture(m.normalTexture?.index)
    const occ = imageTexture(m.occlusionTexture?.index)
    const blend = m.alphaMode === 'BLEND'
    const maps = {}
    if (base) maps.baseColorTexture = base
    if (arm) { maps.metallicMap = arm; maps.roughnessMap = arm }
    if (normal) maps.normalMap = normal
    if (occ) maps.occlusionMap = occ
    const color = p.baseColorFactor ?? [1, 1, 1, 1]
    return {
      id: stableId(`${tag}:mat:${i}`),
      name: m.name ?? `${spec.name} ${i}`,
      material: {
        type: 'pbr', baseColor: [color[0], color[1], color[2]], metallic: arm ? 1 : (p.metallicFactor ?? 0), roughness: arm ? 1 : (p.roughnessFactor ?? 1),
        reflectance: 0.5, opacity: blend ? color[3] : 1, alphaCutoff: 0,
        emissiveFactor: m.emissiveFactor ?? [0, 0, 0], emissiveIntensity: 1, displacementScale: 0.05, depthSpace: 'world', invertHeight: false, clipSilhouette: false,
        textures: maps,
        config: { side: 'double', wireframe: false, transparent: blend, castShadow: !blend, probeable: true },
      },
      textureIds: Object.values(maps).filter((v, k, a) => a.indexOf(v) === k),
      thumbnail: '',
    }
  })

  // ----- geometry
  let parts = partsOf(doc, { filter: (n) => !spec.drop || !spec.drop.test(n.name ?? '') })
  if (spec.merge) {
    // One part per material: the props are small and draw as one.
    const by = new Map()
    for (const p of parts) { if (!by.has(p.material)) by.set(p.material, []); by.get(p.material).push(p) }
    parts = [...by.entries()].map(([material, ps]) => mergeParts(ps, ps[0].name, material))
  }
  for (const [re, ratio] of spec.decimate ?? []) parts = parts.map(p => re.test(p.name) ? decimate(ROOT, p, ratio) : p)

  const children = parts.map((part, i) => {
    const mat = materials[part.material] ?? materials[0]
    return {
      id: stableId(`${tag}:part:${i}`), name: part.name, type: 'model', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children: [],
      variables: { __materialId: pub(mat.id) }, spawnOnStart: true,
      model: { geometry: geometryJson(part), material: clone(mat.material) },
      animationMappings: null, stateMachine: null, ragdoll: null,
    }
  })
  const usedMaterials = [...new Set(parts.map(p => (materials[p.material] ?? materials[0]).id))]
  const used = materials.filter(m => usedMaterials.includes(m.id))
  const textureIds = [...new Set(used.flatMap(m => m.textureIds))]
  const id = stableId(`${tag}:model`)
  const model = {
    id, name: spec.name,
    nodeJson: { id: stableId(`${tag}:root`), name: spec.name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children, variables: {}, spawnOnStart: true },
    textureIds, materialIds: used.map(m => m.id), thumbnail: '', order: 0,
  }
  return { spec, model, materials: used, textures: textureIds.map(t => textures.get(t)), parts }
}

function mergeParts(parts, name, material) {
  const nv = parts.reduce((s, p) => s + p.positions.length / 3, 0)
  const ni = parts.reduce((s, p) => s + p.indices.length, 0)
  const out = { name, material, positions: new Float32Array(nv * 3), normals: new Float32Array(nv * 3), uvs: new Float32Array(nv * 2), indices: new Uint32Array(ni) }
  let v = 0, i = 0
  for (const p of parts) {
    out.positions.set(p.positions, v * 3); out.normals.set(p.normals, v * 3); out.uvs.set(p.uvs, v * 2)
    for (let k = 0; k < p.indices.length; k++) out.indices[i + k] = p.indices[k] + v
    v += p.positions.length / 3; i += p.indices.length
  }
  return out
}

/** Library entries, textures, the file listing and the scene's references for the four imports. */
function addAssets(bundle, scene, imports) {
  const lib = bundle.libraries
  const vfs = bundle.vfs
  const ref = bundle.manifest.sceneMetas[0].refs
  const folders = new Set(vfs.folders)
  const order = Math.max(-1, ...lib.models.map(m => m.order ?? 0)) + 1
  imports.forEach((imp, i) => {
    imp.model.order = order + i
    lib.models.push(imp.model)
    for (const m of imp.materials) if (!lib.materials.some(x => x.id === m.id)) lib.materials.push(m)
    for (const t of imp.textures) if (!bundle.textures.some(x => x.id === t.id)) bundle.textures.push(t)
    const dir = imp.spec.folder
    for (const f of [dir]) if (!folders.has(f)) { folders.add(f); vfs.folders.push(f) }
    const created = 1794300000000
    vfs.entries.push({ path: `${dir}/${imp.spec.name}.model`, kind: 'model', assetId: imp.model.id, created })
    for (const m of imp.materials) vfs.entries.push({ path: `${dir}/${m.name} (${m.id.slice(0, 4)}).mat`, kind: 'material', assetId: m.id, created })
    for (const t of imp.textures) vfs.entries.push({ path: `${dir}/${t.id}.tex`, kind: 'texture', assetId: t.id, created })
    ref.modelIds.push(imp.model.id)
    for (const m of imp.materials) if (!ref.materialIds.includes(m.id)) ref.materialIds.push(m.id)
    for (const t of imp.textures) if (!ref.textureIds.includes(t.id)) ref.textureIds.push(t.id)
  })
}

// ---------------------------------------------------------------------------------------------------
// Part 2: the scene
// ---------------------------------------------------------------------------------------------------

const findNode = (n, f) => { if (f(n)) return n; for (const c of n.children ?? []) { const r = findNode(c, f); if (r) return r } return null }
const walkNodes = (n, fn) => { fn(n); for (const c of n.children ?? []) walkNodes(c, fn) }

const BODY = { mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1], friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0, simulationMode: 'project', simulationRange: 0, canSleep: false, motionSmoothing: 0 }
const boxShape = () => ({ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] })

function makeBuilders(scene, key) {
  let n = 0
  const id = () => stableId(`${key}:${n++}`)
  const group = (name, children = [], extra = {}) => ({ id: id(), name, type: 'node', position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1], children, variables: {}, spawnOnStart: true, ...extra })
  const empty = (name, type, position, extra = {}) => ({ id: id(), name, type, position: r3v(position), rotation: extra.rotation ?? [0, 0, 0], scale: [1, 1, 1], children: [], variables: {}, spawnOnStart: true, ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'rotation')) })
  /** A static box collider with nothing to draw: the node's scale is the box, the body's shape is the unit box. */
  const collider = (name, [x0, x1], [y0, y1], [z0, z1]) => ({
    ...group(name), position: r3v([(x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2]), scale: r3v([x1 - x0, y1 - y0, z1 - z0]),
    body: { ...BODY, shapes: [boxShape()] },
  })
  return { id, group, empty, collider }
}

/** A collider box from the warehouse's own frame. */
function lbox(b, name, [x0, x1], [y0, y1], [z0, z1]) {
  return b.collider(name, [wx(x0), wx(x1)], [wy(y0), wy(y1)], [wz(z0), wz(z1)])
}

/**
 * A sloped slab (a flight of stairs, a ramp): its top surface runs from `a` to `b` (world x, y, z of the centre line),
 * `width` across, `thick` deep. Rotation is the engine's Euler order (Ry * Rx * Rz): +Z end up at -pitch, then turned.
 */
function slab(b, name, a, c, width, thick) {
  const dx = c[0] - a[0], dz = c[2] - a[2], dy = c[1] - a[1]
  const run = Math.hypot(dx, dz), len = Math.hypot(run, dy)
  const pitch = Math.atan2(dy, run) * 180 / Math.PI
  const yaw = Math.atan2(dx, dz) * 180 / Math.PI
  const q = quat.fromEuler(quat.create(), -pitch, yaw, 0)
  const up = vec3.transformQuat(vec3.create(), [0, 1, 0], q)
  const mid = [(a[0] + c[0]) / 2 - up[0] * thick / 2, (a[1] + c[1]) / 2 - up[1] * thick / 2, (a[2] + c[2]) / 2 - up[2] * thick / 2]
  return { ...b.group(name), position: r3v(mid), rotation: [r3(-pitch), r3(yaw), 0], scale: [width, thick, r3(len)], body: { ...BODY, shapes: [boxShape()] } }
}

function addScene(bundle, scene, imports, lib) {
  const root = scene.scene
  const level = findNode(root, n => n.name === 'Level')
  const props = findNode(level, n => n.name === 'Props')
  const covers = findNode(root, n => n.name === 'Cover Points')
  const spawns = findNode(root, n => n.name === 'Spawn Points')
  const b = makeBuilders(scene, 'fps:wh:scene')
  const bySpec = Object.fromEntries(imports.map(i => [i.spec.name, i]))

  // ----- the ground: the collider reaches under the annex (one surface, so the navmesh stays one piece)
  const ground = findNode(level, n => n.name === 'Ground')
  const gShape = ground.body.shapes[0]
  // Unit box scaled [100, 0.5, 100]: grow it north to z = 104 (depth 154 in all, centre at z 27).
  gShape.depth = 1.54
  gShape.offset = [0, 0, 0.27]
  // What it looks like: a second slab, a hair below the warehouse's own floor, asphalt like the yard.
  const annex = clone(ground); delete annex.body
  annex.id = b.id(); annex.name = 'Ground Annex'; annex.position = [6.5, -0.27, 78]; annex.scale = [44, 0.5, 52]
  annex.children = []
  level.children.push(annex)

  // ----- the north wall: two gaps, one into the courtyard, one onto the apron before the main gate; closed at the sides
  const wall = findNode(level, n => n.name === 'Wall North')
  const seg = (name, x0, x1) => { const w = clone(wall); w.id = b.id(); w.name = name; w.position = [(x0 + x1) / 2, wall.position[1], wall.position[2]]; w.scale = [x1 - x0, wall.scale[1], wall.scale[2]]; return w }
  const wallSegs = [seg('Wall North West', -51, -12), seg('Wall North Mid', 4, 14.5), seg('Wall North East', 26.6, 51)]
  level.children.splice(level.children.indexOf(wall), 1, ...wallSegs)
  const side = (name, x, z0, z1) => { const w = clone(wall); w.id = b.id(); w.name = name; w.position = [x, wall.position[1], (z0 + z1) / 2]; w.scale = [0.6, wall.scale[1], z1 - z0]; return w }
  level.children.push(side('Wall Courtyard West', -14.9, 50.5, 82.6), side('Wall Apron East', 26.9, 50.5, 55.4))

  // ----- the building
  const wh = imports.find(i => i.spec.name === 'abandoned_warehouse')
  const modelRoot = reid(clone(wh.model.nodeJson), 'fps:wh:inst:warehouse')
  modelRoot.name = 'Warehouse Model'
  modelRoot.position = [ORIGIN[0], 0, ORIGIN[2]]
  modelRoot.scale = [SCALE, SCALE, SCALE]
  modelRoot.variables = { __modelId: pub(wh.model.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') }

  // ----- its colliders (local frame, the warehouse's own metres)
  const T = 0.15 // half a wall
  const WALL_TOP = 5.4
  const col = []
  const add = (...a) => col.push(lbox(b, ...a))
  // south face: the main gate is open (6 x 3 local), personnel doors are closed
  add('Hall South Left', [-7.65, 0.21], [0, WALL_TOP], [-15 - T, -15 + T])
  add('Hall South Right', [6.22, 7.65], [0, WALL_TOP], [-15 - T, -15 + T])
  add('Main Gate Lintel', [0.21, 6.22], [3.01, WALL_TOP], [-15 - T, -15 + T])
  add('Hall East Wall', [7.5 - T, 7.5 + T], [0, 6.3], [-15 - T, 18 + T])
  add('Hall North Wall', [-21.85, 7.65], [0, 6.3], [18 - T, 18 + T])
  add('Wing West Wall', [-21.85, -21.55], [0, WALL_TOP], [4 - T, 18 + T])
  add('Hall West Wall', [-7.65, -7.35], [0, WALL_TOP], [-15 - T, 4.27])
  // the wing's south face, three open gates
  for (const [a, c] of [[-21.85, -20.96], [-17.95, -16.66], [-13.66, -12.37], [-9.36, -7.35]]) add('Wing South Pier', [a, c], [0, WALL_TOP], [3.97, 4.27])
  for (const [a, c] of [[-20.96, -17.95], [-16.66, -13.66], [-12.37, -9.36]]) add('Wing Gate Lintel', [a, c], [3.01, WALL_TOP], [3.97, 4.27])
  // the office, up on the walkway level
  add('Office Floor', [-1.25, 7.65], [3.35, 3.5], [9.25, 17.9])
  add('Office West Wall A', [-1.3, -1.05], [3.5, 6.3], [9.25, 10.45])
  add('Office West Wall B', [-1.3, -1.05], [3.5, 6.3], [11.45, 17.9])
  add('Office South Wall', [-1.3, 7.65], [3.5, 6.3], [9.25, 9.55])
  // the walkway: a deck round the stairwell
  add('Walkway West South', [-7.8, -5.54], [3.33, 3.48], [7.13, 12.25])
  add('Walkway West North', [-7.8, -5.54], [3.33, 3.48], [14.78, 17.81])
  add('Walkway Middle', [-5.54, -1.16], [3.33, 3.48], [7.13, 17.81])
  add('Walkway Front', [-1.16, 7.4], [3.33, 3.48], [7.13, 9.41])
  // stoops outside the closed personnel doors
  add('Stoop West', [-9.06, -7.65], [0, 0.76], [-3.95, 1.03])
  add('Stoop South', [-7.05, -2.05], [0, 0.76], [-17.5, -15.15])
  // the stairs: three flights and two landings (the GLB's measured tread tops)
  const stair = (name, x, z0, y0, z1, y1) => slab(b, name, W(x, y0, z0), W(x, y1, z1), 0.92 * SCALE, 0.12)
  col.push(stair('Stair Flight 1', -7.03, 14.93, 0, 13.05, 1.45))
  add('Stair Landing 1', [-7.58, -5.51], [1.3, 1.45], [12.23, 13.05])
  col.push(stair('Stair Flight 2', -6.01, 13.0, 1.45, 13.99, 2.25))
  add('Stair Landing 2', [-7.58, -5.51], [2.1, 2.25], [13.99, 14.78])
  col.push(stair('Stair Flight 3', -7.03, 13.99, 2.25, 12.3, 3.48))

  // ----- what stands in it (a hall of shelves and stock; cover for the fighters)
  const crate = findNode(props ?? level, n => /^(Prop )?Crate/.test(n.name) && n.model)
  const inst = (spec, name, x, z, yawDeg, scale, shape) => {
    const asset = bySpec[spec]
    const node = reid(clone(asset.model.nodeJson), `fps:wh:inst:${name}`)
    node.id = b.id(); node.name = name; node.position = r3v([x, 0, z]); node.rotation = [0, yawDeg, 0]; node.scale = [scale, scale, scale]
    node.variables = { __modelId: pub(asset.model.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') }
    node.body = { ...BODY, shapes: [{ type: 'box', width: shape[0], height: shape[1], depth: shape[2], offset: [0, shape[1] / 2, 0], rotation: [0, 0, 0] }] }
    return node
  }
  const plain = (name, x, y, z, yaw, size, color, opt = {}) => {
    const c = clone(crate); c.id = b.id(); c.name = name; c.position = r3v([x, y, z]); c.rotation = [0, yaw, 0]; c.scale = r3v(size)
    if (c.variables) delete c.variables.__materialId
    c.model.material.baseColor = color; c.model.material.roughness = opt.rough ?? 0.85; c.model.material.metallic = opt.metal ?? 0
    if (opt.emissive) { c.model.material.emissiveFactor = opt.emissive; c.model.material.emissiveIntensity = opt.emissiveIntensity ?? 3; c.model.material.config = { ...c.model.material.config, castShadow: false }; delete c.body }
    return c
  }
  const dress = []
  const shelfW = 1.31, shelfD = 0.54
  // shelving rows along the hall's west and east walls and across the wing
  const shelf = (x, z, yaw) => dress.push(inst('utility_shelves', `Prop Shelf ${String(dress.length + 1).padStart(2, '0')}`, x, z, yaw, 1, [shelfW, 2.1, shelfD]))
  for (let i = 0; i < 6; i++) shelf(wx(-7.35) + 0.36, wz(-12.2 + i * 2.0), 90)
  for (let i = 0; i < 5; i++) shelf(wx(7.35) - 0.36, wz(-12.2 + i * 2.0), -90)
  for (let i = 0; i < 4; i++) shelf(wx(-20.2 + i * 2.5), wz(17.85) - 0.36, 180)
  // cement, tanks and stock as cover in the open floor
  const piles = [[-3, -9], [3.4, -6.5], [-2.2, -1.2], [4.2, 1.4], [-16.5, 8.5], [-11.2, 12.2]]
  piles.forEach(([x, z], i) => dress.push(inst('cement_bags_low-poly', `Prop Cement ${String(i + 1).padStart(2, '0')}`, wx(x), wz(z), i * 47 % 180, 0.9, [1.97 * 0.9, 1.0 * 0.9, 1.85 * 0.9])))
  const tanks = [[2.0, -12.6], [-4.6, 2.6], [-18.8, 6.5], [4.8, 6.0]]
  tanks.forEach(([x, z], i) => dress.push(inst('propane_and_gas_tanks', `Prop Tanks ${String(i + 1).padStart(2, '0')}`, wx(x), wz(z), i * 71 % 180, 0.7, [3.0 * 0.7, 1.4 * 0.7, 3.0 * 0.7])))
  const stock = [[-1.2, -13, 8], [0.0, -12.2, -14], [-0.6, -12.7, 40], [5.2, -2.8, 20], [-9.5, 6.8, 0], [-19.8, 14.8, 70], [-16.6, 16.5, 12], [1.6, 4.4, 33]]
  stock.forEach(([x, z, yaw], i) => dress.push(plain(`Prop Crate ${String(i + 1 + 100).slice(1)}`, wx(x), 0.45, wz(z), yaw, [0.9, 0.9, 0.9], [0.5, 0.38, 0.22], { rough: 0.9 })))
  // oil drums and pallets
  for (let i = 0; i < 5; i++) dress.push(plain(`Prop Drum ${String(i + 1 + 100).slice(1)}`, wx(-19 + (i % 3) * 0.55), 0.45, wz(16 - Math.floor(i / 3) * 0.55 - 3.2), i * 40, [0.58, 0.9, 0.58], [0.5, 0.08, 0.06], { rough: 0.5, metal: 0.55 }))

  // ----- lights: hanging fixtures; a flickering one over the walkway
  const lights = []
  let lampN = 0
  const lamp = (name, x, y, z, lumens, range, shadows, flicker) => {
    const [px, py, pz] = W(x, y, z)
    const node = b.empty(name, 'light', [px, py, pz], {
      lightType: 'point', castShadows: !!shadows, bake: true,
      light: { unit: 'photometric', color: [1, 0.86, 0.66], intensity: lumens, range, sourceRadius: 0.2, legacyFalloff: false, ...(flicker ? { flickerAmount: 0.35, flickerSpeed: 9 } : {}) },
    })
    lights.push(node)
    lights.push(plain(`Prop Lamp ${String(++lampN + 100).slice(1)}`, px, py + 0.12, pz, 0, [1.1, 0.12, 0.28], [0.9, 0.8, 0.6], { emissive: [1, 0.82, 0.55] }))
  }
  for (const z of [-11, -4, 3]) for (const x of [-4, 4]) lamp(`Hall Light ${x < 0 ? 'W' : 'E'}${z}`, x, 4.7, z, 7000, 20, x > 0 && z === -4)
  for (const [x, z] of [[-16, 8], [-12, 14], [-19, 15]]) lamp(`Wing Light ${x},${z}`, x, 4.7, z, 6000, 16, x === -12)
  lamp('Under Office Light', 3, 2.9, 13, 4500, 12, false)
  lamp('Office Light S', 3, 5.2, 11.5, 4000, 9, false)
  lamp('Office Light N', 3, 5.2, 15.8, 4000, 9, false)
  lamp('Walkway Light', -4.4, 4.5, 10, 3500, 11, false, true)

  // ----- volumes: GI, probes and exposure, one set per room
  const vols = []
  const gi = (name, c, size, probes, rays = 128) => {
    const node = b.empty(name, 'giVolume', c, { giVolume: { size: r3v(size), probeCounts: probes, rays, maxRayDistance: 40, captureResolution: 32, includeGrass: false, blendDistance: 1, intensity: 1, normalBias: 0.1, viewBias: 0.4, multiBounce: true, additive: false, enabled: true } })
    node.giVolume.bakeId = stableId('fps:gi:' + node.id)
    vols.push(node)
  }
  const hallC = W(0, 2.65, 1.5), hallS = [SCALE * 15.2, wy(5.3), SCALE * 33.2]
  gi('GI Hall', hallC, hallS, [10, 4, 22])
  gi('GI Wing', W(-14.6, 2.65, 11.05), [SCALE * 14.2, wy(5.3), SCALE * 13.9], [10, 4, 10])
  gi('GI Office', W(3.1, 4.9, 13.6), [SCALE * 8.7, wy(2.8), SCALE * 8.5], [6, 3, 6])
  gi('GI Courtyard', [6.2, 4.4, 66.5], [43, 8.8, 31.5], [8, 3, 6], 64)
  const probe = (name, c, size, res = 64) => vols.push(b.empty(name, 'lightProbe', c, { resolution: res, mode: 'baked', updateFrequency: 1, intensity: 1, size: r3v(size), blendDistance: 1.5, affectsLighting: true, affectsReflections: true, boxProjection: true }))
  probe('Probe Hall South', W(0, 2.65, -6.5), [SCALE * 15, wy(5.3), SCALE * 17])
  probe('Probe Hall North', W(0, 2.65, 10), [SCALE * 15, wy(5.3), SCALE * 16])
  probe('Probe Wing', W(-14.6, 2.65, 11.05), [SCALE * 14.2, wy(5.3), SCALE * 13.9])
  probe('Probe Office', W(3.1, 4.9, 13.6), [SCALE * 8.7, wy(2.8), SCALE * 8.5])
  // The scene's own auto-exposure holds its floor at EV 8 for the sun: a room has to be allowed to go dark.
  const exposure = (name, c, size, priority, comp) => vols.push(b.empty(name, 'exposureVolume', c, {
    exposureVolume: { size: r3v(size), blendDistance: 3, priority, enabled: true, overrides: { exposureMinEV: 0, exposureMaxEV: 12, exposureCompensation: comp, exposureSpeedUp: 2.5, exposureSpeedDown: 1.5 } },
  }))
  exposure('Exposure Hall', hallC, [hallS[0] + 0.4, hallS[1] + 0.4, hallS[2] + 0.4], 1, 0.5)
  exposure('Exposure Wing', W(-14.6, 2.65, 11.05), [SCALE * 14.2 + 0.4, wy(5.3) + 0.4, SCALE * 13.9 + 0.4], 1, 0.5)
  exposure('Exposure Office', W(3.1, 4.9, 13.6), [SCALE * 8.7, wy(2.8), SCALE * 8.5], 2, 0.8)

  // ----- spawn and cover points
  const spawn1 = spawns.children[0]
  const spawnAt = (x, z, lookX, lookZ) => {
    const s = clone(spawn1); s.id = b.id(); s.name = `Spawn ${spawns.children.length + 1}`
    s.position = r3v([x, 0.05, z]); s.rotation = [0, r3(Math.atan2(lookX - x, lookZ - z) * 180 / Math.PI), 0]
    s.variables = { ...s.variables, __overrides: { type: 'string', value: JSON.stringify({ '': { name: s.name } }), access: 'private' } }
    spawns.children.push(s)
  }
  spawnAt(wx(-1.5), wz(-9.5), wx(0), wz(5))
  spawnAt(wx(2.0), wz(2.5), wx(0), wz(-8))
  spawnAt(wx(-14), wz(8.5), wx(-8), wz(0))
  spawnAt(wx(-15), wz(14.5), wx(-8), wz(6))
  spawnAt(-30, 44, 0, 20)
  spawnAt(32, 20, 0, 20)
  const cover1 = covers.children[0]
  const coverAt = (x, z) => { const c = clone(cover1); c.id = b.id(); c.position = r3v([x, 0.05, z]); covers.children.push(c) }
  for (const [x, z] of [[-5.6, -10], [-5.6, -4], [-5.6, 1.5], [5.6, -10], [5.6, -4], [5.6, 1.5], [-14, 16], [-8.5, 12.5], [-3.7, -9.6], [4.9, -6.1], [-1.8, -2.5], [3.6, 2.8], [-17.5, 8.5], [-11, 10.8], [-4.4, 3.4], [2.3, -13.9]])
    coverAt(wx(x), wz(z))

  // ----- the group
  const whGroup = b.group('Warehouse', [
    modelRoot,
    b.group('Warehouse Colliders', col),
    b.group('Warehouse Props', dress),
    b.group('Warehouse Lights', lights),
    b.group('Warehouse Volumes', vols),
  ])
  root.children.splice(root.children.indexOf(level) + 1, 0, whGroup)

  // ----- real props where the placeholders stood
  swapRealProps(b, root, props, bySpec, scene)
  clearLanes(props, covers)
}

/** Placeholders in the two lanes into the annex (the courtyard and the apron) would block the openings. */
function clearLanes(props, covers) {
  const inLane = (n) => n.position[2] >= 44.5 && ((n.position[0] > -14 && n.position[0] < 5.8) || (n.position[0] > 13 && n.position[0] < 28))
  props.children = props.children.filter(n => !inLane(n))
  covers.children = covers.children.filter(n => !inLane(n))
}

/** Cement bags for the sandbag walls, tank sets for the fuel tanks and a third of the drum clusters. */
function swapRealProps(b, root, props, bySpec, scene) {
  const cement = bySpec['cement_bags_low-poly'], tanks = bySpec['propane_and_gas_tanks']
  const replace = (matcher, spec, scale, shape, label) => {
    const out = []
    let k = 0
    for (const n of props.children) {
      if (!matcher(n)) { out.push(n); continue }
      const node = reid(clone(spec.model.nodeJson), `fps:wh:swap:${label}:${k}`)
      node.id = b.id(); node.name = `Prop ${label} ${String(++k + 100).slice(1)}`
      node.position = [n.position[0], 0, n.position[2]]; node.rotation = [0, n.rotation[1], 0]; node.scale = [scale, scale, scale]
      node.variables = { __modelId: pub(spec.model.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') }
      node.body = { ...BODY, shapes: [{ type: 'box', width: shape[0], height: shape[1], depth: shape[2], offset: [0, shape[1] / 2, 0], rotation: [0, 0, 0] }] }
      out.push(node)
    }
    props.children = out
    return k
  }
  const sandbags = replace(n => /^Prop Sandbag Wall/.test(n.name), cement, 0.85, [1.97 * 0.85, 0.85, 1.85 * 0.85], 'Cement')
  const tankSets = replace(n => /^Prop Fuel Tank/.test(n.name), tanks, 0.8, [2.4, 1.12, 2.4], 'Tanks')
  // drum clusters: keep the first of every three drums' worth, replace the rest of the cluster with one tank set
  const drums = props.children.filter(n => /^Prop Drum/.test(n.name))
  let swapped = 0
  const taken = new Set()
  drums.forEach((d, i) => {
    if (taken.has(d)) return
    const near = drums.filter(o => !taken.has(o) && Math.hypot(o.position[0] - d.position[0], o.position[2] - d.position[2]) < 1.8)
    near.forEach(o => taken.add(o))
    if (swapped < 3 && near.length >= 3) { swapped++; near.forEach(o => { o.__drop = true }); d.__swap = near }
  })
  const swappedAt = []
  props.children = props.children.filter(n => { if (n.__drop) { if (n.__swap) swappedAt.push(n.position); return false } return true })
  swappedAt.forEach((p, i) => {
    const node = reid(clone(tanks.model.nodeJson), `fps:wh:swap:drumtanks:${i}`)
    node.id = b.id(); node.name = `Prop Tanks ${String(i + 11 + 100).slice(1)}`
    node.position = [p[0], 0, p[2]]; node.rotation = [0, i * 53, 0]; node.scale = [0.6, 0.6, 0.6]
    node.variables = { __modelId: pub(tanks.model.id), __modelBaseTRS: pub('[0,0,0,0,0,0,1,1,1]') }
    node.body = { ...BODY, shapes: [{ type: 'box', width: 1.8, height: 0.84, depth: 1.8, offset: [0, 0.42, 0], rotation: [0, 0, 0] }] }
    props.children.push(node)
  })
  console.log(`warehouse: ${sandbags} sandbag walls -> cement, ${tankSets} fuel tanks + ${swapped} drum clusters -> tank sets`)
}

// ---------------------------------------------------------------------------------------------------
// Part 3: the match and the bots
// ---------------------------------------------------------------------------------------------------

function fixMatch(bundle, scene) {
  const root = scene.scene
  const botNames = ['FPS Bot', 'FPS Vanguard', 'FPS Raider', 'FPS Swat']
  // each bot comes back as itself
  for (const t of bundle.libraries.templates) {
    if (botNames.includes(t.name) && t.nodeJson?.scriptVars) t.nodeJson.scriptVars.respawnTemplate = t.name
  }
  walkNodes(root, n => { if (botNames.includes(n.name) && n.scriptVars && 'respawnTemplate' in n.scriptVars) n.scriptVars.respawnTemplate = n.name })
  const gm = findNode(root, n => n.name === 'FPS Game Manager')
  if (gm?.scriptVars) {
    const alias = { oneVsThree: 'oneVsAll', team2v2: 'teamDeathmatch' }
    gm.scriptVars.gameType = alias[gm.scriptVars.gameType] ?? gm.scriptVars.gameType
    gm.scriptVars.scoreLimit = 30
  }
}

// ---------------------------------------------------------------------------------------------------
// Part 4: the navmesh
// ---------------------------------------------------------------------------------------------------

/** Connected pieces of a baked mesh (regions sharing an edge), as an array of region lists. */
function components(data) {
  const { vertices: v, counts } = data
  const key = (i) => `${Math.round(v[i * 3] * 1000)},${Math.round(v[i * 3 + 1] * 1000)},${Math.round(v[i * 3 + 2] * 1000)}`
  const starts = []
  let at = 0
  for (const c of counts) { starts.push(at); at += c }
  const parent = Array.from(counts, (_, i) => i)
  const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a] } return a }
  const edge = new Map()
  counts.forEach((c, r) => {
    for (let k = 0; k < c; k++) {
      const a = key(starts[r] + k), d = key(starts[r] + (k + 1) % c)
      const e = a < d ? a + '|' + d : d + '|' + a
      const other = edge.get(e)
      if (other === undefined) edge.set(e, r)
      else parent[find(r)] = find(other)
    }
  })
  const groups = new Map()
  counts.forEach((_, r) => { const g = find(r); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(r) })
  return { groups: [...groups.values()], starts, counts }
}

/**
 * Bake the whole map, then keep the main piece and every piece that can be linked to it (a stair, a ramp, a deck, a walkway):
 * a pair of vertices within a step of each other becomes an off-mesh link. Everything else (roofs, crate tops, the sealed
 * strips behind the walls) goes, so a bot is never given a patrol point it cannot reach.
 */
function bakeNav(scene) {
  const root = scene.scene
  const nav = findNode(root, n => n.type === 'navMesh')
  const baker = headlessNavBaker(ROOT)
  // The yard's ground is one box. Carving a few hundred props out of two huge triangles leaves slivers that each cut
  // splits again (700,000 regions, a 42 MB scene); in tiles four metres across a cut stays where it is made. The ground
  // is baked as those tiles, and left out of the gather (its solid lies under its own plane, so it carves nothing).
  const ground = findNode(root, n => n.name === 'Ground' && n.model)
  const gz = ground.body.shapes[0]
  const x0 = ground.position[0] - ground.scale[0] / 2, x1 = ground.position[0] + ground.scale[0] / 2
  const z0 = ground.position[2] + ground.scale[2] * (gz.offset[2] - gz.depth / 2), z1 = ground.position[2] + ground.scale[2] * (gz.offset[2] + gz.depth / 2)
  const tiles = []
  const TILE = 4
  for (let x = x0; x < x1 - 1e-6; x += TILE) for (let z = z0; z < z1 - 1e-6; z += TILE) {
    const xe = Math.min(x + TILE, x1), ze = Math.min(z + TILE, z1)
    tiles.push(x, 0, z, xe, 0, ze, xe, 0, z, x, 0, z, x, 0, ze, xe, 0, ze)
  }
  const groundSoup = { positions: new Float32Array(tiles), indices: new Uint32Array(0) }
  const { surface, obstacles } = baker.gather(root, { skip: (n) => n.type === 'character' || n === ground })
  nav.position = [0, 12, 26]
  nav.size = [112, 40, 160]
  const volume = { position: nav.position, size: nav.size }
  const r = baker.bakeInto(nav, { surface, soups: [groundSoup], obstacles, volume })
  const data = r.data
  const { groups, starts, counts } = components(data)
  const v = data.vertices
  const vert = (region, k) => [v[(starts[region] + k) * 3], v[(starts[region] + k) * 3 + 1], v[(starts[region] + k) * 3 + 2]]
  // the yard: the piece holding the player's start
  const seed = [15.7, 0.05, 37.9]
  let main = -1, best = Infinity
  groups.forEach((g, gi) => { for (const reg of g) { const p = vert(reg, 0); const d = Math.hypot(p[0] - seed[0], p[2] - seed[2]); if (d < best && Math.abs(p[1] - seed[1]) < 0.5) { best = d; main = gi } } })
  // Vertices of every piece but the yard's, in a grid a step wide: a pair of vertices of two pieces in one neighbourhood is a
  // candidate link (the yard itself has hundreds of thousands, so the pieces are compared through the grid, not to each other).
  const H = 1.3, V = 0.55
  const cell = H
  const cellOf = (p) => [Math.floor(p[0] / cell), Math.floor(p[1] / V), Math.floor(p[2] / cell)]
  const grid = new Map()
  groups.forEach((g, gi) => {
    if (gi === main || g.length < 2) return
    for (const reg of g) for (let k = 0; k < counts[reg]; k++) {
      const p = vert(reg, k), c = cellOf(p), id = `${c[0]},${c[1]},${c[2]}`
      let list = grid.get(id); if (!list) grid.set(id, list = [])
      list.push({ gi, p })
    }
  })
  const pair = new Map()
  const consider = (gi, p) => {
    const c = cellOf(p)
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      const list = grid.get(`${c[0] + dx},${c[1] + dy},${c[2] + dz}`)
      if (!list) continue
      for (const o of list) {
        if (o.gi === gi) continue
        const dyv = Math.abs(o.p[1] - p[1]); if (dyv > V) continue
        const dh = Math.hypot(o.p[0] - p[0], o.p[2] - p[2]); if (dh > H) continue
        const key = gi < o.gi ? `${gi}|${o.gi}` : `${o.gi}|${gi}`
        const d = dh + dyv
        const had = pair.get(key)
        if (!had || d < had.d) pair.set(key, { d, a: gi, b: o.gi, from: p, to: o.p })
      }
    }
  }
  groups.forEach((g, gi) => { if (gi === main || g.length >= 2) for (const reg of g) for (let k = 0; k < counts[reg]; k++) consider(gi, vert(reg, k)) })
  // Kruskal from the shortest: a link only where it joins two pieces not yet joined; what ends up with the yard stays
  const uf = groups.map((_, i) => i)
  const top = (i) => { while (uf[i] !== i) { uf[i] = uf[uf[i]]; i = uf[i] } return i }
  const links = []
  for (const c of [...pair.values()].sort((x, y) => x.d - y.d)) {
    if (top(c.a) === top(c.b)) continue
    uf[top(c.a)] = top(c.b)
    links.push({ name: `Link ${links.length + 1}`, from: r3v(c.from), to: r3v(c.to), cost: r3(c.d + 2), bidirectional: true })
  }
  const kept = new Set(groups.map((_, gi) => gi).filter(gi => top(gi) === top(main)))
  // rebuild the mesh from the kept regions
  const keepRegions = groups.flatMap((g, gi) => kept.has(gi) ? g : []).sort((a, b) => a - b)
  const outCounts = Uint32Array.from(keepRegions.map(rg => counts[rg]))
  const outVerts = new Float32Array(outCounts.reduce((s, c) => s + c, 0) * 3)
  let o = 0
  for (const rg of keepRegions) for (let k = 0; k < counts[rg]; k++) { outVerts.set(vert(rg, k), o); o += 3 }
  const serial = baker.mesh.serializeNavMeshData({ vertices: outVerts, counts: outCounts })
  nav.navMesh = serial
  nav.links = links
  console.log(`warehouse: navmesh ${counts.length} regions in ${groups.length} pieces -> ${keepRegions.length} regions in ${kept.size} pieces, ${links.length} links`)
}

// ---------------------------------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------------------------------

let hashes = null
function recomputeHashes(bundle, scene) {
  hashes ??= moduleRegistry()(path.join(ROOT, 'applications', 'editor', 'src', 'utils', 'assetHash.ts'))
  const libs = { material: 'materials', model: 'models', template: 'templates', script: 'scripts', aiBrain: 'aiBrains', terrainMaterial: 'terrainMaterials', tileset: 'tilesets' }
  const out = {}
  for (const [kind, lib] of Object.entries(libs)) for (const a of bundle.libraries[lib] ?? []) out[hashes.assetHashKey(kind, a.id)] = hashes.hashAsset(a)
  scene.assetHashes = out
}

export async function applyWarehouse(bundle) {
  const scene = Object.values(bundle.scenes)[0]
  const root = scene.scene
  if (findNode(root, n => n.name === 'Warehouse' && n.type === 'node')) { fixMatch(bundle, scene); return }
  const missing = MODELS.filter(m => !fs.existsSync(path.join(BUILD, m.file)))
  if (missing.length) { console.warn(`warehouse: ${missing.map(m => m.file).join(', ')} not in build/ - the annex is skipped`); fixMatch(bundle, scene); return }

  const started = Date.now()
  const imports = MODELS.map(importGlb)
  addAssets(bundle, scene, imports)
  addScene(bundle, scene, imports, bundle.libraries)
  fixMatch(bundle, scene)
  bakeNav(scene)
  recomputeHashes(bundle, scene)
  console.log(`warehouse: added in ${((Date.now() - started) / 1000).toFixed(0)} s`)
}
