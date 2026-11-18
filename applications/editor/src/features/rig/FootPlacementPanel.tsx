import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget } from '../animation/skeleton'
import { QUERY_SELECTED_JOINT } from '../animation/SkeletonTree'
import IkRigPanel from '../animation/IkRigPanel'
import { Hint } from '@cleo/app-kit/ui'

// The Skeleton part's Foot Placement tab: the skeleton's foot IK (legs, tuning, locking and its blending), a tab of
// its own beside Skeleton so it gets the whole rail, while the bone tree on the left stays up for the
// click-a-bone-then-a-role gesture. Like the Ragdoll tab, it unmounts behind another tab and asks the tree which
// bone is selected when it comes back (QUERY_SELECTED_JOINT).

export default function FootPlacementPanel() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const [selectedJoint, setSelectedJoint] = useState<number | null>(null)

  useEffect(() => {
    const onJoint = (i: number | null) => setSelectedJoint(typeof i === 'number' ? i : null)
    eventEmitter.on('SELECT_JOINT', onJoint)
    eventEmitter.emit(QUERY_SELECTED_JOINT)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint) }
  }, [eventEmitter])

  const target = getAnimationTarget(editorScene, skeletonTargetId)
  if (!target) return <Hint>Open a skeleton to set up its foot placement.</Hint>
  return <IkRigPanel skin={target.skin} selectedJoint={selectedJoint} />
}
