import { useEffect, useState } from 'react'
import { quat, vec3 } from 'gl-matrix'
import { eulerFromQuatDeg, humanoidSlotOf } from 'cleo'
import type { AnimationStateMachine } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import { Button, Hint, OptionalNumberInput, SegmentedControl, TextInput, cn } from '@cleo/app-kit/ui'
import { confirmDialog, promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { getAnimationTarget } from '../animation/skeleton'
import { pinKey, useCreatorPins } from '../creator/creatorPins'
import { lookupPose, newPose, poseSampleKey, poseTree, variantsOf, type PoseAsset, type PoseRef, type PoseTreeNode } from '../../utils/poseAssets'
import { freePoseName, independentPose, newVariant, projectPoseAsset, setPoseBoneRotation, withPose } from '../../utils/poseEdit'
import type { StoredPoseBone } from '../../utils/animationAssets'
import { poseDeltaOf } from './boneTrs'
import { poseEditStore, usePoseEdit, type PoseView } from './poseEditStore'
import { showPose, usePoseAssetEdit } from './posePreview'
import { CapturePoseIcon, DetachIcon, EditPoseIcon, GoToSampleIcon, ShowPoseIcon, VariantIcon } from './poseIcons'

// The POSE MODE: a skeleton's poses, listed with their variants under them, edited on the character.
//
// Edit a pose (the pencil), click a joint on the character, and turn it: with the rotate gizmo over the viewport
// (PoseGizmo) or the numbers below. A VARIANT stores only what it changes from its base, so an edit to the
// base moves every variant with it, and editing a variant changes only that one: an aim pose and its directions
// in an aim blend space. Every animator and blend space holding a pose follows each edit at once.
//
// In the Animator part the character plays on with every layer (Layered: the hold under its aim, Steady, hand
// IK), which is what the game will show; "Pose alone" pins the pose by itself, as the Skeleton part always does.
// Poses synced from Cleo Creator are read-only (the next sync would undo an edit): a variant of one goes into the
// skeleton's own pose asset.

const tight = 'px-1 py-0'
const iconBtn = 'shrink-0 px-1 py-0'
const icon = 'inline-block w-3.5 h-3.5 align-[-2px]'

/** Every place a machine holds a pose: a state's pose, a blend space's sample (with its axes and spot). */
function usesOf(sm: AnimationStateMachine | null | undefined, poseId: string) {
  const out: { layer: string; state: string; sample?: { x: number; y?: number }; inputs?: { x?: string; y?: string } }[] = []
  if (!sm) return out
  const key = poseSampleKey(poseId)
  const layers = [{ name: 'Base', states: sm.states }, ...(sm.layers ?? [])]
  for (const l of layers) for (const s of l.states) {
    if (s.poseRef?.poseId === poseId) out.push({ layer: l.name, state: s.name })
    const sample = s.field?.samples?.find(x => x.clipName === key)
    if (sample) out.push({ layer: l.name, state: s.name, sample: { x: sample.x, y: sample.y }, inputs: s.fieldInputs })
  }
  return out
}

export interface PoseLibraryProps {
  rigId: string
  rigName: string
  /** The preview character the poses are shown and edited on. */
  targetId: string | null
  /** Whether the character runs its machine (the Animator part), so a pose can be edited with every layer on. */
  layered: boolean
}

export default function PoseLibrary({ rigId, rigName, targetId, layered }: PoseLibraryProps) {
  const { editorScene, eventEmitter } = useCleoEngine()
  const { poseAssets, updatePoseAsset } = useAssetLibrary()
  const pins = useCreatorPins()
  const write = usePoseAssetEdit()
  const { editing, readOnly, view } = usePoseEdit()
  const [jointIndex, setJointIndex] = useState(-1)
  const [open, setOpen] = useState<Set<string>>(() => new Set())
  const target = getAnimationTarget(editorScene, targetId)
  const shown: PoseView = layered ? view : 'alone'
  const isReadOnly = (assetId: string) => pins.folders.has(pinKey('pose', assetId))

  useEffect(() => {
    const onJoint = (i: number) => setJointIndex(typeof i === 'number' ? i : -1)
    eventEmitter.on('SELECT_JOINT', onJoint)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint) }
  }, [eventEmitter])

  // Show the pose being edited (or, layered, the machine with the current poses) whenever it, the view or the
  // library changes. The library's own edits reach every other character through the engine's re-embed.
  const targetKey = target?.node.id
  useEffect(() => {
    if (target) showPose(target, poseAssets, editing, shown)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey, editing?.assetId, editing?.poseId, shown, poseAssets])
  // Leaving the panel stops editing and lets the character go.
  useEffect(() => () => {
    poseEditStore.edit(null)
    getAnimationTarget(editorScene, targetId)?.animator.clearBoneLocalOverrides()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const tree = poseTree(poseAssets, rigId)
  const editingPose = editing ? lookupPose(poseAssets, editing) : null
  const editingAsset = editing ? poseAssets.find(a => a.id === editing.assetId) ?? null : null
  const toggle = (id: string) => setOpen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n })

  // Where a new pose or variant goes when its own asset may not be written: the skeleton's project asset.
  const writableHome = (asset: PoseAsset) => (isReadOnly(asset.id) ? projectPoseAsset(poseAssets, rigId, rigName, isReadOnly).asset : asset)

  const addVariant = async (n: PoseTreeNode) => {
    const name = await promptDialog({ title: 'New variant', message: `A variant of “${n.pose.name}”: it stores only what it changes from it, so it follows every edit to it.`, defaultValue: `${n.pose.name} Variant` })
    if (!name?.trim()) return
    const home = writableHome(n.asset)
    const variant = newVariant({ asset: n.asset, pose: n.pose }, freePoseName(home, name.trim()))
    write({ ...home, poses: [...home.poses, variant] }, 'Add variant')
    setOpen(prev => new Set(prev).add(n.pose.id))
    poseEditStore.edit({ assetId: home.id, poseId: variant.id })
  }

  const capture = async () => {
    if (!target) return
    const name = await promptDialog({ title: 'New pose', message: 'The character as it stands now, every bone off its rest.', defaultValue: 'Pose' })
    if (!name?.trim()) return
    const bones: StoredPoseBone[] = []
    for (const joint of target.skin.joints) {
      const boneName = target.skin.nodeNames?.get(joint.nodeIndex)
      const local = target.animator.posedLocal(joint.nodeIndex)
      const rest = target.animator.boneRestTransform(joint.nodeIndex)
      const delta = boneName && local && rest ? poseDeltaOf(local, rest) : null
      if (delta) bones.push({ name: boneName!, ...delta })
    }
    const home = projectPoseAsset(poseAssets, rigId, rigName, isReadOnly).asset
    const pose = newPose(freePoseName(home, name.trim()), bones)
    write({ ...home, poses: [...home.poses, pose] }, 'New pose')
    poseEditStore.edit({ assetId: home.id, poseId: pose.id })
  }

  const remove = async (n: PoseTreeNode) => {
    const variants = variantsOf(poseAssets, n.pose.id)
    const used = usesOf(target?.animator.getStateMachine(), n.pose.id)
    if (variants.length || used.length) {
      const ok = await confirmDialog({
        title: `Delete “${n.pose.name}”?`, tone: 'danger', confirmLabel: 'Delete',
        message: [
          variants.length ? `Its ${variants.length} variant${variants.length === 1 ? '' : 's'} lose their base: they then hold what they change from rest.` : '',
          used.length ? 'This character’s animator holds it: those states and samples will hold nothing.' : '',
        ].filter(Boolean).join(' '),
      })
      if (!ok) return
    }
    if (editing?.poseId === n.pose.id) poseEditStore.edit(null)
    write(withPose(n.asset, n.pose.id, () => null), 'Delete pose')
  }

  // Straight into the library, as the asset's own name is: an undo step per keystroke would bury the real edits.
  const rename = (n: PoseTreeNode, name: string) => updatePoseAsset(n.asset.id, withPose(n.asset, n.pose.id, p => ({ ...p, name })))

  const row = (n: PoseTreeNode, depth: number): React.ReactNode => {
    const ro = isReadOnly(n.asset.id)
    const isEditing = editing?.poseId === n.pose.id
    const expanded = open.has(n.pose.id) || (editing ? n.variants.some(v => v.pose.id === editing.poseId) : false)
    return (
      <div key={n.pose.id}>
        <div className={cn('flex items-center gap-1 rounded', isEditing && 'bg-selected/30')} style={{ paddingLeft: depth * 12 }}>
          {n.variants.length > 0
            ? <button className='w-3 text-ui-sm text-muted hover:text-fg' onClick={() => toggle(n.pose.id)}
                title={expanded ? 'Hide its variants' : 'Show its variants'}>{expanded ? '▾' : '▸'}</button>
            : <span className='w-3' />}
          <Button variant='ghost' size='sm' active={isEditing} className={iconBtn} disabled={!target}
            title={ro
              ? (isEditing ? 'Stop showing it' : 'Show this pose on the character (synced from Cleo Creator: edit it there, or add a variant)')
              : (isEditing ? 'Stop editing' : 'Edit this pose: click a joint on the character, then turn it with the gizmo or the numbers')}
            onClick={() => poseEditStore.edit(isEditing ? null : { assetId: n.asset.id, poseId: n.pose.id }, ro)}>
            <span className={icon}>{ro ? <ShowPoseIcon /> : <EditPoseIcon />}</span>
          </Button>
          {ro
            ? <span className='flex-1 truncate text-ui-sm text-fg' title='Synced from Cleo Creator: read-only here'>{n.pose.name}</span>
            : <TextInput className={cn(tight, 'flex-1 min-w-0')} value={n.pose.name}
                title='Rename. Animators and blend spaces hold poses by id, so a rename cannot break them.'
                onChange={v => rename(n, v)} />}
          {n.broken && <span className='text-ui-xs text-warning shrink-0' title='Its base pose is gone: it holds what it changes from rest'>no base</span>}
          {n.variants.length > 0 && <span className='text-ui-xs text-muted shrink-0' title={`${n.variants.length} variants`}>{n.variants.length}</span>}
          <Button variant='ghost' size='sm' className={iconBtn}
            title='Add a variant: a pose stored as what it changes from this one, so it follows every edit to this one (an aim direction off an aim pose)'
            onClick={() => addVariant(n)}><span className={icon}><VariantIcon /></span></Button>
          {n.pose.baseRef && !ro && (
            <Button variant='ghost' size='sm' className={iconBtn}
              title='Make it a pose of its own, as it looks now: it stops following its base'
              onClick={() => write(withPose(n.asset, n.pose.id, p => independentPose(poseAssets, p)), 'Make pose independent')}>
              <span className={icon}><DetachIcon /></span>
            </Button>
          )}
          {!ro && <Button variant='remove' size='sm' className={iconBtn} title='Delete this pose' onClick={() => remove(n)}>✕</Button>}
        </div>
        {expanded && n.variants.map(v => row(v, depth + 1))}
      </div>
    )
  }

  return (
    <div className='flex flex-col gap-1'>
      {layered && (
        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[46px] shrink-0'>Show</span>
          <SegmentedControl<PoseView> size='sm' value={view}
            // Back to the layers: the character plays on (showing a pose alone pauses it on one frame).
            onChange={v => { poseEditStore.view(v); if (v === 'layered') target?.animator.play() }}
            options={[
              { value: 'layered', label: 'Layered', title: 'The character plays on with every layer: the pose as the game shows it (turn on Preview, simulate)' },
              { value: 'alone', label: 'Pose alone', title: 'Only the pose, pinned on the character' },
            ]} />
        </div>
      )}

      {tree.length === 0 && <Hint>No poses on this skeleton yet. Capture one from the character, or make them in Cleo Creator ▸ Motion.</Hint>}
      <div className='flex flex-col gap-0.5'>{tree.map(n => row(n, 0))}</div>

      <Button variant='subtle' size='sm' className='self-start' disabled={!target}
        title='A new pose from the character as it stands now (every bone off its rest), in this skeleton’s pose asset'
        onClick={capture}><span className={cn(icon, 'mr-1')}><CapturePoseIcon /></span>New pose</Button>

      {editing && editingPose && editingAsset && target && (
        <BoneEditor
          asset={editingAsset} poseRef={editing} readOnly={readOnly} jointIndex={jointIndex} target={target}
          baseName={editingPose.baseRef ? lookupPose(poseAssets, editingPose.baseRef)?.name ?? null : null}
          write={write} />
      )}
    </div>
  )
}

/** The selected bone of the pose being edited, as numbers; where the pose is held; the hand IK's note. */
function BoneEditor({ asset, poseRef, readOnly, jointIndex, target, baseName, write }: {
  asset: PoseAsset
  poseRef: PoseRef
  readOnly: boolean
  jointIndex: number
  target: NonNullable<ReturnType<typeof getAnimationTarget>>
  baseName: string | null
  write: ReturnType<typeof usePoseAssetEdit>
}) {
  const pose = asset.poses.find(p => p.id === poseRef.poseId)
  if (!pose) return null
  const sm = target.animator.getStateMachine()
  const uses = usesOf(sm, pose.id)
  const nodeIndex = jointIndex >= 0 ? target.skin.joints[jointIndex]?.nodeIndex : undefined
  const bone = nodeIndex !== undefined ? target.skin.nodeNames?.get(nodeIndex) : undefined
  const stored = bone ? pose.bones.find(b => b.name === bone) : undefined
  const q = stored?.rotation ? quat.fromValues(stored.rotation[0], stored.rotation[1], stored.rotation[2], stored.rotation[3]) : quat.create()
  const euler = eulerFromQuatDeg(vec3.create(), q)
  const setEuler = (axis: 0 | 1 | 2, v: number | undefined) => {
    if (!bone || v === undefined) return
    const e = [euler[0], euler[1], euler[2]]
    e[axis] = v
    const r = quat.fromEuler(quat.create(), e[0], e[1], e[2])
    write(withPose(asset, pose.id, p => ({ ...p, bones: setPoseBoneRotation(p.bones, bone, r) })), `Turn ${bone.replace(/^.*:/, '')}`)
  }
  // A hand chain a layer's hand IK holds: what the pose says of it shows only where that layer lets go.
  const slot = bone ? humanoidSlotOf(bone) : null
  const side = slot?.endsWith('.L') ? 'left' : slot?.endsWith('.R') ? 'right' : null
  const heldBy = side && slot && /^(upperArm|foreArm|hand)\./.test(slot)
    ? (sm?.layers ?? []).filter(l => l.handIk?.hand === side).map(l => l.name)
    : []

  return (
    <div className='mt-1 flex flex-col gap-1 rounded border border-control p-1.5'>
      <div className='flex items-center gap-1 text-ui-sm'>
        <span className='flex-1 truncate'>{readOnly ? 'Showing' : 'Editing'} <b>{pose.name}</b></span>
        <Button variant='ghost' size='sm' className={tight} onClick={() => poseEditStore.edit(null)}>Done</Button>
      </div>
      {baseName && <Hint>A variant of <b>{baseName}</b>: these turns are what it changes from it.</Hint>}
      {!bone && !readOnly && <Hint>Click a joint on the character, then turn it with the gizmo or the numbers.</Hint>}
      {bone && (
        <>
          <div className='flex items-center gap-1 text-ui-xs'>
            <span className='flex-1 truncate text-muted' title={bone}>{bone.replace(/^.*:/, '')}</span>
            {!readOnly && stored && (
              <Button variant='ghost' size='sm' className={tight} title={baseName ? 'Back to the base’s turn' : 'Back to rest'}
                onClick={() => write(withPose(asset, pose.id, p => ({ ...p, bones: setPoseBoneRotation(p.bones, bone, [0, 0, 0, 1]) })), `Reset ${bone.replace(/^.*:/, '')}`)}>Reset</Button>
            )}
          </div>
          <div className='flex items-center gap-1 text-ui-xs' title={baseName ? 'Degrees off the base pose, in the parent bone’s frame' : 'Degrees off rest, in the parent bone’s frame'}>
            {(['X', 'Y', 'Z'] as const).map((label, axis) => (
              <label key={label} className='flex items-center gap-0.5'>
                <span className='text-muted'>{label}</span>
                <OptionalNumberInput className={cn('px-1 py-0.5', 'w-[52px]')} step={1} value={Math.round(euler[axis] * 100) / 100}
                  disabled={readOnly} onChange={v => setEuler(axis as 0 | 1 | 2, v)} />
              </label>
            ))}
          </div>
          {heldBy.length > 0 && (
            <Hint>The {side} hand is held on by the hand IK of {heldBy.join(', ')}: this arm shows as posed only where that layer lets go.</Hint>
          )}
        </>
      )}
      {uses.length > 0 && (
        <div className='flex flex-col gap-0.5'>
          {uses.map((u, k) => (
            <div key={k} className='flex items-center gap-1 text-ui-xs text-muted'>
              <span className='flex-1 truncate'>{u.layer} ▸ {u.state}{u.sample ? ' (blend space)' : ''}</span>
              {u.sample && u.inputs && (
                <Button variant='ghost' size='sm' className={iconBtn}
                  title='Put the blend space’s probe on this pose (pins its axes’ parameters), to see it on the character'
                  onClick={() => {
                    if (u.inputs!.x) target.animator.setParamOverride(u.inputs!.x, u.sample!.x)
                    if (u.inputs!.y && u.sample!.y !== undefined) target.animator.setParamOverride(u.inputs!.y, u.sample!.y)
                  }}><span className={icon}><GoToSampleIcon /></span></Button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
