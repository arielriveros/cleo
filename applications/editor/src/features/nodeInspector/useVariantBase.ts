import { Node } from 'cleo'
import { useEditorSessions } from '../EditorSessionsContext'
import { useCleoEngine } from '../EngineContext'
import { pathOf } from '../../utils/templateOverrides'
import { baseNodeAt } from '../../utils/templateVariants'

/**
 * Where a node in an open VARIANT tab comes from: the serialized base node it inherits (to compare a value
 * against, or revert to), or 'added' for a node the variant introduced. Null outside a variant tab.
 */
export function useVariantBase(node: Node | null): { baseName: string; baseNode: any | 'added'; path: string } | null {
  const { editingTemplateVariant, templateRootId } = useEditorSessions()
  const { editorScene } = useCleoEngine()
  if (!node || !editingTemplateVariant || !templateRootId || !editorScene) return null
  const root = editorScene.getNodeById(templateRootId)
  const path = root ? pathOf(root, node) : null
  if (path === null) return null
  const baseNode = baseNodeAt(editingTemplateVariant.base, editingTemplateVariant.diff, path)
  return baseNode === null ? null : { baseName: editingTemplateVariant.baseName, baseNode, path }
}
