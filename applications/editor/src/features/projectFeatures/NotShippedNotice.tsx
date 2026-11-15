import type { Node } from 'cleo'
import { useProjectFeatures } from './featureUi'

/**
 * Over the inspector of a node whose feature the project leaves out (Project ▸ Features): it stays in the
 * scene and keeps working in the editor, but a published game drops it.
 */
export default function NotShippedNotice({ node }: { node: Node | null | undefined }) {
  const off = useProjectFeatures().offFeatureOfNodeType(node?.nodeType)
  if (!off) return null
  return (
    <div className='text-ui-sm text-warning bg-warning/15 px-2 py-1'>
      Not shipped: this project leaves the {off.label} feature out of its games (Project ▸ Features). The node stays
      in the scene; a published game drops it.
    </div>
  )
}
