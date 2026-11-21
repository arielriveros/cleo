import * as cleo from 'cleo'
import { compileScript, type Node } from 'cleo'
import { TEMPLATE_ID_VAR } from '../../utils/templates'
import { MODEL_ID_VAR } from '../../utils/models'
import { getMaterialIdOf, MATERIAL_ID_VAR, applyMaterialAsset } from '../../utils/materials'
import { BASE_CLASS, buildScriptAsset, getScriptIdOf, type ScriptAsset, applyScriptAsset, unlinkScript } from '../../utils/scripts'
import { buildScriptGraphCtx, deriveBaseType, moduleIdOfVfsPath } from '../../utils/scriptGraph'
import { agentBridge } from './bridgeClient'
import {
  CancelledError, byName, editScene, notFound, readScene, ready, refIn, sleep, vec,
  type BridgeHost, type CommandResult, type GetHost,
} from './bridgeHost'
import { NodeRefError, isHiddenNode, nodePath, userChildren, walkUserNodes } from './nodeRefs'
import { elide, inspectorRows, outline, round, settableProps, simpleValue } from './inspect'
import { subtreeBounds } from './capture'
import { formatLogs, logCursor, readLogs } from './agentLogs'
import { typecheckScript, warmTypecheck } from './scriptCheck'
import { describeMaterial, formatMaterial, materialKind, upsertMaterial } from './materials'
import { takeCapture, withCapture } from './shots'
import { normalizeShape, sceneEdit, scriptsMapStep } from './sceneEdit'
import { playControl } from './play'
import { workspace } from './workspace'
import { LIBRARIES } from './libraries'
import { statusData } from './status'
import { applyTextEdits } from './textEdits'

// The editor side of every MCP tool (applications/mcp/src/tools.mjs names the methods). The bigger
// commands live beside this file (sceneEdit.ts, play.ts, workspace.ts, materials.ts, shots.ts); this is the
// registry and the small ones. Every command reads the editor through `getHost()` (bridgeHost.ts).

export type { BridgeHost, GetHost } from './bridgeHost'
export { projectInfo } from './status'

type Command = (params: any, getHost: GetHost, signal?: AbortSignal) => Promise<CommandResult>

/**
 * Methods that only read the editor: no history, no renderer, no camera, no selection. The bridge runs them
 * as they arrive instead of queueing them behind changes (bridgeClient.ts dispatch), so an agent's look at
 * the scene never waits on a capture, a Play run or a cold type check.
 */
export const CONCURRENT_METHODS = ['status', 'scene.tree', 'node.get', 'asset.list', 'logs.read', 'script.read'] as const

// --- reading nodes ---------------------------------------------------------------------------------------

/** Name tags for the outline: what the scene tree's icons say, plus what `with` asks for. */
function flagsFor(h: BridgeHost, withs: ReadonlySet<string>) {
  const { scriptAssets, scripts, templates, models, materials, tilesets, sequences, particleSystems } = h.engine
  return (n: Node): string[] => {
    const out: string[] = []
    const sid = getScriptIdOf(n)
    if (sid) out.push(`script=${scriptAssets.find(a => a.id === sid)?.name ?? '?'}`)
    else if (scripts.has(n.id)) out.push('script=(inline)')
    // A collider's type is in the outline already; whether it falls is not.
    if (n instanceof cleo.ColliderNode || n instanceof cleo.Body2DNode) out.push(n.mass > 0 ? `mass=${n.mass}` : 'static')
    const tid = n.getVariable(TEMPLATE_ID_VAR)
    if (typeof tid === 'string') out.push(`template=${templates.find(t => t.id === tid)?.name ?? '?'}`)
    const mid = n.getVariable(MODEL_ID_VAR)
    if (typeof mid === 'string') out.push(`model=${models.find(m => m.id === mid)?.name ?? '?'}`)
    const matId = n.getVariable(MATERIAL_ID_VAR)
    if (typeof matId === 'string') out.push(`material=${materials.find(m => m.id === matId)?.name ?? '?'}`)
    if (n instanceof cleo.SpriteNode && n.tileset) out.push(`tileset=${tilesets.find(t => t.id === n.tileset!.id)?.name ?? n.tileset.id}`)
    if (n instanceof cleo.SequenceNode && n.sequenceId) out.push(`sequence=${sequences.find(q => q.id === n.sequenceId)?.name ?? '?'}`)
    if (n instanceof cleo.ParticleSystemNode && n.particleSystemId) out.push(`particles=${particleSystems.find(q => q.id === n.particleSystemId)?.name ?? '?'}`)
    if (!n.visible) out.push('hidden')
    if (withs.has('pos')) out.push(`@[${Array.from(n.worldPosition, x => round(x, 2)).join(',')}]`)
    if (withs.has('size')) {
      const b = subtreeBounds(n)
      if (b) out.push(`size=[${b.size.map(x => round(x, 2)).join(',')}]`)
    }
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

const NODE_FIELDS = ['transform', 'bounds', 'children', 'script', 'material', 'shapes', 'variables', 'props', 'inspector', 'assets'] as const

/** What a node links and plays from the libraries: tileset, clips, sequence, effect, tilemap layers. */
function nodeAssets(h: BridgeHost, node: Node): Record<string, unknown> | null {
  const e = h.engine
  const out: Record<string, unknown> = {}
  const tid = node.getVariable(TEMPLATE_ID_VAR)
  if (typeof tid === 'string') out.template = e.templates.find(t => t.id === tid)?.name ?? tid
  const mid = node.getVariable(MODEL_ID_VAR)
  if (typeof mid === 'string') out.model = e.models.find(m => m.id === mid)?.name ?? mid
  if (node instanceof cleo.SpriteNode) out.tileset = node.tileset ? (e.tilesets.find(t => t.id === node.tileset!.id)?.name ?? node.tileset.id) : null
  if (node instanceof cleo.AnimatedSpriteNode && node.clipNames.length)
    out.clips = { names: node.clipNames, playing: node.clip, state: node.state }
  if (node instanceof cleo.SequenceNode)
    out.sequence = { name: node.sequenceId ? (e.sequences.find(q => q.id === node.sequenceId)?.name ?? node.sequenceId) : '(embedded copy)', duration: round(node.sequence?.duration ?? 0, 2) }
  if (node instanceof cleo.ParticleSystemNode)
    out.particleSystem = node.particleSystemId ? (e.particleSystems.find(q => q.id === node.particleSystemId)?.name ?? node.particleSystemId) : '(embedded copy)'
  if (node instanceof cleo.TilemapNode)
    out.layers = node.tilemap.layers.map(l => ({ name: l.cfg.name, tileset: l.cfg.tilesetId ? (e.tilesets.find(t => t.id === l.cfg.tilesetId)?.name ?? l.cfg.tilesetId) : null }))
  return Object.keys(out).length ? out : null
}

async function describeNode(h: BridgeHost, node: Node, fields: ReadonlySet<string>, json: boolean): Promise<Record<string, unknown>> {
  const scene = readScene(h)
  const data: Record<string, unknown> = {
    path: nodePath(node, scene.root), id: node.id, name: node.name, type: node.nodeType,
    parent: node.parent ? nodePath(node.parent, scene.root) : null,
  }
  if (fields.has('transform')) Object.assign(data, {
    position: vec(node.position), rotation: vec(node.rotation), scale: vec(node.scale), visible: node.visible,
    worldPosition: vec(node.worldPosition),
  })
  if (fields.has('bounds')) {
    // World-space box of the node and its children: what placing things next to it needs.
    const b = subtreeBounds(node)
    data.bounds = b ? { center: vec(b.center), size: vec(b.size), min: vec(b.min), max: vec(b.max) } : null
  }
  if (fields.has('children')) data.children = userChildren(node).map(c => `${c.name} [${c.nodeType}]`)
  if (fields.has('script')) {
    const sid = getScriptIdOf(node)
    const asset = sid ? h.engine.scriptAssets.find(a => a.id === sid) : undefined
    data.script = asset
      ? { name: asset.name, extends: BASE_CLASS[asset.baseType] ?? asset.baseType, fields: Object.fromEntries(asset.variables.filter(v => !v.hidden).map(v => [v.name, simpleValue((node as any)[v.name]) ?? toSafe((node as any)[v.name], scene.root)])) }
      : (h.engine.scripts.has(node.id) ? { inline: true } : null)
  }
  if (fields.has('shapes') && (node instanceof cleo.ColliderNode || node instanceof cleo.TriggerNode)) data.shapes = elide(node.shapes)
  if (fields.has('material')) {
    const matId = getMaterialIdOf(node)
    const asset = matId ? h.engine.materials.find(m => m.id === matId) : undefined
    data.material = asset ? describeMaterial(asset, h.engine.textures) : (matId ?? null)
  }
  if (fields.has('assets')) { const a = nodeAssets(h, node); if (a) data.assets = a }
  if (fields.has('variables')) {
    // Straight from the node: serializing it would walk (and copy the buffers of) its whole subtree.
    data.variables = Object.fromEntries([...node.variables].filter(([k]) => !k.startsWith('__')).map(([k, v]) => [k, simpleValue(v?.value) ?? toSafe(v?.value, scene.root)]))
  }
  if (fields.has('props')) data.props = settableProps(node)
  if (fields.has('inspector')) { const rows = inspectorRows(node); if (Object.keys(rows).length) data.inspector = rows }
  if (json) {
    const j = await node.serialize()
    data.json = elide({ ...j, children: (j.children ?? []).map((c: any) => `${c.name} [${c.type}]`) })
  }
  return data
}

// --- scripts ---------------------------------------------------------------------------------------------

async function scriptWrite(p: any, getHost: GetHost): Promise<CommandResult> {
  const h = ready(getHost)
  const name = String(p.name).trim()
  const lib = h.engine.scriptAssets
  const existing = byName(lib, name)
  if (p.source && p.edits) throw new Error('Give source (the whole script) or edits (replacements), not both.')
  if (!p.source && !p.edits) throw new Error('script_write needs source, or edits to patch an existing script.')
  if (p.edits && !existing) throw notFound('script to patch', name, lib)
  const source = p.edits ? applyTextEdits(existing!.source, p.edits) : String(p.source)
  const pathOf = (id: string) => {
    const vfsPath = h.engine.scriptPaths.get(id)
    return vfsPath ? moduleIdOfVfsPath(vfsPath) : undefined
  }
  // Attaching changes the scene, so where it would land is checked before anything is saved.
  const scene = p.attach?.length ? editScene(h) : null

  // The runtime's own compile: syntax and the module shapes it supports, exactly as Play will run it.
  let compileError: string | null = null
  try { compileScript(source, { path: existing ? pathOf(existing.id) : `/${name}` }) } catch (err) { compileError = err instanceof Error ? err.message : String(err) }

  const graph = buildScriptGraphCtx(h.engine.scriptPaths, lib)
  const label = `${existing ? 'Edit' : 'New'} script ${existing?.name ?? name}`
  let asset!: ScriptAsset
  const attached: string[] = []
  const attachErrors: string[] = []
  // One undo step: the asset (created, or its source changed) under the attachments it serves.
  await h.history.transaction(label, async track => {
    if (existing) {
      const before = existing.source
      // saveScriptSource re-derives the asset (and the scripts that extend it) and re-seeds every node using it.
      h.engine.saveScriptSource(existing.id, source)
      const derived = deriveBaseType(source, pathOf(existing.id), graph)
      asset = buildScriptAsset(existing.name, existing.baseType === 'node' && derived !== 'node' ? derived : existing.baseType, source, existing.id)
      h.history.pushFirst({
        label,
        undo: () => getHost().engine.saveScriptSource(existing.id, before),
        redo: () => getHost().engine.saveScriptSource(existing.id, source),
      })
    } else {
      asset = buildScriptAsset(name, deriveBaseType(source, undefined, graph), source)
      const made = asset
      h.engine.addScriptAsset(made)
      h.history.pushFirst({
        label,
        undo: () => getHost().engine.removeScriptAsset(made.id),
        redo: () => getHost().engine.addScriptAsset(made),
      })
    }
    for (const ref of p.attach ?? []) {
      try {
        const node = refIn(h, scene!, ref)
        await track(node)
        const record = scriptsMapStep(h, node.id, label)
        const previous = getScriptIdOf(node)
        if (previous && previous !== asset.id) unlinkScript(node, lib.find(a => a.id === previous), h.engine.scripts)
        const ok = applyScriptAsset(node, asset, h.engine.scripts)
        record()
        if (!ok) { attachErrors.push(`${ref}: a ${node.nodeType} node cannot take a script that extends ${asset.baseType}`); continue }
        h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'script', node })
        attached.push(nodePath(node, scene!.root))
      } catch (err) { attachErrors.push(`${ref}: ${err instanceof Error ? err.message : String(err)}`) }
    }
  })

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
    `${existing ? (p.edits ? `Patched (${p.edits.length} edit${p.edits.length === 1 ? '' : 's'})` : 'Updated') : 'Created'} script "${asset.name}" `
      + `(${asset.kind === 'module' ? 'module' : `class extends ${BASE_CLASS[asset.baseType] ?? asset.baseType}, attaches to ${asset.baseType === 'node' ? 'any node' : `${asset.baseType} nodes`}`}). One undo step.`,
    fields.length ? `Public fields (per-node inspector values): ${fields.map(v => `${v.name}: ${v.type} = ${JSON.stringify(v.default)}`).join('; ')}` : 'No public fields.',
    compileError ? `Runtime compile FAILED: ${compileError}` : 'Runtime compile: ok.',
    typeReport,
  ]
  if (attached.length) lines.push(`Attached to: ${attached.join(', ')}.`)
  if (attachErrors.length) lines.push(`Not attached: ${attachErrors.join('; ')}`)
  return { text: lines.join('\n'), isError: !!compileError || attachErrors.length > 0 }
}

// --- commands ------------------------------------------------------------------------------------------

const commands: Record<string, Command> = {
  async status(_p, getHost) {
    return { data: await statusData(getHost) }
  },

  async 'scene.tree'(p, getHost) {
    const h = ready(getHost)
    const e = h.engine
    const scene = readScene(h)
    const root = p.root ? refIn(h, scene, p.root) : scene.root
    const withs = new Set<string>(p.with ?? [])
    const { text } = outline(scene, {
      root, depth: p.depth ?? 4, limit: p.limit ?? 300, type: p.type, name: p.name, flags: flagsFor(h, withs), ids: withs.has('id'),
    })
    // The header answers what editor_status would, for the questions a look at the tree comes with.
    const where = e.isPlayMode ? `the running game (${e.isSimulating ? 'simulate' : 'play'})` : `"${e.activeTab?.title ?? 'scene'}"`
    const selected = e.selectedNode ? scene.getNodeById(e.selectedNode) : null
    const head = [`Scene tree of ${where}`, `${e.sceneDimension} scene`, `selected: ${selected ? nodePath(selected, scene.root) : 'nothing'}`]
    if (!e.isPlayMode && e.dirtyTabs[e.activeTabId]) head.push('unsaved changes')
    return { text: `${head.join(' · ')}\n${text}` }
  },

  async 'node.get'(p, getHost) {
    const h = ready(getHost)
    const scene = readScene(h)
    if (p.node && p.nodes) throw new Error('Give node or nodes, not both.')
    const refs: string[] = p.nodes ?? (p.node ? [p.node] : [])
    if (!refs.length) throw new Error('node_get needs node (or nodes).')
    const fields = new Set<string>(p.fields ?? NODE_FIELDS)
    if (!p.nodes) return { data: await describeNode(h, refIn(h, scene, refs[0]), fields, !!p.json) }
    const out: unknown[] = []
    for (const ref of refs) {
      try { out.push(await describeNode(h, refIn(h, scene, ref), fields, !!p.json)) } catch (err) {
        if (!(err instanceof NodeRefError)) throw err
        out.push({ ref, error: err.message })
      }
    }
    return { data: out }
  },

  'scene.edit': sceneEdit,

  'script.write': scriptWrite,

  async 'script.read'(p, getHost) {
    const h = ready(getHost)
    const asset = byName(h.engine.scriptAssets, p.name)
    if (!asset) throw notFound('script', p.name, h.engine.scriptAssets)
    const scene = h.engine.mainScene
    const users: string[] = []
    walkUserNodes(scene.root, n => { if (getScriptIdOf(n) === asset.id) users.push(nodePath(n, scene.root)) })
    const fields = asset.variables.filter(v => !v.hidden).map(v => `${v.name}: ${typeof v.type === 'string' ? v.type : cleo.propertyTypeLabel(v.type)} = ${JSON.stringify(v.default)}`)
    return {
      text: `Script "${asset.name}" (${asset.kind === 'module' ? 'module' : `extends ${BASE_CLASS[asset.baseType] ?? asset.baseType}`}), path ${h.engine.scriptPaths.get(asset.id) ?? '(not in a folder)'}\n`
        + `Fields: ${fields.join('; ') || 'none'}\nUsed by (open scene): ${users.join(', ') || 'none'}\n\n${asset.source}`,
    }
  },

  async 'material.write'(p, getHost, signal) {
    const h = ready(getHost)
    // Assigning changes the scene; the library change alone may happen from any tab.
    const scene = p.assignTo?.length ? editScene(h) : null
    const label = `Material ${p.name}`
    let res!: ReturnType<typeof upsertMaterial>
    const assigned: string[] = []
    await h.history.transaction(label, async track => {
      res = upsertMaterial(h, getHost, p.name, p, { label })
      for (const ref of p.assignTo ?? []) {
        const node = refIn(h, scene!, ref)
        await track(node)
        if (!applyMaterialAsset(node, res.asset)) throw new Error(`"${node.name}" cannot take material "${res.asset.name}".`)
        h.engine.eventEmitter.emit('SCENE_CHANGED', { kind: 'material', node })
        assigned.push(nodePath(node, scene!.root))
      }
    }, { atomic: true })
    h.engine.eventEmitter.emit('TEXTURES_CHANGED')
    const kind = materialKind(res.asset.material)
    return withCapture({
      text: `${res.created ? 'Created' : 'Updated'} material "${res.asset.name}" (${kind}${res.retyped ? `, was another type: its colour was kept` : ''}); `
        + `${res.created ? '' : 'every node using it shows the change; '}one undo step.`
        + (assigned.length ? ` Assigned to ${assigned.join(', ')}.` : '')
        + `\n${formatMaterial(describeMaterial(res.asset, h.engine.textures))}`,
    }, p.capture, getHost, undefined, signal)
  },

  async 'asset.list'(p, getHost) {
    const h = ready(getHost)
    const q = p.query?.toLowerCase()
    const lines: string[] = []
    for (const [kind, list] of Object.entries(LIBRARIES)) {
      if (p.kind && kind !== p.kind) continue
      const items = list(h.engine)
      const hits = q ? items.filter(i => i.name.toLowerCase().includes(q)) : items
      if (!hits.length && !p.kind) continue
      const shown = hits.slice(0, 200).map(i => `${i.name}${i.note ? ` (${i.note})` : ''}${p.ids ? ` #${i.id}` : ''}`)
      lines.push(`${kind} (${hits.length}): ${shown.join(', ') || 'none'}${hits.length > 200 ? ', …' : ''}`)
    }
    return { text: lines.join('\n') || 'No assets match.' }
  },

  async 'view.capture'(p, getHost, signal) {
    // After a camera jump, temporal AA and motion blur smear the old view in for a few frames: takeCapture
    // lets them settle when it frames a node.
    const shot = await takeCapture(getHost, p, { defaultMax: 1024, signal })
    return { text: shot.text, images: [shot.image] }
  },

  async 'logs.read'(p) {
    const entries = readLogs({ since: p.since, level: p.level, scope: p.scope, limit: p.limit ?? 60 })
    const cursor = logCursor()
    return { text: `${entries.length ? formatLogs(entries) : 'No log entries' + (p.since !== undefined ? ' since that cursor.' : '.')}\ncursor: ${cursor}` }
  },

  'play.control': playControl,

  workspace,

  async history(p, getHost) {
    // Undo acts on the edited scene, which the running game is a copy of: Ctrl+Z is off during Play too.
    if (p.action !== 'status' && getHost().engine.isPlayMode)
      throw new Error('The game is running: undo and redo act on the edited scene, so stop first (play_control {"action":"stop"}).')
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
    const find = (ref: string) => refIn(h, scene, ref)
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor
    let fn: (...args: unknown[]) => Promise<unknown>
    try { fn = new AsyncFunction('cleo', 'engine', 'scene', 'editor', 'find', 'log', 'track', String(p.code)) } catch (err) {
      throw new Error(`The code does not parse: ${err instanceof Error ? err.message : String(err)}`)
    }
    const timeoutMs = p.timeoutMs ?? 30000
    const result = await Promise.race([
      // `track(node)` snapshots a node before the code changes it, so its property changes undo with the run.
      h.history.transaction('Claude script', async track => fn(cleo, h.engine.instance, scene, h.engine, find, log, track)),
      sleep(timeoutMs).then(() => { throw new Error(`The code did not finish within ${timeoutMs} ms (it may still be running).`) }),
    ])
    h.engine.eventEmitter.emit('SCENE_CHANGED')
    const out = JSON.stringify(toSafe(result, scene.root), null, 1)
    return { text: `${logs.length ? `log:\n${logs.join('\n')}\n` : ''}result: ${out ?? 'undefined'}` }
  },
}

/** The methods this editor answers; the MCP side's tools must name only these (tests check it). */
export const COMMAND_METHODS = Object.keys(commands)

let warmScheduled = false

/** Run one relayed tool call. Unknown methods and thrown errors come back as the call's error. */
export async function runCommand(method: string, params: unknown, getHost: GetHost, signal?: AbortSignal): Promise<CommandResult> {
  const command = commands[method]
  if (!command) throw new Error(`This editor does not know the command "${method}". Is it older than the MCP server? Reload the editor.`)
  // An agent is at work: load the script type checker in the background, so its first script_write does not
  // spend seconds on it. Not at link time: a dev editor links whether or not any agent ever calls.
  if (!warmScheduled) {
    warmScheduled = true
    window.setTimeout(() => {
      const e = getHost().engine
      const pathOf = (id: string) => { const p = e.scriptPaths.get(id); return p ? moduleIdOfVfsPath(p) : undefined }
      void warmTypecheck(e.scriptAssets, pathOf)
    }, 1500)
  }
  try {
    return await command(params ?? {}, getHost, signal)
  } catch (err) {
    // A bad node reference is the agent's to fix, not a crash: answer it as a tool error with the hint.
    if (err instanceof NodeRefError || err instanceof CancelledError) return { text: err.message, isError: true }
    throw err
  }
}

// Exposed for tests.
export const __test = { normalizeShape, toSafe, isHiddenNode }
