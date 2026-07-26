import { Node, AnimatedModel } from 'cleo'
import { useState } from 'react'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useCleoEngine } from '../../EngineContext'
import { useEventBus } from '../../EventBusContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint } from '../../../components/ui'
import { AnimationIcon } from '../sectionIcons'
import { modelIdOf, skinnedModelNodeOf, skinnedModelJsonOf, MODEL_ID_VAR } from '../../../utils/models'

// Entry point to the Animation Editor mode, shown for any node that IS or CONTAINS a skinned model (an
// AnimatedModel with a skin + animator). Takes any Node and finds the skinned ModelNode in its subtree, so
// selecting a holder root — including a character's root inside a template — shows the section, not only the
// deep ModelNode child. Renders itself away when the subtree has no skinned model.
export default function AnimationSlot(props: { node: Node }) {
  const { enterAnimationEditor, createAnimationFieldForModel, enterAnimationFieldEditor } = useEditorSessions()
  const { animationFields } = useAssetLibrary()
  const { models } = useCleoEngine()
  const eventEmitter = useEventBus()
  const [, force] = useState(0)

  const modelNode = skinnedModelNodeOf(props.node)
  if (!modelNode) return null

  const model = modelNode.model as AnimatedModel
  const clipCount = model.animations.length

  // A field belongs to a MODEL ASSET, resolved by the `__modelId` back-link. modelIdOf WALKS UP from the
  // skinned model node: an imported model instantiates as a holder Node with the skinned ModelNode beneath it,
  // so `__modelId` is on the holder while the model node is the child.
  const modelId = modelIdOf(modelNode)
  const fields = modelId ? animationFields.filter(f => f.modelId === modelId) : []

  // Only skinned assets are worth linking a skinned model node to — a static model has no clips to blend.
  const skinnedAssets = models.filter(m => !!skinnedModelJsonOf(m.nodeJson))

  // Establish the missing asset link (older / imported models that never went through library placement carry
  // no `__modelId`, so modelIdOf finds nothing). Stamping it on THIS model node makes both the Animation Fields
  // and the Model-asset (Edit Model) section resolve; SCENE_CHANGED persists it and marks the tab dirty. It is
  // only a reference — the node's own geometry/clips are left as they are.
  const linkTo = (assetId: string) => {
    if (!assetId) return
    modelNode.setVariable(MODEL_ID_VAR, assetId, 'string')
    eventEmitter.emit('SCENE_CHANGED')
    force(x => x + 1)
  }

  return (
    <Collapsable title='Animation' icon={<AnimationIcon />} badge={clipCount || undefined} persistKey='animation'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <Hint>
          Skinned model — {clipCount} clip{clipCount === 1 ? '' : 's'}. Edit the skeleton, preview
          clips and author the animation state machine in the Animation Editor.
        </Hint>
        <Button variant='primary' className='w-full py-2' onClick={() => enterAnimationEditor(modelNode.id)}
          title='Open the Animation Editor for this skinned model'>
          ▶ Open Animation Editor
        </Button>

        {modelId ? <>
          {fields.map(f => (
            <Button key={f.id} variant='subtle' className='w-full py-1.5' onClick={() => enterAnimationFieldEditor(f.id)}
              title={`Open the "${f.name}" blend space`}>
              ⊞ {f.name}
            </Button>
          ))}
          <Button variant='subtle' className='w-full py-1.5' onClick={() => createAnimationFieldForModel(modelId)}
            title='Create a blend space that mixes this model’s clips by 1D or 2D parameters'>
            + New Animation Field
          </Button>
        </> : <>
          {/* No asset link: this model node was never placed from the library (an older / imported subtree), so
              its blend spaces can't be resolved. Let the user point it at the matching library asset once. */}
          <Hint>
            This model node isn’t linked to a model asset, so its Animation Fields can’t be shown. Link it to the
            matching library model to manage its blend spaces (and enable Edit Model). This only sets a
            reference — it won’t replace the node’s geometry.
          </Hint>
          {skinnedAssets.length > 0 ? (
            <select
              className='w-full bg-control text-white border border-border rounded px-2 py-1 text-xs'
              value=''
              onChange={e => linkTo(e.target.value)}>
              <option value=''>Link to a model asset…</option>
              {skinnedAssets.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          ) : (
            <Hint>No skinned model assets in the library to link to — import the character as a model first.</Hint>
          )}
        </>}
      </div>
    </Collapsable>
  )
}
