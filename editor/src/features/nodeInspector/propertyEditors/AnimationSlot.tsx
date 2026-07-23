import { ModelNode, AnimatedModel } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint } from '../../../components/ui'
import { AnimationIcon } from '../sectionIcons'

// Entry point to the Animation Editor mode, shown only for skinned models (an AnimatedModel with a
// skin + animator). Mirrors the skinned-mesh gate used by PhysicsEditor's Ragdoll section.
export default function AnimationSlot(props: { node: ModelNode }) {
  const { enterAnimationEditor } = useEditorSessions()

  const model = props.node.model
  const isSkinned = model instanceof AnimatedModel && model.hasSkin && !!props.node.animator
  if (!isSkinned) return null

  const clipCount = (model as AnimatedModel).animations.length

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
      </div>
    </Collapsable>
  )
}
