import { useEffect, useState } from 'react'
import { CharacterBody2DNode, Body2DNode, Area2DNode, DEFAULT_PLATFORMER, jumpPhysics } from 'cleo'
import type { PlatformerSettings } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { DocScope, NumberInput, PropertyRow, PropertyTable, Select, TextInput, Toggle, Hint } from '@cleo/app-kit/ui'
import { useEventBus } from '../../EventBusContext'
import { CharacterIcon, PhysicsIcon } from '../sectionIcons'

// The inspectors of the 2D physics nodes (src/physics2d): a character body with its platformer controller,
// a box collider, and a trigger area. Documented with the rest of 2D (docs/editor/tilemap-2d.md).

function PairInput(props: { value: [number, number], step?: number, min?: number, onChange: (v: [number, number]) => void }) {
  const clamp = (v: number) => (props.min !== undefined ? Math.max(props.min, v) : v)
  return (
    <span className='flex gap-1'>
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[0]} onChange={(v) => props.onChange([clamp(v), props.value[1]])} />
      <NumberInput className='w-16' step={props.step ?? 0.1} value={props.value[1]} onChange={(v) => props.onChange([props.value[0], clamp(v)])} />
    </span>
  )
}

/** A bit mask as eight toggles for its low bits: the 2D layers. */
function LayerBits(props: { value: number, onChange: (v: number) => void }) {
  return (
    <span className='flex gap-0.5'>
      {[0, 1, 2, 3, 4, 5, 6, 7].map(bit => {
        const on = (props.value & (1 << bit)) !== 0
        return (
          <button key={bit} type='button' title={`Layer ${bit + 1}`}
            className={`w-5 h-5 text-ui-xs rounded-sm border ${on ? 'bg-primary text-on-primary border-primary' : 'border-border text-muted'}`}
            onClick={() => props.onChange(on ? props.value & ~(1 << bit) : props.value | (1 << bit))}>{bit + 1}</button>
        )
      })}
    </span>
  )
}

function useNodeEdit(node: unknown): () => void {
  const eventEmitter = useEventBus()
  const [, setVersion] = useState(0)
  useEffect(() => { setVersion(v => v + 1) }, [node])
  return () => {
    setVersion(v => v + 1)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
}

/** One number of the platformer's tuning, with its default as the reset. */
function Tune(props: { n: CharacterBody2DNode, k: keyof PlatformerSettings, label: string, step: number, hint?: string, changed: () => void }) {
  const v = props.n.settings[props.k] as number
  return (
    <PropertyRow label={props.label} hint={props.hint}>
      <NumberInput step={props.step} value={v} onChange={(x) => { (props.n.settings as any)[props.k] = Math.max(0, x); props.changed() }} />
    </PropertyRow>
  )
}

export function CharacterBody2DEditor(props: { node: CharacterBody2DNode }) {
  const n = props.node
  const changed = useNodeEdit(n)
  const { gravity, jumpSpeed } = jumpPhysics(n.settings)
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
            <PropertyRow label='Controller' hint='Platformer: runs and jumps with the feel tuned below. None: falls by its gravity and moves by its velocity, which a script sets.'>
              <Select value={n.controller} onChange={(e) => { n.controller = e.target.value === 'none' ? 'none' : 'platformer'; changed() }}>
                <option value='platformer'>Platformer</option>
                <option value='none'>None</option>
              </Select>
            </PropertyRow>
            <PropertyRow label='Player input' hint='Read the input actions below. Off: a script drives it (move, jump, dash), an enemy with the same feel.'>
              <Toggle checked={n.playerInput} onChange={(c) => { n.playerInput = c; changed() }} />
            </PropertyRow>
            {n.playerInput && (
              <>
                <PropertyRow label='Move action'><TextInput value={n.moveAction} onChange={(v) => { n.moveAction = v; changed() }} /></PropertyRow>
                <PropertyRow label='Jump action'><TextInput value={n.jumpAction} onChange={(v) => { n.jumpAction = v; changed() }} /></PropertyRow>
                <PropertyRow label='Dash action'><TextInput value={n.dashAction} onChange={(v) => { n.dashAction = v; changed() }} /></PropertyRow>
              </>
            )}
            <PropertyRow label='Step height' hint='The most it climbs walking: a step, the rise of a slope. World units.'>
              <NumberInput step={0.05} value={n.stepHeight} onChange={(v) => { n.stepHeight = Math.max(0, v); changed() }} />
            </PropertyRow>
            <PropertyRow label='Flip sprites' hint='Mirror its sprite children to face the way it faces.'>
              <Toggle checked={n.flipSprites} onChange={(c) => { n.flipSprites = c; changed() }} />
            </PropertyRow>
            {n.controller === 'none' && (
              <PropertyRow label='Gravity' hint='Fall acceleration, units per second squared.'>
                <NumberInput step={1} value={n.gravity} onChange={(v) => { n.gravity = v; changed() }} />
              </PropertyRow>
            )}
          </PropertyTable>
        </div>
      </Collapsable>

      {n.controller === 'platformer' && (
        <Collapsable title='Platformer' icon={<PhysicsIcon />} persistKey='node.characterBody2D.platformer' defaultOpen>
          <div className='w-full p-2'>
            <PropertyTable columns={['45%', '55%']}>
              <PropertyRow label='Double jump'><Toggle checked={n.abilities.doubleJump} onChange={(c) => { n.abilities.doubleJump = c; changed() }} /></PropertyRow>
              <PropertyRow label='Dash'><Toggle checked={n.abilities.dash} onChange={(c) => { n.abilities.dash = c; changed() }} /></PropertyRow>
              <PropertyRow label='Wall jump' hint='Wall slide and wall jump.'><Toggle checked={n.abilities.wallJump} onChange={(c) => { n.abilities.wallJump = c; changed() }} /></PropertyRow>
              <Tune n={n} k='runSpeed' label='Run speed' step={0.5} changed={changed} />
              <Tune n={n} k='acceleration' label='Acceleration' step={5} changed={changed} />
              <Tune n={n} k='deceleration' label='Deceleration' step={5} changed={changed} />
              <Tune n={n} k='airAcceleration' label='Air acceleration' step={5} changed={changed} />
              <Tune n={n} k='jumpHeight' label='Jump height' step={0.1} hint='The apex of a full jump, units above the take-off.' changed={changed} />
              <Tune n={n} k='jumpTimeToApex' label='Time to apex' step={0.02} hint='Seconds to the apex: gravity and the launch speed follow from the two.' changed={changed} />
              <Tune n={n} k='fallGravityMultiplier' label='Fall gravity' step={0.1} hint='Gravity on the way down, times the rise’s.' changed={changed} />
              <Tune n={n} k='jumpCutMultiplier' label='Jump cut' step={0.05} hint='The share of the rise kept when jump is let go early: a tap is a hop.' changed={changed} />
              <Tune n={n} k='maxFallSpeed' label='Max fall speed' step={1} changed={changed} />
              <Tune n={n} k='coyoteTime' label='Coyote time' step={0.01} changed={changed} />
              <Tune n={n} k='jumpBuffer' label='Jump buffer' step={0.01} changed={changed} />
              <Tune n={n} k='airJumps' label='Air jumps' step={1} changed={changed} />
              <Tune n={n} k='dashSpeed' label='Dash speed' step={1} changed={changed} />
              <Tune n={n} k='dashTime' label='Dash time' step={0.01} changed={changed} />
              <Tune n={n} k='dashCooldown' label='Dash cooldown' step={0.05} changed={changed} />
              <Tune n={n} k='wallSlideSpeed' label='Wall slide speed' step={0.5} changed={changed} />
              <PropertyRow label='Wall jump speed' hint='The push away from the wall and up.'>
                <PairInput min={0} value={n.settings.wallJumpSpeed} onChange={(v) => { n.settings.wallJumpSpeed = v; changed() }} />
              </PropertyRow>
            </PropertyTable>
            <Hint className='mt-1'>
              Gravity {gravity.toFixed(1)} u/s², launch {jumpSpeed.toFixed(1)} u/s. Defaults: a {DEFAULT_PLATFORMER.jumpHeight}-unit jump in {DEFAULT_PLATFORMER.jumpTimeToApex} s.
            </Hint>
          </div>
        </Collapsable>
      )}
    </DocScope>
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
