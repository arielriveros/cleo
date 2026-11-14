import * as cleo from 'cleo'
import type { Node, Scene } from 'cleo'
import type { ShapeDescription } from '../engineContextTypes'
import { ADD_ITEMS, addItemTo, findAddItem } from '../sceneInspector/addCatalog'
import { buildTemplateFromNode, instantiateTemplate, isWithinTemplateInstance, TEMPLATE_ID_VAR, type Template } from '../../utils/templates'
import { OVERRIDES_VAR, setFieldOverride, setNameOverride, writeOverrides } from '../../utils/templateOverrides'
import { cloneJson, variantFromContent } from '../../utils/templateVariants'
import { cryptoRandomId } from '../../utils/ids'
import { instantiateModelAsset } from '../../utils/models'
import { applyMaterialAsset } from '../../utils/materials'
import { applyScriptAsset, getScriptIdOf, unlinkScript } from '../../utils/scripts'
import { toRuntimeTileset } from '../../utils/tilesets'
import { meshPositions, shapeFitSource } from '../../utils/editorHelpers'
import { fitShapeToPoints } from '../nodeInspector/physicsEditors/shapeListOps'
import {
  CancelledError, byName, editScene, inSceneTab, notFound, ready, throwIfAborted, until,
  type BridgeHost, type CommandResult, type GetHost,
} from './bridgeHost'
import { nodePath, resolveNodeRef, userChildren } from './nodeRefs'
import { applyProp, nearestNames } from './inspect'
import { findMaterial, uniqueMaterialName, upsertMaterial, type MadeMaterials, type MaterialAsset, type MaterialSpec } from './materials'
import { withCapture } from './shots'

// scene_edit: a list of ops applied as ONE undo step, and by default all or nothing. Every op's fields are
// checked before the first one runs; an op that fails later rolls the whole call back (HistoryContext's
// atomic transaction), asset-library changes included, since those are undo entries of the same step.

// --- collider and trigger shapes ----------------------------------------------------------------------

export function normalizeShape(s: any): ShapeDescription {
  const base = { offset: [0, 0, 0], rotation: [0, 0, 0], ...s }
  switch (base.type) {
    case 'box': return { width: 1, height: 1, depth: 1, ...base }
    case 'sphere': return { radius: 0.5, ...base }
    case 'capsule': return { radius: 0.4, height: 1.8, numSegments: 12, ...base }
    case 'cylinder': return { radius: 0.5, height: 1, numSegments: 12, ...base }
    case 'plane': return base
    default: throw new Error(`Unknown shape type ${JSON.stringify(s?.type)}: use box, sphere, capsule, cylinder or plane.`)
  }
}

/**
 * A box around the meshes under a collider or trigger, the way the inspector's Fit does it (a trigger with
 * none of its own fits the node it is under); a 1 m box when there are none.
 */
function fittedBox(owner: Node): ShapeDescription {
  // World matrices catch up with setPosition/setScale only in the next frame's update: meshes created or
  // moved earlier in this same call would be measured where they were (a 12 m floor fitted as a 1 m box).
  let top = owner
  while (top.parent) top = top.parent
  top.updateTransforms(null)
  const box = normalizeShape({ type: 'box' })
  const points = meshPositions(shapeFitSource(owner), owner)
  return points.length ? fitShapeToPoints(box, points) : box
}

/** An op's `shapes` checked: a list of shapes, or 'fit' for one box fitted to what is under the node. */
function opShapes(h: BridgeHost, node: Node, value: unknown): ShapeDescription[] | 'fit' {
  const flat = h.engine.sceneDimension === '2D'
  if (node instanceof cleo.Body2DNode) throw new Error(`"${node.name}" is a Collider 2D: its box is props size [w, h] (and offset), not shapes.`)
  if (flat && node instanceof cleo.TriggerNode)
    throw new Error(`In a 2D scene "${node.name}" is a box: set props size [w, h] and offset [x, y], not shapes.`)
  if (!(node instanceof cleo.ColliderNode) && !(node instanceof cleo.TriggerNode))
    throw new Error(`"${node.name}" is a ${node.nodeType}: only a collider or a trigger has shapes. `
      + (flat ? 'In a 2D scene, put it under a body2D (Collider 2D) instead.' : 'Create one (type collider or trigger) and put the node under it.'))
  if (value === 'fit') return 'fit'
  if (!Array.isArray(value)) throw new Error('shapes is a list of shapes, or "fit".')
  return value.map(normalizeShape)
}

// --- the call's state ------------------------------------------------------------------------------------

export interface EditCtx {
  h: BridgeHost
  getHost: GetHost
  scene: Scene
  aliases: Map<string, Node>
  track: (n: Node) => Promise<void>
  label: string
  /** The selection when the call began: a create selects its node, but "@selected" means the user's pick. */
  selectedId: string | null
  made: MadeMaterials
  /** Templates made by makeTemplate in this call, by lowercased name (the library is stale React state). */
  madeTemplates: Map<string, Template>
  signal?: AbortSignal
}

function refOf(ctx: EditCtx, ref: string): Node { return resolveNodeRef(ctx.scene, ref, ctx.aliases, ctx.selectedId) }

/**
 * Undo for the per-node `scripts` map (resolved source by node id), which lives outside node.serialize. Call
 * before changing a node's script link; the returned function records the change after it. Without it,
 * undoing an attach would leave the source behind and the node would run it as an inline script.
 */
export function scriptsMapStep(h: BridgeHost, nodeId: string, label: string): () => void {
  const map = h.engine.scripts
  const before = map.get(nodeId)
  return () => {
    const after = map.get(nodeId)
    if (after === before) return
    const write = (v: string | undefined) => { if (v === undefined) map.delete(nodeId); else map.set(nodeId, v) }
    h.history.push({ label, undo: () => write(before), redo: () => write(after) })
  }
}

// --- op fields -------------------------------------------------------------------------------------------

/** The fields create and update both take: what a node is and has. */
const NODE_FIELDS = ['name', 'position', 'rotation', 'scale', 'visible', 'props', 'scriptFields', 'material', 'shapes', 'assets']

/** Which fields each op takes. The tool schema is one flat object, so the check that a field fits its op is here. */
export const OP_FIELDS: Record<string, ReadonlySet<string>> = {
  create: new Set(['op', 'type', 'template', 'model', 'parent', 'as', 'script', ...NODE_FIELDS]),
  update: new Set(['op', 'node', ...NODE_FIELDS]),
  delete: new Set(['op', 'node']),
  move: new Set(['op', 'node', 'parent', 'index']),
  attachScript: new Set(['op', 'node', 'script']),
  detachScript: new Set(['op', 'node']),
  select: new Set(['op', 'node']),
  makeTemplate: new Set(['op', 'node', 'name', 'replace']),
  unpack: new Set(['op', 'node']),
  revertOverrides: new Set(['op', 'node', 'field']),
  makeVariant: new Set(['op', 'node', 'name']),
}

/** Fields an older version took, and what does their job now. */
const RETIRED_FIELDS: Record<string, string> = {
  body: 'a rigid body is a Collider node now: create type "collider" (props mass, friction, layer, mask; shapes) and put the node under it',
  trigger: 'a trigger is a Trigger node now: create type "trigger" with shapes (in 2D, props size/offset)',
}

/** Whether `op` takes every field it was given; throws naming the stray one, what replaced it, and what the op takes. */
export function checkOpFields(op: any): void {
  const allowed = OP_FIELDS[op?.op]
  if (!allowed) throw new Error(`Unknown op ${JSON.stringify(op?.op)}. Ops: ${Object.keys(OP_FIELDS).join(', ')}.`)
  for (const [k, v] of Object.entries(op)) {
    if (v === undefined || allowed.has(k)) continue
    if (RETIRED_FIELDS[k]) throw new Error(`"${k}" is gone: ${RETIRED_FIELDS[k]}.`)
    const near = nearestNames(k, allowed)
    throw new Error(`${op.op} does not take "${k}".${near.length ? ` Did you mean ${near.map(n => `"${n}"`).join(' or ')}?` : ''} It takes: ${[...allowed].filter(f => f !== 'op').join(', ')}.`)
  }
  if ((op.op !== 'create' && op.op !== 'select') && (op.node === undefined || op.node === null))
    throw new Error(`${op.op} needs node.`)
  if (op.op === 'move' && !op.parent) throw new Error('move needs parent.')
  if (op.op === 'attachScript' && !op.script) throw new Error('attachScript needs script.')
}

// --- materials and asset links ---------------------------------------------------------------------------

/** The material an op names: an existing asset by name, or a spec to create or update one now. */
function opMaterial(ctx: EditCtx, node: Node, value: unknown, nodeName?: string): () => MaterialAsset {
  if (typeof value === 'string') {
    const found = findMaterial(ctx.h, value, ctx.made)
    if (!found) throw notFound('material', value, ctx.h.engine.materials)
    return () => found
  }
  const spec = value as MaterialSpec
  // Named after the node as the op leaves it: a create's `name` is applied after this is worked out.
  const name = spec.name?.trim() || uniqueMaterialName(ctx.h, `${nodeName?.trim() || node.name} Material`, ctx.made)
  // Updating an existing material re-applies it everywhere it is linked (upsertMaterial propagates it).
  return () => upsertMaterial(ctx.h, ctx.getHost, name, spec, { made: ctx.made, label: ctx.label }).asset
}

interface AssetLinks { tileset?: string | null; sequence?: string | null; particleSystem?: string | null }

/** The `assets` field checked against the node and the libraries; returns the change to make. */
function opAssets(ctx: EditCtx, node: Node, links: AssetLinks): () => string[] {
  const e = ctx.h.engine
  const steps: (() => string)[] = []
  if (links.tileset !== undefined) {
    if (!(node instanceof cleo.SpriteNode))
      throw new Error(`"${node.name}" is a ${node.nodeType}: a tileset links to a sprite or animated sprite (a tilemap's layers are painted in the editor).`)
    const asset = links.tileset === null ? null : byName(e.tilesets, links.tileset)
    if (links.tileset !== null && !asset) throw notFound('tileset', links.tileset, e.tilesets)
    steps.push(() => {
      node.tileset = asset ? toRuntimeTileset(asset) : null
      if (asset) node.tileIndex = 0
      e.eventEmitter.emit('TEXTURES_CHANGED')
      return asset ? `tileset=${asset.name}` : 'tileset=none'
    })
  }
  if (links.sequence !== undefined) {
    if (!(node instanceof cleo.SequenceNode)) throw new Error(`"${node.name}" is a ${node.nodeType}: a sequence links to a sequence node.`)
    const asset = links.sequence === null ? null : byName(e.sequences, links.sequence)
    if (links.sequence !== null && !asset) throw notFound('sequence', links.sequence, e.sequences)
    steps.push(() => { ctx.getHost().engine.linkSequenceToNode(node, asset?.id ?? null); return `sequence=${asset?.name ?? 'none'}` })
  }
  if (links.particleSystem !== undefined) {
    if (!(node instanceof cleo.ParticleSystemNode)) throw new Error(`"${node.name}" is a ${node.nodeType}: a particle system links to a particle system node.`)
    const asset = links.particleSystem === null ? null : byName(e.particleSystems, links.particleSystem)
    if (links.particleSystem !== null && !asset) throw notFound('particle system', links.particleSystem, e.particleSystems)
    steps.push(() => { ctx.getHost().engine.linkParticleSystemToNode(node, asset?.id ?? null); return `particles=${asset?.name ?? 'none'}` })
  }
  return () => steps.map(s => s())
}

// --- node fields -----------------------------------------------------------------------------------------

/**
 * Apply what an op says a node is and has (NODE_FIELDS), validating everything before changing anything,
 * so a bad field fails the op with the node untouched. `fresh`: the node was created by this op, so there is
 * nothing to snapshot (undoing the create removes it whole).
 */
async function applyFields(ctx: EditCtx, node: Node, op: any, fresh: boolean): Promise<string[]> {
  const { h } = ctx
  for (const [k, v] of Object.entries(op.props ?? {})) applyProp(node, k, v, true)
  const sid = getScriptIdOf(node)
  const scriptAsset = sid ? h.engine.scriptAssets.find(a => a.id === sid) : undefined
  if (op.scriptFields) {
    if (!scriptAsset) throw new Error(`"${node.name}" has no script asset attached, so it has no script fields.`)
    const fields = new Set(scriptAsset.variables.filter(v => !v.hidden).map(v => v.name))
    for (const k of Object.keys(op.scriptFields))
      if (!fields.has(k)) throw new Error(`Script "${scriptAsset.name}" has no public field "${k}". Fields: ${[...fields].join(', ') || 'none'}.`)
  }
  const material = op.material ? opMaterial(ctx, node, op.material, op.name) : undefined
  const shapes = op.shapes !== undefined && op.shapes !== null ? opShapes(h, node, op.shapes) : undefined
  const assets = op.assets ? opAssets(ctx, node, op.assets) : undefined

  if (!fresh) await ctx.track(node)
  const did: string[] = []
  const emitter = h.engine.eventEmitter
  // A placed template's root keeps its name and script fields as OVERRIDES: without the record, the next
  // template save or resync rebuilds the copy and puts the template's values back. A copy placed by this
  // very op too: `create {template, name}` names that one copy, not the template.
  const instanceRoot = inSceneTab(h) && typeof node.getVariable(TEMPLATE_ID_VAR) === 'string'

  if (op.name !== undefined && op.name !== null) {
    node.name = op.name
    if (instanceRoot) setNameOverride(node, op.name)
    did.push('name')
  }
  if (op.position) { node.setPosition(op.position); did.push('position') }
  if (op.rotation) { node.setRotation(op.rotation); did.push('rotation') }
  if (op.scale) { node.setScale(op.scale); did.push('scale') }
  if (op.visible !== undefined && op.visible !== null) { node.visible = op.visible; did.push('visible') }
  if (op.props) {
    for (const [k, v] of Object.entries(op.props)) applyProp(node, k, v)
    emitter.emit('SCENE_CHANGED', { kind: 'component', node })
    did.push(`props(${Object.keys(op.props).join(', ')})${instanceRoot && !fresh ? ' (a template change resets these on a placed copy: edit the template for lasting ones)' : ''}`)
  }
  if (op.scriptFields) {
    // Script fields are native properties that Node.serialize leaves out (the editor injects them as
    // scriptVars at save time), so the node snapshot cannot see them: an undo entry of their own.
    const id = node.id
    const next = { ...op.scriptFields }
    const before = Object.fromEntries(Object.keys(next).map(k => [k, (node as any)[k]]))
    const write = (values: Record<string, unknown>) => {
      const n = ctx.scene.getNodeById(id)
      if (!n) return
      for (const [k, v] of Object.entries(values)) (n as any)[k] = Array.isArray(v) ? [...v] : v
      emitter.emit('SCENE_CHANGED', { kind: 'variable', node: n })
    }
    write(next)
    if (instanceRoot) for (const [k, v] of Object.entries(next)) setFieldOverride(node, k, v)
    h.history.push({ label: ctx.label, undo: () => write(before), redo: () => write(next) })
    did.push(`scriptFields(${Object.keys(next).join(', ')})`)
  }
  if (material) {
    const asset = material()
    if (!applyMaterialAsset(node, asset)) throw new Error(`"${node.name}" cannot take material "${asset.name}".`)
    emitter.emit('TEXTURES_CHANGED')
    emitter.emit('SCENE_CHANGED', { kind: 'material', node })
    did.push(`material=${asset.name}`)
  }
  if (shapes) {
    // The node's own field, so the call's snapshot undoes it with the rest.
    const owner = node as cleo.ColliderNode | cleo.TriggerNode
    owner.shapes = (shapes === 'fit' ? [fittedBox(node)] : shapes) as any
    emitter.emit('PHYSICS_CHANGED')
    emitter.emit('SCENE_CHANGED', { kind: 'physics', node })
    did.push(`shapes(${owner.shapes.map((s: any) => s.type).join(', ')})`)
  } else if (op.props && (node instanceof cleo.ColliderNode || node instanceof cleo.TriggerNode || node instanceof cleo.Body2DNode)) {
    // A collider's mass, layers or surface: the helpers and the nav soup read them.
    emitter.emit('PHYSICS_CHANGED')
  }
  if (assets) {
    did.push(...assets())
    emitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
  return did
}

/** Link a script asset to a node, replacing its script; undoable through the scripts map step. */
function attachScriptTo(ctx: EditCtx, node: Node, scriptName: string): string {
  const { h } = ctx
  const asset = byName(h.engine.scriptAssets, scriptName)
  if (!asset) throw notFound('script', scriptName, h.engine.scriptAssets)
  const record = scriptsMapStep(h, node.id, ctx.label)
  const previous = getScriptIdOf(node)
  if (previous && previous !== asset.id) unlinkScript(node, h.engine.scriptAssets.find(a => a.id === previous), h.engine.scripts)
  const ok = applyScriptAsset(node, asset, h.engine.scripts)
  record()
  if (!ok)
    throw new Error(`Script "${asset.name}" extends ${asset.baseType}; it cannot attach to ${node.nodeType} "${node.name}". `
      + 'Change the class it extends (Node attaches anywhere), or attach it to a matching node.')
  h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'script', node })
  return asset.name
}

/** Where a create lands without a parent: the template root in a template tab, the model in a model tab. */
function defaultParent(ctx: EditCtx): Node {
  const { activeTab, templateRootId, modelEditTargetId } = ctx.h.engine
  if (activeTab?.kind === 'template' && templateRootId) return ctx.scene.getNodeById(templateRootId) ?? ctx.scene.root
  if (activeTab?.kind === 'model' && modelEditTargetId) return ctx.scene.getNodeById(modelEditTargetId) ?? ctx.scene.root
  return ctx.scene.root
}

function assertEditable(ctx: EditCtx, node: Node, what: string) {
  if (inSceneTab(ctx.h) && isWithinTemplateInstance(node.parent))
    throw new Error(`Cannot ${what} "${node.name}": it is inside a placed template instance. Edit the template itself `
      + '(workspace {"action":"openAsset","kind":"template","name":"<its template>"}), or the instance root.')
}

/** A template by name: one made earlier in this call first, then the library. */
function templateNamed(ctx: EditCtx, name: string): Template | undefined {
  return ctx.madeTemplates.get(name.toLowerCase()) ?? byName(ctx.h.engine.templates, name)
}

/** Point every alias that named `from` at `to` (a node the op rebuilt). */
function realias(ctx: EditCtx, from: Node, to: Node) {
  for (const [k, v] of ctx.aliases) if (v === from) ctx.aliases.set(k, to)
}

// --- ops -------------------------------------------------------------------------------------------------

async function opCreate(ctx: EditCtx, op: any): Promise<string> {
  const { h, scene } = ctx
  const parent = op.parent ? refOf(ctx, op.parent) : defaultParent(ctx)
  if (inSceneTab(h) && isWithinTemplateInstance(parent))
    throw new Error(`Cannot add under "${parent.name}": it is inside a placed template instance.`)
  const sources = [op.type, op.template, op.model].filter(Boolean)
  if (sources.length !== 1) throw new Error('A create op needs exactly one of type, template or model.')

  let node: Node | undefined
  let what: string
  if (op.type) {
    const item = findAddItem(op.type)
    if (!item) {
      const near = nearestNames(op.type, ADD_ITEMS.map(i => i.id))
      throw new Error(`Unknown type "${op.type}". ${near.length ? `Did you mean: ${near.join(', ')}?` : `Types: ${ADD_ITEMS.map(i => i.id).join(', ')}.`}`)
    }
    node = await addItemTo(item, parent, { editorScene: scene, eventEmitter: h.engine.eventEmitter })
    what = op.type
  } else if (op.template) {
    const t = templateNamed(ctx, op.template)
    if (!t) throw notFound('template', op.template, h.engine.templates)
    const id = instantiateTemplate(t, parent, { scripts: h.engine.scripts }, h.engine.materials)
    node = scene.getNodeById(id)
    h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    what = `template ${t.name}`
  } else {
    const m = byName(h.engine.models, op.model)
    if (!m) throw notFound('model', op.model, h.engine.models)
    const id = instantiateModelAsset(m, parent, h.engine.materials, h.engine.models, h.engine.animations)
    node = scene.getNodeById(id)
    if (node && h.engine.activeTab?.kind !== 'model') h.engine.adoptRigController(m.id, node)
    h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    what = `model ${m.name}`
  }
  if (!node) throw new Error(`Creating ${what} produced no node.`)
  if (op.as) ctx.aliases.set(op.as, node)
  // The new node takes the same fields an update does, so a whole object (material, shapes, script and its
  // fields) is one op. The script goes first: scriptFields need it attached.
  const extra: string[] = []
  try {
    if (op.script) extra.push(`script=${attachScriptTo(ctx, node, op.script)}`)
    const did = await applyFields(ctx, node, op, true)
    extra.push(...did.filter(d => !['name', 'position', 'rotation', 'scale'].includes(d)))
  } catch (err) {
    // A create whose fields fail leaves nothing behind: the op failed as a whole.
    ctx.aliases.delete(op.as)
    scene.removeNode(node)
    throw err
  }
  return `create ${what} -> ${nodePath(node, scene.root)} (#${node.id})${op.as ? ` as ${op.as}` : ''}${extra.length ? `: ${extra.join(', ')}` : ''}`
}

async function opUpdate(ctx: EditCtx, op: any): Promise<string> {
  const { scene } = ctx
  const node = refOf(ctx, op.node)
  if (node === scene.root) throw new Error('The scene root cannot be edited.')
  assertEditable(ctx, node, 'edit')
  const did = await applyFields(ctx, node, op, false)
  if (!did.length) throw new Error('An update op needs at least one field to change.')
  return `update ${nodePath(node, scene.root)}: ${did.join(', ')}`
}

function isAncestor(a: Node, b: Node): boolean {
  for (let n = b.parent; n; n = n.parent) if (n === a) return true
  return false
}

async function opMove(ctx: EditCtx, op: any): Promise<string> {
  const node = refOf(ctx, op.node)
  const parent = refOf(ctx, op.parent)
  if (node === ctx.scene.root) throw new Error('The scene root cannot be moved.')
  if (node === parent || isAncestor(node, parent)) throw new Error(`Cannot move "${node.name}" under itself.`)
  assertEditable(ctx, node, 'move')
  if (inSceneTab(ctx.h) && isWithinTemplateInstance(parent)) throw new Error(`Cannot move into "${parent.name}": it is inside a template instance.`)
  // The index counts the parent's VISIBLE children; translate it to the real array (helpers sit there too).
  const shown = userChildren(parent).filter(c => c !== node)
  const anchor = op.index !== undefined ? shown[op.index] : undefined
  parent.addChild(node, anchor ? parent.children.indexOf(anchor) : undefined)
  return `move ${node.name} -> ${nodePath(node, ctx.scene.root)}`
}

async function opAttachScript(ctx: EditCtx, op: any): Promise<string> {
  const node = refOf(ctx, op.node)
  assertEditable(ctx, node, 'attach a script to')
  if (!byName(ctx.h.engine.scriptAssets, op.script)) throw notFound('script', op.script, ctx.h.engine.scriptAssets)
  await ctx.track(node)
  const name = attachScriptTo(ctx, node, op.script)
  return `attachScript ${name} -> ${nodePath(node, ctx.scene.root)}`
}

async function opDetachScript(ctx: EditCtx, op: any): Promise<string> {
  const { h } = ctx
  const node = refOf(ctx, op.node)
  const sid = getScriptIdOf(node)
  if (!sid) return `detachScript: ${node.name} had no script`
  await ctx.track(node)
  const record = scriptsMapStep(h, node.id, ctx.label)
  unlinkScript(node, h.engine.scriptAssets.find(a => a.id === sid), h.engine.scripts)
  record()
  h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'script', node })
  return `detachScript ${nodePath(node, ctx.scene.root)}`
}

/** A node becomes a new template; with `replace` (the default) it is swapped for an instance of it. */
async function opMakeTemplate(ctx: EditCtx, op: any): Promise<string> {
  const { h, scene } = ctx
  const node = refOf(ctx, op.node)
  if (node === scene.root) throw new Error('The scene root cannot become a template.')
  assertEditable(ctx, node, 'make a template of')
  if (isWithinTemplateInstance(node))
    throw new Error(`"${node.name}" is (inside) a placed copy of a template already: makeVariant makes a new template from a placed copy.`)
  const name = String(op.name ?? node.name).trim() || node.name
  if (templateNamed(ctx, name)) throw new Error(`A template named "${name}" exists already: pass another name.`)
  const built = await buildTemplateFromNode(node, { scripts: h.engine.scripts }, h.engine.scriptAssets)
  // A template is named after its root node (its tab saves it under the root's name), so the root is renamed.
  const template: Template = { ...built, name, nodeJson: { ...built.nodeJson, name } }
  const add = () => ctx.getHost().engine.addTemplate(template)
  add()
  // Under the call's node changes: undone after the instance is gone, redone before it comes back.
  h.history.pushFirst({ label: ctx.label, undo: () => ctx.getHost().engine.removeTemplate(template.id), redo: add })
  ctx.madeTemplates.set(name.toLowerCase(), template)
  if (op.replace === false) return `makeTemplate "${name}" from ${nodePath(node, scene.root)} (the node stays as it was)`

  const parent = node.parent!
  const index = parent.children.indexOf(node)
  const id = instantiateTemplate(template, parent, { scripts: h.engine.scripts }, h.engine.materials)
  const inst = scene.getNodeById(id)
  if (!inst) throw new Error(`Placing "${name}" produced no node.`)
  // The copy keeps the node's own name: a name override, as the inspector records one.
  if (node.name !== name) { inst.name = node.name; setNameOverride(inst, node.name) }
  inst.setPosition(Array.from(node.position) as any)
  inst.setRotation(Array.from(node.rotation) as any)
  inst.setScale(Array.from(node.scale) as any)
  parent.moveChildTo(inst, index)
  scene.removeNode(node)
  realias(ctx, node, inst)
  h.engine.eventEmitter.emit('TEXTURES_CHANGED')
  return `makeTemplate "${name}"; ${nodePath(inst, scene.root)} is now a placed copy of it (#${inst.id}, read-only inside)`
}

/** A placed copy becomes plain nodes: no template link, no overrides; its contents become editable. */
async function opUnpack(ctx: EditCtx, op: any): Promise<string> {
  const node = refOf(ctx, op.node)
  const tid = node.getVariable(TEMPLATE_ID_VAR)
  if (typeof tid !== 'string') {
    if (isWithinTemplateInstance(node)) throw new Error(`"${node.name}" is inside a placed copy: unpack its root.`)
    throw new Error(`"${node.name}" is not a placed template.`)
  }
  assertEditable(ctx, node, 'unpack')
  await ctx.track(node)
  node.removeVariable(TEMPLATE_ID_VAR)
  node.removeVariable(OVERRIDES_VAR)
  ctx.h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'variable', node })
  const t = ctx.h.engine.templates.find(x => x.id === tid)
  return `unpack ${nodePath(node, ctx.scene.root)}: no longer a copy of "${t?.name ?? tid}"`
}

/**
 * Undo for a placed copy's link (its name, template id and overrides) when the editor REBUILDS the copy:
 * the rebuild's own structure entries put the old node object back on undo, but the editor changed that
 * object's link before replacing it, so it would come back half-changed. Taken before the change; the entry
 * goes under the call's other entries (pushFirst), so it runs after the old node is back.
 */
function linkStateStep(ctx: EditCtx, root: Node): () => void {
  const id = root.id
  const before = { name: root.name, template: root.getVariable(TEMPLATE_ID_VAR), overrides: root.getVariable(OVERRIDES_VAR) }
  return () => ctx.h.history.pushFirst({
    label: ctx.label,
    undo: () => {
      const n = ctx.scene.getNodeById(id)
      if (!n) return
      n.name = before.name
      if (typeof before.template === 'string') n.setVariable(TEMPLATE_ID_VAR, before.template, 'string'); else n.removeVariable(TEMPLATE_ID_VAR)
      if (typeof before.overrides === 'string') n.setVariable(OVERRIDES_VAR, before.overrides, 'string'); else n.removeVariable(OVERRIDES_VAR)
      ctx.h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'variable', node: n })
    },
    // The rebuild's structure entries bring the rebuilt copy back, link and all.
    redo: () => {},
  })
}

/** The child of `parent` that was not there before: what a rebuild put in place of a copy. */
function newChildOf(parent: Node, before: ReadonlySet<Node>): Node | undefined {
  return parent.children.find(c => !before.has(c))
}

/** Drop a placed copy's overrides (one field, "name", or all) and rebuild it from its template. */
async function opRevertOverrides(ctx: EditCtx, op: any): Promise<string> {
  const node = refOf(ctx, op.node)
  if (!isWithinTemplateInstance(node)) throw new Error(`"${node.name}" is not a placed template or inside one.`)
  let root: Node = node
  while (typeof root.getVariable(TEMPLATE_ID_VAR) !== 'string' && root.parent) root = root.parent
  const parent = root.parent!
  const before = new Set(parent.children)
  const path = nodePath(node, ctx.scene.root)
  const record = linkStateStep(ctx, root)
  // A rebuild: ids change, and what is under the copy comes back from the template.
  ctx.getHost().engine.revertTemplateOverride(node, op.field, node === root && !op.field)
  record()
  const rebuilt = newChildOf(parent, before)
  if (rebuilt) realias(ctx, root, rebuilt)
  return `revertOverrides ${path}${op.field ? ` (${op.field})` : ''}: rebuilt from its template${rebuilt ? ` as ${nodePath(rebuilt, ctx.scene.root)} (#${rebuilt.id})` : ''}`
}

/**
 * A placed copy becomes a new variant of its template, and is relinked to it: what the editor's "make a
 * variant from this copy" does (createVariantFromInstance), minus its rebuild of the copy. That rebuild
 * runs with history off and gives the copy new ids, so it could not be undone; the copy IS the variant's
 * content, so it already matches, and relinking it in place keeps it one undoable step.
 */
async function opMakeVariant(ctx: EditCtx, op: any): Promise<string> {
  const { h } = ctx
  const node = refOf(ctx, op.node)
  const baseId = node.getVariable(TEMPLATE_ID_VAR)
  if (typeof baseId !== 'string') throw new Error(`"${node.name}" is not a placed template: makeVariant needs the root of a placed copy.`)
  if (!inSceneTab(h)) throw new Error('makeVariant works on a placed copy in the scene tab.')
  const base = h.engine.templates.find(t => t.id === baseId) ?? [...ctx.madeTemplates.values()].find(t => t.id === baseId)
  if (!base) throw new Error(`"${node.name}" places a template that is no longer in the library.`)
  const taken = new Set([...h.engine.templates, ...ctx.madeTemplates.values()].map(t => t.name))
  let name = String(op.name ?? '').trim()
  if (name && taken.has(name)) throw new Error(`A template named "${name}" exists already: pass another name.`)
  if (!name) {
    name = node.name !== base.name && !taken.has(node.name) ? node.name : `${base.name} Variant`
    for (let i = 2; taken.has(name); i++) name = `${base.name} Variant ${i}`
  }
  await ctx.track(node)
  const content = await buildTemplateFromNode(node, { scripts: h.engine.scripts }, h.engine.scriptAssets)
  // Where the copy stands is the placement's, not the asset's; the override record is the copy's.
  delete content.nodeJson.variables?.[OVERRIDES_VAR]
  for (const key of ['position', 'rotation', 'scale'] as const) {
    if (base.nodeJson[key] !== undefined) content.nodeJson[key] = cloneJson(base.nodeJson[key])
    else delete content.nodeJson[key]
  }
  content.nodeJson.name = name
  const variant = variantFromContent(base, content, cryptoRandomId(), name)
  const add = () => ctx.getHost().engine.addTemplate(variant)
  add()
  h.history.pushFirst({ label: ctx.label, undo: () => ctx.getHost().engine.removeTemplate(variant.id), redo: add })
  ctx.madeTemplates.set(name.toLowerCase(), variant)
  node.name = name
  writeOverrides(node, {})
  node.setVariable(TEMPLATE_ID_VAR, variant.id, 'string')
  h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'variable', node })
  return `makeVariant "${name}" (a variant of "${base.name}"): ${nodePath(node, ctx.scene.root)} now places it`
}

const OPS: Record<string, (ctx: EditCtx, op: any) => Promise<string>> = {
  create: opCreate,
  update: opUpdate,
  move: opMove,
  attachScript: opAttachScript,
  detachScript: opDetachScript,
  makeTemplate: opMakeTemplate,
  unpack: opUnpack,
  revertOverrides: opRevertOverrides,
  makeVariant: opMakeVariant,
  delete: async (ctx, op) => {
    const node = refOf(ctx, op.node)
    if (node === ctx.scene.root) throw new Error('The scene root cannot be deleted.')
    assertEditable(ctx, node, 'delete')
    const path = nodePath(node, ctx.scene.root)
    // removeNode, not Node.remove(): the scene unwinds its own bookkeeping (SceneInspector does the same).
    ctx.scene.removeNode(node)
    return `delete ${path}`
  },
  select: async (ctx, op) => {
    const node = op.node === null || op.node === undefined ? null : refOf(ctx, op.node)
    ctx.h.engine.eventEmitter.emit('SELECT_NODE', node?.id ?? null)
    return node ? `select ${nodePath(node, ctx.scene.root)}` : 'select none'
  },
}

/** The scene_edit command. */
export async function sceneEdit(p: any, getHost: GetHost, signal?: AbortSignal): Promise<CommandResult> {
  const h = ready(getHost)
  const scene = editScene(h)
  const label = p.label || 'Claude edit'
  const atomic = p.atomic !== false
  const ops: any[] = Array.isArray(p.ops) ? p.ops : []
  // Every op's fields first: a misspelt field costs nothing, and the message names what the op takes.
  for (let i = 0; i < ops.length; i++) {
    try { checkOpFields(ops[i]) } catch (err) {
      return { text: `Op ${i + 1} (${ops[i]?.op}): ${err instanceof Error ? err.message : String(err)}\nNothing was changed.`, isError: true }
    }
  }
  const done: string[] = []
  // Widened on purpose: it is assigned inside the transaction's callback, which narrowing cannot see.
  let failure = null as string | null
  const ctx: EditCtx = {
    h, getHost, scene, aliases: new Map(), track: async () => {}, label,
    selectedId: h.engine.selectedNode ?? null, made: new Map(), madeTemplates: new Map(), signal,
  }
  try {
    await h.history.transaction(label, async track => {
      ctx.track = track
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i]
        try {
          throwIfAborted(signal)
          done.push(`${i + 1}. ${await OPS[op.op](ctx, op)}`)
        } catch (err) {
          failure = err instanceof CancelledError
            ? `Cancelled before op ${i + 1}.`
            : `Op ${i + 1} (${op.op}) failed: ${err instanceof Error ? err.message : String(err)}`
          if (atomic) throw err
          break
        }
      }
    }, { atomic })
  } catch (err) {
    failure ??= `The edit failed: ${err instanceof Error ? err.message : String(err)}`
  }
  h.engine.eventEmitter.emit('SCENE_CHANGED')
  let head: string
  if (!failure) head = `${done.length} op${done.length === 1 ? '' : 's'} applied as one undo step ("${label}").`
  else if (atomic) head = `${failure}\nNothing was changed: the whole call was rolled back. Fix that op and send the call again.`
  else head = `${failure}\n${done.length ? `Ops 1-${done.length} were applied (one undo step "${label}"); fix the failed op and send the rest again.` : 'Nothing was changed.'}`
  const result: CommandResult = { text: [head, ...(failure && atomic ? [] : done)].join('\n'), isError: !!failure }
  return !failure || (!atomic && done.length) ? withCapture(result, p.capture, getHost, ctx.aliases, signal) : result
}
