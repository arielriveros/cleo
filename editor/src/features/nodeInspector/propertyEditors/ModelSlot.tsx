import { Node } from 'cleo'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useDocument } from '../../DocumentContext'
import Collapsable from '../../../components/Collapsable'
import { Button, valueClass } from '../../../components/ui'
import { ShapeIcon } from '../sectionIcons'
import { modelIdOf, modelNodeOf } from '../../../utils/models'

// The way into the model editor from a node that has geometry. Renders for anything with geometry, adopting
// the subtree into the library on the way in when it has no asset yet.
export default function ModelSlot(props: { node: Node }) {
  const { models } = useAssetLibrary()
  const { enterModelEditor, adoptModelAsset } = useEditorSessions()
  const { activeTab } = useDocument()

  // Inside a model tab this is the thing being edited, so a button that opens it is noise.
  if (activeTab.kind === 'model') return null

  // Walks down: an imported model is a holder Node with its ModelNodes beneath it, so the selected node
  // alone cannot answer whether the selection contains geometry.
  if (!modelNodeOf(props.node)) return null

  const asset = models.find(m => m.id === modelIdOf(props.node))

  const edit = async () => {
    const id = await adoptModelAsset(props.node)
    if (id) enterModelEditor(id)
  }

  return (
    <Collapsable title='Model' icon={<ShapeIcon />} persistKey='modelSlot'>
      <div className='w-full p-2 flex flex-col gap-2'>
        {asset && <div className={valueClass}>{asset.name}</div>}
        <Button variant='subtle' className='w-full py-1.5' onClick={() => void edit()}
          title={asset ? `Open "${asset.name}" in the model editor` : 'Open this model in the model editor'}>
          Edit Model
        </Button>
      </div>
    </Collapsable>
  )
}
