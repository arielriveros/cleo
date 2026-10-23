import { useEffect, useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { isWithinTemplateInstance } from '../../utils/templates'

/** How often the Inspector re-reads live values while a Simulate session runs. */
const LIVE_REFRESH_MS = 250

// Resolves the current selection independently for each of the Properties, Scripts and Physics panels.
//
// While Simulating, the selection lives in the running play scene (`inspectedScene`), and everything but the
// Transform is read-only: those sections write the editor's persistent stores (bodies, scripts, materials),
// which would leak a throwaway session's edits into the authored scene. `simulating` lets a panel say so.
export function useSelectedNode(): { node: Node | null, readOnly: boolean, simulating: boolean } {
  const { inspectedScene, selectedNode, editorMode, isSimulating } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)

  useEffect(() => {
    setNode(inspectedScene && selectedNode ? inspectedScene.getNodeById(selectedNode) ?? null : null)
  }, [inspectedScene, selectedNode])

  // A placed template instance and its children are read-only in Scene mode, except their Transform.
  const readOnly = isSimulating || (editorMode === 'scene' && !!node && isWithinTemplateInstance(node))

  return { node, readOnly, simulating: isSimulating }
}

/**
 * A counter that ticks while a Simulate session runs, for editors that show values the simulation moves
 * every frame (a transform, a body's state). Zero and inert otherwise, so authoring pays nothing.
 */
export function useLiveTick(): number {
  const { isSimulating } = useCleoEngine()
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!isSimulating) return
    const id = window.setInterval(() => setTick(t => t + 1), LIVE_REFRESH_MS)
    return () => window.clearInterval(id)
  }, [isSimulating])
  return isSimulating ? tick : 0
}

export function isRootNode(node: Node): boolean {
  return node.id === 'root' || node.name === 'root'
}
