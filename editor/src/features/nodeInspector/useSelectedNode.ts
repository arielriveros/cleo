import { useEffect, useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { isWithinTemplateInstance } from '../../utils/templates'

// Resolves the current selection independently for each of the Properties, Scripts and Physics panels.
export function useSelectedNode(): { node: Node | null, readOnly: boolean } {
  const { editorScene, selectedNode, editorMode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)

  useEffect(() => {
    setNode(editorScene && selectedNode ? editorScene.getNodeById(selectedNode) ?? null : null)
  }, [editorScene, selectedNode])

  // A placed template instance and its children are read-only in Scene mode, except their Transform.
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node)

  return { node, readOnly }
}

export function isRootNode(node: Node): boolean {
  return node.id === 'root' || node.name === 'root'
}
