import { ModelNode, AnimatedModel } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint } from '../../../components/ui'
import { AnimationIcon } from '../sectionIcons'
import { modelIdOf } from '../../../utils/models'

// Entry point to the Animation Editor mode, shown only for skinned models (an AnimatedModel with a
// skin + animator). Mirrors the skinned-mesh gate used by PhysicsEditor's Ragdoll section.
export default function AnimationSlot(props: { node: ModelNode }) {
  const { enterAnimationEditor, createAnimationFieldForModel, enterAnimationFieldEditor } = useEditorSessions()
  const { animationFields } = useAssetLibrary()

  const model = props.node.model
  const isSkinned = model instanceof AnimatedModel && model.hasSkin && !!props.node.animator
  if (!isSkinned) return null

  const clipCount = (model as AnimatedModel).animations.length

  // A field belongs to a MODEL ASSET, not to this placed node, so the button is only offered when the node
  // is a placed instance of one. A node built by hand (or imported straight into the scene) has no asset
  // for a field to reference.
  //
  // modelIdOf WALKS UP: an imported model instantiates as a holder Node with the skinned ModelNode beneath
  // it, so `__modelId` is on the parent while this node — the only one the animation UI applies to — is the
  // child. Reading the variable off this node alone finds nothing for every normally-imported character.
  const modelId = modelIdOf(props.node)
  const fields = modelId ? animationFields.filter(f => f.modelId === modelId) : []

  return (
    <Collapsable title='Animation' icon={<AnimationIcon />} badge={clipCount || undefined} persistKey='animation'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <Hint>
          Skinned model — {clipCount} clip{clipCount === 1 ? '' : 's'}. Edit the skeleton, preview
          clips and author the animation state machine in the Animation Editor.
        </Hint>
        <Button variant='primary' className='w-full py-2' onClick={() => enterAnimationEditor(props.node.id)}
          title='Open the Animation Editor for this skinned model'>
          ▶ Open Animation Editor
        </Button>

        {modelId && <>
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
        </>}
      </div>
    </Collapsable>
  )
}
