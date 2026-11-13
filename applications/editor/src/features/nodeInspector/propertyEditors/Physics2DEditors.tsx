import { useEffect, useState } from 'react'
import { CharacterBody2DNode, Body2DNode, Area2DNode, ControllerNode, LOCOMOTION_2D_DEFAULTS, jumpPhysics } from 'cleo'
import type { Body2DMovement } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import {
  Button, DocScope, NumberInput, PropertyRow, PropertyTable, SectionTitle, SegmentedControl, Select, Toggle, Hint,
} from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { usePlayback } from '../../PlaybackContext'
import { CharacterIcon, PhysicsIcon } from '../sectionIcons'
import { LayerBits, PairInput } from './ui2D'

// The inspectors of the 2D physics nodes (src/physics2d): a character body (its generic walking, flying and
// jumping, and who drives it), a box collider, and a trigger area. Documented with the rest of 2D
// (docs/editor/tilemap-2d.md).

function useNodeEdit(node: unknown): () => void {
  const eventEmitter = useEventBus()
  const [, setVersion] = useState(0)
  useEffect(() => { setVersion(v => v + 1) }, [node])
  return () => {
    setVersion(v => v + 1)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
}

type NumberKey = 'walkSpeed' | 'runSpeed' | 'acceleration' | 'deceleration' | 'airControl' | 'jumpHeight' | 'jumpTimeToApex'
  | 'fallGravityMultiplier' | 'maxFallSpeed' | 'coyoteSeconds' | 'jumpBufferSeconds' | 'gravityScale' | 'stepHeight'

/** One number of the body's tuning, never negative. */
function Tune(props: { n: CharacterBody2DNode, k: NumberKey, label: string, step: number, max?: number, hint?: string, changed: () => void }) {
  return (
    <PropertyRow label={props.label} hint={props.hint}>
      <NumberInput step={props.step} value={props.n[props.k]} onChange={(x) => {
        props.n[props.k] = Math.min(props.max ?? Infinity, Math.max(0, x)); props.changed()
      }} />
    </PropertyRow>
  )
}

const MOVEMENTS: { value: Body2DMovement, label: string }[] = [{ value: 'walk', label: 'Walk' }, { value: 'fly', label: 'Fly' }]

export function CharacterBody2DEditor(props: { node: CharacterBody2DNode }) {
  const n = props.node
  const changed = useNodeEdit(n)
  const { gravity, jumpSpeed } = jumpPhysics(n)
  const walker = n.movement === 'walk'
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Character Body 2D' icon={<CharacterIcon />} persistKey='node.characterBody2D' defaultOpen>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Size' hint='The box, width and height, standing on the node’s position (its feet).'>
              <PairInput min={0.01} value={n.size} onChange={(v) => { n.size = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Layer' hint='The 2D layers it is on: an area sees it when the area looks for one of them.'>
              <LayerBits value={n.layer} onChange={(v) => { n.layer = v; changed() }} />
            </PropertyRow>
            <Tune n={n} k='stepHeight' label='Step height' step={0.05} hint='The most it climbs walking: a step, the rise of a slope. World units.' changed={changed} />
            <PropertyRow label='Flip sprites' hint='Mirror its sprite children to face the way it faces.'>
              <Toggle checked={n.flipSprites} onChange={(c) => { n.flipSprites = c; changed() }} />
            </PropertyRow>
            <PropertyRow label='One-way platforms' hint='One-way platforms hold it up. Off: it passes through them both ways, as a flier does.'>
              <Toggle checked={n.oneWayPlatforms} onChange={(c) => { n.oneWayPlatforms = c; changed() }} />
            </PropertyRow>
          </PropertyTable>

          <SectionTitle title='Driven by' className='mt-3 mb-1' />
          <DrivenBy body={n} changed={changed} />

          <SectionTitle title='Movement' className='mt-3 mb-1' />
          <div className='mb-2'>
            <SegmentedControl value={n.movement} options={MOVEMENTS} onChange={(v) => { n.movement = v; changed() }} />
          </div>
          <PropertyTable columns={['45%', '55%']}>
            <Tune n={n} k='walkSpeed' label='Walk speed' step={0.5} hint='Units per second with the stick fully over.' changed={changed} />
            <Tune n={n} k='runSpeed' label='Run speed' step={0.5} hint='While the intent sprints (a Sprint action on the controller).' changed={changed} />
            <Tune n={n} k='acceleration' label='Acceleration' step={5} hint='Getting up to speed, units per second squared.' changed={changed} />
            {walker && <Tune n={n} k='deceleration' label='Deceleration' step={5} hint='Slowing to a stop on the ground.' changed={changed} />}
            {walker && <Tune n={n} k='airControl' label='Air control' step={0.05} max={1} hint='The share of acceleration steering has in the air: low commits a jump.' changed={changed} />}
          </PropertyTable>

          {walker && <>
            <SectionTitle title='Jump' className='mt-3 mb-1' />
            <PropertyTable columns={['45%', '55%']}>
              <Tune n={n} k='jumpHeight' label='Jump height' step={0.1} hint='The apex of a jump, units above the take-off.' changed={changed} />
              <Tune n={n} k='jumpTimeToApex' label='Time to apex' step={0.02} hint='Seconds to the apex: gravity and the launch speed follow from the two.' changed={changed} />
              <Tune n={n} k='fallGravityMultiplier' label='Fall gravity' step={0.1} hint='Gravity on the way down, times the rise’s: above 1 reads as weight.' changed={changed} />
              <Tune n={n} k='maxFallSpeed' label='Max fall speed' step={1} changed={changed} />
              <Tune n={n} k='coyoteSeconds' label='Coyote time' step={0.01} hint='Seconds after walking off a ledge a jump still counts as from the ground.' changed={changed} />
              <Tune n={n} k='jumpBufferSeconds' label='Jump buffer' step={0.01} hint='Seconds a press before landing is remembered for.' changed={changed} />
            </PropertyTable>
            <Hint className='mt-1'>
              Gravity {gravity.toFixed(1)} u/s², launch {jumpSpeed.toFixed(1)} u/s. Defaults: a {LOCOMOTION_2D_DEFAULTS.jumpHeight}-unit jump in {LOCOMOTION_2D_DEFAULTS.jumpTimeToApex} s.
            </Hint>
          </>}

          <SectionTitle title='Advanced' className='mt-3 mb-1' />
          <PropertyTable columns={['45%', '55%']}>
            <Tune n={n} k='gravityScale' label='Gravity scale' step={0.1} hint='A multiplier on gravity, which scripts change at run time: 0 holds the height through a dash.' changed={changed} />
            <PropertyRow label='Drive without a controller' hint='Run its locomotion every frame even with no controller or script driving it.'>
              <Toggle checked={n.driveWhenUnpossessed} onChange={(c) => { n.driveWhenUnpossessed = c; changed() }} />
            </PropertyRow>
          </PropertyTable>
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
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Collider 2D' icon={<PhysicsIcon />} persistKey='node.body2D' defaultOpen>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Size' hint='Width and height, world units, centred on the node.'>
              <PairInput min={0} value={n.size} onChange={(v) => { n.size = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Kind' hint='Solid: a block. One-way: a platform stood on from above, passed from below.'>
              <Select value={n.kind} onChange={(e) => { n.kind = e.target.value === 'oneWay' ? 'oneWay' : 'solid'; changed() }}>
                <option value='solid'>Solid</option>
                <option value='oneWay'>One-way platform</option>
              </Select>
            </PropertyRow>
            <PropertyRow label='Enabled'>
              <Toggle checked={n.enabled} onChange={(c) => { n.enabled = c; changed() }} />
            </PropertyRow>
          </PropertyTable>
          <Hint className='mt-1'>Move it and it carries what stands on it: a moving platform, a lift.</Hint>
        </div>
      </Collapsable>
    </DocScope>
  )
}

export function Area2DEditor(props: { node: Area2DNode }) {
  const n = props.node
  const changed = useNodeEdit(n)
  return (
    <DocScope page='editor/tilemap-2d'>
      <Collapsable title='Area 2D' icon={<PhysicsIcon />} persistKey='node.area2D' defaultOpen>
        <div className='w-full p-2'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Size'>
              <PairInput min={0} value={n.size} onChange={(v) => { n.size = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Offset' hint='From the node, mirrored when the character it rides on faces left.'>
              <PairInput value={n.offset} onChange={(v) => { n.offset = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Layer' hint='The layers it is on, which another area must look for to see it.'>
              <LayerBits value={n.layer} onChange={(v) => { n.layer = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Looks for' hint='The layers it sees bodies and areas on.'>
              <LayerBits value={n.mask} onChange={(v) => { n.mask = v; changed() }} />
            </PropertyRow>
            <PropertyRow label='Detect areas' hint='Also see other areas: a sword’s hitbox seeing a hurtbox.'>
              <Toggle checked={n.detectAreas} onChange={(c) => { n.detectAreas = c; changed() }} />
            </PropertyRow>
            <PropertyRow label='Enabled'>
              <Toggle checked={n.enabled} onChange={(c) => { n.enabled = c; changed() }} />
            </PropertyRow>
          </PropertyTable>
          <Hint className='mt-1'>Scripts hear onTriggerEnter / onTriggerExit, on the area and on what came in.</Hint>
        </div>
      </Collapsable>
    </DocScope>
  )
}
