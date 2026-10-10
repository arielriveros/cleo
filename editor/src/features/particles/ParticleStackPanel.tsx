import { useState } from 'react'
import {
  RENDER_PARAMS, PARTICLE_MESH_TRIANGLE_WARNING, moduleDefinition, makeModule, modulesForStage, particleMeshFromNodeJson,
  type EmitterDef, type ParamSpec, type ParticleModule, type ParticleStage, type ParticleSystemDef,
} from 'cleo'
import {
  Button, Collapsable, Hint, NumberInput, Popover, PropertyRow, PropertyTable, SegmentedControl, Select, TextInput,
  Toggle, VectorInput, cn,
} from '../../components/ui'
import { useParticleEditor } from './ParticleEditorContext'
import { useCleoEngine } from '../EngineContext'
import ParamField from './ParamField'
import { EMITTER_PRESETS } from './emitterPresets'

// The particle editor's Properties panel: the emitter list, then the selected emitter's module stack in
// its three stages, then its renderer. Niagara's stack, in the editor's own inspector vocabulary — every
// card is a `Collapsable`, every field a `ParamField` generated from the module catalogue.
//
// All edits go through `edit`, which clones the working copy, applies a mutation and commits it. Cloning
// the whole system per keystroke is cheap at this size and is what makes undo trivially correct.

const STAGES: { stage: ParticleStage; title: string; key: 'spawn' | 'init' | 'update'; hint: string }[] = [
  { stage: 'spawn', title: 'Spawn', key: 'spawn', hint: 'How many particles are born, and when.' },
  { stage: 'init', title: 'Initialize', key: 'init', hint: 'Each particle\'s starting state, rolled once at birth.' },
  { stage: 'update', title: 'Update', key: 'update', hint: 'Forces, collision and how particles change over their life. Applied in a fixed order every step.' },
]

const FLIPBOOK_PARAMS: ParamSpec[] = [
  { key: 'columns', label: 'Columns', kind: 'int', min: 1, max: 64 },
  { key: 'rows', label: 'Rows', kind: 'int', min: 1, max: 64 },
  { key: 'frames', label: 'Frames', kind: 'int', min: 1, max: 4096, hint: 'Frames used, from the top-left, row by row.' },
  { key: 'mode', label: 'Playback', kind: 'enum', options: [{ value: 'life', label: 'Over lifetime' }, { value: 'fps', label: 'Frames per second' }] },
  { key: 'cycles', label: 'Cycles', kind: 'float', min: 0, step: 0.5, when: p => p.mode === 'life', hint: 'Times the sequence plays over one life.' },
  { key: 'fps', label: 'FPS', kind: 'float', min: 0, step: 1, when: p => p.mode === 'fps' },
  { key: 'randomStart', label: 'Random start', kind: 'bool' },
  { key: 'blend', label: 'Blend frames', kind: 'bool', hint: 'Cross-fade neighbouring frames for smooth motion at low frame counts.' },
]

const clone = (s: ParticleSystemDef): ParticleSystemDef => JSON.parse(JSON.stringify(s))

export default function ParticleStackPanel() {
  const { asset, system, name, rename, emitterId, selectEmitter, commit, save, dirty } = useParticleEditor()

  if (!asset || !system) {
    return <div className='p-3 text-xs text-muted'>No particle system is open.</div>
  }

  const emitter = system.emitters.find(e => e.id === emitterId) ?? null

  /** Clone, mutate, commit. `coalesceKey` makes a drag one undo step. */
  const edit = (label: string, mutate: (draft: ParticleSystemDef) => void, coalesceKey?: string) => {
    const next = clone(system)
    mutate(next)
    commit(next, label, coalesceKey)
  }
  const editEmitter = (label: string, mutate: (e: EmitterDef) => void, coalesceKey?: string) => {
    if (!emitter) return
    edit(label, draft => {
      const target = draft.emitters.find(e => e.id === emitter.id)
      if (target) mutate(target)
    }, coalesceKey && `${emitter.id}:${coalesceKey}`)
  }

  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-1 p-2'>
        <TextInput value={name} onChange={rename} title='Asset name' />
        <Button size='sm' variant={dirty ? 'primary' : 'subtle'} onClick={save} title='Save (Ctrl+S)'>Save</Button>
      </div>

      <EmitterList system={system} selected={emitterId} onSelect={selectEmitter} edit={edit} />

      {emitter ? (
        <>
          <EmitterSettings emitter={emitter} editEmitter={editEmitter} />
          {STAGES.map(s => (
            <StageSection key={s.stage} stage={s.stage} title={s.title} hint={s.hint}
                          modules={emitter[s.key]} emitterId={emitter.id} emitters={system.emitters}
                          onChange={(modules, label, coalesceKey) => editEmitter(label, e => { e[s.key] = modules }, coalesceKey)} />
          ))}
          <RenderSection emitter={emitter} editEmitter={editEmitter} />
        </>
      ) : (
        <Hint className='px-3'>Add an emitter to start.</Hint>
      )}

      <BoundsSection system={system} edit={edit} />
    </div>
  )
}

// --- Emitters ---------------------------------------------------------------------------------------

function EmitterList({ system, selected, onSelect, edit }: {
  system: ParticleSystemDef
  selected: string | null
  onSelect: (id: string | null) => void
  edit: (label: string, mutate: (draft: ParticleSystemDef) => void, coalesceKey?: string) => void
}) {
  const add = (build: () => EmitterDef) => {
    const created = build()
    // Unique name, so emitter names stay usable as burst(count, name) targets from scripts.
    const taken = new Set(system.emitters.map(e => e.name))
    let label = created.name, n = 2
    while (taken.has(label)) label = `${created.name} ${n++}`
    created.name = label
    edit('Add emitter', draft => { draft.emitters.push(created) })
    onSelect(created.id)
  }
  const move = (index: number, by: number) => edit('Reorder emitters', draft => {
    const [e] = draft.emitters.splice(index, 1)
    draft.emitters.splice(Math.max(0, Math.min(draft.emitters.length, index + by)), 0, e)
  })

  return (
    <Collapsable title='Emitters' badge={system.emitters.length} persistKey='particles.emitters'
      hint='Every emitter simulates and draws independently; together they are the effect.'
      right={
        <Popover title='Add emitter' align='right' className='p-1 w-[240px]'
                 trigger={<span className='px-1 text-xs text-muted hover:text-white'>+ Emitter</span>}>
          {close => (
            <div className='flex flex-col'>
              {EMITTER_PRESETS.map(p => (
                <button key={p.id} className='rounded px-2 py-1 text-left hover:bg-control'
                        onClick={() => { add(p.build); close() }}>
                  <div className='text-xs text-white'>{p.label}</div>
                  <div className='text-[10px] text-dim'>{p.description}</div>
                </button>
              ))}
            </div>
          )}
        </Popover>
      }>
      <div className='flex flex-col gap-0.5 p-1'>
        {system.emitters.map((e, i) => (
          <div key={e.id}
               className={cn('group flex items-center gap-1 rounded px-1 py-0.5 cursor-pointer',
                             e.id === selected ? 'bg-selected' : 'hover:bg-control')}
               onClick={() => onSelect(e.id)}>
            <span onClick={ev => ev.stopPropagation()}>
              <Toggle checked={e.enabled}
                      onChange={enabled => edit(enabled ? 'Enable emitter' : 'Disable emitter', draft => {
                        const t = draft.emitters.find(x => x.id === e.id); if (t) t.enabled = enabled
                      })} />
            </span>
            <span className={cn('flex-1 truncate text-xs', e.enabled ? 'text-white' : 'text-dim')}>{e.name}</span>
            <span className='hidden gap-0.5 group-hover:flex' onClick={ev => ev.stopPropagation()}>
              <Button size='icon' variant='ghost' title='Move up' disabled={i === 0} onClick={() => move(i, -1)}>↑</Button>
              <Button size='icon' variant='ghost' title='Move down' disabled={i === system.emitters.length - 1} onClick={() => move(i, 1)}>↓</Button>
              <Button size='icon' variant='ghost' title='Duplicate' onClick={() => add(() => ({ ...clone({ ...system, emitters: [e] }).emitters[0], id: crypto.randomUUID() }))}>⧉</Button>
              <Button size='icon' variant='ghost' title='Delete emitter'
                      onClick={() => {
                        edit('Delete emitter', draft => { draft.emitters = draft.emitters.filter(x => x.id !== e.id) })
                        if (selected === e.id) onSelect(system.emitters.find(x => x.id !== e.id)?.id ?? null)
                      }}>✕</Button>
            </span>
          </div>
        ))}
      </div>
    </Collapsable>
  )
}

function EmitterSettings({ emitter, editEmitter }: {
  emitter: EmitterDef
  editEmitter: (label: string, mutate: (e: EmitterDef) => void, coalesceKey?: string) => void
}) {
  return (
    <Collapsable title='Emitter' persistKey='particles.emitter'>
      <div className='p-2'>
        <PropertyTable columns={['42%', '58%']}>
          <PropertyRow label='Name' divider>
            <TextInput value={emitter.name} onChange={name => editEmitter('Rename emitter', e => { e.name = name }, 'name')} />
          </PropertyRow>
          <PropertyRow label='Capacity' hint='Live particles this emitter can hold. Spawning past it recycles the oldest. Changing it restarts the preview.' divider>
            <NumberInput value={emitter.capacity} min={1} max={262144} step={256}
                         onChange={v => editEmitter('Capacity', e => { e.capacity = Math.max(1, Math.min(262144, Math.round(v))) }, 'capacity')} />
          </PropertyRow>
          <PropertyRow label='Space' hint='World: particles stay where they were born. Local: they move with the emitter.' divider>
            <SegmentedControl size='sm' grow value={emitter.simSpace}
                              onChange={simSpace => editEmitter('Simulation space', e => { e.simSpace = simSpace })}
                              options={[{ value: 'world', label: 'World' }, { value: 'local', label: 'Local' }]} />
          </PropertyRow>
          <PropertyRow label='Duration' hint='Seconds per cycle.' divider>
            <NumberInput value={emitter.duration} min={0.01} step={0.5}
                         onChange={v => editEmitter('Duration', e => { e.duration = Math.max(0.01, v) }, 'duration')} />
          </PropertyRow>
          <PropertyRow label='Looping' divider>
            <Toggle checked={emitter.looping} onChange={looping => editEmitter('Looping', e => { e.looping = looping })} />
          </PropertyRow>
          <PropertyRow label='Prewarm' hint='Start a looping emitter as if it had already run a cycle.' divider>
            <Toggle checked={emitter.prewarm} onChange={prewarm => editEmitter('Prewarm', e => { e.prewarm = prewarm })} />
          </PropertyRow>
          <PropertyRow label='Start delay' hint='Seconds before the first particle.' divider>
            <NumberInput value={emitter.startDelay} min={0} step={0.1}
                         onChange={v => editEmitter('Start delay', e => { e.startDelay = Math.max(0, v) }, 'startDelay')} />
          </PropertyRow>
          <PropertyRow label='Seed' hint='Same seed and stack, same particles.'>
            <div className='flex items-center gap-1'>
              <NumberInput value={emitter.seed} step={1} onChange={v => editEmitter('Seed', e => { e.seed = Math.abs(Math.round(v)) >>> 0 }, 'seed')} />
              <Button size='icon' variant='ghost' title='New random seed'
                      onClick={() => editEmitter('Seed', e => { e.seed = Math.floor(Math.random() * 1e6) })}>🎲</Button>
            </div>
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}

// --- Module stacks ----------------------------------------------------------------------------------

function StageSection({ stage, title, hint, modules, emitterId, emitters, onChange }: {
  stage: ParticleStage
  title: string
  hint: string
  modules: ParticleModule[]
  emitterId: string
  emitters: readonly EmitterDef[]
  onChange: (modules: ParticleModule[], label: string, coalesceKey?: string) => void
}) {
  const present = new Set(modules.map(m => m.type))
  const addable = modulesForStage(stage).filter(m => !(m.unique && present.has(m.type)))

  const update = (index: number, next: ParticleModule, label: string, coalesceKey?: string) =>
    onChange(modules.map((m, i) => (i === index ? next : m)), label, coalesceKey)

  return (
    <Collapsable title={title} badge={modules.length} hint={hint} persistKey={`particles.stage.${stage}`}>
      <div className='flex flex-col gap-1 p-1'>
        {modules.map((m, i) => (
          <ModuleCard key={`${emitterId}:${m.type}`} module={m} emitterId={emitterId} emitters={emitters}
                      onToggle={enabled => update(i, { ...m, enabled }, enabled ? 'Enable module' : 'Disable module')}
                      onParams={(patch, coalesce) => update(i, { ...m, params: { ...m.params, ...patch } },
                                                            `Edit ${moduleDefinition(m.type)?.label ?? m.type}`,
                                                            coalesce ? `${m.type}.${Object.keys(patch).join(',')}` : undefined)}
                      onRemove={() => onChange(modules.filter((_, j) => j !== i), 'Remove module')}
                      onMove={by => {
                        const next = [...modules]
                        const [x] = next.splice(i, 1)
                        next.splice(Math.max(0, Math.min(next.length, i + by)), 0, x)
                        onChange(next, 'Reorder modules')
                      }} />
        ))}
        {addable.length > 0 && (
          <Select value='' className='mt-1 w-full text-muted'
                  onChange={e => { if (e.target.value) onChange([...modules, makeModule(e.target.value)], 'Add module') }}>
            <option value=''>+ Add module…</option>
            {addable.map(m => <option key={m.type} value={m.type} title={m.description}>{m.label}</option>)}
          </Select>
        )}
      </div>
    </Collapsable>
  )
}

function ModuleCard({ module, emitterId, emitters, onToggle, onParams, onRemove, onMove }: {
  module: ParticleModule
  emitterId: string
  emitters: readonly EmitterDef[]
  onToggle: (enabled: boolean) => void
  onParams: (patch: Record<string, unknown>, coalesce?: boolean) => void
  onRemove: () => void
  onMove: (by: number) => void
}) {
  const def = moduleDefinition(module.type)
  const [open, setOpen] = useState(true)
  if (!def) return null
  const visible = def.params.filter(p => !p.when || p.when(module.params))

  return (
    <div className={cn('rounded border border-border bg-surface', !module.enabled && 'opacity-60')}>
      <div className='group flex items-center gap-1 px-1 py-0.5'>
        <button className='w-4 text-[10px] text-muted' onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▼' : '▶'}
        </button>
        <Toggle checked={module.enabled} onChange={onToggle} />
        <span className='flex-1 truncate text-xs text-white' title={def.description}>{def.label}</span>
        <span className='hidden group-hover:flex'>
          <Button size='icon' variant='ghost' title='Move up' onClick={() => onMove(-1)}>↑</Button>
          <Button size='icon' variant='ghost' title='Move down' onClick={() => onMove(1)}>↓</Button>
        </span>
        <Button size='icon' variant='ghost' title='Remove module' onClick={onRemove}>✕</Button>
      </div>
      {open && visible.length > 0 && (
        <div className='px-2 pb-1'>
          <PropertyTable columns={['40%', '60%']}>
            {visible.map((spec, i) => (
              <PropertyRow key={`${emitterId}:${spec.key}`} label={spec.label} hint={'hint' in spec ? spec.hint : undefined}
                           divider={i < visible.length - 1}>
                <ParamField spec={spec} value={module.params[spec.key]} params={module.params}
                            emitters={emitters} selfId={emitterId}
                            onChange={(v, c) => onParams({ [spec.key]: v }, c)} onPatch={onParams} />
              </PropertyRow>
            ))}
          </PropertyTable>
        </div>
      )}
    </div>
  )
}

// --- Render -----------------------------------------------------------------------------------------

function RenderSection({ emitter, editEmitter }: {
  emitter: EmitterDef
  editEmitter: (label: string, mutate: (e: EmitterDef) => void, coalesceKey?: string) => void
}) {
  const render = emitter.render as unknown as Record<string, unknown>
  const flipbook = emitter.render.flipbook as unknown as Record<string, unknown>
  const visible = RENDER_PARAMS.filter(p => !p.when || p.when(render))
  const textured = !!emitter.render.textureId
  const { models } = useCleoEngine()
  return (
    <Collapsable title='Render' persistKey='particles.render' hint="How this emitter's particles are drawn.">
      <div className='p-2'>
        <PropertyTable columns={['40%', '60%']}>
          {visible.map(spec => (
            <PropertyRow key={spec.key} label={spec.label} hint={'hint' in spec ? spec.hint : undefined} divider>
              <ParamField spec={spec} value={render[spec.key]}
                          onChange={(v, c) => editEmitter('Edit render', e => {
                            (e.render as unknown as Record<string, unknown>)[spec.key] = v
                            // Picking a model CAPTURES its geometry into the effect; see particleMesh.ts.
                            if (spec.key === 'modelId') {
                              const model = models.find(m => m.id === v)
                              e.render.meshData = model ? particleMeshFromNodeJson(model.nodeJson) : null
                            }
                          }, c ? `render.${spec.key}` : undefined)} />
            </PropertyRow>
          ))}
          {textured && FLIPBOOK_PARAMS.filter(p => !p.when || p.when(flipbook)).map(spec => (
            <PropertyRow key={`fb.${spec.key}`} label={`Flipbook · ${spec.label}`} hint={'hint' in spec ? spec.hint : undefined} divider>
              <ParamField spec={spec} value={flipbook[spec.key]}
                          onChange={(v, c) => editEmitter('Edit flipbook', e => {
                            (e.render.flipbook as unknown as Record<string, unknown>)[spec.key] = v
                          }, c ? `flipbook.${spec.key}` : undefined)} />
            </PropertyRow>
          ))}
        </PropertyTable>
        {emitter.render.mode === 'mesh' && emitter.render.mesh === 'model' && (
          <Hint>
            {emitter.render.meshData
              ? `${(emitter.render.meshData.indices.length / 3).toLocaleString()} triangles per particle` +
                (emitter.render.meshData.indices.length / 3 > PARTICLE_MESH_TRIANGLE_WARNING ? ' — heavy: every particle draws all of them.' : '.')
              : 'Pick a model; until then the emitter draws nothing.'}
          </Hint>
        )}
      </div>
    </Collapsable>
  )
}

// --- Bounds -----------------------------------------------------------------------------------------

function BoundsSection({ system, edit }: {
  system: ParticleSystemDef
  edit: (label: string, mutate: (draft: ParticleSystemDef) => void, coalesceKey?: string) => void
}) {
  return (
    <Collapsable title='Bounds' persistKey='particles.bounds' defaultOpen={false}
                 hint="A fixed box, in the effect's local space, that its particles stay inside. Used for culling and selection — GPU particles are never read back, so it cannot be measured.">
      <div className='p-2'>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Center' divider>
            <VectorInput value={system.bounds.center} step={0.1}
                         onChange={v => edit('Bounds', d => { d.bounds.center = v as [number, number, number] }, 'bounds.center')} />
          </PropertyRow>
          <PropertyRow label='Half extents'>
            <VectorInput value={system.bounds.extents} min={0.01} step={0.1}
                         onChange={v => edit('Bounds', d => { d.bounds.extents = v as [number, number, number] }, 'bounds.extents')} />
          </PropertyRow>
        </PropertyTable>
      </div>
    </Collapsable>
  )
}

