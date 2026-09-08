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
    setSelection(null)
    setView('graph')
    forceSeed(n => n + 1)
  }, [asset])

  const target = asset && targetRef.current?.id === asset.id ? targetRef.current.node : null

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
    if (asset.kind === 'goals') asset.graph = node.goals
    else asset.machine = node.behavior
    asset.fuzzy = node.fuzzy
    setVersion(v => v + 1)
    markTabDirty(activeTab.id)
  }, [asset, activeTab.id, markTabDirty])

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
  }), [asset, target, view, selection, version, commit, rename])

  return <AiEditorContext.Provider value={value}>{children}</AiEditorContext.Provider>
}
