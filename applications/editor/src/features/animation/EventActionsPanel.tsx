import { useMemo } from 'react'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, cn, ComboSelect, NumberInput, Select, Toggle } from '@cleo/app-kit/ui'
import type { EventAction, EventActionBinding } from 'cleo'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useStateMachine } from './StateMachineContext'
import { eventNamesOf, targetPaths, type TargetKind } from '../../utils/eventActionTargets'

// Event Actions, in the Variables panel: what each named animation event DOES. A clip's Events track says WHEN
// (a marker `shot` at 0.02 s); this says WHAT happens when it fires, for the character or weapon this machine drives:
// play a sound, burst a particle system, flash a light, spawn a template. The animator runs them itself, so a shot's
// flash and sound stay in sync with the clip and need no script. See animation/eventActions.ts.

/** Dense-row padding for the library controls (their default is px-2 py-1). */
const tight = 'px-1 py-0.5'

const KINDS: { value: EventAction['kind']; label: string; title: string }[] = [
  { value: 'sound', label: 'Play sound', title: 'Play a sound node; a new one rings over the last' },
  { value: 'particles', label: 'Particles', title: 'Burst, start or stop a particle system node' },
  { value: 'light', label: 'Flash light', title: 'Flash a light node, then fade it to nothing' },
  { value: 'spawn', label: 'Spawn', title: 'Spawn a template at a node' },
]

const NEW_ACTION: Record<EventAction['kind'], EventAction> = {
  sound: { kind: 'sound', target: '' },
  particles: { kind: 'particles', target: '', mode: 'burst' },
  light: { kind: 'light', target: '', intensity: 8000, seconds: 0.06 },
  spawn: { kind: 'spawn', template: '', at: '' },
}

const KIND_OF_TARGET: Record<EventAction['kind'], TargetKind> = { sound: 'sound', particles: 'particleSystem', light: 'light', spawn: 'any' }

export function EventActionsSection() {
  const { fullSm, target, setEventActions } = useStateMachine()
  const { animations, templates } = useAssetLibrary()
  const bindings = fullSm.eventActions ?? []

  // The names clips carry, so an event is picked rather than typed (a new name is still accepted).
  const names = useMemo(() => {
    const played = new Set<string>()
    for (const layer of [fullSm, ...(fullSm.layers ?? [])]) for (const s of layer.states) if (s.clipName) played.add(s.clipName)
    const clips = animations.flatMap(a => a.clips).filter(c => played.has(c.name))
    return eventNamesOf(clips, fullSm.events, bindings)
  }, [animations, fullSm, bindings])

  const paths = useMemo(() => ({
    sound: targetPaths(target?.node, 'sound'),
    particleSystem: targetPaths(target?.node, 'particleSystem'),
    light: targetPaths(target?.node, 'light'),
    any: targetPaths(target?.node, 'any'),
  }), [target])

  const setBinding = (i: number, patch: Partial<EventActionBinding>) =>
    setEventActions(bindings.map((b, idx) => (idx === i ? { ...b, ...patch } : b)))
  const setAction = (i: number, k: number, next: EventAction) =>
    setBinding(i, { actions: bindings[i].actions.map((a, idx) => (idx === k ? next : a)) })

  return (
    <Collapsable title='Event actions' badge={bindings.length || undefined}>
      <div className='p-2 flex flex-col gap-2'>
        {bindings.length === 0 && (
          <p className='text-ui-sm text-muted'>
            What an animation event does. Add a marker on a clip's Events track, then bind its name here to a sound, particles, a light flash or a spawned template.
          </p>
        )}
        {bindings.map((b, i) => (
          <div key={i} className='flex flex-col gap-1 border border-control rounded p-1'>
            <div className='flex items-center gap-1'>
              <div className='flex-1 min-w-0'>
                <ComboSelect value={b.event} noun='event' allowEmpty={false} allowCustom
                  choices={names.map(value => ({ value }))}
                  title='The event name a clip marker (or a script) fires'
                  onChange={v => setBinding(i, { event: v })} />
              </div>
              <Button variant='remove' size='sm' title='Remove this event' onClick={() => setEventActions(bindings.filter((_, idx) => idx !== i))}>✕</Button>
            </div>
            {b.actions.map((a, k) => (
              <ActionRow key={k} action={a} paths={paths} templates={templates.map(t => t.name)}
                onChange={next => setAction(i, k, next)}
                onRemove={() => setBinding(i, { actions: b.actions.filter((_, idx) => idx !== k) })} />
            ))}
            <div className='flex flex-wrap gap-1'>
              {KINDS.map(kd => (
                <Button key={kd.value} size='sm' variant='subtle' title={kd.title}
                  onClick={() => setBinding(i, { actions: [...b.actions, structuredClone(NEW_ACTION[kd.value])] })}>+ {kd.label}</Button>
              ))}
            </div>
          </div>
        ))}
        <Button size='sm' variant='subtle' className='self-start'
          onClick={() => setEventActions([...bindings, { event: names.find(n => !bindings.some(b => b.event === n)) ?? 'event', actions: [] }])}>+ Event</Button>
      </div>
    </Collapsable>
  )
}

function ActionRow({ action, paths, templates, onChange, onRemove }: {
  action: EventAction
  paths: Record<TargetKind, string[]>
  templates: string[]
  onChange: (next: EventAction) => void
  onRemove: () => void
}) {
  const pick = (kind: TargetKind, value: string, set: (v: string) => void, title: string) => (
    <div className='flex-1 min-w-0'>
      <ComboSelect value={value} noun='node' allowEmpty={false} allowCustom choices={paths[kind].map(v => ({ value: v }))} title={title} onChange={set} />
    </div>
  )
  const label = (text: string) => <span className='text-ui-xs text-muted w-[52px] shrink-0'>{text}</span>
  return (
    <div className='flex flex-col gap-1 rounded bg-surface px-1 py-1'>
      <div className='flex items-center gap-1'>
        <Select className={cn(tight, 'flex-1 min-w-0')} value={action.kind}
          onChange={e => onChange(structuredClone(NEW_ACTION[e.target.value as EventAction['kind']]))}>
          {KINDS.map(k => <option key={k.value} value={k.value} title={k.title}>{k.label}</option>)}
        </Select>
        <Button variant='remove' size='sm' onClick={onRemove}>✕</Button>
      </div>

      {action.kind === 'sound' && (
        <>
          <div className='flex items-center gap-1'>{label('Sound')}{pick(KIND_OF_TARGET.sound, action.target, v => onChange({ ...action, target: v }), 'The sound node, by path, found below this character then each parent')}</div>
          <Toggle label='overlap' className='text-ui-xs' checked={action.overlap !== false}
            onChange={c => onChange({ ...action, ...(c ? { overlap: undefined } : { overlap: false }) })} />
        </>
      )}

      {action.kind === 'particles' && (
        <>
          <div className='flex items-center gap-1'>{label('System')}{pick(KIND_OF_TARGET.particles, action.target, v => onChange({ ...action, target: v }), 'The particle system node')}</div>
          <div className='flex items-center gap-1'>
            {label('Mode')}
            <Select className={cn(tight, 'flex-1 min-w-0')} value={action.mode} onChange={e => onChange({ ...action, mode: e.target.value as 'play' | 'burst' | 'stop' })}>
              <option value='burst'>Burst</option><option value='play'>Start</option><option value='stop'>Stop</option>
            </Select>
            {action.mode === 'burst' && (
              <span title='Particles per burst (0: the emitter’s own burst)'>
                <NumberInput className={cn(tight, 'w-[52px]')} step='1' value={action.count ?? 0} onChange={v => onChange({ ...action, count: Math.max(0, Math.floor(v)) })} />
              </span>
            )}
          </div>
        </>
      )}

      {action.kind === 'light' && (
        <>
          <div className='flex items-center gap-1'>{label('Light')}{pick(KIND_OF_TARGET.light, action.target, v => onChange({ ...action, target: v }), 'The light node. Author it at intensity 0')}</div>
          <div className='flex items-center gap-1'>
            {label('Peak')}
            <span title='Lumens at the peak of the flash'><NumberInput className={cn(tight, 'w-[72px]')} step='500' value={action.intensity} onChange={v => onChange({ ...action, intensity: Math.max(0, v) })} /></span>
            <span className='text-ui-xs text-muted'>s</span>
            <span title='Seconds the flash takes to fade'><NumberInput className={cn(tight, 'w-[56px]')} step='0.01' value={action.seconds} onChange={v => onChange({ ...action, seconds: Math.max(0.01, v) })} /></span>
          </div>
        </>
      )}

      {action.kind === 'spawn' && (
        <>
          <div className='flex items-center gap-1'>
            {label('Template')}
            <div className='flex-1 min-w-0'>
              <ComboSelect value={action.template} noun='template' allowEmpty={false} allowCustom choices={templates.map(v => ({ value: v }))}
                title='The template to instantiate' onChange={v => onChange({ ...action, template: v })} />
            </div>
          </div>
          <div className='flex items-center gap-1'>{label('At')}{pick('any', action.at ?? '', v => onChange({ ...action, at: v || undefined }), 'The node it appears at (empty: this character). A viewmodel node is placed where it is drawn')}</div>
          <div className='flex items-center gap-1'>
            {label('Turn')}
            <Select className={cn(tight, 'flex-1 min-w-0')} value={action.rotation === 'camera' || action.rotation === 'owner' ? action.rotation : Array.isArray(action.rotation) ? 'fixed' : 'target'}
              onChange={e => onChange({ ...action, rotation: e.target.value === 'camera' || e.target.value === 'owner' ? e.target.value : e.target.value === 'fixed' ? [0, 0, 0] : undefined })}>
              <option value='target'>Like the node</option><option value='owner'>Like the character</option><option value='camera'>Like the camera</option><option value='fixed'>Fixed angles</option>
            </Select>
          </div>
          {Array.isArray(action.rotation) && (
            <div className='flex items-center gap-1'>
              {label('Angles')}
              {([0, 1, 2] as const).map(axis => (
                <NumberInput key={axis} className={cn(tight, 'w-[52px]')} step='5' value={(action.rotation as [number, number, number])[axis]}
                  onChange={v => { const r = [...(action.rotation as [number, number, number])] as [number, number, number]; r[axis] = v; onChange({ ...action, rotation: r }) }} />
              ))}
            </div>
          )}
          <Toggle label='follow' className='text-ui-xs' checked={action.follow === true}
            onChange={c => onChange({ ...action, follow: c ? true : undefined })} />
        </>
      )}
    </div>
  )
}
