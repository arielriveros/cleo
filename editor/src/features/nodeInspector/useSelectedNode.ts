import { useEffect, useState } from 'react'
import { Node } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { isWithinTemplateInstance } from '../../utils/templates'

// Shared by the Properties, Scripts and Physics panels: each is its own dock panel now, so each
// resolves the selection independently instead of being handed a node by a common parent.
export function useSelectedNode(): { node: Node | null, readOnly: boolean } {
  const { editorScene, selectedNode, editorMode } = useCleoEngine()
  const [node, setNode] = useState<Node | null>(null)

  useEffect(() => {
    setNode(editorScene && selectedNode ? editorScene.getNodeById(selectedNode) ?? null : null)
  }, [editorScene, selectedNode])

  // A placed template instance (and its children) is read-only in Scene mode, except its Transform.
  // Template mode itself stays fully editable (that's where the template is authored).
  const readOnly = editorMode === 'scene' && !!node && isWithinTemplateInstance(node)

  return { node, readOnly }
}

export function isRootNode(node: Node): boolean {
  return node.id === 'root' || node.name === 'root'
}
