// What the FPS generator's pieces share: ids, the script/material/texture registries, primitive props, node and
// template helpers, particle-system helpers, UI helpers. Everything here is a function of nothing but the
// repository (no state between runs), so the project comes out byte-identical every time.
//
// The shapes are the editor's own: scripts are reflected by its parser, templates are split and diffed by its
// template code, a scene's asset hashes are its hashAsset (see tools/exampleKit/*). Where a node shape is
// needed that this repo's generators already make (a character, a camera rig), the souls seed scene has it.

import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { TextureSet, loadScriptReflector, node, readJson, stableId as nsId, uiNode, vars } from '../exampleKit/bundle.mjs'
import { editorModules } from '../exampleKit/fbxImport.mjs'
import { moduleRegistry } from '../exampleKit/tsLoader.mjs'

export { node, uiNode, vars, readJson }

export const HERE = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(HERE, '..', '..')
export const BUILD = path.join(ROOT, 'build')
export const PREPARED = path.join(BUILD, 'fps_prepared')
export const SCRIPTS = path.join(ROOT, 'examples', 'scripts')
export const SEED = path.join(ROOT, 'tools', 'soulsDemo', 'seed')

export const CREATED_AT = 1790000000000
export const PROJECT_NAME = 'Firing Line'

/** Every id this project mints, namespaced so nothing can collide with the other examples'. */
export const stableId = (key) => nsId('fps:' + key)
export const clone = (x) => JSON.parse(JSON.stringify(x))
export const round3 = (v) => Math.round(v * 1000) / 1000

export const reflect = loadScriptReflector(ROOT)
export const { storeSkin, loadSkin } = editorModules(ROOT)

const engine = moduleRegistry({ uuid: { v4: () => 'unused' }, '/bvh': { BVH: class {} } })
export const { Geometry } = engine(path.join(ROOT, 'src', 'core', 'geometry.ts'))
export const { makeModule, parseParticleSystem } = engine(path.join(ROOT, 'src', 'particles', 'particleSystemAsset.ts'))
export const { defaultRenderSettings } = engine(path.join(ROOT, 'src', 'particles', 'particleModules.ts'))
export const { regenerateNodeIds, cloneNodeJson } = engine(path.join(ROOT, 'src', 'core', 'scene', 'nodeJson.ts'))
export const { hashAsset, assetHashKey } = moduleRegistry()(path.join(ROOT, 'applications', 'editor', 'src', 'utils', 'assetHash.ts'))
export const { diffTemplate, materializeVariant } = moduleRegistry()(path.join(ROOT, 'applications', 'editor', 'src', 'utils', 'templateVariants.ts'))
export const { buildAnimationFieldAsset, toRuntimeField } = moduleRegistry({
  cleo: { Node: class {}, ModelNode: class {}, AnimatedModel: class {} },
  './ids': { cryptoRandomId: () => { throw new Error('ids must be stable in a generator') } },
})(path.join(ROOT, 'applications', 'editor', 'src', 'utils', 'animationFields.ts'))

export const textures = new TextureSet(null)

// =====================================================================================================
// Scripts
// =====================================================================================================

/** [asset name, file, base node type]. A script asset is named after its FILE: the explorer path is the import path. */
export const SCRIPT_FILES = [
  ['FpsShared', 'FpsShared', 'node'],
  ['FpsCombatant', 'FpsCombatant', 'character'],
  ['FpsGameManager', 'FpsGameManager', 'node'],
  ['FpsPlayer', 'FpsPlayer', 'character'],
  ['FpsBot', 'FpsBot', 'character'],
  ['FpsHud', 'FpsHud', 'uiRoot'],
  ['FpsFx', 'FpsFx', 'node'],
  ['FpsDecal', 'FpsDecal', 'node'],
  ['FpsTracer', 'FpsTracer', 'node'],
  ['FpsMarker', 'FpsMarker', 'node'],
]

const readScript = (file) => fs.readFileSync(path.join(SCRIPTS, `${file}.ts`), 'utf8')

/** A class script's fields including the ones it inherits from base-class scripts, base first. */
function resolveVariables(file, seen = new Set()) {
  const source = readScript(file)
  const own = reflect(source)
  const ext = /export\s+default\s+class\s+\w+\s+extends\s+(\w+)/.exec(source)
  const imp = ext && new RegExp(`import\\s+${ext[1]}\\s+from\\s+['"](?:\\./|@/(?:[^'"]*/)?)(\\w+)['"]`).exec(source)
  if (!imp || seen.has(imp[1])) return own
  seen.add(file)
  const merged = new Map()
  for (const v of [...resolveVariables(imp[1], seen), ...own]) merged.set(v.name, v)
  return [...merged.values()]
}

export const scripts = (() => {
  const assets = []
  const byFile = new Map()
  for (const [name, file, baseType] of SCRIPT_FILES) {
    const source = readScript(file)
    const kind = /^\s*export\s+default\s+class\b/m.test(source) ? 'class' : 'module'
    const asset = { id: stableId(`script:${file}`), name, baseType, source, kind, variables: kind === 'module' ? [] : resolveVariables(file) }
    assets.push(asset)
    byFile.set(file, asset)
  }
  return { assets, byFile }
})()

/** Attach a script: the library link and the inline source, exactly as the editor writes it. */
export function withScript(target, file, scriptVars = {}) {
  const asset = scripts.byFile.get(file)
  if (!asset) throw new Error(`no script asset for ${file}`)
  const known = new Set(asset.variables.map(v => v.name))
  for (const key of Object.keys(scriptVars))
    if (!known.has(key)) throw new Error(`${file} has no field "${key}" (setting it on ${target.name})`)
  target.variables = { ...(target.variables ?? {}), ...vars({ __scriptId: asset.id }) }
  target.script = asset.source
  target.scriptVars = scriptVars
  return target
}

// =====================================================================================================
// The seed scene: node shapes this repo already makes (character, camera rig, light, sky...)
// =====================================================================================================

export const seedScene = readJson(path.join(SEED, 'scene.json'))

export function sourceNode(name) {
  const walk = (n) => n.name === name ? n : (n.children ?? []).reduce((a, c) => a ?? walk(c), null)
  const found = walk(seedScene.scene)
  if (!found) throw new Error(`the seed scene has no node named "${name}"`)
  return clone(found)
}

// =====================================================================================================
// Materials
// =====================================================================================================

export const materials = []

export function pbr(baseColor, extra = {}) {
  const glows = (extra.emissive ?? [0, 0, 0]).some(c => c > 0)
  return {
    type: 'pbr', baseColor, metallic: extra.metallic ?? 0, roughness: extra.roughness ?? 0.85, reflectance: extra.reflectance ?? 0.5,
    opacity: extra.opacity ?? 1,
    emissiveFactor: extra.emissive ?? [0, 0, 0], emissiveIntensity: extra.emissiveIntensity ?? 1,
    ...(glows ? { emissiveExposureWeight: extra.emissiveExposureWeight ?? 0.1 } : {}),
    textures: extra.textures ?? {},
    ...(extra.uv ?? {}),
    ...(extra.alphaCutoff ? { alphaCutoff: extra.alphaCutoff } : {}),
    config: { side: extra.side ?? 'front', wireframe: false, transparent: !!extra.transparent, castShadow: extra.castShadow ?? true, probeable: true },
  }
}

export function material(key, name, mat, textureIds = []) {
  const id = stableId(`material:${key}`)
  materials.push({ id, name, material: mat, textureIds: [...new Set(textureIds)] })
  return id
}

export const matJson = (id) => clone(materials.find(m => m.id === id).material)

/** A texture file from build/fps_prepared/textures, registered once under a stable id. */
export function texFile(file, { mime, config = {} } = {}) {
  const id = stableId(`texture:${file}`)
  const ext = path.extname(file).toLowerCase()
  return textures.add(id, path.join(PREPARED, 'textures', file), { wrapping: 'repeat', mipMap: true, ...config }, mime ?? (ext === '.png' ? 'image/png' : 'image/jpeg'))
}

// =====================================================================================================
// Primitive props
// =====================================================================================================

const geometryCache = new Map()
export function geometryOf(shape) {
  if (typeof shape === 'object') return shape
  if (geometryCache.has(shape)) return geometryCache.get(shape)
  const g = shape === 'box' ? Geometry.Cube(1, 1, 1)
    : shape === 'cylinder' ? Geometry.Cylinder(16, 0.5, 1)
      : shape === 'sphere' ? Geometry.Sphere(16, 0.5)
        : shape === 'ramp' ? Geometry.Ramp(1, 1, 1)
          : null
  if (!g) throw new Error(`no primitive "${shape}"`)
  const json = {
    positions: Array.from(g.positions), normals: Array.from(g.normals), tangents: Array.from(g.tangents),
    bitangents: Array.from(g.bitangents), texCoords: Array.from(g.uvs), indices: Array.from(g.indices),
  }
  geometryCache.set(shape, json)
  return json
}

export function staticBody(shape) {
  const shapes = shape === 'cylinder'
    ? [{ type: 'cylinder', radius: 0.5, height: 1, numSegments: 12, offset: [0, 0, 0], rotation: [0, 0, 0] }]
    : [{ type: 'box', width: 1, height: 1, depth: 1, offset: [0, 0, 0], rotation: [0, 0, 0] }]
  return {
    mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
    friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0,
    motionSmoothing: 0, shapes,
  }
}

/** A primitive model node: unit geometry scaled by the node, so a unit collider scales with it. */
export function prop(key, name, shape, materialId, { position = [0, 0, 0], scale = [1, 1, 1], rotation = [0, 0, 0], solid = false, children = [], extra = {} } = {}) {
  const n = node(name, 'model', {
    id: stableId(`prop:${key}`), position, rotation, scale, children,
    variables: vars({ __materialId: materialId }),
    model: { geometry: geometryOf(shape), material: matJson(materialId) },
    ...extra,
  })
  if (solid) n.body = staticBody(shape)
  return n
}

export const group = (key, name, children, extra = {}) => node(name, 'node', { id: stableId(`group:${key}`), children, ...extra })

// =====================================================================================================
// Sounds: silent cue nodes a project fills in (there is no sound in the assets this was made from)
// =====================================================================================================

/** A `Sounds` group of empty SoundNodes, one per cue name. */
export function soundsGroup(key, cues, { spatial = false } = {}) {
  const sound = (name) => node(name, 'sound', {
    id: stableId(`${key}:sound:${name}`),
    sound: spatial
      ? { mode: 'spatial', sampleId: null, volume: 1, loopMode: 'inherit', playOnStart: false, distanceModel: 'inverse', refDistance: 3, maxDistance: 80, rolloffFactor: 1 }
      : { mode: 'ambient', sampleId: null, volume: 1, loopMode: 'inherit', playOnStart: false, distanceModel: 'inverse', refDistance: 1, maxDistance: 100, rolloffFactor: 1 },
  })
  return group(`${key}:sounds`, 'Sounds', cues.map(sound))
}

// =====================================================================================================
// Particle systems (.vfx)
// =====================================================================================================

export const particleSystems = []
const seedOf = (key) => parseInt(stableId('seed:' + key).slice(0, 6), 16)
export const mod = (type, params = {}) => { const m = makeModule(type); Object.assign(m.params, params); return m }
export function emitter(key, name, fields) {
  const base = {
    id: stableId(`emitter:${key}`), name, enabled: true, capacity: 512, simSpace: 'world',
    duration: 5, looping: true, prewarm: false, startDelay: 0, seed: seedOf(key),
    spawn: [], init: [], update: [], render: defaultRenderSettings(),
  }
  return { ...base, ...fields, render: { ...base.render, ...(fields.render ?? {}) } }
}

/** Lux on a surface that renders white at exposure 1 (src/graphics/lighting.ts). */
export const REFERENCE_ILLUMINANCE = 78643.2
const GLOW_EXPOSURE_WEIGHT = 0.1
const exposureAtEV = ev => REFERENCE_ILLUMINANCE / (1.2 * 2 ** ev)
/** The luminance an additive glow needs to read at `ev`'s exposure (the effects are tuned for daylight, EV 13). */
export const GLOW_LUMINANCE = exposureAtEV(13) ** (GLOW_EXPOSURE_WEIGHT - 1)

function physicalEmitter(e, luminance = GLOW_LUMINANCE) {
  if (e.render?.lit) return e
  if ((e.render?.blend ?? 'alpha') !== 'additive') return { ...e, render: { ...e.render, lit: true } }
  const tidy = v => +v.toPrecision(3)
  return {
    ...e,
    init: e.init.map(m => (m.type === 'color' ? { ...m, params: { ...m.params, intensity: tidy((m.params.intensity ?? 1) * luminance) } } : m)),
  }
}

export function vfx(key, name, emitters, bounds = { center: [0, 1, 0], extents: [2, 2, 2] }, lod = undefined, luminance = GLOW_LUMINANCE) {
  const system = parseParticleSystem({ version: 1, emitters: emitters.map(e => physicalEmitter(e, luminance)), bounds, lod })
  const asset = { id: stableId(`vfx:${key}`), name, system }
  particleSystems.push(asset)
  return asset
}

export const fade = (peak = 1) => ({ color: [{ t: 0, c: [1, 1, 1] }, { t: 1, c: [1, 1, 1] }], alpha: [{ t: 0, a: 0 }, { t: 0.15, a: peak }, { t: 0.7, a: peak }, { t: 1, a: 0 }] })
export const burst = (count) => mod('spawnBurst', { bursts: [{ time: 0, count, cycles: 1, interval: 1, probability: 1 }] })
export const bounceOff = (restitution, friction, extra = {}) =>
  mod('collision', { bodies: true, depth: true, radius: 1, restitution, friction, lifetimeLoss: 0, ...extra })

export function particles(key, name, asset, { position = [0, 0, 0], playOnStart = true, scale = [1, 1, 1], rotation = [0, 0, 0] } = {}) {
  return node(name, 'particleSystem', {
    id: stableId(`particles:${key}`), position, scale, rotation,
    particleSystem: { system: clone(asset.system), particleSystemId: asset.id, playOnStart, simulationSpeed: 1, spawnRateScale: 1, tint: [1, 1, 1, 1] },
  })
}

export function pointLight(key, name, color, lumens, range, position = [0, 0, 0], extra = {}) {
  return node(name, 'light', {
    id: stableId(`light:${key}`), position, lightType: 'point', castShadows: false,
    light: { unit: 'photometric', color, intensity: lumens, range, sourceRadius: 0.05, legacyFalloff: false },
    ...extra,
  })
}

// =====================================================================================================
// Templates
// =====================================================================================================

/** Mirrors NODE_REF_KEYS in src/core/scene/nodeJson.ts: ids of OTHER nodes, which differ per copy. */
const REF_KEYS = new Set(['followId', 'lookAtId', 'cameraNodeId', 'uiTargetId', 'focusTargetId', 'possessedId', 'aimSourceId', 'navMeshId', 'collisionIgnoreIds'])
/** A template's source json (builder output, before re-keying), for checking copies against it. */
export const TEMPLATE_SOURCE = new Map()

export function walkJson(n, fn, pathTo = '') {
  fn(n, pathTo)
  const seen = new Map()
  for (const c of n.children ?? []) {
    const k = seen.get(c.name) ?? 0
    seen.set(c.name, k + 1)
    walkJson(c, fn, (pathTo ? pathTo + '/' : '') + (k === 0 ? c.name : `${c.name}#${k}`))
  }
}

/** A template from a builder's node: re-keyed to ids of its own, bodies and triggers moved to the template's maps. */
export function asTemplate(key, nodeJson, textureIds = []) {
  const source = cloneNodeJson(nodeJson)
  const root = cloneNodeJson(nodeJson)
  let i = 0
  regenerateNodeIds(root, new Map(), () => stableId(`template:${key}:${i++}`))
  root.position = [0, 0, 0]
  root.rotation = [0, 0, 0]
  const bodies = {}, triggers = {}
  walkJson(root, n => {
    delete n.__sourceId
    if (n.body) { bodies[n.id] = n.body; delete n.body }
    if (n.trigger) { triggers[n.id] = n.trigger; delete n.trigger }
  })
  const template = { id: stableId(`template:${key}`), name: root.name, nodeJson: root, textureIds, scripts: {}, bodies, triggers }
  TEMPLATE_SOURCE.set(template.id, source)
  return template
}

function templateShape(key, nodeJson, textureIds) {
  const root = cloneNodeJson(nodeJson)
  let i = 0
  regenerateNodeIds(root, new Map(), () => stableId(`template:${key}:${i++}`))
  root.position = [0, 0, 0]
  root.rotation = [0, 0, 0]
  const bodies = {}, triggers = {}
  walkJson(root, n => {
    delete n.__sourceId
    if (n.body) { bodies[n.id] = n.body; delete n.body }
    if (n.trigger) { triggers[n.id] = n.trigger; delete n.trigger }
  })
  return { id: stableId(`template:${key}`), name: root.name, nodeJson: root, textureIds, scripts: {}, bodies, triggers }
}

/**
 * A variant of `base` whose content is `nodeJson`: what the editor stores (the diff, and the content
 * materialized from base + diff), through the editor's own templateVariants.ts.
 */
export function variantTemplate(key, base, nodeJson, textureIds = []) {
  const candidate = templateShape(key, nodeJson, textureIds)
  const diff = diffTemplate(base, candidate)
  const t = { id: candidate.id, name: candidate.name, ...materializeVariant(base, candidate.id, diff), variant: { baseTemplateId: base.id, diff } }
  TEMPLATE_SOURCE.set(t.id, cloneNodeJson(nodeJson))
  return t
}

function comparable(n, isRoot) {
  const out = {}
  for (const [k, v] of Object.entries(n)) {
    if (k === 'children' || k === 'id' || k === '__sourceId' || k === 'scriptVars' || REF_KEYS.has(k)) continue
    if (isRoot && (k === 'position' || k === 'rotation' || k === 'scale' || k === 'name')) continue
    out[k] = v
  }
  return JSON.stringify(out)
}

/**
 * Link a builder's node to `template`: verify it is the template's content, stamp `__templateId`, and record
 * how it differs (root name, script values) as `__overrides`, the record the editor replays after a rebuild.
 */
export function linkInstance(template, copy) {
  const source = TEMPLATE_SOURCE.get(template.id)
  if (!source) throw new Error(`template "${template.name}" has no recorded source`)
  const want = new Map(), got = new Map()
  walkJson(source, (n, p) => want.set(p, n))
  walkJson(copy, (n, p) => got.set(p, n))
  const overrides = {}
  for (const [p, n] of got) {
    const t = want.get(p)
    if (!t) throw new Error(`${copy.name}: "${p}" is not in template "${template.name}"`)
    if (comparable(n, p === '') !== comparable(t, p === ''))
      throw new Error(`${copy.name}: "${p || '(root)'}" differs from template "${template.name}" in more than its script values`)
    const entry = {}
    if (p === '' && n.name !== t.name) entry.name = n.name
    for (const [field, value] of Object.entries(n.scriptVars ?? {}))
      if (JSON.stringify(value) !== JSON.stringify(t.scriptVars?.[field])) (entry.fields ??= {})[field] = value
    if (entry.name !== undefined || entry.fields) overrides[p] = entry
  }
  for (const p of want.keys()) if (!got.has(p)) throw new Error(`${copy.name}: template "${template.name}" has "${p}", the copy does not`)
  copy.variables = { ...(copy.variables ?? {}), ...vars({ __templateId: template.id }) }
  if (Object.keys(overrides).length)
    copy.variables.__overrides = { type: 'string', value: JSON.stringify(overrides), access: 'private' }
  return copy
}

// =====================================================================================================
// UI
// =====================================================================================================

export const INK = [0.93, 0.94, 0.95, 1]
export const DIM = [0.66, 0.7, 0.74, 1]
export const ACCENT = [0.95, 0.72, 0.28, 1]
export const FONT = '"Segoe UI", "Helvetica Neue", Arial, sans-serif'

export const screenRoot = (name, key, children, extra = {}, ui = {}) => uiNode(name, 'uiRoot', {
  space: 'screen', referenceResolution: [1920, 1080], scaleMode: 'scaleWithScreen', matchWidthOrHeight: 0.5, referenceDpr: 1,
  uiTargetId: null, referenceDistance: 10, minScale: 0.1, maxScale: 4, billboard: true, clampToScreen: false, hideBehindCamera: true,
  anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [0, 0], offsetMax: [0, 0], ...ui,
}, { id: stableId(`ui:${key}`), children, ...extra })

export const text = (key, name, value, rect, style = {}) => uiNode(name, 'uiText', {
  ...rect, text: value, fontSize: style.size ?? 22, fontFamily: style.font ?? FONT, fontWeight: style.weight ?? 500,
  align: style.align ?? 'left', vAlign: style.vAlign ?? 'middle', wrap: true, lineHeight: style.lineHeight ?? 1.2, tint: style.tint ?? INK,
}, { id: stableId(`ui:${key}`) })

export const bar = (key, name, rect, fill, back, smoothing, z = 0) => uiNode(name, 'uiProgressBar', {
  ...rect, min: 0, max: 100, value: 100, fillTint: fill, tint: back, direction: 'ltr', smoothing, borderRadius: 2, zOrder: z,
}, { id: stableId(`ui:${key}`) })

export const panel = (key, name, rect, tint, children = [], extra = {}) => uiNode(name, 'uiPanel', {
  ...rect, tint, borderRadius: extra.radius ?? 0, interactive: false, ...(extra.ui ?? {}),
}, { id: stableId(`ui:${key}`), children, visible: extra.visible ?? true })

export const rect = (anchor, min, max) => ({ anchorMin: anchor, anchorMax: anchor, offsetMin: min, offsetMax: max })
export const stretch = (inset = 0) => ({ anchorMin: [0, 0], anchorMax: [1, 1], offsetMin: [inset, inset], offsetMax: [-inset, -inset] })

export function walkSize(dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? walkSize(full) : fs.statSync(full).size
  }
  return total
}
