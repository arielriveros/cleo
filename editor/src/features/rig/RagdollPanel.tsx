import { useEffect, useState } from 'react'
import { autoHumanoidProfile, defaultJoint, findBoneJoint, type RagdollJointType, type RagdollPart, type RagdollProfile, type RagdollShape } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useRig } from './RigContext'
import { getAnimationTarget } from '../animation/skeleton'
import {
  Button, Hint, NumberInput, PropertyRow, PropertyTable, Select, Slider, TextInput, Toggle, cn, sectionTitleClass,
} from '../../components/ui'
import { RAGDOLL_SELECT_PART, RAGDOLL_SHOW, RAGDOLL_TEST, RAGDOLL_TEST_STATE, rigRagdollProfile } from './RagdollPreview'

// The rig's ragdoll: which bones become bodies when a character on this skeleton dies, how big and
// heavy each is, and how each joint bends. Authored here, embedded into every model on the rig, read by
// the runtime ragdoll (engine `ragdollProfile.ts`). With nothing authored, a humanoid skeleton falls with
// the automatic profile, which this panel shows as a preview and can turn into an editable copy.

const SHAPES: { value: RagdollShape; label: string }[] = [
  { value: 'capsule', label: 'Capsule' }, { value: 'box', label: 'Box' }, { value: 'sphere', label: 'Sphere' },
]
const JOINTS: { value: RagdollJointType; label: string }[] = [
  { value: 'cone', label: 'Cone (ball with limits)' }, { value: 'hinge', label: 'Hinge (knee, elbow)' }, { value: 'fixed', label: 'Fixed' },
]

export default function RagdollPanel() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const { asset, patch } = useRig()
  const [open, setOpen] = useState<number | null>(null)
  const [selectedJoint, setSelectedJoint] = useState(-1)
  const [testing, setTesting] = useState(false)
  const [show, setShow] = useState(true)

  useEffect(() => {
    const onJoint = (i: number) => setSelectedJoint(typeof i === 'number' ? i : -1)
    const onTest = (v: boolean) => setTesting(!!v)
    eventEmitter.on('SELECT_JOINT', onJoint)
    eventEmitter.on(RAGDOLL_TEST_STATE, onTest)
    return () => { eventEmitter.off('SELECT_JOINT', onJoint); eventEmitter.off(RAGDOLL_TEST_STATE, onTest) }
  }, [eventEmitter])

  const target = getAnimationTarget(editorScene, skeletonTargetId)
  const skin = target?.skin ?? null
  const { profile, authored } = rigRagdollProfile(asset?.ragdoll, skin)

  // Clicking a bone in the skeleton opens the part on it.
  useEffect(() => {
    if (!skin || !profile || selectedJoint < 0) return
    const i = profile.parts.findIndex(p => findBoneJoint(skin, p.bone) === selectedJoint)
    if (i >= 0 && i !== open) { setOpen(i); eventEmitter.emit(RAGDOLL_SELECT_PART, i) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedJoint])

  if (!asset) return null

  const boneNames = skin
    ? skin.joints.map(j => skin.nodeNames?.get(j.nodeIndex)).filter((n): n is string => !!n)
    : []
  const selectedBone = skin && selectedJoint >= 0 ? skin.nodeNames?.get(skin.joints[selectedJoint]?.nodeIndex) : undefined

  const write = (next: RagdollProfile | null) => patch({ ...asset, ragdoll: next ? (next as never) : undefined })
  const set = (change: Partial<RagdollProfile>) => profile && write({ ...profile, ...change })
  const setPart = (i: number, change: Partial<RagdollPart>) =>
    profile && write({ ...profile, parts: profile.parts.map((p, k) => (k === i ? { ...p, ...change } : p)) })
  const setJoint = (i: number, change: Partial<RagdollPart['joint']>) =>
    profile && setPart(i, { joint: { ...profile.parts[i].joint, ...change } })

  const select = (i: number | null) => {
    setOpen(i)
    eventEmitter.emit(RAGDOLL_SELECT_PART, i)
    if (i !== null && skin && profile) {
      const j = findBoneJoint(skin, profile.parts[i].bone)
      if (j >= 0) eventEmitter.emit('SELECT_JOINT', j)
    }
  }

  const generate = () => {
    if (!skin) return
    const auto = autoHumanoidProfile(skin)
    if (auto) write(auto)
  }
  const addPart = () => {
    const bone = selectedBone ?? boneNames[0]
    if (!bone) return
    const base: RagdollProfile = profile ?? { version: 1, totalMass: 70, parts: [], selfCollision: true, linearDamping: 0.02, angularDamping: 0.2, solverIterations: 20 }
    const part: RagdollPart = {
      name: bone.split(':').pop() ?? bone, bone, shape: 'capsule', radius: 0.05, massFraction: 0.05, joint: defaultJoint('cone'),
    }
    write({ ...base, parts: [...base.parts, part] })
    select(base.parts.length)
  }

  const massSum = profile ? profile.parts.reduce((s, p) => s + Math.max(0, p.massFraction), 0) || 1 : 1

  return (
    <div>
      <div className={cn(sectionTitleClass, 'mb-1')}>Ragdoll</div>
      <Hint className='mb-1'>
        {authored
          ? 'How characters on this skeleton fall when they die. Every model on the skeleton falls with this.'
          : profile
            ? 'Automatic humanoid ragdoll (shown in the viewport). Customize it to edit the parts.'
            : 'Not a recognizable humanoid: characters fall with the generic per-bone ragdoll. Add parts to author one.'}
      </Hint>

      <div className='flex gap-1 mb-1'>
        {!authored && profile && <Button variant='subtle' size='sm' className='flex-1' onClick={() => write(profile)}
          title='Copy the automatic profile into the skeleton so its parts can be edited'>Customize</Button>}
        {authored && <Button variant='subtle' size='sm' className='flex-1' onClick={generate} disabled={!skin}
          title='Replace every part with a fresh automatic humanoid fit'>Regenerate</Button>}
        {authored && <Button variant='subtle' size='sm' className='flex-1' onClick={() => { write(null); select(null) }}
          title='Drop the authored profile and go back to the automatic one'>Reset to auto</Button>}
      </div>

      <div className='flex gap-1 mb-2 items-center'>
        <Button variant={testing ? 'primary' : 'subtle'} size='sm' className='flex-1' disabled={!target}
          title='Drop the preview character onto a floor to see how it falls'
          onClick={() => eventEmitter.emit(RAGDOLL_TEST, 'drop')}>{testing ? 'Drop again' : 'Test drop'}</Button>
        <Button variant='subtle' size='sm' className='flex-1' disabled={!testing}
          onClick={() => eventEmitter.emit(RAGDOLL_TEST, 'reset')}>Reset pose</Button>
        <Toggle label='Show' checked={show} onChange={v => { setShow(v); eventEmitter.emit(RAGDOLL_SHOW, v) }} />
      </div>

      {profile && (
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Total mass (kg)' hint='The whole body. Each part gets its share below.'>
            <NumberInput value={profile.totalMass} min={1} step={5} disabled={!authored} onChange={v => set({ totalMass: Math.max(1, v) })} />
          </PropertyRow>
          <PropertyRow label='Self collision' hint='Arms and legs collide with each other and the torso. Directly jointed parts never do.'>
            <Toggle checked={profile.selfCollision} disabled={!authored} onChange={v => set({ selfCollision: v })} />
          </PropertyRow>
          <PropertyRow label='Spin damping' hint='How quickly tumbling dies away. Higher looks heavier and slower; too high looks like moving through syrup.'>
            <NumberInput value={profile.angularDamping} min={0} max={1} step={0.05} disabled={!authored} onChange={v => set({ angularDamping: Math.min(1, Math.max(0, v)) })} />
          </PropertyRow>
          <PropertyRow label='Solver iterations' hint='While a ragdoll is moving. Fewer lets joints stretch; more costs time.'>
            <NumberInput value={profile.solverIterations} min={5} max={60} step={1} disabled={!authored} onChange={v => set({ solverIterations: Math.round(Math.min(60, Math.max(5, v))) })} />
          </PropertyRow>
        </PropertyTable>
      )}

      <div className='flex flex-col gap-1 mt-1'>
        {profile?.parts.map((part, i) => {
          const isOpen = open === i
          const missing = boneNames.length > 0 && !boneNames.includes(part.bone)
          const jt = part.joint ?? defaultJoint()
          return (
            <div key={i} className={cn('rounded border', isOpen ? 'border-highlight' : 'border-control')}>
              <div className='flex items-center gap-1 p-1'>
                <button className='text-ui-sm px-1 shrink-0 text-muted hover:text-fg' onClick={() => select(isOpen ? null : i)}>
                  {isOpen ? '▾' : '▸'}
                </button>
                {authored
                  ? <TextInput className='flex-1' value={part.name} onChange={v => setPart(i, { name: v })} />
                  : <span className='flex-1 truncate text-ui'>{part.name}</span>}
                <span className='text-ui-sm text-muted shrink-0' title='Share of the total mass'>
                  {(profile.totalMass * Math.max(0, part.massFraction) / massSum).toFixed(1)} kg
                </span>
                {authored && <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='Remove this part. Its bones ride on the part above.'
                  onClick={() => { write({ ...profile, parts: profile.parts.filter((_, k) => k !== i) }); select(null) }}>✕</Button>}
              </div>
              {isOpen && (
                <div className='p-1 pt-0'>
                  <PropertyTable columns={['40%', '60%']}>
                    <PropertyRow label='Bone' hint='The body rides on this bone; bones under it without a part of their own ride along.'>
                      <Select value={part.bone} disabled={!authored} onChange={e => setPart(i, { bone: e.target.value })}>
                        {missing && <option value={part.bone}>{part.bone} (missing)</option>}
                        {boneNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </Select>
                    </PropertyRow>
                    <PropertyRow label='Ends at' hint='The bone where the segment ends; sets its direction and default length.'>
                      <Select value={part.tipBone ?? ''} disabled={!authored} onChange={e => setPart(i, { tipBone: e.target.value || undefined })}>
                        <option value=''>Along the bone</option>
                        {boneNames.map(n => <option key={n} value={n}>{n}</option>)}
                      </Select>
                    </PropertyRow>
                    <PropertyRow label='Shape'>
                      <Select value={part.shape} disabled={!authored} onChange={e => setPart(i, { shape: e.target.value as RagdollShape })}>
                        {SHAPES.map(s => <option key={s.value} value={s.value}>{s.label}</option>)}
                      </Select>
                    </PropertyRow>
                    <PropertyRow label={part.shape === 'box' ? 'Half width' : 'Radius'} hint='In the skeleton’s units (metres on most skeletons).'>
                      <NumberInput value={part.radius} min={0.005} step={0.005} disabled={!authored} onChange={v => setPart(i, { radius: Math.max(0.005, v) })} />
                    </PropertyRow>
                    {part.shape !== 'sphere' && (
                      <PropertyRow label='Length' hint='Blank: from the bone to “Ends at”.'>
                        <NumberInput value={part.length ?? 0} min={0} step={0.01} disabled={!authored}
                          onChange={v => setPart(i, { length: v > 0 ? v : undefined })} />
                      </PropertyRow>
                    )}
                    {part.shape === 'box' && (
                      <PropertyRow label='Depth'>
                        <NumberInput value={part.depth ?? part.radius * 2} min={0.005} step={0.005} disabled={!authored} onChange={v => setPart(i, { depth: Math.max(0.005, v) })} />
                      </PropertyRow>
                    )}
                    <PropertyRow label='Mass share' hint='Relative weight of this part; normalized over all parts.'>
                      <NumberInput value={part.massFraction} min={0} step={0.005} disabled={!authored} onChange={v => setPart(i, { massFraction: Math.max(0, v) })} />
                    </PropertyRow>
                    <PropertyRow label='Joint' divider>
                      <Select value={jt.type} disabled={!authored} onChange={e => setJoint(i, { type: e.target.value as RagdollJointType })}>
                        {JOINTS.map(j => <option key={j.value} value={j.value}>{j.label}</option>)}
                      </Select>
                    </PropertyRow>
                  </PropertyTable>
                  {jt.type === 'cone' && (
                    <div className='flex flex-col gap-1 mt-1'>
                      <Slider label='Swing' min={0} max={150} step={1} value={jt.swing} readout={v => `${v.toFixed(0)}°`}
                        onChange={v => authored && setJoint(i, { swing: v })} />
                      <Slider label='Twist' min={0} max={180} step={1} value={jt.twist} readout={v => `${v.toFixed(0)}°`}
                        title='Rotation about the bone. Keep it loose: a tight twist limit jitters.'
                        onChange={v => authored && setJoint(i, { twist: v })} />
                      <Slider label='Aim forward' min={-90} max={90} step={1} value={jt.tilt?.[0] ?? 0} readout={v => `${v.toFixed(0)}°`}
                        title='Turn the centre of the cone toward the character’s front'
                        onChange={v => authored && setJoint(i, { tilt: [v, jt.tilt?.[1] ?? 0] })} />
                      <Slider label='Aim down' min={-90} max={90} step={1} value={jt.tilt?.[1] ?? 0} readout={v => `${v.toFixed(0)}°`}
                        title='Turn the centre of the cone toward the ground (an arm bound in a T-pose rests lower)'
                        onChange={v => authored && setJoint(i, { tilt: [jt.tilt?.[0] ?? 0, v] })} />
                    </div>
                  )}
                  {jt.type === 'hinge' && (
                    <div className='flex flex-col gap-1 mt-1'>
                      <Slider label='Bend from' min={-90} max={180} step={1} value={jt.hingeMin} readout={v => `${v.toFixed(0)}°`}
                        onChange={v => authored && setJoint(i, { hingeMin: v })} />
                      <Slider label='Bend to' min={-90} max={180} step={1} value={jt.hingeMax} readout={v => `${v.toFixed(0)}°`}
                        onChange={v => authored && setJoint(i, { hingeMax: v })} />
                      <Button variant='subtle' size='sm' disabled={!authored}
                        title='Fold the other way (a knee folds back, an elbow forward)'
                        onClick={() => {
                          const d = jt.bendDir ?? [0, 0, 1]
                          setJoint(i, { bendDir: [-d[0], -d[1], -d[2]] })
                        }}>Flip bend direction</Button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>

      {(authored || !profile) && (
        <Button variant='subtle' className='w-full py-1.5 mt-1' disabled={!boneNames.length} onClick={addPart}
          title={selectedBone ? `Add a part on ${selectedBone}` : 'Pick a bone in the Skeleton panel first'}>
          + Add part{selectedBone ? ` on ${selectedBone.split(':').pop()}` : ''}
        </Button>
      )}
      {!target && <Hint className='mt-1'>Pick a preview model to see the ragdoll.</Hint>}
    </div>
  )
}
