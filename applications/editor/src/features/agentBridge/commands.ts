import * as cleo from 'cleo'
import { Material, compileScript, type Node, type Scene } from 'cleo'
import type { useCleoEngine } from '../EngineContext'
import type { useHistory } from '../HistoryContext'
import type { BodyDescription, ShapeDescription } from '../engineContextTypes'
import { ADD_ITEMS, addItemTo, findAddItem } from '../sceneInspector/addCatalog'
import { instantiateTemplate, isWithinTemplateInstance, TEMPLATE_ID_VAR } from '../../utils/templates'
import { instantiateModelAsset, MODEL_ID_VAR } from '../../utils/models'
import { applyMaterialAsset, buildMaterialAsset, getMaterialIdOf, MATERIAL_ID_VAR } from '../../utils/materials'
import { applyScriptAsset, BASE_CLASS, buildScriptAsset, getScriptIdOf, unlinkScript, type ScriptAsset } from '../../utils/scripts'
import { buildScriptGraphCtx, deriveBaseType, moduleIdOfVfsPath } from '../../utils/scriptGraph'
import { meshPositions } from '../../utils/editorHelpers'
import { renderMaterialAssetThumbnail } from '../../utils/modelThumbnails'
import { fitShapeToPoints } from '../nodeInspector/physicsEditors/shapeListOps'
import { APP_VERSION } from '../../version'
import { agentBridge, type CommandResult } from './bridgeClient'
import { NodeRefError, isHiddenNode, nodePath, resolveNodeRef, userChildren, walkUserNodes } from './nodeRefs'
import { applyProp, elide, outline, round, settableProps, simpleValue } from './inspect'
import { captureViewport, frameNode } from './capture'
import { formatLogs, logCursor, readLogs } from './agentLogs'
import { typecheckScript } from './scriptCheck'

// The editor side of every MCP tool (applications/mcp/src/tools.mjs names the methods). Each command reads
// the editor through `getHost()`, which returns the LATEST render's context, never a closure from when the
// link opened: library arrays are React state, and a command that waited (a capture, a Play start) must see
// what changed meanwhile.

export interface BridgeHost {
  engine: ReturnType<typeof useCleoEngine>
  history: ReturnType<typeof useHistory>
}
export type GetHost = () => BridgeHost

type Command = (params: any, getHost: GetHost) => Promise<CommandResult>

// --- shared helpers ------------------------------------------------------------------------------------

function ready(getHost: GetHost): BridgeHost {
  const h = getHost()
  if (!h.engine.instance || !h.engine.isSceneReady)
    throw new Error('The editor is still loading the project; try again in a few seconds.')
  return h
}

/** What reads look at: the running game during Play/Simulate, the active tab's scene otherwise. */
function readScene(h: BridgeHost): Scene {
  return h.engine.isPlayMode && h.engine.instance ? h.engine.instance.scene : h.engine.editorScene
}

/** What edits change. Never the play scene: Stop throws it away. */
function editScene(h: BridgeHost): Scene {
  if (h.engine.isPlayMode)
    throw new Error('The game is running, and edits to it are discarded on Stop. Call play_control {"action":"stop"} first.')
  return h.engine.editorScene
}

const sleep = (ms: number) => new Promise(r => window.setTimeout(r, ms))

async function until(test: () => boolean, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}.`)
    await sleep(50)
  }
}

function byName<T extends { name: string }>(list: readonly T[], name: string): T | undefined {
  return list.find(x => x.name === name) ?? list.find(x => x.name.toLowerCase() === name.toLowerCase())
}

function notFound(kind: string, name: string, list: readonly { name: string }[]): Error {
  const names = list.map(x => `"${x.name}"`).slice(0, 30).join(', ')
  return new Error(`No ${kind} named "${name}". ${list.length ? `Available: ${names}${list.length > 30 ? ', …' : ''}.` : `The project has none.`}`)
}

const vec = (v: ArrayLike<number>) => Array.from(v, x => round(x))

/** Name tags for the outline: what the scene tree's icons say. */
function flagsFor(h: BridgeHost) {
  const { scriptAssets, scripts, bodies, triggers, templates, models, materials } = h.engine
  return (n: Node): string[] => {
    const out: string[] = []
    const sid = getScriptIdOf(n)
    if (sid) out.push(`script=${scriptAssets.find(a => a.id === sid)?.name ?? '?'}`)
    else if (scripts.has(n.id)) out.push('script=(inline)')
    const body = bodies.get(n.id)
    if (body) out.push(body.mass > 0 ? `body(mass=${body.mass})` : 'body(static)')
    if (triggers.has(n.id)) out.push('trigger')
    const tid = n.getVariable(TEMPLATE_ID_VAR)
    if (typeof tid === 'string') out.push(`template=${templates.find(t => t.id === tid)?.name ?? '?'}`)
    const mid = n.getVariable(MODEL_ID_VAR)
    if (typeof mid === 'string') out.push(`model=${models.find(m => m.id === mid)?.name ?? '?'}`)
    const matId = n.getVariable(MATERIAL_ID_VAR)
    if (typeof matId === 'string') out.push(`material=${materials.find(m => m.id === matId)?.name ?? '?'}`)
    if (!n.visible) out.push('hidden')
    return out
  }
}

/** A value from a script or an `execute`, safe to JSON: nodes become refs, cycles and depth are cut. */
function toSafe(v: unknown, root: Node | null, depth = 0, seen = new WeakSet<object>()): unknown {
  if (v === undefined) return null
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? round(v) : String(v)
  if (typeof v === 'function') return '<function>'
  if (typeof v !== 'object') return String(v)
  if (v instanceof cleo.Node) return { node: root ? nodePath(v, root) : v.name, id: v.id, type: v.nodeType }
  if (ArrayBuffer.isView(v)) return elide(v)
  if (seen.has(v)) return '<cycle>'
  seen.add(v)
  if (depth > 6) return '<…>'
  if (v instanceof Map) return Object.fromEntries([...v].slice(0, 100).map(([k, x]) => [String(k), toSafe(x, root, depth + 1, seen)]))
  if (v instanceof Set) return [...v].slice(0, 100).map(x => toSafe(x, root, depth + 1, seen))
  if (Array.isArray(v)) return v.slice(0, 200).map(x => toSafe(x, root, depth + 1, seen))
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(v).slice(0, 100)) out[k] = toSafe((v as any)[k], root, depth + 1, seen)
  return out
}

// --- physics records -----------------------------------------------------------------------------------

/** What the Physics panel's "Add body" starts from (PhysicsEditor NEW_BODY). */
const NEW_BODY: BodyDescription = {
  mass: 0, linearDamping: 0, angularDamping: 0, linearConstraints: [1, 1, 1], angularConstraints: [1, 1, 1],
  friction: 0.3, restitution: 0, simulatePhysics: true, cameraCollision: true, groundProbeDistance: 0,
  simulationMode: 'project', simulationRange: 0, canSleep: false, shapes: [],
}

function normalizeShape(s: any): ShapeDescription {
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

/** A box around the node's own mesh, the way the panel's Fit does it; a 1 m box when it has none. */
function fittedBox(node: Node): ShapeDescription {
  const box = normalizeShape({ type: 'box' })
  const points = meshPositions(node)
  return points.length ? fitShapeToPoints(box, points) : box
}

function writePhysics(h: BridgeHost, node: Node, channel: 'body' | 'trigger', value: Record<string, any> | null, label: string): string {
  const map = (channel === 'body' ? h.engine.bodies : h.engine.triggers) as Map<string, any>
  const emitter = h.engine.eventEmitter
  const before = map.get(node.id) ?? null
  let next: any = null
  if (value) {
    next = { ...(before ?? (channel === 'body' ? NEW_BODY : { shapes: [] })), ...value }
    next.shapes = Array.isArray(value.shapes) && value.shapes.length
      ? value.shapes.map(normalizeShape)
      : (before?.shapes?.length ? before.shapes : [fittedBox(node)])
  }
  const write = (record: any) => {
    if (record) map.set(node.id, record); else map.delete(node.id)
    emitter.emit('PHYSICS_CHANGED')
    emitter.emit('SCENE_CHANGED', { kind: 'physics', node })
  }
  write(next)
  // Bodies and triggers live outside node.serialize(), so the snapshot cannot undo them: a step of its own,
  // which the open transaction folds into the call's single undo step.
  h.history.push({ label, undo: () => write(before), redo: () => write(next) })
  return next ? `${channel} (${next.shapes.map((s: ShapeDescription) => s.type).join(', ')})` : `${channel} removed`
}

/**
 * Undo for the per-node `scripts` map (resolved source by node id), which lives outside node.serialize like
 * bodies do. Call before changing a node's script link; the returned function records the change after it.
 * Without it, undoing an attach would leave the source behind and the node would run it as an inline script.
 */
function scriptsMapStep(h: BridgeHost, nodeId: string, label: string): () => void {
  const map = h.engine.scripts
  const before = map.get(nodeId)
  return () => {
    const after = map.get(nodeId)
    if (after === before) return
    const write = (v: string | undefined) => { if (v === undefined) map.delete(nodeId); else map.set(nodeId, v) }
    h.history.push({ label, undo: () => write(before), redo: () => write(after) })
  }
}

// --- scene_edit ----------------------------------------------------------------------------------------

interface EditCtx { h: BridgeHost; scene: Scene; aliases: Map<string, Node>; track: (n: Node) => Promise<void>; label: string }

function refOf(ctx: EditCtx, ref: string): Node { return resolveNodeRef(ctx.scene, ref, ctx.aliases) }

/** Where a create lands without a parent: the template root in a template tab, the model in a model tab. */
function defaultParent(ctx: EditCtx): Node {
  const { editorMode, templateRootId, modelEditTargetId } = ctx.h.engine
  if (editorMode === 'template' && templateRootId) return ctx.scene.getNodeById(templateRootId) ?? ctx.scene.root
  if (editorMode === 'model' && modelEditTargetId) return ctx.scene.getNodeById(modelEditTargetId) ?? ctx.scene.root
  return ctx.scene.root
}

function assertEditable(ctx: EditCtx, node: Node, what: string) {
  if (ctx.h.engine.editorMode === 'scene' && isWithinTemplateInstance(node.parent))
    throw new Error(`Cannot ${what} "${node.name}": it is inside a placed template instance. Edit the template itself, or the instance root.`)
}

async function opCreate(ctx: EditCtx, op: any): Promise<string> {
  const { h, scene } = ctx
  const parent = op.parent ? refOf(ctx, op.parent) : defaultParent(ctx)
  if (h.engine.editorMode === 'scene' && isWithinTemplateInstance(parent))
    throw new Error(`Cannot add under "${parent.name}": it is inside a placed template instance.`)
  const sources = [op.type, op.template, op.model].filter(Boolean)
  if (sources.length !== 1) throw new Error('A create op needs exactly one of type, template or model.')

  let node: Node | undefined
  let what: string
  if (op.type) {
    const item = findAddItem(op.type)
    if (!item) throw new Error(`Unknown type "${op.type}". Types: ${ADD_ITEMS.map(i => i.id).join(', ')}.`)
    node = await addItemTo(item, parent, { editorScene: scene, eventEmitter: h.engine.eventEmitter, triggers: h.engine.triggers })
    what = op.type
  } else if (op.template) {
    const t = byName(h.engine.templates, op.template)
    if (!t) throw notFound('template', op.template, h.engine.templates)
    const id = instantiateTemplate(t, parent, { scripts: h.engine.scripts, bodies: h.engine.bodies, triggers: h.engine.triggers }, h.engine.materials)
    node = scene.getNodeById(id)
    h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    what = `template ${t.name}`
  } else {
    const m = byName(h.engine.models, op.model)
    if (!m) throw notFound('model', op.model, h.engine.models)
    const id = instantiateModelAsset(m, parent, h.engine.materials, h.engine.models, h.engine.animations)
    node = scene.getNodeById(id)
    if (node && h.engine.editorMode !== 'model') h.engine.adoptRigController(m.id, node)
    h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    what = `model ${m.name}`
  }
  if (!node) throw new Error(`Creating ${what} produced no node.`)
  if (op.name) node.name = op.name
  if (op.position) node.setPosition(op.position)
  if (op.rotation) node.setRotation(op.rotation)
  if (op.scale) node.setScale(op.scale)
  if (op.as) ctx.aliases.set(op.as, node)
  return `create ${what} -> ${nodePath(node, scene.root)} (#${node.id})${op.as ? ` as ${op.as}` : ''}`
}

async function opUpdate(ctx: EditCtx, op: any): Promise<string> {
  const { h, scene } = ctx
  const node = refOf(ctx, op.node)
  if (node === scene.root) throw new Error('The scene root cannot be edited.')
  assertEditable(ctx, node, 'edit')

  // Check everything first, so a bad field fails the op before any of it has been applied.
  for (const [k, v] of Object.entries(op.props ?? {})) applyProp(node, k, v, true)
  const sid = getScriptIdOf(node)
  const scriptAsset = sid ? h.engine.scriptAssets.find(a => a.id === sid) : undefined
  if (op.scriptFields) {
    if (!scriptAsset) throw new Error(`"${node.name}" has no script asset attached, so it has no script fields.`)
    const fields = new Set(scriptAsset.variables.filter(v => !v.hidden).map(v => v.name))
    for (const k of Object.keys(op.scriptFields))
      if (!fields.has(k)) throw new Error(`Script "${scriptAsset.name}" has no public field "${k}". Fields: ${[...fields].join(', ') || 'none'}.`)
  }
  const material = op.material ? byName(h.engine.materials, op.material) : undefined
  if (op.material && !material) throw notFound('material', op.material, h.engine.materials)
  for (const rec of [op.body, op.trigger]) for (const s of rec?.shapes ?? []) normalizeShape(s)

  await ctx.track(node)
  const did: string[] = []
  const emitter = h.engine.eventEmitter

  if (op.name !== undefined) { node.name = op.name; did.push('name') }
  if (op.position) { node.setPosition(op.position); did.push('position') }
  if (op.rotation) { node.setRotation(op.rotation); did.push('rotation') }
  if (op.scale) { node.setScale(op.scale); did.push('scale') }
  if (op.visible !== undefined) { node.visible = op.visible; did.push('visible') }
  if (op.props) {
    for (const [k, v] of Object.entries(op.props)) applyProp(node, k, v)
    emitter.emit('SCENE_CHANGED', { kind: 'component', node })
    did.push(`props(${Object.keys(op.props).join(', ')})`)
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
    h.history.push({ label: ctx.label, undo: () => write(before), redo: () => write(next) })
    did.push(`scriptFields(${Object.keys(next).join(', ')})`)
  }
  if (material) {
    if (!applyMaterialAsset(node, material)) throw new Error(`"${node.name}" cannot take material "${material.name}".`)
    emitter.emit('TEXTURES_CHANGED')
    emitter.emit('SCENE_CHANGED', { kind: 'material', node })
    did.push(`material=${material.name}`)
  }
  if (op.body !== undefined) did.push(writePhysics(h, node, 'body', op.body, ctx.label))
  if (op.trigger !== undefined) did.push(writePhysics(h, node, 'trigger', op.trigger, ctx.label))
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
  if (ctx.h.engine.editorMode === 'scene' && isWithinTemplateInstance(parent)) throw new Error(`Cannot move into "${parent.name}": it is inside a template instance.`)
  // The index counts the parent's VISIBLE children; translate it to the real array (helpers sit there too).
  const shown = userChildren(parent).filter(c => c !== node)
  const anchor = op.index !== undefined ? shown[op.index] : undefined
  parent.addChild(node, anchor ? parent.children.indexOf(anchor) : undefined)
  return `move ${node.name} -> ${nodePath(node, ctx.scene.root)}`
}

async function opAttachScript(ctx: EditCtx, op: any): Promise<string> {
  const { h } = ctx
  const node = refOf(ctx, op.node)
  assertEditable(ctx, node, 'attach a script to')
  const asset = byName(h.engine.scriptAssets, op.script)
  if (!asset) throw notFound('script', op.script, h.engine.scriptAssets)
  await ctx.track(node)
  const record = scriptsMapStep(h, node.id, ctx.label)
  const previous = getScriptIdOf(node)
  if (previous && previous !== asset.id) unlinkScript(node, h.engine.scriptAssets.find(a => a.id === previous), h.engine.scripts)
  const ok = applyScriptAsset(node, asset, h.engine.scripts)
  record()
  if (!ok)
    throw new Error(`Script "${asset.name}" extends ${asset.baseType}; it cannot attach to ${node.nodeType} "${node.name}". `
      + 'Change the class it extends (Node attaches anywhere), or attach it to a matching node.')
  h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'script', node })
  return `attachScript ${asset.name} -> ${nodePath(node, ctx.scene.root)}`
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

const OPS: Record<string, (ctx: EditCtx, op: any) => Promise<string>> = {
  create: opCreate,
  update: opUpdate,
  move: opMove,
  attachScript: opAttachScript,
  detachScript: opDetachScript,
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
    const node = op.node === null ? null : refOf(ctx, op.node)
    ctx.h.engine.eventEmitter.emit('SELECT_NODE', node?.id ?? null)
    return node ? `select ${nodePath(node, ctx.scene.root)}` : 'select none'
  },
}

// --- commands ------------------------------------------------------------------------------------------

const commands: Record<string, Command> = {
  async status(_p, getHost) {
    const h = getHost()
    const e = h.engine
    const scene = e.instance ? readScene(h) : null
    let nodes = 0
    if (scene) walkUserNodes(scene.root, () => { nodes++ })
    const selected = e.selectedNode && scene ? scene.getNodeById(e.selectedNode) : null
    let backend = 'default'
    try { backend = localStorage.getItem('cleo_renderer_backend') ?? 'default' } catch { /* ignore */ }
    return {
      data: {
        editor: { version: APP_VERSION, origin: location.origin, renderer: backend, loading: !e.isSceneReady },
        project: await projectInfo(),
        scenes: e.sceneList.map(s => ({ name: s.name, id: s.id, main: s.id === e.mainSceneId, open: s.id === e.openSceneId })),
        activeTab: { title: e.activeTab?.title, kind: e.activeTab?.kind, unsaved: !!e.dirtyTabs[e.activeTabId] },
        editorMode: e.editorMode,
        play: e.isPlayMode ? { state: e.isSimulating ? 'simulate' : 'play', paused: !!e.instance?.isPaused } : { state: 'editing' },
        unsavedTabs: e.tabs.filter(t => e.dirtyTabs[t.id]).map(t => t.title),
        selected: selected ? nodePath(selected, scene!.root) : null,
        sceneNodes: nodes,
        agent: { executeAllowed: agentBridge.executeAllowed },
      },
    }
  },

  async 'scene.tree'(p, getHost) {
    const h = ready(getHost)
    const scene = readScene(h)
    const root = p.root ? resolveNodeRef(scene, p.root) : scene.root
    const { text } = outline(scene, {
      root, depth: p.depth ?? 4, limit: p.limit ?? 300, type: p.type, name: p.name, flags: flagsFor(h),
    })
    const where = h.engine.isPlayMode ? 'the running game' : `"${h.engine.activeTab?.title ?? 'scene'}"`
    return { text: `Scene tree of ${where}:\n${text}` }
  },

  async 'node.get'(p, getHost) {
    const h = ready(getHost)
    const scene = readScene(h)
    const node = resolveNodeRef(scene, p.node)
    const json = await node.serialize()
    const sid = getScriptIdOf(node)
    const asset = sid ? h.engine.scriptAssets.find(a => a.id === sid) : undefined
    const variables = Object.fromEntries(Object.entries(json?.variables ?? {})
      .filter(([k]) => !k.startsWith('__')).map(([k, v]: [string, any]) => [k, v?.value]))
    const matId = getMaterialIdOf(node)
    const data: Record<string, unknown> = {
      path: nodePath(node, scene.root), id: node.id, name: node.name, type: node.nodeType,
      parent: node.parent ? nodePath(node.parent, scene.root) : null,
      position: vec(node.position), rotation: vec(node.rotation), scale: vec(node.scale), visible: node.visible,
      worldPosition: vec(node.worldPosition),
      children: userChildren(node).map(c => `${c.name} [${c.nodeType}]`),
      script: asset
        ? { name: asset.name, extends: BASE_CLASS[asset.baseType] ?? asset.baseType, fields: Object.fromEntries(asset.variables.filter(v => !v.hidden).map(v => [v.name, simpleValue((node as any)[v.name]) ?? toSafe((node as any)[v.name], scene.root)])) }
        : (h.engine.scripts.has(node.id) ? { inline: true } : null),
      body: h.engine.bodies.has(node.id) ? elide(h.engine.bodies.get(node.id)) : null,
      trigger: h.engine.triggers.has(node.id) ? elide(h.engine.triggers.get(node.id)) : null,
      material: matId ? (h.engine.materials.find(m => m.id === matId)?.name ?? matId) : null,
      variables,
      props: settableProps(node),
    }
    if (p.json) data.json = elide({ ...json, children: (json.children ?? []).map((c: any) => `${c.name} [${c.type}]`) })
    return { data }
  },

  async 'scene.edit'(p, getHost) {
    const h = ready(getHost)
    const scene = editScene(h)
    const label = p.label || 'Claude edit'
    const done: string[] = []
    let failure: string | null = null
    await h.history.transaction(label, async track => {
      const ctx: EditCtx = { h, scene, aliases: new Map(), track, label }
      for (let i = 0; i < p.ops.length; i++) {
        const op = p.ops[i]
        const run = OPS[op?.op]
        if (!run) { failure = `Op ${i + 1}: unknown op ${JSON.stringify(op?.op)}.`; break }
        try {
          done.push(`${i + 1}. ${await run(ctx, op)}`)
        } catch (err) {
          failure = `Op ${i + 1} (${op.op}) failed: ${err instanceof Error ? err.message : String(err)}`
          break
        }
      }
    })
    h.engine.eventEmitter.emit('SCENE_CHANGED')
    const head = failure
      ? `${failure}\n${done.length ? `Ops 1-${done.length} were applied (one undo step "${label}"); fix the failed op and send the rest again.` : 'Nothing was changed.'}`
      : `${done.length} op${done.length === 1 ? '' : 's'} applied as one undo step ("${label}").`
    return { text: [head, ...done].join('\n'), isError: !!failure }
  },

  async 'script.write'(p, getHost) {
    const h = ready(getHost)
    const name = String(p.name).trim()
    const source = String(p.source)
    const lib = h.engine.scriptAssets
    const existing = byName(lib, name)
    const pathOf = (id: string) => {
      const vfsPath = h.engine.scriptPaths.get(id)
      return vfsPath ? moduleIdOfVfsPath(vfsPath) : undefined
    }

    // The runtime's own compile: syntax and the module shapes it supports, exactly as Play will run it.
    let compileError: string | null = null
    try { compileScript(source, { path: existing ? pathOf(existing.id) : `/${name}` }) } catch (err) { compileError = err instanceof Error ? err.message : String(err) }

    const graph = buildScriptGraphCtx(h.engine.scriptPaths, lib)
    let asset: ScriptAsset
    if (existing) {
      // saveScriptSource re-derives the asset (and the scripts that extend it) and re-seeds every node using it.
      h.engine.saveScriptSource(existing.id, source)
      const derived = deriveBaseType(source, pathOf(existing.id), graph)
      asset = buildScriptAsset(existing.name, existing.baseType === 'node' && derived !== 'node' ? derived : existing.baseType, source, existing.id)
    } else {
      asset = buildScriptAsset(name, deriveBaseType(source, undefined, graph), source)
      h.engine.addScriptAsset(asset)
    }

    const attached: string[] = []
    const attachErrors: string[] = []
    if (p.attach?.length) {
      const scene = editScene(h)
      await h.history.transaction(`Attach ${asset.name}`, async track => {
        for (const ref of p.attach) {
          try {
            const node = resolveNodeRef(scene, ref)
            await track(node)
            const record = scriptsMapStep(h, node.id, `Attach ${asset.name}`)
            const previous = getScriptIdOf(node)
            if (previous && previous !== asset.id) unlinkScript(node, lib.find(a => a.id === previous), h.engine.scripts)
            const ok = applyScriptAsset(node, asset, h.engine.scripts)
            record()
            if (!ok) { attachErrors.push(`${ref}: a ${node.nodeType} node cannot take a script that extends ${asset.baseType}`); continue }
            h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'script', node })
            attached.push(nodePath(node, scene.root))
          } catch (err) { attachErrors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`) }
        }
      })
    }

    let typeReport = 'Type check: skipped.'
    if (p.check !== false && !compileError) {
      try {
        const library = existing ? lib.map(a => a.id === asset.id ? asset : a) : [...lib, asset]
        const moduleId = pathOf(asset.id) ?? `/${asset.name}`
        const diags = await Promise.race([
          typecheckScript(source, moduleId, library, pathOf),
          sleep(45000).then(() => { throw new Error('the type checker did not answer within 45 s') }),
        ])
        const errors = diags.filter(d => d.severity === 'error')
        typeReport = diags.length
          ? `Type check: ${errors.length} error(s), ${diags.length - errors.length} warning(s). Fix them and call script_write again:\n`
            + diags.slice(0, 30).map(d => `  ${d.line}:${d.column} TS${d.code} ${d.severity}: ${d.message}`).join('\n')
          : 'Type check: no errors.'
      } catch (err) {
        typeReport = `Type check unavailable (${err instanceof Error ? err.message : String(err)}); the runtime compile passed.`
      }
    }

    const fields = asset.variables.filter(v => !v.hidden)
    const lines = [
      `${existing ? 'Updated' : 'Created'} script "${asset.name}" (${asset.kind === 'module' ? 'module' : `class extends ${BASE_CLASS[asset.baseType] ?? asset.baseType}, attaches to ${asset.baseType === 'node' ? 'any node' : `${asset.baseType} nodes`}`}).`,
      fields.length ? `Public fields (per-node inspector values): ${fields.map(v => `${v.name}: ${v.type} = ${JSON.stringify(v.default)}`).join('; ')}` : 'No public fields.',
      compileError ? `Runtime compile FAILED: ${compileError}` : 'Runtime compile: ok.',
      typeReport,
    ]
    if (attached.length) lines.push(`Attached to: ${attached.join(', ')} (one undo step).`)
    if (attachErrors.length) lines.push(`Not attached: ${attachErrors.join('; ')}`)
    return { text: lines.join('\n'), isError: !!compileError || attachErrors.length > 0 }
  },

  async 'script.read'(p, getHost) {
    const h = ready(getHost)
    const asset = byName(h.engine.scriptAssets, p.name)
    if (!asset) throw notFound('script', p.name, h.engine.scriptAssets)
    const scene = h.engine.editorScene
    const users: string[] = []
    walkUserNodes(scene.root, n => { if (getScriptIdOf(n) === asset.id) users.push(nodePath(n, scene.root)) })
    const fields = asset.variables.filter(v => !v.hidden).map(v => `${v.name}: ${v.type} = ${JSON.stringify(v.default)}`)
    return {
      text: `Script "${asset.name}" (${asset.kind === 'module' ? 'module' : `extends ${BASE_CLASS[asset.baseType] ?? asset.baseType}`}), path ${h.engine.scriptPaths.get(asset.id) ?? '(not in a folder)'}\n`
        + `Fields: ${fields.join('; ') || 'none'}\nUsed by (open scene): ${users.join(', ') || 'none'}\n\n${asset.source}`,
    }
  },

  async 'material.write'(p, getHost) {
    const h = ready(getHost)
    const existing = byName(h.engine.materials, p.name)
    const props: Record<string, unknown> = {}
    if (p.baseColor) props.baseColor = p.baseColor
    if (p.metallic !== undefined) props.metallic = p.metallic
    if (p.roughness !== undefined) props.roughness = p.roughness
    if (p.emissive) props.emissiveFactor = p.emissive
    if (p.emissiveIntensity !== undefined) props.emissiveIntensity = p.emissiveIntensity
    if (p.opacity !== undefined) props.opacity = p.opacity

    let material: Material
    if (existing && existing.material?.type === 'pbr') {
      material = Material.parse(existing.material)
      for (const [k, v] of Object.entries(props)) material.properties.set(k, v)
      if (p.transparent !== undefined) material.config.transparent = p.transparent
    } else {
      material = Material.PBR(props as any, { transparent: !!p.transparent })
    }
    const asset = buildMaterialAsset(material, existing?.name ?? p.name, existing?.thumbnail ?? '', existing?.id)
    if (existing) h.engine.updateMaterial(existing.id, asset)
    else h.engine.addMaterial(asset)

    const scene = h.engine.isPlayMode ? null : h.engine.editorScene
    const relinked: string[] = []
    const assigned: string[] = []
    if (scene) {
      await h.history.transaction(`Material ${asset.name}`, async track => {
        if (existing) walkUserNodes(scene.root, n => { if (getMaterialIdOf(n) === asset.id && applyMaterialAsset(n, asset)) relinked.push(n.name) })
        for (const ref of p.assignTo ?? []) {
          const node = resolveNodeRef(scene, ref)
          await track(node)
          if (!applyMaterialAsset(node, asset)) throw new Error(`"${node.name}" cannot take material "${asset.name}".`)
          h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'material', node })
          assigned.push(nodePath(node, scene.root))
        }
      })
      h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    }
    // The explorer card's thumbnail, rendered after the fact so the call does not wait on it.
    const engine = h.engine.instance!
    void renderMaterialAssetThumbnail(engine, asset).then(thumbnail => {
      if (thumbnail) getHost().engine.updateMaterial(asset.id, { ...asset, thumbnail })
    }).catch(() => { /* a thumbnail is cosmetic */ })
    return {
      text: `${existing ? 'Updated' : 'Created'} material "${asset.name}" (PBR).`
        + (relinked.length ? ` Re-applied to ${relinked.length} node(s) using it.` : '')
        + (assigned.length ? ` Assigned to ${assigned.join(', ')}.` : ''),
    }
  },

  async 'asset.list'(p, getHost) {
    const h = ready(getHost)
    const e = h.engine
    const q = p.query?.toLowerCase()
    const libs: Record<string, { name: string; note?: string }[]> = {
      template: e.templates.map(t => ({ name: t.name, note: t.variant ? 'variant' : undefined })),
      model: e.models.map(m => ({ name: m.name, note: m.rigId ? 'rigged' : undefined })),
      material: e.materials.map(m => ({ name: m.name, note: m.material?.type })),
      script: e.scriptAssets.map(s => ({ name: s.name, note: s.kind === 'module' ? 'module' : `extends ${BASE_CLASS[s.baseType] ?? s.baseType}` })),
      animation: e.animations.map(a => ({ name: a.name })),
      animController: e.animControllers.map(c => ({ name: c.name })),
      aiBrain: e.aiBrains.map(b => ({ name: b.name, note: b.kind })),
      particleSystem: e.particleSystems.map(s => ({ name: s.name })),
      sound: e.soundSamples.map(s => ({ name: s.name })),
      texture: e.textures.map(t => ({ name: t.name })),
      tileset: e.tilesets.map(t => ({ name: t.name })),
    }
    const lines: string[] = []
    for (const [kind, items] of Object.entries(libs)) {
      if (p.kind && kind !== p.kind) continue
      const hits = q ? items.filter(i => i.name.toLowerCase().includes(q)) : items
      if (!hits.length && !p.kind) continue
      const shown = hits.slice(0, 200).map(i => i.note ? `${i.name} (${i.note})` : i.name)
      lines.push(`${kind} (${hits.length}): ${shown.join(', ') || 'none'}${hits.length > 200 ? ', …' : ''}`)
    }
    return { text: lines.join('\n') || 'No assets match.' }
  },

  async 'view.capture'(p, getHost) {
    const h = ready(getHost)
    const engine = h.engine.instance!
    let note = ''
    if (p.focus) {
      if (h.engine.isPlayMode) throw new Error('focus moves the editor camera, which is not in use during Play. Capture without focus.')
      const scene = h.engine.editorScene
      const node = resolveNodeRef(scene, p.focus)
      const camera = engine.scene.activeCamera
      if (!camera || !camera.isEditorOwned) throw new Error('The editor camera is not available in this tab.')
      frameNode(camera, node, p.yaw ?? 35, p.pitch ?? 25)
      note = ` Framed ${nodePath(node, scene.root)} (the editor camera moved).`
    }
    // After a camera jump, let temporal AA and motion blur settle: the first frames smear the old view in.
    const shot = await captureViewport(engine.renderer, { maxSize: p.maxSize ?? 1024, format: p.format ?? 'jpeg', skipFrames: p.focus ? 12 : 0 })
    const what = h.engine.isPlayMode ? 'the running game' : `the ${h.engine.activeTab?.title ?? 'scene'} viewport`
    return { text: `Capture of ${what}, ${shot.width}x${shot.height}.${note}`, images: [{ data: shot.data, mimeType: shot.mimeType }] }
  },

  async 'logs.read'(p) {
    const entries = readLogs({ since: p.since, level: p.level, scope: p.scope, limit: p.limit ?? 60 })
    const cursor = logCursor()
    return { text: `${entries.length ? formatLogs(entries) : 'No log entries' + (p.since !== undefined ? ' since that cursor.' : '.')}\ncursor: ${cursor}` }
  },

  async 'play.control'(p, getHost) {
    const h = ready(getHost)
    const state = () => {
      const e = getHost().engine
      return e.isPlayMode ? `${e.isSimulating ? 'simulate' : 'play'}${e.instance?.isPaused ? ' (paused)' : ''}` : 'editing'
    }
    switch (p.action) {
      case 'status':
        return { text: `State: ${state()}. Log cursor: ${logCursor()}.` }
      case 'play':
      case 'simulate': {
        if (h.engine.isPlayMode) return { text: `Already running (${state()}). Stop first to restart.` }
        const cursor = logCursor()
        if (p.action === 'play') h.engine.startPlay(); else h.engine.startSimulate()
        await until(() => getHost().engine.isPlayMode, 20000, 'the game to start')
        await sleep(Math.round((p.runSeconds ?? 1.5) * 1000))
        const entries = readLogs({ since: cursor, limit: 80 })
        const errors = entries.filter(e => e.level === 'error').length
        return {
          text: `State: ${state()}. Ran ${p.runSeconds ?? 1.5} s. ${entries.length} new log entr${entries.length === 1 ? 'y' : 'ies'}`
            + `${errors ? ` (${errors} error${errors === 1 ? '' : 's'})` : ''}:\n${formatLogs(entries) || '(none)'}\ncursor: ${logCursor()}`,
          isError: false,
        }
      }
      case 'pause':
        if (!h.engine.isPlayMode) return { text: 'Not running.' }
        h.engine.pausePlay()
        await sleep(100)
        return { text: `State: ${state()}.` }
      case 'stop':
        if (!h.engine.isPlayMode) return { text: 'Already editing.' }
        h.engine.stopPlay()
        await until(() => !getHost().engine.isPlayMode, 20000, 'the game to stop')
        return { text: 'Stopped; back to editing. Anything changed during play was discarded.' }
      default:
        throw new Error(`Unknown action ${JSON.stringify(p.action)}.`)
    }
  },

  async history(p, getHost) {
    const steps = p.steps ?? 1
    const done: string[] = []
    for (let i = 0; i < (p.action === 'status' ? 0 : steps); i++) {
      const hist = getHost().history
      const label = p.action === 'undo' ? hist.undoLabel : hist.redoLabel
      if (p.action === 'undo' ? !hist.canUndo : !hist.canRedo) break
      if (p.action === 'undo') hist.undo(); else hist.redo()
      done.push(label ?? 'step')
      await sleep(30) // let the stack's re-render land before reading the next label
    }
    const after = getHost().history
    return {
      text: `${done.length ? `${p.action === 'undo' ? 'Undid' : 'Redid'}: ${done.join(', ')}. ` : ''}`
        + `Next undo: ${after.undoLabel ?? 'none'}; next redo: ${after.redoLabel ?? 'none'}.`,
    }
  },

  async 'scene.save'(_p, getHost) {
    const h = ready(getHost)
    if (h.engine.isPlayMode) throw new Error('Stop the game before saving.')
    const ok = await h.engine.saveActiveTab()
    return { text: ok ? `Saved "${getHost().engine.activeTab?.title}".` : 'Nothing was saved (no changes, or the save was cancelled).' }
  },

  async execute(p, getHost) {
    if (!agentBridge.executeAllowed)
      throw new Error('Code execution is turned off in this editor (menu bar Agent chip > Allow code execution).')
    const h = ready(getHost)
    const scene = readScene(h)
    const logs: string[] = []
    const log = (...args: unknown[]) => { logs.push(args.map(a => typeof a === 'string' ? a : JSON.stringify(toSafe(a, scene.root))).join(' ')) }
    const find = (ref: string) => resolveNodeRef(scene, ref)
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor
    let fn: (...args: unknown[]) => Promise<unknown>
    try { fn = new AsyncFunction('cleo', 'engine', 'scene', 'editor', 'find', 'log', String(p.code)) } catch (err) {
      throw new Error(`The code does not parse: ${err instanceof Error ? err.message : String(err)}`)
    }
    const timeoutMs = p.timeoutMs ?? 30000
    const result = await Promise.race([
      h.history.transaction('Claude script', async () => fn(cleo, h.engine.instance, scene, h.engine, find, log)),
      sleep(timeoutMs).then(() => { throw new Error(`The code did not finish within ${timeoutMs} ms (it may still be running).`) }),
    ])
    h.engine.eventEmitter.emit('SCENE_CHANGED')
    const out = JSON.stringify(toSafe(result, scene.root), null, 1)
    return { text: `${logs.length ? `log:\n${logs.join('\n')}\n` : ''}result: ${out ?? 'undefined'}` }
  },
}

async function projectInfo(): Promise<{ id: string | null; name: string | null }> {
  try {
    const { activeProjectId } = await import('../../utils/projectScope')
    const { loadProjects } = await import('../../utils/projects')
    const id = activeProjectId() || null
    const name = id ? (await loadProjects()).find(p => p.id === id)?.name ?? null : null
    return { id, name }
  } catch { return { id: null, name: null } }
}
export { projectInfo }

/** Run one relayed tool call. Unknown methods and thrown errors come back as the call's error. */
export async function runCommand(method: string, params: unknown, getHost: GetHost): Promise<CommandResult> {
  const command = commands[method]
  if (!command) throw new Error(`This editor does not know the command "${method}". Is it older than the MCP server?`)
  try {
    return await command(params ?? {}, getHost)
  } catch (err) {
    // A bad node reference is the agent's to fix, not a crash: answer it as a tool error with the hint.
    if (err instanceof NodeRefError) return { text: err.message, isError: true }
    throw err
  }
}

// Exposed for tests.
export const __test = { normalizeShape, toSafe, isHiddenNode }
