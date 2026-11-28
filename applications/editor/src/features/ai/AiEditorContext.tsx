import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { ControllerNode } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { AiBrainAsset, toRuntimeBrain } from '../../utils/aiBrains'

/**
 * The AI-brain tab's working copy, and what is selected inside it.
 *
 * ## Why the working copy is a detached ControllerNode
 *
 * `BehaviorEditor`, `GoalsEditor`, `FuzzyEditor` and the three graph canvases all take a
 * `ControllerNode` and read `.behavior` / `.goals` / `.fuzzy` off it. They were written that way when a
 * brain WAS a controller's own data, and they are careful about things that matter — every rename goes
 * through `aiGraphEdits` so a dangling reference is never silently dropped, every write goes through
 * the engine's tolerant parsers.
 *
 * Rather than rewrite all of that to take a bare asset, the tab holds a ControllerNode that belongs to
 * no scene and exists only to carry the asset's data. Every editor works unchanged, and the node is
 * copied back into the asset on each edit. This is the same trick the terrain-material tab already
 * plays with `editingTerrainMaterialNode`.
 *
 * The node is deliberately NOT in any scene: nothing steps it, nothing draws it, and it cannot be
 * selected. It is a bag of fields with the right shape.
 */

/**
 * What is selected inside the open brain.
 *
 * Keyed by NAME, never by array index — indices shift the moment something is removed, so an
 * index-keyed selection silently starts describing its neighbour. The one exception is a fuzzy rule,
 * which genuinely has no name; that canvas re-derives its indices from the model on every edit.
 */
export type AiSelection =
  | { kind: 'state'; name: string }
  | { kind: 'transition'; a: string; b: string }
  | { kind: 'goal'; name: string }
  | { kind: 'evaluator'; goalName: string }
  | { kind: 'fuzzyVar'; name: string }
  | { kind: 'fuzzySet'; variable: string; name: string }
  | { kind: 'fuzzyRule'; index: number }
  | null

/** Which half of a brain the tab is showing: its graph, or the fuzzy model both kinds can read. */
export type AiBrainView = 'graph' | 'fuzzy'

interface AiEditorSession {
  /** The asset being edited, or null when the active tab is not an AI brain. */
  asset: AiBrainAsset | null
  /**
   * The behaviour machine layer the canvas and the inspector show ('' the top level). A layer is shown through a
   * working node of its own whose machine is the layer's states and transitions over the brain's parameters, so
   * every editor edits it unchanged; `commit` writes it back into the layer.
   */
  layer: string
  setLayer: (layer: string) => void
  /** The brain's layers' names and states, and the top level's states (for Layer time and Layer state sources). */
  layers: { name: string; states: string[] }[]
  baseStates: string[]
  addLayer: () => void
  removeLayer: (name: string) => void
  renameLayer: (from: string, to: string) => void
  setLayerEnabled: (name: string, on: boolean) => void
  /** The working copy every editor and canvas reads. Null when there is no brain tab open. */
  target: ControllerNode | null
  view: AiBrainView
  setView: (view: AiBrainView) => void
  selection: AiSelection
  setSelection: (selection: AiSelection) => void
  version: number
  /** Copy the working node back into the asset, mark the tab dirty, and re-render every reader. */
  commit: () => void
  /** Rename the asset in place. Saved with everything else. */
  rename: (name: string) => void
}

const EMPTY: AiEditorSession = {
  asset: null, target: null, view: 'graph', setView: () => {},
  selection: null, setSelection: () => {}, version: 0, commit: () => {}, rename: () => {},
  layer: '', setLayer: () => {}, layers: [], baseStates: [], addLayer: () => {}, removeLayer: () => {}, renameLayer: () => {}, setLayerEnabled: () => {},
}

const AiEditorContext = createContext<AiEditorSession>(EMPTY)

export function useAiEditor(): AiEditorSession {
  return useContext(AiEditorContext)
}

export function AiEditorProvider({ children }: { children: React.ReactNode }) {
  const { aiBrains, editingAiBrainId, activeTab, markTabDirty, saveAiBrain, registerAiBrainApply } = useCleoEngine()
  const [view, setView] = useState<AiBrainView>('graph')
  const [selection, setSelection] = useState<AiSelection>(null)
  const [version, setVersion] = useState(0)
  const [layer, setLayerState] = useState('')
  // The layer's working node, rebuilt when the layer shown changes (or the brain does).
  const layerRef = useRef<{ key: string; node: ControllerNode } | null>(null)

  // The working copy, keyed by the asset it was seeded from. A ref rather than state: the editors
  // mutate the node in place and announce it through `commit`, exactly as they do for a scene node.
  const targetRef = useRef<{ id: string; node: ControllerNode } | null>(null)
  const [, forceSeed] = useState(0)

  const asset = editingAiBrainId ? aiBrains.find(b => b.id === editingAiBrainId) ?? null : null

  // Seeded when the tab changes to a different brain — NOT on every asset change, or an edit would
  // immediately overwrite the working copy that produced it.
  useEffect(() => {
    if (!asset) { targetRef.current = null; return }
    if (targetRef.current?.id === asset.id) return

    const node = new ControllerNode(asset.name)
    const runtime = toRuntimeBrain(asset)
    node.behavior = runtime.behavior
    node.goals = runtime.goals
    node.fuzzy = runtime.fuzzy
    node.brain = runtime.brain
    node.brainId = asset.id

    targetRef.current = { id: asset.id, node }
    layerRef.current = null
    setLayerState('')
    setSelection(null)
    setView('graph')
    forceSeed(n => n + 1)
  }, [asset])

  const base = asset && targetRef.current?.id === asset.id ? targetRef.current.node : null
  const layerData = base && layer ? base.behavior.layers?.find(l => l.name === layer) ?? null : null
  if (base && layerData && layerRef.current?.key !== `${base.id}|${layer}`) {
    const node = new ControllerNode(`${base.name} ▸ ${layer}`)
    node.behavior = { parameters: base.behavior.parameters, states: layerData.states, transitions: layerData.transitions }
    node.fuzzy = base.fuzzy
    node.brain = base.brain
    layerRef.current = { key: `${base.id}|${layer}`, node }
  }
  const target = base && layerData && layerRef.current ? layerRef.current.node : base

  /**
   * Write the working node back into the asset.
   *
   * Mutates the asset object rather than replacing it: the tab's save path reads the same object, and
   * routing every keystroke through the library's setState would re-embed into every live scene on
   * each one. The library is updated once, on save.
   */
  const commit = useCallback(() => {
    const node = targetRef.current?.node
    if (!asset || !node) return
    // A layer shown: its node's states and transitions back into the layer, its parameters (the brain's) back too.
    const view = layerRef.current
    if (layer && view && view.key === `${node.id}|${layer}`) {
      const v = view.node.behavior
      node.behavior = {
        ...node.behavior,
        parameters: v.parameters,
        layers: (node.behavior.layers ?? []).map(l => l.name === layer ? { ...l, states: v.states, transitions: v.transitions } : l),
      }
    }
    if (asset.kind === 'goals') asset.graph = node.goals
    else asset.machine = node.behavior
    asset.fuzzy = node.fuzzy
    setVersion(v => v + 1)
    markTabDirty(activeTab.id)
  }, [asset, activeTab.id, markTabDirty, layer])

  /** The brain's layers changed (added, removed, renamed): into the asset, and the layer view rebuilt. */
  const editLayers = useCallback((change: (layers: NonNullable<ControllerNode['behavior']['layers']>) => NonNullable<ControllerNode['behavior']['layers']>, show?: string) => {
    const node = targetRef.current?.node
    if (!asset || !node || asset.kind === 'goals') return
    node.behavior = { ...node.behavior, layers: change(node.behavior.layers ?? []) }
    if (!node.behavior.layers?.length) delete node.behavior.layers
    asset.machine = node.behavior
    layerRef.current = null
    if (show !== undefined) setLayerState(show)
    setSelection(null)
    setVersion(v => v + 1)
    markTabDirty(activeTab.id)
  }, [asset, activeTab.id, markTabDirty])

  const setLayer = useCallback((name: string) => { layerRef.current = null; setSelection(null); setLayerState(name) }, [])
  const addLayer = useCallback(() => {
    const taken = new Set((targetRef.current?.node.behavior.layers ?? []).map(l => l.name))
    let name = 'Layer'
    for (let i = 2; taken.has(name); i++) name = `Layer ${i}`
    editLayers(ls => [...ls, { name, states: [{ name: 'State', goal: 'idle', isEntry: true }], transitions: [] }], name)
  }, [editLayers])
  const removeLayer = useCallback((name: string) => editLayers(ls => ls.filter(l => l.name !== name), ''), [editLayers])
  const renameLayer = useCallback((from: string, to: string) => {
    const next = to.trim()
    const taken = new Set((targetRef.current?.node.behavior.layers ?? []).map(l => l.name))
    if (!next || next === from || taken.has(next)) return
    // A source reading the layer (Layer time, Layer state) follows it to its new name.
    const node = targetRef.current?.node
    if (node) node.behavior = {
      ...node.behavior,
      parameters: node.behavior.parameters.map(p => (p.source.kind === 'layerTime' || p.source.kind === 'layerState') && p.source.layer === from
        ? { ...p, source: { ...p.source, layer: next } } : p),
    }
    editLayers(ls => ls.map(l => l.name === from ? { ...l, name: next } : l), next)
  }, [editLayers])
  const setLayerEnabled = useCallback((name: string, on: boolean) =>
    editLayers(ls => ls.map(l => l.name === name ? (on ? (({ enabled: _drop, ...rest }) => rest)(l) : { ...l, enabled: false }) : l)), [editLayers])
  const layers = useMemo(() => (base?.behavior.layers ?? []).map(l => ({ name: l.name, states: l.states.map(s => s.name) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, version])
  const baseStates = useMemo(() => (base?.behavior.states ?? []).map(s => s.name),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, version])

  const rename = useCallback((name: string) => {
    if (!asset) return
    asset.name = name
    setVersion(v => v + 1)
    markTabDirty(activeTab.id)
  }, [asset, activeTab.id, markTabDirty])

  /**
   * Hand Ctrl+S a way to reach this working copy.
   *
   * `commit` has already written the node back into the asset object, and the library holds that same
   * object — so saving is just pushing it through `saveAiBrain`, which updates the library and
   * re-embeds the brain into every controller already holding an older copy.
   */
  useEffect(() => {
    if (!asset || activeTab.kind !== 'aiBrain') return
    const tabId = activeTab.id
    registerAiBrainApply({ tabId, apply: () => saveAiBrain(asset) })
    return () => registerAiBrainApply(null)
  }, [asset, activeTab.id, activeTab.kind, registerAiBrainApply, saveAiBrain])

  const value = useMemo<AiEditorSession>(() => ({
    asset, target, view, setView, selection, setSelection, version, commit, rename,
    layer, setLayer, layers, baseStates, addLayer, removeLayer, renameLayer, setLayerEnabled,
  }), [asset, target, view, selection, version, commit, rename, layer, setLayer, layers, baseStates, addLayer, removeLayer, renameLayer, setLayerEnabled])

  return <AiEditorContext.Provider value={value}>{children}</AiEditorContext.Provider>
}
