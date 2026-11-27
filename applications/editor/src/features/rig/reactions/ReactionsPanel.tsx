import { useEffect, useMemo, useState } from 'react'
import { mat4 } from 'gl-matrix'
import {
  BEHAVIOUR_SPECS, MUSCLE_REGIONS, MUSCLE_SPECS, PHYSICS_BACKENDS, PIN_SPECS, REACTION_PRESETS, THRESHOLD_SPECS, defaultReactionSet, parseReactionSet,
  type BehaviourConfig, type BehaviourId, type MuscleRegion, type ReactionParamSpec, type ReactionSet,
} from 'cleo'
import {
  Button, Collapsable, DocScope, Hint, PresetMenu, SectionTitle, SegmentedControl, Select, Slider, TextInput, Toggle, cn,
} from '@cleo/app-kit/ui'
import { PauseIcon, PlayIcon, StepForwardIcon, StopIcon, CopyIcon, CloseIcon } from '@cleo/app-kit/ui/icons'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { useCleoEngine } from '../../EngineContext'
import { useAssetLibrary } from '../../AssetLibraryContext'
import { useRig } from '../RigContext'
import { getAnimationTarget } from '../../animation/skeleton'
import { newPose, posesForRig } from '../../../utils/poseAssets'
import type { StoredPoseBone } from '../../../utils/animationAssets'
import { freePoseName, projectPoseAsset } from '../../../utils/poseEdit'
import { usePoseAssetEdit } from '../posePreview'
import { poseDeltaOf } from '../boneTrs'
import { pinKey, useCreatorPins } from '../../creator/creatorPins'
import type { RigReactions } from '../../../utils/reactionSets'
import { benchStore, type BenchActWhat, type BenchState, type BenchTool } from './benchStore'
import { BENCH_SCENARIOS, type BenchScenario } from './scenarios'
import ReactionTimeline from './ReactionTimeline'
import {
  BailIcon, CaptureIcon, FallIcon, GetUpIcon, HitIcon, KillIcon, KnockOutIcon, NoToolIcon, ShootIcon, ShoveIcon, TripIcon,
} from './reactionIcons'

// The rig's Reactions tab: how characters on this skeleton react when they are hit, shoved, trip, drop or are
// thrown from a vehicle (the engine's physics/reactive/, Euphoria's model: muscles per body region, reflexes
// called behaviours). A skeleton holds named SETS (a soldier and a civilian on one rig); every number comes from
// the engine's spec tables, and each behaviour can be given poses from the pose library and clips of the rig.
// The bench below runs the set being edited on the preview character, live: change a number and see it.

const icon = 'inline-block w-4 h-4'
/** The sliders' label and readout columns: room for the longest names ("Recovered after") and units ("250 N·m"). */
const LABEL = 'w-[104px]'
const READOUT = 'w-[64px] whitespace-nowrap'
const REGION_LABEL: Record<MuscleRegion, string> = { neck: 'Neck and head', spine: 'Spine', arms: 'Arms', hands: 'Hands', legs: 'Legs', feet: 'Feet' }

function useBench(): BenchState {
  const [s, setS] = useState(benchStore.get())
  useEffect(() => benchStore.subscribe(setS), [])
  return s
}

/** One spec'd number as a slider (the label's tooltip comes from the docs table of its section). */
function SpecSlider({ spec, value, onChange, disabled }: { spec: ReactionParamSpec; value: number; onChange: (v: number) => void; disabled?: boolean }) {
  const digits = spec.step >= 1 ? 0 : spec.step >= 0.1 ? 1 : 2
  return (
    <Slider label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={value} title={spec.doc}
      labelClassName={LABEL} readoutClassName={READOUT}
      readout={v => `${v.toFixed(digits)}${spec.unit ? ` ${spec.unit}` : ''}`}
      onChange={v => { if (!disabled) onChange(v) }} />
  )
}

export default function ReactionsPanel() {
  const { editorScene, skeletonTargetId, instance } = useCleoEngine()
  const { asset, patch } = useRig()
  const { animations, poseAssets } = useAssetLibrary()
  const writePose = usePoseAssetEdit()
  const pins = useCreatorPins()
  const bench = useBench()
  const [rename, setRename] = useState(false)
  // Reactions run on Jolt alone (PhysicsCapabilities.reactions): on another backend the tab still shows the sets,
  // every control off, under a warning that says why.
  const physics = instance?.physics
  const supported = !physics || (physics.capabilities ? physics.capabilities.reactions : physics.backend === 'jolt')
  const backendName = physics ? PHYSICS_BACKENDS.find(b => b.request === physics.backend)?.label ?? physics.backend : ''

  const reactions: RigReactions | undefined = asset?.reactions
  const sets = reactions?.sets ?? []
  const index = Math.max(0, Math.min(sets.length - 1, bench.set))
  const authored = sets.length > 0
  const set: ReactionSet = useMemo(() => (authored ? parseReactionSet(sets[index], index) : defaultReactionSet()), [authored, sets, index])

  const clips = useMemo(() => (asset?.animationIds ?? [])
    .map(id => animations.find(a => a.id === id)).filter(Boolean)
    .flatMap(a => ((a as { clips?: { name: string }[] }).clips ?? []).map(c => c.name)), [asset?.animationIds, animations])
  const poses = useMemo(() => posesForRig(asset, poseAssets), [asset, poseAssets])
  const poseHome = (poseId: string) => poseAssets.find(a => a.poses.some(p => p.id === poseId))

  if (!asset) return null

  const write = (next: RigReactions | undefined) => patch({ ...asset, reactions: next })
  const writeSet = (next: ReactionSet) => {
    if (!authored) return
    write({ version: 1, ...(reactions?.defaultSet ? { defaultSet: reactions.defaultSet } : {}), sets: sets.map((s, i) => (i === index ? next : s)) })
  }
  const setNumber = (path: (s: ReactionSet) => Record<string, number>, key: string, v: number) => {
    const next = JSON.parse(JSON.stringify(set)) as ReactionSet
    path(next)[key] = v
    writeSet(next)
  }
  const setBehaviour = (id: BehaviourId, change: (b: BehaviourConfig) => void) => {
    const next = JSON.parse(JSON.stringify(set)) as ReactionSet
    change(next.behaviours[id])
    writeSet(next)
  }
  const addSet = (make: () => ReactionSet, name?: string) => {
    const s = make()
    const taken = new Set(sets.map(x => x.name))
    let n = name ?? s.name, k = 2
    while (taken.has(n)) n = `${name ?? s.name} ${k++}`
    const id = `${n.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Math.random().toString(36).slice(2, 7)}`
    write({ version: 1, ...(reactions?.defaultSet ? { defaultSet: reactions.defaultSet } : {}), sets: [...sets, { ...s, id, name: n }] })
    benchStore.set({ set: sets.length })
  }

  // The pose the simulated body holds now (the bench's character, as the bodies draw it), as a new pose.
  const capture = async () => {
    const t = getAnimationTarget(editorScene, skeletonTargetId)
    if (!t) return
    const name = await promptDialog({ title: 'Capture pose', message: 'The body as the simulation holds it now, every bone off its rest: a pose to give a behaviour.', defaultValue: 'Reaction pose' })
    if (!name?.trim()) return
    const skin = t.skin, finals = t.animator.getFinalBoneMatrices()
    const globals = new Map<number, mat4>()
    skin.joints.forEach((j, i) => {
      const bind = mat4.create()
      if (!mat4.invert(bind, j.inverseBindMatrix as mat4)) return
      globals.set(j.nodeIndex, mat4.multiply(mat4.create(), finals[i], bind))
    })
    const bones: StoredPoseBone[] = []
    for (const j of skin.joints) {
      const boneName = skin.nodeNames?.get(j.nodeIndex)
      const g = globals.get(j.nodeIndex), parent = skin.nodeParents?.get(j.nodeIndex)
      const pg = parent !== undefined ? globals.get(parent) : undefined
      const rest = t.animator.boneRestTransform(j.nodeIndex)
      if (!boneName || !g || !rest) continue
      const local = pg ? mat4.multiply(mat4.create(), mat4.invert(mat4.create(), pg)!, g) : g
      const delta = poseDeltaOf(local, rest)
      if (delta?.rotation) bones.push({ name: boneName, rotation: delta.rotation })
    }
    const home = projectPoseAsset(poseAssets, asset.id, asset.name, id => pins.folders.has(pinKey('pose', id))).asset
    const pose = newPose(freePoseName(home, name.trim()), bones)
    writePose({ ...home, poses: [...home.poses, pose] }, 'Capture pose')
  }

  const tools: { value: BenchTool; label: React.ReactNode; title: string }[] = [
    { value: 'shoot', label: <span className={icon}><ShootIcon /></span>, title: 'Click the character to shoot it there' },
    { value: 'push', label: <span className={icon}><ShoveIcon /></span>, title: 'Click the character to shove it there' },
    { value: 'none', label: <span className={icon}><NoToolIcon /></span>, title: 'Clicks go to the viewport as usual' },
  ]
  const actions: { what: BenchActWhat; icon: React.ReactNode; title: string }[] = [
    { what: 'hit', icon: <HitIcon />, title: 'Hit it in the chest (with the impulse set)' },
    { what: 'push', icon: <ShoveIcon />, title: 'Shove it (the scenario’s push)' },
    { what: 'trip', icon: <TripIcon />, title: 'Trip it' },
    { what: 'fall', icon: <FallIcon />, title: 'Make it fall from where it stands' },
    { what: 'bail', icon: <BailIcon />, title: 'Throw it out of a moving vehicle (the speed set)' },
    { what: 'knockOut', icon: <KnockOutIcon />, title: 'Knock it out: it lies a while before it can get up' },
    { what: 'kill', icon: <KillIcon />, title: 'Kill it: it falls limp and stays down' },
    { what: 'getUp', icon: <GetUpIcon />, title: 'Get up now, if it is down' },
  ]
  const o = bench.options
  const setOption = (k: keyof typeof o, v: number) => benchStore.set({ options: { ...o, [k]: v } })

  return (
    <DocScope page='editor/reactions'>
      <div>
        <SectionTitle title='Reactions' doc='editor/reactions' className='mb-1' />
        {!supported && (
          <div role='alert' data-testid='reactions-jolt-only' className='text-ui-xs text-warning border border-warning/40 rounded p-1 mb-1 leading-snug'>
            Reactions run only on the Jolt physics backend. This project runs on {backendName}, so its characters do not
            react to hits and nothing here can be changed. Switch the project to Jolt in the options' Physics backend.
          </div>
        )}
        {/* Off as a whole: the fieldset turns off its native controls, `inert` the custom ones (sliders, toggles). */}
        <fieldset disabled={!supported} {...(supported ? {} : { inert: '' } as React.HTMLAttributes<HTMLFieldSetElement>)}
          className={cn('min-w-0 m-0 p-0 border-0', !supported && 'opacity-50 pointer-events-none select-none')}>

        {/* ----- the sets ----- */}
        {!authored ? (
          <>
            <Hint className='mb-1'>Characters on this skeleton react with the built-in Default set. Customize it to tune their muscles and reflexes.</Hint>
            <div className='flex gap-1 mb-2'>
              <Button variant='subtle' size='sm' className='flex-1' onClick={() => addSet(() => defaultReactionSet(), 'Default')}
                title='Give this skeleton its own reaction set, starting from the built-in one'>Customize</Button>
              <PresetMenu presets={REACTION_PRESETS.map(p => ({ id: p.name, label: p.name, description: p.doc, make: p.make }))}
                label='From a preset' title='Start this skeleton’s reactions from a ready-made set' onApply={p => addSet(p.make, p.label)} />
            </div>
          </>
        ) : (
          <div className='flex gap-1 mb-2 items-center'>
            {rename
              ? <TextInput className='flex-1' value={set.name} autoFocus onChange={v => writeSet({ ...set, name: v || set.name })} onBlur={() => setRename(false)} />
              : (
                <Select className='flex-1' value={String(index)} onChange={e => benchStore.set({ set: Number(e.target.value) })}
                  onDoubleClick={() => setRename(true)} title='The set being edited and tried (double-click to rename)'>
                  {sets.map((s, i) => <option key={s.id ?? i} value={i}>{s.name}{reactions?.defaultSet === s.id ? ' (default)' : ''}</option>)}
                </Select>
              )}
            <PresetMenu presets={REACTION_PRESETS.map(p => ({ id: p.name, label: p.name, description: p.doc, make: p.make }))}
              label='New' title='Add a set, from a preset' onApply={p => addSet(p.make, p.label)} />
            <Button variant='subtle' size='sm' className='px-1' title='Duplicate this set' onClick={() => addSet(() => JSON.parse(JSON.stringify(set)), `${set.name} copy`)}>
              <span className={icon}><CopyIcon /></span>
            </Button>
            <Toggle label='Default' checked={reactions?.defaultSet === set.id} title='The set a model on this skeleton uses when it names none'
              onChange={v => write({ version: 1, ...(v ? { defaultSet: set.id } : {}), sets })} />
            <Button variant='remove' size='sm' className='px-1' title='Delete this set'
              onClick={() => { write(sets.length > 1 ? { version: 1, sets: sets.filter((_, i) => i !== index) } : undefined); benchStore.set({ set: 0 }) }}>
              <span className={icon}><CloseIcon /></span>
            </Button>
          </div>
        )}

        {/* ----- the bench ----- */}
        <Collapsable title='Test bench' persistKey='reactions.bench' doc='editor/reactions#the-test-bench'>
          <div className='flex flex-col gap-1'>
            <Select value={bench.scenario} title={BENCH_SCENARIOS.find(s => s.id === bench.scenario)?.doc}
              onChange={e => benchStore.set({ scenario: e.target.value as BenchScenario })}>
              {BENCH_SCENARIOS.map(s => <option key={s.id} value={s.id} title={s.doc}>{s.label}</option>)}
            </Select>
            {bench.scenario === 'stairs' && <>
              <Slider label='Steps' min={2} max={30} step={1} value={o.stairCount} readout onChange={v => setOption('stairCount', v)} />
              <Slider label='Rise' min={0.05} max={0.4} step={0.01} value={o.stairRise} readout={v => `${v.toFixed(2)} m`} onChange={v => setOption('stairRise', v)} />
              <Slider label='Run' min={0.15} max={0.6} step={0.01} value={o.stairRun} readout={v => `${v.toFixed(2)} m`} onChange={v => setOption('stairRun', v)} />
            </>}
            {bench.scenario === 'ramp' && <Slider label='Slope' min={5} max={60} step={1} value={o.rampAngle} readout={v => `${v.toFixed(0)}°`} onChange={v => setOption('rampAngle', v)} />}
            {bench.scenario === 'ledge' && <Slider label='Drop' min={0.5} max={15} step={0.1} value={o.ledgeHeight} readout={v => `${v.toFixed(1)} m`} onChange={v => setOption('ledgeHeight', v)} />}
            {bench.scenario === 'vehicle' && <Slider label='Speed' min={0} max={40} step={0.5} value={o.vehicleSpeed} readout={v => `${v.toFixed(1)} m/s`} onChange={v => setOption('vehicleSpeed', v)} />}

            <div className='flex gap-1 items-center'>
              <Button variant={bench.running ? 'primary' : 'subtle'} size='sm' className='px-1' title={bench.running ? 'Run the scenario again from the start' : 'Run the scenario'}
                onClick={() => benchStore.act({ kind: 'start' })}><span className={icon}><PlayIcon /></span></Button>
              <Button variant='subtle' size='sm' className='px-1' disabled={!bench.running} title='End the run: props gone, the character back on its animation'
                onClick={() => benchStore.act({ kind: 'reset' })}><span className={icon}><StopIcon /></span></Button>
              <Button variant={bench.paused ? 'primary' : 'subtle'} size='sm' className='px-1' title={bench.paused ? 'Resume (from the replay frame, if scrubbed)' : 'Pause'}
                onClick={() => benchStore.set({ paused: !bench.paused, scrub: null })}><span className={icon}>{bench.paused ? <PlayIcon /> : <PauseIcon />}</span></Button>
              <Button variant='subtle' size='sm' className='px-1' disabled={!bench.paused} title='One frame forward'
                onClick={() => benchStore.act({ kind: 'step' })}><span className={icon}><StepForwardIcon /></span></Button>
              <SegmentedControl size='sm' value={bench.slow} onChange={v => benchStore.set({ slow: v })}
                options={[1, 0.5, 0.25, 0.1].map(v => ({ value: v, label: `${v}×`, title: v === 1 ? 'Real time' : `Slow motion: ${v} of real time` }))} />
            </div>

            <div className='flex gap-1 items-center flex-wrap'>
              <SegmentedControl size='sm' joined value={bench.tool} onChange={v => benchStore.set({ tool: v })} options={tools} />
              {actions.map(a => (
                <Button key={a.what} variant='subtle' size='sm' className='px-1' title={a.title} onClick={() => benchStore.act({ kind: 'act', what: a.what })}>
                  <span className={icon}>{a.icon}</span>
                </Button>
              ))}
              <Button variant='subtle' size='sm' className='px-1' title='Capture the pose the body holds now into the pose library' onClick={capture}>
                <span className={icon}><CaptureIcon /></span>
              </Button>
            </div>
            <Slider label='Impulse' min={1} max={400} step={1} value={bench.impulse} readout={v => `${v.toFixed(0)} N·s`}
              labelClassName={LABEL} readoutClassName={READOUT}
              title='How hard a shot, a click-shove or the hit button lands' onChange={v => benchStore.set({ impulse: v })} />
            <div className='flex gap-2'>
              <Toggle label='Target' checked={bench.overlays.target} title='Draw the pose the muscles reach for'
                onChange={v => benchStore.set({ overlays: { ...bench.overlays, target: v } })} />
              <Toggle label='Balance' checked={bench.overlays.balance} title='Draw the centre of mass and the capture point'
                onChange={v => benchStore.set({ overlays: { ...bench.overlays, balance: v } })} />
              <Toggle label='Impact' checked={bench.overlays.impact} title='Draw where the fall will land'
                onChange={v => benchStore.set({ overlays: { ...bench.overlays, impact: v } })} />
            </div>
            {bench.live && (
              <div className='text-ui-sm text-muted'>
                <span className='text-fg'>{bench.live.state}</span>
                {Object.keys(bench.live.behaviours).length > 0 && <> · {Object.entries(bench.live.behaviours).map(([b, w]) => `${b} ${Math.round(w * 100)}%`).join(', ')}</>}
                {' '}· health {Math.round(bench.live.health * 100)}%
              </div>
            )}
            <ReactionTimeline />
          </div>
        </Collapsable>

        {/* ----- the numbers ----- */}
        {!authored && <Hint className='mb-1'>The numbers below are the built-in set’s; customize to change them.</Hint>}
        <div className={cn(!authored && 'opacity-70')}>
          <Collapsable title='Muscles' persistKey='reactions.muscles' doc='editor/reactions#muscles'>
            <Slider label='Overall strength' min={0} max={5} step={0.05} value={set.strength} readout={v => `${v.toFixed(2)}×`}
              labelClassName={LABEL} readoutClassName={READOUT}
              title='Multiplies every muscle: a tough character, a weak one' onChange={v => authored && writeSet({ ...set, strength: v })} />
            {MUSCLE_REGIONS.map(region => (
              <div key={region} className='mt-1'>
                <div className='text-ui-sm text-muted'>{REGION_LABEL[region]}</div>
                {MUSCLE_SPECS.map(spec => (
                  <SpecSlider key={spec.key} spec={spec} value={set.muscles[region][spec.key as keyof ReactionSet['muscles'][MuscleRegion]]} disabled={!authored}
                    onChange={v => setNumber(s => s.muscles[region] as unknown as Record<string, number>, spec.key, v)} />
                ))}
              </div>
            ))}
          </Collapsable>
          <Collapsable title='Strings' persistKey='reactions.pins' doc='editor/reactions#strings'>
            {PIN_SPECS.map(spec => <SpecSlider key={spec.key} spec={spec} value={set.pins[spec.key]} disabled={!authored} onChange={v => setNumber(s => s.pins, spec.key, v)} />)}
          </Collapsable>
          <Collapsable title='Thresholds' persistKey='reactions.thresholds' doc='editor/reactions#thresholds'>
            {THRESHOLD_SPECS.map(spec => <SpecSlider key={spec.key} spec={spec} value={set.thresholds[spec.key]} disabled={!authored} onChange={v => setNumber(s => s.thresholds, spec.key, v)} />)}
          </Collapsable>
          {BEHAVIOUR_SPECS.map(spec => {
            const b = set.behaviours[spec.id]
            return (
              <Collapsable key={spec.id} title={spec.label} persistKey={`reactions.b.${spec.id}`} defaultOpen={false} doc={`editor/reactions#${spec.label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
                right={<Toggle checked={b.enabled} title={b.enabled ? 'On: it runs when its moment comes' : 'Off: it never runs'} onChange={v => authored && setBehaviour(spec.id, x => { x.enabled = v })} />}>
                <Hint className='mb-1'>{spec.doc}</Hint>
                {spec.params.map(p => <SpecSlider key={p.key} spec={p} value={b.params[p.key]} disabled={!authored} onChange={v => setBehaviour(spec.id, x => { x.params[p.key] = v })} />)}
                {spec.poses.map(slot => {
                  const ref = b.poses?.[slot.slot]?.poseRef
                  return (
                    <div key={slot.slot} className='flex items-center gap-1 mt-1' title={slot.doc}>
                      <span className='text-ui-sm w-24 shrink-0'>{slot.label}</span>
                      <Select className='flex-1' value={ref?.poseId ?? ''} disabled={!authored}
                        onChange={e => setBehaviour(spec.id, x => {
                          const id = e.target.value
                          const home = id ? poseHome(id) : undefined
                          x.poses = { ...(x.poses ?? {}) }
                          if (id && home) x.poses[slot.slot] = { poseRef: { assetId: home.id, poseId: id } }
                          else delete x.poses[slot.slot]
                        })}>
                        <option value=''>None (its own)</option>
                        {poses.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </Select>
                    </div>
                  )
                })}
                {spec.clips.map(slot => (
                  <div key={slot.slot} className='flex items-center gap-1 mt-1' title={slot.doc}>
                    <span className='text-ui-sm w-24 shrink-0'>{slot.label}</span>
                    <Select className='flex-1' value={b.clips?.[slot.slot] ?? ''} disabled={!authored}
                      onChange={e => setBehaviour(spec.id, x => {
                        x.clips = { ...(x.clips ?? {}) }
                        if (e.target.value) x.clips[slot.slot] = e.target.value
                        else delete x.clips[slot.slot]
                      })}>
                      <option value=''>None</option>
                      {clips.map(c => <option key={c} value={c}>{c}</option>)}
                    </Select>
                  </div>
                ))}
              </Collapsable>
            )
          })}
        </div>
        </fieldset>
      </div>
    </DocScope>
  )
}
