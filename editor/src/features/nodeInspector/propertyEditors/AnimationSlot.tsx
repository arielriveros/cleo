import { Node, AnimatedModel } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint } from '../../../components/ui'
import { AnimationIcon } from '../sectionIcons'
import AnimationAssetPicker from '../../animation/AnimationAssetPicker'
import { skinnedModelNodeOf } from '../../../utils/models'

// Everything about the selected model's animation, in the inspector — clips, the shared `.anim` assets it
// plays, its blend spaces, and the way into the Animation Editor. Shows for any node that IS or CONTAINS a
// skinned model; the actions that need an asset adopt the subtree into the library on the way.
export default function AnimationSlot(props: { node: Node }) {
  const { enterAnimationEditor, createAnimationFieldForModel, enterAnimationFieldEditor, adoptModelAsset, resolveModelAssetId } = useEditorSessions()
  const { animationFields } = useAssetLibrary()

  const modelNode = skinnedModelNodeOf(props.node)
  if (!modelNode) return null

  const model = modelNode.model as AnimatedModel
  const clips = model.animations
  // Walks UP from the skinned node: an imported model is a holder with the ModelNode beneath it, so the
  // asset reference sits on the holder.
  const modelId = resolveModelAssetId(modelNode)
  const fields = modelId ? animationFields.filter(f => f.modelId === modelId) : []

  const newField = async () => {
    const id = await adoptModelAsset(props.node)
    if (id) createAnimationFieldForModel(id)
  }

  return (
    <Collapsable title='Animation' icon={<AnimationIcon />} badge={clips.length || undefined} persistKey='animation'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <Button variant='primary' className='w-full py-2' onClick={() => enterAnimationEditor(modelNode.id)}
          title='Open the Animation Editor for this skinned model'>
          ▶ Open Animation Editor
        </Button>

        <div className='flex flex-col gap-0.5'>
          {clips.length === 0 && <Hint>No clips yet — link one below, or import a file in the Animation Editor.</Hint>}
          {clips.map(c => (
            <div key={c.name} className='flex items-center gap-1 text-xs px-1 py-0.5'>
              <span className='truncate flex-1' title={c.name}>{c.name}</span>
              {/* A clip carrying an assetId came from a shared `.anim`; it is stored once in the library and
                  retargeted onto this rig, not embedded in this node. Worth distinguishing, because that is
                  what decides where renaming or deleting it has to happen. */}
              {c.assetId && <span className='text-[10px] text-muted shrink-0' title='From a linked animation asset'>linked</span>}
            </div>
          ))}
        </div>

        <div>
          <div className='text-[11px] text-muted mb-1'>Animations</div>
          <AnimationAssetPicker modelId={modelId ?? null} onNeedModel={() => adoptModelAsset(props.node)} />
        </div>

        <div className='flex flex-col gap-1'>
          {fields.map(f => (
            <Button key={f.id} variant='subtle' className='w-full py-1.5' onClick={() => enterAnimationFieldEditor(f.id)}
              title={`Open the "${f.name}" blend space`}>
              ⊞ {f.name}
            </Button>
          ))}
          <Button variant='subtle' className='w-full py-1.5' onClick={() => void newField()}
            title='Create a blend space that mixes this model’s clips by 1D or 2D parameters'>
            + New Animation Field
          </Button>
        </div>
      </div>
    </Collapsable>
  )
}
