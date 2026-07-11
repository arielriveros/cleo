import { ModelNode, AnimatedModel } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'

// Entry point to the Animation Editor mode, shown only for skinned models (an AnimatedModel with a
// skin + animator). Mirrors the skinned-mesh gate used by PhysicsEditor's Ragdoll section.
export default function AnimationSlot(props: { node: ModelNode }) {
  const { enterAnimationEditor } = useCleoEngine()

  const model = props.node.model
  const isSkinned = model instanceof AnimatedModel && model.hasSkin && !!props.node.animator
  if (!isSkinned) return null

  const clipCount = (model as AnimatedModel).animations.length

  return (
    <Collapsable title='Animation'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <p className='text-[11px] text-gray-400'>
          Skinned model — {clipCount} clip{clipCount === 1 ? '' : 's'}. Edit the skeleton, preview
          clips and author the animation state machine in the Animation Editor.
        </p>
        <button
          className='bg-[#326acc] hover:bg-[#2a59a9] rounded px-2 py-2 text-xs font-semibold text-white border border-[#274b8f]'
          onClick={() => enterAnimationEditor(props.node.id)}
          title='Open the Animation Editor for this skinned model'>
          ▶ Open Animation Editor
        </button>
      </div>
    </Collapsable>
  )
}
