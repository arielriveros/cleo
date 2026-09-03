import { useEffect, useRef, useState } from 'react'
import { CharacterNode, FACING_MODES } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { SegmentedControl, Slider, cn, labelClass, sectionTitleClass } from '../../../components/ui'
import { hintAffordance } from '../../../components/ui/Field'
import { CharacterIcon } from '../sectionIcons'

const CHARACTER_HINT = 'The pawn. It turns a ControlIntent into velocity and facing, and never asks where the intent came from — so the same character walks under a player, an AI or a script. Possess it with a Controller node.'
const FACING_HINT = 'Aim turns the body toward where the Controller is looking (a strafe character). Velocity turns it toward travel (a face-your-movement character). None leaves rotation alone.'
const TURN_HINT = 'Turn-in-place fires once the aim swings past the threshold and holds until it is back within the release angle. Two numbers, not one: with a single threshold the turn chatters whenever the camera hovers on it.'
const JUMP_HINT = 'Coyote time keeps a jump working just after walking off an edge; the buffer keeps one pressed just before landing. Lockout suppresses the ground projection right after take-off, so it cannot flatten the jump.'
const ACCEL_HINT = 'Units per second squared. 0 snaps to full speed, which is what a keyboard character usually wants; above 0 makes the engine’s isAccelerating / isDecelerating animation builtins meaningful.'
const OUTPUT_HINT = 'What this character publishes to its Animator each frame. Bind these from a state machine parameter of type Variable, with the node reference set to this character.'
const DRIVE_HINT = 'Run locomotion with nothing possessing this character. Off by default, so an unpossessed character is inert and cannot fight physics for its own velocity.'

interface CharacterState {
  walkSpeed: number; runSpeed: number; jumpSpeed: number
  turnSpeed: number; turnThreshold: number; turnReleaseAngle: number
  directionSmoothing: number; acceleration: number; airControl: number
  coyoteSeconds: number; jumpBufferSeconds: number; jumpLockoutSeconds: number
  facingMode: string; driveWhenUnpossessed: boolean
}

function readNode(node: CharacterNode): CharacterState {
  return {
    walkSpeed: node.walkSpeed, runSpeed: node.runSpeed, jumpSpeed: node.jumpSpeed,
    turnSpeed: node.turnSpeed, turnThreshold: node.turnThreshold, turnReleaseAngle: node.turnReleaseAngle,
    directionSmoothing: node.directionSmoothing, acceleration: node.acceleration, airControl: node.airControl,
    coyoteSeconds: node.coyoteSeconds, jumpBufferSeconds: node.jumpBufferSeconds,
    jumpLockoutSeconds: node.jumpLockoutSeconds,
    facingMode: node.facingMode, driveWhenUnpossessed: node.driveWhenUnpossessed,
  }
}

export default function CharacterEditor(props: { node: CharacterNode }) {
  const { eventEmitter, isPlayMode } = useCleoEngine()
  const [state, setState] = useState<CharacterState>(() => readNode(props.node))

  useEffect(() => { setState(readNode(props.node)) }, [props.node])

  const apply = (patch: Partial<CharacterState>) => {
    for (const key in patch) (props.node as any)[key] = (patch as any)[key]
    setState({ ...state, ...patch })
    eventEmitter.emit('SCENE_CHANGED')
  }

  // Invoked as functions, not components, so the inputs keep identity across re-renders.
  const slider = (label: string, k: keyof CharacterState, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={state[k] as number} title={hint}
      labelClassName='w-[112px]' readout={(v) => v.toFixed(fixed)}
      onChange={(v) => apply({ [k]: v } as Partial<CharacterState>)} />
  )

  const header = (label: string, hint?: string) => (
    <div className={cn(sectionTitleClass, 'mt-3 mb-1', hintAffordance(hint))} title={hint}>{label}</div>
  )

  return (
    <Collapsable title='Character' icon={<CharacterIcon />} persistKey='character' hint={CHARACTER_HINT}>
      <div className='w-full p-2'>
        {header('Speed')}
        {slider('Walk', 'walkSpeed', 0, 20, 0.1)}
        {slider('Run', 'runSpeed', 0, 30, 0.1)}
        {slider('Acceleration', 'acceleration', 0, 100, 0.5, 1, ACCEL_HINT)}
        {slider('Air Control', 'airControl', 0, 1, 0.01)}

        {header('Facing', FACING_HINT)}
        <div className='mb-2'>
          <SegmentedControl
            value={state.facingMode}
            options={FACING_MODES.map(m => ({ value: m, label: m[0].toUpperCase() + m.slice(1) }))}
            onChange={(v) => apply({ facingMode: v })}
          />
        </div>
        {slider('Turn Speed', 'turnSpeed', 0, 1440, 10, 0)}
        {slider('Direction Smooth', 'directionSmoothing', 0, 1, 0.01)}

        {header('Turn in place', TURN_HINT)}
        {slider('Threshold', 'turnThreshold', 1, 180, 1, 0)}
        {slider('Release', 'turnReleaseAngle', 0, Math.max(1, state.turnThreshold - 1), 1, 0)}

        {header('Jump', JUMP_HINT)}
        {slider('Speed', 'jumpSpeed', 0, 20, 0.1)}
        {slider('Coyote', 'coyoteSeconds', 0, 0.5, 0.01)}
        {slider('Buffer', 'jumpBufferSeconds', 0, 0.5, 0.01)}
        {slider('Lockout', 'jumpLockoutSeconds', 0, 1, 0.01)}

        {header('Advanced')}
        <label className='flex items-center gap-2 mb-2'>
          <input type='checkbox' checked={state.driveWhenUnpossessed}
            onChange={e => apply({ driveWhenUnpossessed: e.target.checked })} />
          <span className={cn(labelClass, hintAffordance(DRIVE_HINT))} title={DRIVE_HINT}>
            Drive without a Controller
          </span>
        </label>

        {header('Animator outputs', OUTPUT_HINT)}
        <AnimatorOutputs node={props.node} live={isPlayMode} />
      </div>
    </Collapsable>
  )
}

/**
 * The three values this character publishes to its Animator.
 *
 * Polled on rAF while playing, because that is the only way to see whether a blend space is reading what
 * you think it is: `moveDir` is an angle whose SIGN is the thing that goes wrong, and a mirrored strafe
 * looks almost right until you watch the number.
 */
function AnimatorOutputs({ node, live }: { node: CharacterNode; live: boolean }) {
  const [values, setValues] = useState({ moveDir: 0, isJumping: false, turnRequest: 0 })
  const frame = useRef(0)

  useEffect(() => {
    if (!live) return
    const tick = () => {
      setValues({ moveDir: node.moveDir, isJumping: node.isJumping, turnRequest: node.turnRequest })
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [node, live])

  const row = (name: string, value: string, note: string) => (
    <div className='flex items-center gap-2 text-[11px] font-mono'>
      <span className={cn(labelClass, 'w-[92px]')}>{name}</span>
      <span className='w-16 tabular-nums text-white'>{value}</span>
      <span className='text-muted'>{note}</span>
    </div>
  )

  return (
    <div className='flex flex-col gap-0.5'>
      {row('moveDir', live ? values.moveDir.toFixed(1) : '—', '0 ahead · -90 right · +90 left')}
      {row('turnRequest', live ? String(values.turnRequest) : '—', '±1 / ±2, + is right')}
      {row('isJumping', live ? String(values.isJumping) : '—', 'take-off until landed')}
      {!live && <p className='text-[11px] text-muted mt-1'>Press Play to watch these update.</p>}
    </div>
  )
}
