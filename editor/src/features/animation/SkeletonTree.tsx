import { useEffect, useMemo, useRef, useState } from 'react'
import { NodeRendererProps, Tree, TreeApi } from 'react-arborist'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget, buildJointTree, jointLabel, JointTreeNode } from './skeleton'
import { useElementSize } from '../../utils/useElementSize'
import { useScopedDndManager } from '../../utils/treeDnd'
import IkRigPanel from './IkRigPanel'

// Left-sidebar skeleton hierarchy for the Animation Editor. Same react-arborist tree as the scene
// inspector — virtualized, keyboard-navigable, filterable, which matters here because a humanoid rig runs
// to a few hundred bones — but read-only: a skeleton's shape comes from the model, so nothing is dragged,
// renamed or deleted in here. Selection drives a parallel SELECT_JOINT event (kept separate from the
// scene's SELECT_NODE selection).

const ROW_HEIGHT = 22
const INDENT = 12
const GUTTER = 6
const CHEVRON = 16

/** A joint flattened for the tree: the label is resolved up front so rows need no access to the Skin. */
interface JointRow {
  id: string
  index: number
  label: string
  children: JointRow[]
}

const toRows = (joints: JointTreeNode[], skin: any): JointRow[] =>
  joints.map(joint => ({
    id: String(joint.index),
    index: joint.index,
    label: jointLabel(skin, joint.index),
    children: toRows(joint.children, skin),
  }))

/** Disclosure arrow — one rotating shape, so a long rig doesn't read as a field of speckles. */
const Chevron = ({ open }: { open: boolean }) => (
  <svg viewBox='0 0 24 24' width='9' height='9' fill='none' stroke='currentColor' strokeWidth='3.2'
       strokeLinecap='round' strokeLinejoin='round'
       className={`transition-transform duration-100 ${open ? 'rotate-90' : ''}`}>
    <path d='m9 6 6 6-6 6' />
  </svg>
)

/** The faint rules tying a bone to its parent — one per level, centred on that ancestor's chevron. */
const IndentGuides = ({ level }: { level: number }) => (
  <>
    {Array.from({ length: level }, (_, i) => (
      <span key={i} aria-hidden className='absolute inset-y-0 w-px bg-white/[0.08] pointer-events-none'
            style={{ left: GUTTER + i * INDENT + CHEVRON / 2 }} />
    ))}
  </>
)

// `style` is unused on purpose: it carries react-arborist's indent as padding, which IndentGuides replaces.
function JointRowView({ node }: NodeRendererProps<JointRow>) {
  return (
    <div
      style={{ paddingLeft: GUTTER + node.level * INDENT }}
      className={`group relative flex items-center h-[20px] pr-[6px] rounded-md text-ellipsis overflow-hidden whitespace-nowrap ${
        node.isSelected ? 'bg-primary/40 text-white' : 'text-fg hover:bg-white/[0.06] cursor-pointer'}`}
      title={node.data.label}>
      <IndentGuides level={node.level} />
      <span
        className='flex items-center justify-center w-[16px] shrink-0 text-muted hover:text-fg select-none z-[1]'
        onClick={(e) => { e.stopPropagation(); if (node.data.children.length) node.toggle() }}>
        {node.data.children.length > 0
          ? <Chevron open={node.isOpen} />
          : <span className='w-[3px] h-[3px] rounded-full bg-white/25' />}
      </span>
      <span className='text-xs truncate pl-1'>{node.data.label}</span>
    </div>
  )
}

export default function SkeletonTree() {
  const { editorScene, animationTargetId, eventEmitter } = useCleoEngine()
  const [selectedJoint, setSelectedJoint] = useState<number | null>(null)
  const [filter, setFilter] = useState('')
  const treeRef = useRef<TreeApi<JointRow> | undefined>(undefined)
  // Measured for react-arborist's virtualization; the same element scopes its drag-and-drop backend so it
  // cannot disable native drops elsewhere in the editor (see treeDnd) even though this tree never drags.
  const { ref: viewportRef, element: viewportEl, size } = useElementSize<HTMLDivElement>()
  const dndManager = useScopedDndManager(viewportEl)

  const target = getAnimationTarget(editorScene, animationTargetId)
  const rows = useMemo(() => (target ? toRows(buildJointTree(target.skin), target.skin) : []), [target?.node.id])

  // Keep the tree highlight in sync with joint selections coming from the viewport.
  useEffect(() => {
    const onSelectJoint = (index: number | null) => setSelectedJoint(index)
    eventEmitter.on('SELECT_JOINT', onSelectJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onSelectJoint) }
  }, [eventEmitter])

  // Push a viewport pick into the tree, opening and scrolling to the row. Only when the tree does not
  // already hold it, so a click in here never fights the sync (see SceneInspector for the same pattern).
  const selectedRef = useRef<number | null>(selectedJoint)
  selectedRef.current = selectedJoint
  useEffect(() => {
    const tree = treeRef.current
    if (!tree) return
    if (selectedJoint === null) { if (tree.selectedIds.size) tree.deselectAll(); return }
    const id = String(selectedJoint)
    if (tree.selectedIds.has(id)) return
    const scrolled = tree.scrollTo(id)
    const select = () => {
      const t = treeRef.current
      if (t && t.get(id)) t.select(id, { focus: false })
    }
    if (scrolled) scrolled.then(select).catch(() => undefined); else select()
  }, [selectedJoint, rows])

  const handleSelect = (selection: { data: JointRow }[]) => {
    const index = selection.length ? selection[selection.length - 1].data.index : null
    if (index === selectedRef.current) return
    setSelectedJoint(index)
    eventEmitter.emit('SELECT_JOINT', index)
  }

  if (!target) {
    return (
      <div className='flex flex-col bg-surface-raised w-full h-full p-3 text-sm text-muted'>
        No skinned model selected.
      </div>
    )
  }

  return (
    <div className='flex flex-col text-white bg-surface-raised w-full h-full overflow-hidden'>
      <div className='px-3 py-2 border-b border-white/[0.06] shrink-0'>
        <div className='text-xs uppercase tracking-wide text-highlight'>Skeleton</div>
        <div className='text-[11px] text-muted truncate' title={target.node.name}>{target.node.name}</div>
        <div className='text-[11px] text-dim'>{target.skin.joints.length} joints</div>
      </div>
      <div className='shrink-0 px-[5px] py-1'>
        <input
          type='text' value={filter} placeholder='Filter bones'
          onChange={(e) => setFilter(e.target.value)}
          className='type-value w-full bg-white/[0.06] text-white placeholder:text-dim rounded-md px-2 py-[3px] outline-none focus:bg-white/[0.1] transition-colors' />
      </div>
      <div ref={viewportRef} className='flex-1 min-h-0'>
        { dndManager && size.height > 0 &&
          <Tree<JointRow>
            ref={treeRef}
            data={rows}
            dndManager={dndManager}
            width={size.width}
            height={size.height}
            rowHeight={ROW_HEIGHT}
            indent={INDENT}
            openByDefault
            selectionFollowsFocus
            disableDrag
            disableDrop
            disableEdit
            disableMultiSelection
            searchTerm={filter}
            searchMatch={(node, term) => node.data.label.toLowerCase().includes(term.toLowerCase())}
            onSelect={handleSelect}
            className='outline-none'>
            {JointRowView}
          </Tree>
        }
      </div>
      {/* Below the tree rather than in its own panel: assigning a bone to a role is a two-step gesture that
          starts with a click in the tree above, so the two have to be visible at once. */}
      <div className='shrink-0 border-t border-white/[0.06]'>
        <IkRigPanel skin={target.skin} selectedJoint={selectedJoint} />
      </div>
    </div>
  )
}
