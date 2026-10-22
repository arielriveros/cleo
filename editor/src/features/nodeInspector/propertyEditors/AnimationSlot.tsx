import { useState } from 'react'
import { Node } from 'cleo'
import type { AnimationStateMachine } from 'cleo'
import { useEditorSessions } from '../../EditorSessionsContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useCleoEngine } from '../../EngineContext'
import { useDocument } from '../../DocumentContext'
import Collapsable from '../../../components/Collapsable'
import { Button, Hint, Select, cn } from '../../../components/ui'
import { useAssetDrop } from '../../../utils/useAssetDrop'
import { AnimationIcon } from '../sectionIcons'
import { ownSkinnedModelNodeOf, modelIdOf } from '../../../utils/models'
import { instantiateController, machineClipNames, machineIsEmpty } from '../../../utils/animationControllers'
import AnimateCharacterWizard from '../../characterAnimation/AnimateCharacterWizard'

// The one animation-related thing a model NODE owns: which machine it runs.
//
// That is either its OWN state machine, or an Animation Controller asset — Unity's Animator Controller,
// Unreal's Anim Blueprint — shared by every character that uses it, with this node's CLIP OVERRIDES on
// top: one zombie controller, a crawler whose Walk is a crawl. Either way the node holds a resolved copy
// (that is what plays and what ships); `controllerId` on the copy is where it came from.
//
// Clips and blend spaces belong to the `.rig` asset, and are edited through the Rig slot above.
export default function AnimationSlot(props: { node: Node }) {
  const { enterStateMachineEditor } = useEditorSessions()
  const { animControllers, animationFields, boneMasks, poseAssets, models } = useAssetLibrary()
  const { activeTab } = useCleoEngine()
  const { markTabDirty } = useDocument()
  const [, force] = useState(0)
  const [wizardOpen, setWizardOpen] = useState(false)
  // Above the early return (hooks). `pick` is only reached from a drop, i.e. after a render that got past it.
  const { dragOver, dropProps } = useAssetDrop('text/cleo-anim-controller', id => pick(id))

  const modelNode = ownSkinnedModelNodeOf(props.node)
  if (!modelNode?.animator) return null
  const animator = modelNode.animator
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

  return (
    <Collapsable title='Animation' icon={<AnimationIcon />} persistKey='animation'>
      {wizardOpen && <AnimateCharacterWizard node={modelNode} onClose={() => { setWizardOpen(false); force(x => x + 1) }} />}
      <div className={cn('w-full p-2 flex flex-col gap-2 rounded border', dragOver ? 'border-selected' : 'border-transparent')}
        title='Drop an Animator here to use it' {...dropProps}>
        {/* The fast path: a character with nothing to play gets one button that sets it all up. */}
        {machineIsEmpty(sm) && (
          <div className='flex flex-col gap-1 rounded border border-highlight/40 bg-highlight/10 p-2'>
            <Hint>This character has no animation yet, so it will hold its bind pose.</Hint>
            <Button variant='primary' className='w-full py-2' onClick={() => setWizardOpen(true)}
              title='Pick a template (locomotion, fighter, NPC) and its clips — the animator is built for you'>
              ✨ Animate this character…
            </Button>
          </div>
        )}
        <Select value={controller?.id ?? ''} onChange={e => pick(e.target.value)}
          title='Run a shared Animator, or this character’s own'>
          <option value=''>{sm?.controllerId && !controller ? 'Shared animator missing — own copy' : 'Its own animator'}</option>
          {offered.map(c => <option key={c.id} value={c.id}>Shared: {c.name}</option>)}
        </Select>

        <Button variant={machineIsEmpty(sm) ? 'subtle' : 'primary'} className='w-full py-2' onClick={() => enterStateMachineEditor(modelNode.id)}
          title={controller
            ? `Edit the shared “${controller.name}” animator. Saving updates every character that uses it.`
            : 'Edit which clip this character plays when — its states, layers, transitions and parameters'}>
          ▶ Edit Animation
        </Button>

        {controller && controllerClips.length > 0 && (
          <div className='flex flex-col gap-1'>
            <div className='text-ui-sm text-muted'>Clip overrides (this character only)</div>
            {controllerClips.map(from => (
              <div key={from} className='flex items-center gap-1 text-ui-sm'>
                <span className='w-[96px] truncate text-fg' title={from}>{from}</span>
                <span className='text-muted'>→</span>
                <Select className='flex-1 min-w-0' value={sm?.clipOverrides?.[from] ?? ''}
                  onChange={e => setOverride(from, e.target.value)}>
                  <option value=''>(same)</option>
                  {clips.filter((c: string) => c !== from).map((c: string) => <option key={c} value={c}>{c}</option>)}
                </Select>
              </div>
            ))}
          </div>
        )}

        <Hint>
          {controller
            ? 'Shared by every character using it. Overrides swap clips for this one only.'
            : 'Which clip plays when. Save it as a Controller from the editor to share it between characters.'}
        </Hint>
      </div>
    </Collapsable>
  )
}
