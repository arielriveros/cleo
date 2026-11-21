import { useEffect, useRef, useState } from 'react'
import { VehicleNode, WheelNode, VEHICLE_PRESETS, applyVehiclePreset, type Node, type VehiclePreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useCleoEngine } from '../../EngineContext'
import { Button, CloseIcon, DocScope, PresetMenu, SectionTitle, cn, labelClass } from '@cleo/app-kit/ui'
import { JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS } from '@cleo/app-kit/ui/SegmentedControl'
import { AxleIcon, VehicleIcon, WheelIcon } from '../sectionIcons'
import { useHistory } from '../../HistoryContext'
import { DeclaredSection } from '../../properties/DeclaredSections'

// The Vehicle and Wheel nodes' panels (docs/editor/vehicles.md): their declared properties (src/properties/
// physics.ts), whose every write builds a vehicle already driving in Play again (VehicleNode.rebuild). A vehicle
// is built here step by step: its wheels are added from the Wheels list, its power chosen under Drive, and its
// meshes are the developer's own. The wheel list, the presets and the live readout are the card's own.

const ITEM = 'flex items-center justify-center w-[30px] h-[24px] text-muted hover:text-fg hover:bg-control'

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
  const { isPlayMode, eventEmitter, editorScene } = useCleoEngine()
  useSceneVersion()
  const history = useHistory()
  const [kept, setKept] = useState<string[]>([])
  useEffect(() => { setKept([]) }, [n])

  // One undo step: the vehicle, its chassis and every wheel are snapshotted before the preset touches them.
  const applyPreset = (preset: VehiclePreset) => {
    history.transaction(`Vehicle preset: ${preset.label}`, async track => {
      await track(n)
      if (n.collider && n.collider !== (n as Node)) await track(n.collider)
      for (const w of n.wheels) await track(w)
      const result = applyVehiclePreset(n, preset, { remove: node => editorScene?.removeNode(node) })
      setKept(result ? result.kept.map(w => w.name) : [])
    }).then(() => {
      eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: n })
      eventEmitter.emit('PHYSICS_CHANGED')
    }).catch(err => console.error(err))
  }
  return (
    <Collapsable title='Vehicle' icon={<VehicleIcon />} persistKey='vehicle'
      right={<PresetMenu presets={VEHICLE_PRESETS} onApply={applyPreset} title='Vehicle presets: settings, wheel layout and chassis (your meshes are kept)' />}>
      <DocScope page='editor/vehicles' section='vehicle'>
        <div className='w-full p-2'>
          {!n.collider && <p className='text-ui-sm text-muted mb-2'>Put it in a Collider with mass: that is its chassis.</p>}
          {kept.length > 0 && <p className='text-ui-sm text-warning mb-2'>Kept {kept.join(', ')}: the preset has no place for {kept.length === 1 ? 'it' : 'them'}, but {kept.length === 1 ? 'it carries' : 'they carry'} a mesh. Delete {kept.length === 1 ? 'it' : 'them'} if not wanted.</p>}

          <SectionTitle title='Wheels' className='mt-1 mb-1' />
          <WheelList vehicle={n} />

          <DeclaredSection node={n} title='Drive'>
            {n.drivetrain === 'none' && <p className='text-ui-sm text-muted mb-2'>Nothing drives it: it rolls, steers and brakes.</p>}
            {n.drivetrain === 'motors' && <p className='text-ui-sm text-muted mb-2'>Each wheel's motor (torque, top speed) is set on the wheel. A wheel with no torque only rolls.</p>}
            {n.drivetrain === 'engine' && n.wheels.every(w => !w.driven) && <p className='text-ui-sm text-warning mb-2'>Mark the wheels the engine turns as Driven, on each wheel.</p>}
          </DeclaredSection>
          <DeclaredSection node={n} title='Driving' />
          <DeclaredSection node={n} title='Engine' />
          <DeclaredSection node={n} title='Gearbox' />
          <DeclaredSection node={n} title='Handling' />
          <DeclaredSection node={n} title='Lean' />
          <DeclaredSection node={n} title='Hitch'>
            {n.hitchTarget && <p className='text-ui-sm text-muted'>In Play a ball joint joins the two chassis where the hitch point is when the scene starts: place it at the towing vehicle's tow ball.</p>}
          </DeclaredSection>

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
  const history = useHistory()
  // The Vehicle stays selected, so wheel after wheel can be added; a row selects its wheel. One undo step each.
  const add = (count: number) => {
    history.transaction(count === 1 ? 'Add wheel' : 'Add axle', async () => {
      for (let i = 0; i < count; i++) vehicle.addWheel()
      vehicle.rebuild()
    }).catch(err => console.error(err))
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
              {vehicle.drivetrain === 'engine' && w.driven ? 'driven' : vehicle.drivetrain === 'motors' && w.motorTorque > 0 ? 'motor' : ''}
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
      {node.drivetrain === 'engine' && row('RPM', values.rpm.toFixed(0))}
      {node.drivetrain === 'engine' && row('Gear', values.gear > 0 ? String(values.gear) : values.gear < 0 ? 'R' : 'N')}
      {row('On the ground', `${values.grounded} / ${node.wheels.length}`)}
    </div>
  )
}

export function WheelEditor(props: { node: WheelNode }) {
  const n = props.node
  const vehicle = vehicleOf(n)
  useSceneVersion()
  return (
    <Collapsable title='Wheel' icon={<WheelIcon />} persistKey='wheel'>
      <DocScope page='editor/vehicles' section='wheel'>
        <div className='w-full p-2'>
          {!vehicle && <p className='text-ui-sm text-muted mb-2'>Put it under a Vehicle node.</p>}
          {n.children.length === 0 && <p className='text-ui-sm text-muted mb-2'>No mesh: put the wheel's model under it, and it turns and steers with the wheel.</p>}
          <DeclaredSection node={n} title='Tyre' />
          <DeclaredSection node={n} title='Suspension' />
          <DeclaredSection node={n} title='Steering and brakes' />
          <DeclaredSection node={n} title='Motor' />
        </div>
      </DocScope>
    </Collapsable>
  )
}
