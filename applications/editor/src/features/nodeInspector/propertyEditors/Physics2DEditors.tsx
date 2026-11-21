import { useEffect, useState } from 'react'
import { CharacterBody2DNode, Body2DNode, ControllerNode, LOCOMOTION_2D_DEFAULTS, jumpPhysics } from 'cleo'
import type { Body2DMovement } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, DocScope, SectionTitle, Hint } from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { usePlayback } from '../../PlaybackContext'
import { CharacterIcon, PhysicsIcon } from '../sectionIcons'
import DeclaredSections, { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The inspectors of the 2D physics nodes (src/physics2d): a character body (its generic walking, flying and
// jumping, and who drives it) and a box collider. A 2D trigger is a Trigger node in a 2D scene (TriggerEditor).
// Documented with the rest of 2D (docs/editor/tilemap-2d.md).

function useNodeEdit(node: unknown): () => void {
  const eventEmitter = useEventBus()
  const [, setVersion] = useState(0)
  useEffect(() => { setVersion(v => v + 1) }, [node])
  return () => {
    setVersion(v => v + 1)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
}

export function CharacterBody2DEditor(props: { node: CharacterBody2DNode }) {
  const n = props.node
  const changed = useNodeEdit(n)
  useNodeTick(n)   // the lines under the rows follow them
  const { gravity, jumpSpeed } = jumpPhysics(n)
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Character Body 2D' icon={<CharacterIcon />} persistKey='node.characterBody2D' defaultOpen>
        <div className='w-full p-2'>
          <DeclaredSection node={n} title='' />
          <SectionTitle title='Driven by' className='mt-3 mb-1' />
          <DrivenBy body={n} changed={changed} />
          <DeclaredSection node={n} title='Movement' />
          <DeclaredSection node={n} title='Jump'>
            <Hint className='mt-1'>
              Gravity {gravity.toFixed(1)} u/s², launch {jumpSpeed.toFixed(1)} u/s. Defaults: a {LOCOMOTION_2D_DEFAULTS.jumpHeight}-unit jump in {LOCOMOTION_2D_DEFAULTS.jumpTimeToApex} s.
            </Hint>
          </DeclaredSection>
          <DeclaredSection node={n} title='Advanced' />
          <Hint className='mt-1'>
            A dash, a double jump or a wall jump is the game’s own: write it in the body’s script, in onMove2D.
          </Hint>
          <LiveReadout body={n} />
        </div>
      </Collapsable>
    </DocScope>
  )
}

/**
 * Who drives the body: the controller possessing it, by name, or a choice to add one -- a Player
 * Controller reading Move and Jump, or an AI Controller -- as its last child, possessing it.
 */
function DrivenBy(props: { body: CharacterBody2DNode, changed: () => void }) {
  const { body } = props
  const driver = body.controller ?? findChildController(body)
  const add = (source: 'player' | 'ai') => {
    const c = new ControllerNode(source === 'player' ? 'Player Controller' : 'AI Controller')
    c.controlSource = source
    c.aimSource = 'world'
    c.driveAimTarget = false
    c.lookAction = ''
    c.sprintAction = ''
    c.crouchAction = ''
    body.addChild(c) // emits the structural SCENE_CHANGED (and its undo step) itself
    c.possess(body)
    props.changed()
  }
  if (driver) {
    const source = driver.controlSource === 'player' ? 'player input' : driver.controlSource === 'ai' ? 'AI' : 'none'
    return <Hint className='mb-1'>{driver.name} ({source})</Hint>
  }
  return (
    <div className='flex gap-1 mb-1'>
      <Button size='sm' variant='subtle' onClick={() => add('player')}>Add Player Controller</Button>
      <Button size='sm' variant='subtle' onClick={() => add('ai')}>Add AI Controller</Button>
    </div>
  )
}

/** A controller under the body that names it, before its first think has resolved the possession. */
function findChildController(body: CharacterBody2DNode): ControllerNode | null {
  for (const child of body.children)
    if (child instanceof ControllerNode && child.possessedId === body.id) return child
  return null
}

/** Speed, contacts and jumping while playing: the numbers a state machine reads. */
function LiveReadout({ body }: { body: CharacterBody2DNode }) {
  const { isPlayMode } = usePlayback()
  const [, tick] = useState(0)
  useEffect(() => {
    if (!isPlayMode) return
    let raf = 0
    const loop = () => { tick(v => v + 1); raf = requestAnimationFrame(loop) }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [isPlayMode])
  if (!isPlayMode) return null
  const v = body.velocity2D
  return (
    <Hint className='mt-1 font-mono'>
      v ({v[0].toFixed(1)}, {v[1].toFixed(1)}) · {body.isGrounded ? 'grounded' : 'air'}{body.onWall ? ' · wall' : ''}{body.isJumping ? ' · jumping' : ''}
    </Hint>
  )
}

export function Body2DEditor(props: { node: Body2DNode }) {
  const n = props.node
  const changed = useNodeEdit(n)
  useNodeTick(n)   // the lines under the rows follow them
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Collider 2D' icon={<PhysicsIcon />} persistKey='node.body2D' defaultOpen>
        <div className='w-full p-2'>
          <DeclaredSections node={n} />
          <Hint className='mt-1'>
            {n.mass > 0
              ? 'It falls, and what is under it falls with it.'
              : 'Move it and it carries what stands on it: a moving platform, a lift.'}
          </Hint>
        </div>
      </Collapsable>
    </DocScope>
  )
}
