import { useEffect, useMemo, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget, buildJointTree, jointLabel, JointTreeNode } from './skeleton'

// Left-sidebar skeleton hierarchy for the Animation Editor. Mirrors the scene tree's recursive,
// per-row-expanded pattern, but is built from the target model's Skin joints and drives a parallel
// SELECT_JOINT event (kept separate from the scene's SELECT_NODE selection).

interface RowProps {
  joint: JointTreeNode
  depth: number
  selected: number | null
  skin: any
  onSelect: (index: number) => void
}

function JointRow({ joint, depth, selected, skin, onSelect }: RowProps) {
  const [expanded, setExpanded] = useState(true)
  const isSelected = selected === joint.index
  return (
    <div>
      <div
        className={`group flex items-center h-[22px] px-[5px] mb-[1px] rounded-[2px] text-ellipsis overflow-hidden whitespace-nowrap ${isSelected ? 'bg-[#2c2cff] border border-white' : 'border border-[#3b3b3b] hover:bg-[#3f3fb4] cursor-pointer'}`}
        style={{ paddingLeft: 5 + depth * 12 }}
        onClick={() => onSelect(joint.index)}
        title={jointLabel(skin, joint.index)}>
        {joint.children.length > 0 ? (
          <span
            className='inline-flex items-center justify-center w-[16px] h-[16px] mr-1 text-white cursor-pointer select-none'
            onClick={(e) => { e.stopPropagation(); setExpanded(!expanded) }}>
            {expanded ? '▾' : '▸'}
          </span>
        ) : (
          <span className='inline-block w-[16px] mr-1 text-center text-[#6a6ad0]'>•</span>
        )}
        <span className='text-xs truncate'>{jointLabel(skin, joint.index)}</span>
      </div>
      {expanded && joint.children.map(child => (
        <JointRow key={child.index} joint={child} depth={depth + 1} selected={selected} skin={skin} onSelect={onSelect} />
      ))}
    </div>
  )
}

export default function SkeletonTree() {
  const { editorScene, animationTargetId, eventEmitter } = useCleoEngine()
  const [selectedJoint, setSelectedJoint] = useState<number | null>(null)

  const target = getAnimationTarget(editorScene, animationTargetId)
  const roots = useMemo(() => (target ? buildJointTree(target.skin) : []), [target?.node.id])

  // Keep the tree highlight in sync with joint selections coming from the viewport.
  useEffect(() => {
    const onSelectJoint = (index: number | null) => setSelectedJoint(index)
    eventEmitter.on('SELECT_JOINT', onSelectJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onSelectJoint) }
  }, [eventEmitter])

  const select = (index: number) => {
    setSelectedJoint(index)
    eventEmitter.emit('SELECT_JOINT', index)
  }

  if (!target) {
    return (
      <div className='flex flex-col text-white bg-[#202020] w-full h-full p-3 text-sm text-gray-400'>
        No skinned model selected.
      </div>
    )
  }

  return (
    <div className='flex flex-col text-white bg-[#202020] w-full h-full overflow-hidden'>
      <div className='px-3 py-2 border-b border-[#2d2d77] shrink-0'>
        <div className='text-xs uppercase tracking-wide text-[#8f8fff]'>Skeleton</div>
        <div className='text-[11px] text-gray-400 truncate' title={target.node.name}>{target.node.name}</div>
        <div className='text-[11px] text-gray-500'>{target.skin.joints.length} joints</div>
      </div>
      <div className='flex-1 overflow-y-auto py-1'>
        {roots.map(root => (
          <JointRow key={root.index} joint={root} depth={0} selected={selectedJoint} skin={target.skin} onSelect={select} />
        ))}
      </div>
    </div>
  )
}
