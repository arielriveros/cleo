import type { Node } from 'cleo'
import { experimentalFeatureOfNodeType, experimentalNoteOf } from 'cleo'
import { FlaskIcon } from '@cleo/app-kit/ui'

/**
 * Over the inspector of a node whose feature is experimental (the engine's FeatureDef.experimental): it works as
 * documented, but its settings and look may still change between versions.
 */
export default function ExperimentalNotice({ node }: { node: Node | null | undefined }) {
  const f = node ? experimentalFeatureOfNodeType(node.nodeType) : undefined
  if (!f) return null
  return (
    <div className='flex items-start gap-1.5 text-ui-sm text-warning bg-warning/10 px-2 py-1'>
      <span className='inline-flex w-3.5 h-3.5 shrink-0 mt-0.5'><FlaskIcon /></span>
      <span>Experimental: {experimentalNoteOf(f)} It works as documented; expect changes.</span>
    </div>
  )
}
