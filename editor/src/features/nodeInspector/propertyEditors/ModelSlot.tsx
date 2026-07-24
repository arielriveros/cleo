import { Node } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint, valueClass } from '../../../components/ui'
import { ShapeIcon } from '../sectionIcons'
import { modelIdOf, modelInstanceRootOf } from '../../../utils/models'

// The model-asset reference for a placed model instance: which asset this subtree came from, and a way in.
//
// It exists because the split is not obvious from the node alone. What you see in the viewport is a COPY of
// the asset's subtree, but it carries a `__modelId` back-link, and that link decides where an edit lands:
// geometry, materials and animation clips belong to the ASSET (edit them once, every placement follows),
// while this node's transform, name, scripts and physics are per-placement. Without something saying so, the
// only way to find out is to edit one and watch what does or does not propagate.
export default function ModelSlot(props: { node: Node }) {
  const { models, enterModelEditor } = useCleoEngine()

  // Walks up: an imported model instantiates as a holder Node with the ModelNodes beneath it, so the link
  // sits on an ancestor of whichever node is actually selected.
  const modelId = modelIdOf(props.node)
  if (!modelId) return null

  const asset = models.find(m => m.id === modelId)
  const root = modelInstanceRootOf(props.node)
  const isRoot = root === props.node

  return (
    <Collapsable title='Model asset' icon={<ShapeIcon />} persistKey='modelSlot'>
      <div className='w-full p-2 flex flex-col gap-2'>
        {asset ? <>
          <div className={valueClass}>{asset.name}</div>
          <Hint>
            Geometry, materials and animation clips live on this asset — editing them here updates every
            placement of it. This node&apos;s transform{isRoot ? '' : ', name'}, scripts and physics are
            per-placement and stay local.
          </Hint>
          <Button variant='subtle' className='w-full py-1.5' onClick={() => enterModelEditor(modelId)}
            title={`Open "${asset.name}" in the model editor`}>
            Edit Model
          </Button>
        </> : (
          // The link outlives the asset on purpose — deleting a model leaves placed copies alone (see
          // deleteConsequence) — so a dangling id means the copy still renders but nothing propagates to it.
          <Hint>
            This was placed from a model asset that no longer exists, so it is now a plain subtree: edits to
            it stay local and nothing will propagate in.
          </Hint>
        )}
      </div>
    </Collapsable>
  )
}
