import { Node } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint } from '../../../components/ui'
import { AnimationIcon } from '../sectionIcons'
import { ownSkinnedModelNodeOf } from '../../../utils/models'

// The one animation-related thing a model NODE owns: its state machine.
//
// ## Why this is all that is left here
//
// Clips belong to the `.rig` asset (`RigAsset.animationIds`), and so do blend spaces
// (`AnimationFieldAsset.rigId`). This section used to show both — a clip list, an `AnimationAssetPicker`
// and the field buttons — but all three read the rig THROUGH the model, which is the same data reached
// the long way round and a second place to reason about who owns a clip. They live in the rig editor now
// (`RigInspector`), which is where the ✎ on the Rig slot above leads.
//
// ## Why the machine does NOT move with them
//
// A state machine is per-NODE, not per-rig: `ModelNode._serializePayload` writes `payload.stateMachine`
// (src/core/scene/nodes/modelNode.ts), and two characters built on one armature legitimately run
// different machines over the same clips — a shambling zombie and a sprinting one share every clip and
// agree on nothing else. It also cannot be reached from anywhere but here: the animation tab is
// deliberately not restorable (see `tabState.ts`) and `openAsset` has no route to it, so this button is
// the only door.
export default function AnimationSlot(props: { node: Node }) {
  const { enterAnimationEditor } = useEditorSessions()

  const modelNode = ownSkinnedModelNodeOf(props.node)
  if (!modelNode) return null

  return (
    <Collapsable title='State Machine' icon={<AnimationIcon />} persistKey='animation'>
      <div className='w-full p-2 flex flex-col gap-2'>
        <Button variant='primary' className='w-full py-2' onClick={() => enterAnimationEditor(modelNode.id)}
          title='Edit which clip this character plays when — its states, transitions and parameters'>
          ▶ Open State Machine
        </Button>
        <Hint>Which clip plays when. The clips themselves belong to the <b>rig</b> above.</Hint>
      </div>
    </Collapsable>
  )
}
