import { useEffect, useRef, useState } from 'react'
import { VehicleNode, WheelNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { DocScope, SectionTitle, SegmentedControl, Slider, TextInput, Toggle, cn, labelClass } from '@cleo/app-kit/ui'
import { hintAffordance } from '@cleo/app-kit/ui/Field'
import { VehicleIcon, WheelIcon } from '../sectionIcons'

// The Vehicle and Wheel nodes' panels (docs/editor/vehicles.md). Fields write the node and mark the scene
// changed; a vehicle already driving in Play is built again from them (VehicleNode.rebuild).

const PLAYER_HINT = "Drive it from the player's input: Move steers and drives, Jump holds the hand brake. Off: a script sets throttle, steer, brake and handBrake."
const REVERSE_HINT = "The throttle held against the way it rolls brakes first, then reverses once nearly stopped, like a road car's pedals."
const LSD_HINT = 'Limited-slip differentials send torque to the wheel that grips. Off: open differentials, a spinning wheel takes it all.'
const CAST_HINT = "What each wheel finds the ground with. Cylinder follows kerbs and bumps by the tyre's real shape (Jolt); the Cannon and Rapier backends cast a ray whatever is chosen."
const DRIVEN_HINT = 'The engine turns this wheel. Wheels side by side share an axle and its differential.'

/** Edits a node's plain fields, rebuilding its vehicle while Play runs. */
function useFields(node: VehicleNode | WheelNode, rebuild: () => void) {
  const { eventEmitter } = useCleoEngine()
  const [, setVersion] = useState(0)
  useEffect(() => { setVersion(v => v + 1) }, [node])
  return (patch: Record<string, unknown>) => {
    for (const key in patch) (node as any)[key] = patch[key]
    setVersion(v => v + 1)
    rebuild()
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
}

const vehicleOf = (node: WheelNode): VehicleNode | null => {
  for (let n = node.parent; n; n = n.parent) if (n instanceof VehicleNode) return n
  return null
}

export function VehicleEditor(props: { node: VehicleNode }) {
  const n = props.node
  const { isPlayMode } = useCleoEngine()
  const apply = useFields(n, () => n.rebuild())
  const slider = (label: string, k: keyof VehicleNode & string, min: number, max: number, step: number, fixed = 0, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={(n as any)[k] as number} title={hint}
      labelClassName='w-[112px]' readout={v => v.toFixed(fixed)} onChange={v => apply({ [k]: v })} />
  )
  const toggle = (label: string, k: keyof VehicleNode & string, hint: string) => (
    <Toggle className='mb-2' checked={(n as any)[k] as boolean} onChange={checked => apply({ [k]: checked })}
      label={<span className={cn(labelClass, hintAffordance(hint))} title={hint}>{label}</span>} />
  )
  return (
    <Collapsable title='Vehicle' icon={<VehicleIcon />} persistKey='vehicle'>
      <DocScope page='editor/vehicles' section='vehicle'>
        <div className='w-full p-2'>
          {n.wheels.length === 0 && <p className='text-ui-sm text-muted mb-2'>No wheels yet: add Wheel nodes under it.</p>}
          {!n.collider && <p className='text-ui-sm text-muted mb-2'>Put it in a Collider with mass: that is its chassis.</p>}
          <SectionTitle title='Driving' className='mt-1 mb-1' />
          {toggle('Player input', 'playerInput', PLAYER_HINT)}
          {toggle('Auto reverse', 'autoReverse', REVERSE_HINT)}

          <SectionTitle title='Engine' className='mt-3 mb-1' />
          {slider('Torque', 'maxTorque', 0, 3000, 10)}
          {slider('Idle RPM', 'minRpm', 300, 3000, 50)}
          {slider('Redline RPM', 'maxRpm', 2000, 12000, 100)}

          <SectionTitle title='Gearbox' className='mt-3 mb-1' />
          {slider('Shift up', 'shiftUpRpm', 1000, 12000, 100)}
          {slider('Shift down', 'shiftDownRpm', 500, 8000, 100)}
          {slider('Shift time', 'shiftTime', 0, 2, 0.05, 2)}
          {slider('Final drive', 'finalDrive', 1, 10, 0.01, 2)}
          {slider('Reverse ratio', 'reverseRatio', 0.5, 6, 0.01, 2)}
          <GearRatios node={n} onChange={gears => apply({ gearRatios: gears })} />
          {toggle('Limited slip', 'limitedSlip', LSD_HINT)}

          <SectionTitle title='Handling' className='mt-3 mb-1' />
          {slider('Anti-roll', 'antiRoll', 0, 20000, 100)}
          {slider('Max pitch / roll', 'maxPitchRoll', 5, 180, 1)}
          <div className='mb-2' title={CAST_HINT}>
            <SegmentedControl value={n.cast}
              options={[{ value: 'ray', label: 'Ray' }, { value: 'sphere', label: 'Sphere' }, { value: 'cylinder', label: 'Cylinder' }]}
              onChange={v => apply({ cast: v })} />
          </div>

          <SectionTitle title='Live' className='mt-3 mb-1' />
          <LiveReadout node={n} live={isPlayMode} />
        </div>
      </DocScope>
    </Collapsable>
  )
}

/** The forward gears' ratios, first first, as one comma list. */
function GearRatios(props: { node: VehicleNode; onChange: (gears: number[]) => void }) {
  const [text, setText] = useState(() => props.node.gearRatios.join(', '))
  useEffect(() => { setText(props.node.gearRatios.join(', ')) }, [props.node])
  const commit = () => {
    const gears = text.split(/[\s,]+/).map(Number).filter(g => Number.isFinite(g) && g > 0)
    if (gears.length > 0) props.onChange(gears)
    setText((gears.length > 0 ? gears : props.node.gearRatios).join(', '))
  }
  return (
    <label className='flex items-center gap-2 mb-2'>
      <span className={cn(labelClass, 'w-[112px]')}>Gears</span>
      <TextInput className='flex-1 min-w-0 font-mono' value={text}
        onChange={setText} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') commit() }} />
    </label>
  )
}

/** Speed, RPM and gear while Play runs, polled each frame. */
function LiveReadout({ node, live }: { node: VehicleNode; live: boolean }) {
  const [values, setValues] = useState({ speed: 0, rpm: 0, gear: 0, grounded: 0 })
  const frame = useRef(0)
  useEffect(() => {
    if (!live) return
    const tick = () => {
      const v = node.vehicle
      let grounded = 0
      if (v) for (let i = 0; i < v.wheelCount; i++) if (v.wheel(i).grounded) grounded++
      setValues({ speed: node.speed, rpm: node.rpm, gear: node.gear, grounded })
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [node, live])
  const row = (name: string, value: string) => (
    <div className='flex items-center gap-2 text-ui-sm font-mono'>
      <span className={cn(labelClass, 'w-[92px]')}>{name}</span>
      <span className='tabular-nums text-fg'>{value}</span>
    </div>
  )
  if (!live) return <p className='text-ui-sm text-muted'>Press Play to watch speed, RPM and gear.</p>
  return (
    <div className='flex flex-col gap-0.5'>
      {row('Speed', `${(values.speed * 3.6).toFixed(0)} km/h`)}
      {row('RPM', values.rpm.toFixed(0))}
      {row('Gear', values.gear > 0 ? String(values.gear) : values.gear < 0 ? 'R' : 'N')}
      {row('On the ground', `${values.grounded} / ${node.wheels.length}`)}
    </div>
  )
}

export function WheelEditor(props: { node: WheelNode }) {
  const n = props.node
  const apply = useFields(n, () => vehicleOf(n)?.rebuild())
  const slider = (label: string, k: keyof WheelNode & string, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={(n as any)[k] as number} title={hint}
      labelClassName='w-[112px]' readout={v => v.toFixed(fixed)} onChange={v => apply({ [k]: v })} />
  )
  return (
    <Collapsable title='Wheel' icon={<WheelIcon />} persistKey='wheel'>
      <DocScope page='editor/vehicles' section='wheel'>
        <div className='w-full p-2'>
          {!vehicleOf(n) && <p className='text-ui-sm text-muted mb-2'>Put it under a Vehicle node.</p>}
          <SectionTitle title='Tyre' className='mt-1 mb-1' />
          {slider('Radius', 'radius', 0.05, 2, 0.01)}
          {slider('Width', 'width', 0.02, 1, 0.01)}
          {slider('Grip', 'grip', 0.1, 2, 0.01)}

          <SectionTitle title='Suspension' className='mt-3 mb-1' />
          {slider('Travel', 'suspensionTravel', 0, 1, 0.01)}
          {slider('Length', 'suspensionLength', Math.max(0.05, n.suspensionTravel), 2, 0.01)}
          {slider('Frequency', 'suspensionFrequency', 0.3, 6, 0.05)}
          {slider('Damping', 'suspensionDamping', 0, 1.5, 0.01)}

          <SectionTitle title='Steering and brakes' className='mt-3 mb-1' />
          {slider('Steer angle', 'steerAngle', 0, 60, 1, 0)}
          <Toggle className='mb-2' checked={n.driven} onChange={checked => apply({ driven: checked })}
            label={<span className={cn(labelClass, hintAffordance(DRIVEN_HINT))} title={DRIVEN_HINT}>Driven</span>} />
          {slider('Brake', 'brakeTorque', 0, 10000, 50, 0)}
          {slider('Hand brake', 'handBrakeTorque', 0, 10000, 50, 0)}
        </div>
      </DocScope>
    </Collapsable>
  )
}
