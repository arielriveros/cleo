import { useEffect, useMemo, useRef, useState } from 'react'
import { AnimatedModel, ModelNode, Node, RAGDOLL_DEFAULTS, effectiveRagdollProfile } from 'cleo'
import type { AnimationStateMachine, RagdollOptions } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useCleoEngine } from '../../EngineContext'
import { useDocument } from '../../DocumentContext'
import AxisInput from '@cleo/app-kit/ui/AxisInput'
import { Button, Hint, NumberInput, PropertyRow, PropertyTable, SectionTitle, Select, cn } from '@cleo/app-kit/ui'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { modelIdOf } from '../../../utils/models'
import { instantiateController, machineClipNames } from '../../../utils/animationControllers'

// What a CHARACTER decides for itself, under its Skeleton: everything else about its animation and its ragdoll
// is the skeleton's (the rig's clips, animators, blend spaces, ragdoll profile), authored in the Skeleton part.
//
// - **Animator**: which machine this character runs, its own or a shared Animator (Unity's Animator
//   Controller, Unreal's Anim Blueprint), and when shared, the clips it swaps for this character only. Either
//   way the node holds a resolved copy (that is what plays and what ships); `controllerId` is where it came from.
// - **Ragdoll**: how heavy this character falls and how hard it is pushed (ModelNode.ragdollConfig). Which
//   bodies and joints it falls with is the skeleton's ragdoll profile.

/** Whether `node` is a skinned model a ragdoll applies to: a ModelNode with a skinned AnimatedModel and an animator. */
export function isRagdollModel(node: Node): node is ModelNode {
  const m = node as ModelNode
  return node.nodeType === 'model' && m.model instanceof AnimatedModel && m.model.hasSkin && !!m.animator
}

/** The per-character rows, for the skinned `modelNode` the selected node is (or holds). */
export default function CharacterRows({ modelNode, rigId }: { modelNode: ModelNode; rigId?: string }) {
  return (
    <div className='flex flex-col gap-1'>
      <SectionTitle title='This character' />
      <PropertyTable>
        <AnimatorRows modelNode={modelNode} />
        {isRagdollModel(modelNode) && <RagdollRows key={modelNode.id} node={modelNode} rigId={rigId} />}
      </PropertyTable>
    </div>
  )
}

/** Its machine: its own, or a shared Animator with this character's clip overrides. */
function AnimatorRows({ modelNode }: { modelNode: ModelNode }) {
  const { enterStateMachineEditor } = useEditorSessions()
  const { animControllers, animationFields, boneMasks, poseAssets, models } = useAssetLibrary()
  const { activeTab } = useCleoEngine()
  const { markTabDirty } = useDocument()
  const [, force] = useState(0)
  const [showOverrides, setShowOverrides] = useState(false)
  const { dragOver, dropProps } = useAssetDrop('text/cleo-anim-controller', id => pick(id))

  const animator = modelNode.animator
  if (!animator) return null
  const sm = animator.getStateMachine()
  const controller = sm?.controllerId ? animControllers.find(c => c.id === sm.controllerId) : undefined
  const rigId = models.find(m => m.id === modelIdOf(modelNode))?.rigId
  // Controllers authored on this rig first; generic ones (no rig) are offered too.
  const offered = animControllers.filter(c => !c.rigId || !rigId || c.rigId === rigId)
  const libs = { animationFields, boneMasks, poses: poseAssets }

  const write = (next: AnimationStateMachine | null) => {
    animator.setStateMachine(next)
    markTabDirty(activeTab.id, 'anim-controller')
    force(x => x + 1)
  }

  const pick = (id: string) => {
    if (!id) {
      // Back to an own machine: keep what it is running, just stop following the controller.
      if (!sm) return
      const { controllerId: _c, clipOverrides: _o, ...own } = sm
      write(own as AnimationStateMachine)
      return
    }
    const asset = animControllers.find(c => c.id === id)
    if (asset) write(instantiateController(asset, libs, sm?.controllerId === id ? sm.clipOverrides : undefined))
  }

  const setOverride = (from: string, to: string) => {
    if (!controller) return
    const overrides = { ...(sm?.clipOverrides ?? {}) }
    if (to && to !== from) overrides[from] = to
    else delete overrides[from]
    write(instantiateController(controller, libs, overrides))
  }

  const clips = (modelNode.model as any).animations?.map((a: { name: string }) => a.name) ?? []
  const controllerClips = controller ? machineClipNames(controller.machine) : []
  const overridden = Object.keys(sm?.clipOverrides ?? {}).length

  return (
    <>
      <PropertyRow label='Animator'>
        <div className={cn('flex items-center gap-1 rounded border', dragOver ? 'border-selected' : 'border-transparent')}
          title='Drop an Animator here to use it' {...dropProps}>
          <Select className='flex-1 min-w-0' value={controller?.id ?? ''} onChange={e => pick(e.target.value)}
            title='Run a shared Animator, or this character’s own'>
            <option value=''>{sm?.controllerId && !controller ? 'Shared animator missing — own copy' : 'Its own'}</option>
            {offered.map(c => <option key={c.id} value={c.id}>Shared: {c.name}</option>)}
          </Select>
          <Button variant='ghost' size='icon' className='text-highlight' onClick={() => enterStateMachineEditor(modelNode.id)}
            title={controller
              ? `Edit the shared “${controller.name}” animator. Saving updates every character that uses it.`
              : 'Edit this character’s own animator: its states, layers, transitions and parameters'}>✎</Button>
        </div>
      </PropertyRow>
      {controller && controllerClips.length > 0 && (
        <PropertyRow label='Clip overrides' doc='editor/animation#using-one-on-a-character::Clip overrides (this character only)'>
          <Button variant='ghost' size='sm' className='w-full justify-start' onClick={() => setShowOverrides(v => !v)}
            title={showOverrides ? 'Hide the clip overrides' : 'Swap a clip of the shared animator for another, for this character only'}>
            {overridden ? `${overridden} of ${controllerClips.length}` : 'None'}
          </Button>
        </PropertyRow>
      )}
      {controller && showOverrides && controllerClips.map(from => (
        <PropertyRow key={from} label={<span className='pl-2 text-muted' title={from}>{from}</span>} doc={false}>
          <Select className='w-full min-w-0' value={sm?.clipOverrides?.[from] ?? ''}
            onChange={e => setOverride(from, e.target.value)}>
            <option value=''>(same)</option>
            {clips.filter((c: string) => c !== from).map((c: string) => <option key={c} value={c}>{c}</option>)}
          </Select>
        </PropertyRow>
      ))}
    </>
  )
}

/** The source label, for the hint when the skeleton has no ragdoll of its own. */
const SOURCE_HINT = {
  rig: null,
  auto: null,
  generic: 'The skeleton has no ragdoll profile and is not a humanoid, so it falls as a generic one. Set one up in its Ragdoll tab.',
} as const

/** How heavy this character falls and how hard it is pushed: ModelNode.ragdollConfig, an ordinary scene edit. */
function RagdollRows({ node, rigId }: { node: ModelNode; rigId?: string }) {
  const { eventEmitter, enterRigEditor } = useCleoEngine()
  const [ragdoll, setRagdoll] = useState<RagdollOptions>(() => ({ ...RAGDOLL_DEFAULTS, ...(node.ragdollConfig || {}) }))
  const [sceneChanged, setSceneChanged] = useState(0)

  useEffect(() => {
    const onChange = () => setSceneChanged(v => v + 1)
    eventEmitter.on('SCENE_CHANGED', onChange)
    return () => { eventEmitter.off('SCENE_CHANGED', onChange) }
  }, [eventEmitter])

  // Adopting the node's config on selection is not an edit; changing it is. (Mounted per node: keyed by id.)
  const loadRef = useRef(true)
  useEffect(() => {
    node.ragdollConfig = ragdoll
    if (loadRef.current) loadRef.current = false
    else eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }, [ragdoll])

  const source = useMemo(() => {
    const skin = node.model instanceof AnimatedModel ? node.model.skin : null
    return skin ? effectiveRagdollProfile(skin).source : 'generic'
  }, [node, sceneChanged])
  const hint = SOURCE_HINT[source]

  const edit = rigId && (
    <Button variant='ghost' size='icon' className='text-highlight' onClick={() => { enterRigEditor(rigId); eventEmitter.emit('FOCUS_RIG_ASSET', { kind: 'ragdoll' }) }}
      title='Edit the ragdoll in the skeleton: its bodies, joints and a test drop (the Ragdoll tab)'>✎</Button>
  )

  return (
    <>
      {/* The generic ragdoll ignores the mass scale: its bones weigh what the skeleton's generic settings say. */}
      {source !== 'generic' && (
        <PropertyRow label='Ragdoll mass'>
          <div className='flex items-center gap-1'>
            <NumberInput className='flex-1 min-w-0' step={0.05} min={0.1} value={ragdoll.massScale ?? 1}
              onChange={v => setRagdoll({ ...ragdoll, massScale: Math.max(0.1, v) })} />
            {edit}
          </div>
        </PropertyRow>
      )}
      <PropertyRow label='Ragdoll push'>
        <div className='flex items-center gap-1'>
          <AxisInput step={0.1} value={[ragdoll.impulse?.[0] ?? 0, ragdoll.impulse?.[1] ?? 0, ragdoll.impulse?.[2] ?? 0]}
            onChange={v => setRagdoll({ ...ragdoll, impulse: [v[0], v[1], v[2]] })} />
          {source === 'generic' && edit}
        </div>
      </PropertyRow>
      {hint && <tr><td colSpan={2}><Hint>{hint}</Hint></td></tr>}
    </>
  )
}
