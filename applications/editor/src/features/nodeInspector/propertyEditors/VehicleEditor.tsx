import { useEffect, useRef, useState } from 'react'
import { VehicleNode, WheelNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { Button, CloseIcon, DocScope, SectionTitle, SegmentedControl, Slider, TextInput, Toggle, cn, labelClass } from '@cleo/app-kit/ui'
import { JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS } from '@cleo/app-kit/ui/SegmentedControl'
import { hintAffordance } from '@cleo/app-kit/ui/Field'
import { AxleIcon, VehicleIcon, WheelIcon } from '../sectionIcons'

// The Vehicle and Wheel nodes' panels (docs/editor/vehicles.md). A vehicle is built here step by step: its
// wheels are added from the Wheels list, its power chosen under Drive, and its meshes are the developer's own.
// Fields write the node and mark the scene changed; a vehicle already driving in Play is built again from them
// (VehicleNode.rebuild).

const PLAYER_HINT = "Drive it from the player's input: Move steers and drives, Jump holds the hand brake. Off: a script sets throttle, steer, brake and handBrake."
const REVERSE_HINT = "The throttle held against the way it rolls brakes first, then reverses once nearly stopped, like a road car's pedals."
const LSD_HINT = 'Limited-slip differentials send torque to the wheel that grips. Off: open differentials, a spinning wheel takes it all.'
const CAST_HINT = "What each wheel finds the ground with. Cylinder follows kerbs and bumps by the tyre's real shape (Jolt); the Cannon and Rapier backends cast a ray whatever is chosen."
const DRIVEN_HINT = 'The engine turns this wheel. Wheels side by side share an axle and its differential.'
const ITEM = 'flex items-center justify-center w-[30px] h-[24px] text-muted hover:text-fg hover:bg-control'
const DRIVES = [
  { value: 'none', label: 'None', title: 'Nothing drives it: it rolls, steers and brakes, pushed or towed (a trailer, a cart)' },
  { value: 'engine', label: 'Engine', title: 'An engine and an automatic gearbox, through differentials to the wheels marked Driven' },
  { value: 'motors', label: 'Motors', title: 'An electric motor in each wheel: its own torque and top speed, set on the wheel' },
]

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

/** Re-render on any scene change: the wheel list follows wheels added, renamed or deleted elsewhere. */
function useSceneVersion() {
  const { eventEmitter } = useCleoEngine()
  const [, setVersion] = useState(0)
  useEffect(() => {
    const bump = () => setVersion(v => v + 1)
    eventEmitter.on('SCENE_CHANGED', bump)
    return () => { eventEmitter.off('SCENE_CHANGED', bump) }
  }, [eventEmitter])
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
          {!n.collider && <p className='text-ui-sm text-muted mb-2'>Put it in a Collider with mass: that is its chassis.</p>}

          <SectionTitle title='Wheels' className='mt-1 mb-1' />
          <WheelList vehicle={n} />

          <SectionTitle title='Drive' className='mt-3 mb-1' />
          <div className='mb-2'>
            <SegmentedControl joined value={n.drive} options={DRIVES} onChange={v => apply({ drive: v })} />
          </div>
          {n.drive === 'none' && <p className='text-ui-sm text-muted mb-2'>Nothing drives it: it rolls, steers and brakes.</p>}
          {n.drive === 'motors' && <p className='text-ui-sm text-muted mb-2'>Each wheel's motor (torque, top speed) is set on the wheel. A wheel with no torque only rolls.</p>}
          {n.drive === 'engine' && n.wheels.every(w => !w.driven) && <p className='text-ui-sm text-warning mb-2'>Mark the wheels the engine turns as Driven, on each wheel.</p>}

          <SectionTitle title='Driving' className='mt-3 mb-1' />
          {toggle('Player input', 'playerInput', PLAYER_HINT)}
          {toggle('Auto reverse', 'autoReverse', REVERSE_HINT)}

          {n.drive === 'engine' && <>
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
          </>}

          <SectionTitle title='Handling' className='mt-3 mb-1' />
          {slider('Anti-roll', 'antiRoll', 0, 20000, 100)}
          {slider('Max pitch / roll', 'maxPitchRoll', 5, 180, 1)}
          <div className='mb-2' title={CAST_HINT}>
            <SegmentedControl joined value={n.cast}
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

/**
 * The vehicle's wheels: one row each (select it, remove it), and the strip that adds one wheel or a whole axle
 * at the chassis's next free corners (VehicleNode.addWheel). A wheel comes with no mesh: put yours under it.
 */
function WheelList({ vehicle }: { vehicle: VehicleNode }) {
  const { eventEmitter, editorScene } = useCleoEngine()
  useSceneVersion()
  const wheels = vehicle.wheels
  // The Vehicle stays selected, so wheel after wheel can be added; a row selects its wheel.
  const add = (count: number) => {
    for (let i = 0; i < count; i++) vehicle.addWheel()
    vehicle.rebuild()
  }
  return (
    <div className='mb-2'>
      {wheels.length === 0 && <p className='text-ui-sm text-muted mb-1'>No wheels yet.</p>}
      {wheels.map(w => (
        <div key={w.id} className='flex items-center gap-1 text-ui-sm'>
          <button type='button' className='flex-1 min-w-0 flex items-center gap-1.5 text-left px-1 py-0.5 rounded hover:bg-control truncate'
            title={`Select ${w.name}`} onClick={() => eventEmitter.emit('SELECT_NODE', w.id)}>
            <span className='w-3.5 h-3.5 shrink-0 text-muted'><WheelIcon /></span>
            <span className='truncate'>{w.name}</span>
            <span className='ml-auto text-dim shrink-0'>
              {vehicle.drive === 'engine' && w.driven ? 'driven' : vehicle.drive === 'motors' && w.motorTorque > 0 ? 'motor' : ''}
              {w.steerAngle > 0 ? ' · steers' : ''}
            </span>
          </button>
          <Button variant='remove' size='icon' className='p-1' title={`Remove ${w.name}`}
            onClick={() => { editorScene?.removeNode(w); vehicle.rebuild() }}>
            <span className='block w-3 h-3'><CloseIcon /></span>
          </Button>
        </div>
      ))}
      <div className={cn(JOINED_GROUP_CLASS, 'mt-1')}>
        <button type='button' className={ITEM} title='Add a wheel at the next free corner of the chassis' onClick={() => add(1)}>
          <span className='w-4 h-4'><WheelIcon /></span>
        </button>
        <button type='button' className={cn(ITEM, JOINED_DIVIDER_CLASS)} title='Add an axle: a left and a right wheel' onClick={() => add(2)}>
          <span className='w-4 h-4'><AxleIcon /></span>
        </button>
      </div>
    </div>
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
      {node.drive === 'engine' && row('RPM', values.rpm.toFixed(0))}
      {node.drive === 'engine' && row('Gear', values.gear > 0 ? String(values.gear) : values.gear < 0 ? 'R' : 'N')}
      {row('On the ground', `${values.grounded} / ${node.wheels.length}`)}
    </div>
  )
}

export function WheelEditor(props: { node: WheelNode }) {
  const n = props.node
  const vehicle = vehicleOf(n)
  useSceneVersion()
  const apply = useFields(n, () => vehicle?.rebuild())
  const slider = (label: string, k: keyof WheelNode & string, min: number, max: number, step: number, fixed = 2, hint?: string) => (
    <Slider label={label} min={min} max={max} step={step} value={(n as any)[k] as number} title={hint}
      labelClassName='w-[112px]' readout={v => v.toFixed(fixed)} onChange={v => apply({ [k]: v })} />
  )
  return (
    <Collapsable title='Wheel' icon={<WheelIcon />} persistKey='wheel'>
      <DocScope page='editor/vehicles' section='wheel'>
        <div className='w-full p-2'>
          {!vehicle && <p className='text-ui-sm text-muted mb-2'>Put it under a Vehicle node.</p>}
          {n.children.length === 0 && <p className='text-ui-sm text-muted mb-2'>No mesh: put the wheel's model under it, and it turns and steers with the wheel.</p>}
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
          {slider('Brake', 'brakeTorque', 0, 10000, 50, 0)}
          {slider('Hand brake', 'handBrakeTorque', 0, 10000, 50, 0)}

          {vehicle?.drive === 'engine' && <Toggle className='mb-2 mt-2' checked={n.driven} onChange={checked => apply({ driven: checked })}
            label={<span className={cn(labelClass, hintAffordance(DRIVEN_HINT))} title={DRIVEN_HINT}>Driven</span>} />}

          {vehicle?.drive === 'motors' && <>
            <SectionTitle title='Motor' className='mt-3 mb-1' />
            {slider('Torque', 'motorTorque', 0, 3000, 10, 0)}
            <Slider label='Top speed' min={1} max={300} step={1} value={Math.round(n.motorTopSpeed * 3.6)}
              labelClassName='w-[112px]' readout={v => `${v.toFixed(0)} km/h`} onChange={v => apply({ motorTopSpeed: v / 3.6 })} />
          </>}
        </div>
      </DocScope>
    </Collapsable>
  )
}
