import { useState } from 'react'
import {
  RENDER_PARAMS, PARTICLE_MESH_TRIANGLE_WARNING, LOD_ALL_LEVELS, moduleDefinition, makeModule, modulesForStage, particleMeshFromNodeJson,
  type EmitterDef, type ParamSpec, type ParticleModule, type ParticleStage, type ParticleSystemDef,
} from 'cleo'
import {
  Button, Collapsable, Hint, MenuItem, NumberInput, Popover, PropertyRow, PropertyTable, SegmentedControl, Select, TextInput,
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
//
// What each card is for is not written here: its title's hover card is read from docs/editor/particles.md.

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
    return <div className='p-3 text-ui text-muted'>No particle system is open.</div>
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
  /** One stage's module list, editing that stage of the selected emitter. */
  const stageModules = (e: EmitterDef, stage: ParticleStage) => (
    <StageModules stage={stage} modules={e[stage]} emitterId={e.id} emitters={system.emitters}
                  onChange={(modules, label, coalesceKey) => editEmitter(label, d => { d[stage] = modules }, coalesceKey)} />
  )

  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-1 p-2'>
        <TextInput value={name} onChange={rename} title='Asset name' />
        <Button size='sm' variant={dirty ? 'primary' : 'subtle'} onClick={save} title='Save (Ctrl+S)'>Save</Button>
      </div>

      <EmitterList system={system} selected={emitterId} onSelect={selectEmitter} edit={edit} />

      {emitter ? (
        <>
          <EmitterSettings emitter={emitter} editEmitter={editEmitter} lodLevels={system.lod?.levels.length ?? 0} />
          {/* Three literal cards rather than a map over the stages: each title is its stage's docs term. */}
          <Collapsable title='Spawn' badge={emitter.spawn.length} persistKey='particles.stage.spawn'>
            {stageModules(emitter, 'spawn')}
          </Collapsable>
          <Collapsable title='Initialize' badge={emitter.init.length} persistKey='particles.stage.init'>
            {stageModules(emitter, 'init')}
          </Collapsable>
          <Collapsable title='Update' badge={emitter.update.length} persistKey='particles.stage.update'>
            {stageModules(emitter, 'update')}
          </Collapsable>
          <RenderSection emitter={emitter} editEmitter={editEmitter} />
        </>
      ) : (
        <Hint className='px-3'>Add an emitter to start.</Hint>
      )}

      <LodSection system={system} edit={edit} />
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
      right={
        <Popover title='Add emitter' align='right' className='p-1 w-[240px]'
                 trigger={<span className='px-1 text-ui text-muted hover:text-fg'>+ Emitter</span>}>
          {close => (
            <div className='flex flex-col'>
              {EMITTER_PRESETS.map(p => (
                <MenuItem key={p.id} hint={p.description}
                          onClick={() => { add(p.build); close() }}>
                  {p.label}
                </MenuItem>
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
            <span className={cn('flex-1 truncate text-ui', e.enabled ? 'text-fg' : 'text-dim')}>{e.name}</span>
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

function EmitterSettings({ emitter, editEmitter, lodLevels }: {
  emitter: EmitterDef
  editEmitter: (label: string, mutate: (e: EmitterDef) => void, coalesceKey?: string) => void
  /** The system's LOD level count, for the Detail select. */
  lodLevels: number
}) {
  const maxLod = emitter.maxLod ?? LOD_ALL_LEVELS
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
          <PropertyRow label='Detail' divider
                       hint={'The coarsest LOD level this emitter still spawns at. A detail layer (sparks, embers) set to 0 '
                         + 'drops out as soon as the effect moves to level 1; its live particles finish their lives. See LOD.'}>
            <Select className='w-full' value={maxLod >= LOD_ALL_LEVELS ? 'all' : String(maxLod)}
                    onChange={ev => editEmitter('Detail', e => { e.maxLod = ev.target.value === 'all' ? LOD_ALL_LEVELS : Number(ev.target.value) })}>
              <option value='all'>Every LOD level</option>
              {Array.from({ length: Math.max(lodLevels, maxLod < LOD_ALL_LEVELS ? maxLod + 1 : 0) }, (_, i) => (
                <option key={i} value={String(i)}>{i === 0 ? 'Full detail only (level 0)' : `Up to level ${i}`}</option>
              ))}
            </Select>
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

/** A stage's modules and its add menu: the body of that stage's card. */
function StageModules({ stage, modules, emitterId, emitters, onChange }: {
  stage: ParticleStage
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
        <Button variant='ghost' size='sm' className='w-4 px-0 py-0 text-ui-xs' onClick={() => setOpen(o => !o)} title={open ? 'Collapse' : 'Expand'}>
          {open ? '▼' : '▶'}
        </Button>
        <Toggle checked={module.enabled} onChange={onToggle} />
        <span className='flex-1 truncate text-ui text-fg' title={def.description}>{def.label}</span>
        <span className='hidden group-hover:flex'>
          <Button size='icon' variant='ghost' title='Move up' onClick={() => onMove(-1)}>↑</Button>
          <Button size='icon' variant='ghost' title='Move down' onClick={() => onMove(1)}>↓</Button>
        </span>
        <Button variant='remove' size='icon' title='Remove module' onClick={onRemove}>✕</Button>
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
    // The Rendering section rather than the short "Render" line, so its table also explains the fields.
    <Collapsable title='Render' doc='editor/particles#rendering' persistKey='particles.render'>
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

// --- LOD --------------------------------------------------------------------------------------------

const STEP_OPTIONS = [
  { value: 1, label: 'Every frame' }, { value: 2, label: '1/2 (30 Hz)' }, { value: 3, label: '1/3 (20 Hz)' }, { value: 4, label: '1/4 (15 Hz)' },
]

type LodDef = ParticleSystemDef['lod']
type LodLevelDef = LodDef['levels'][number]
const noLod = (): LodDef => ({ enabled: true, levels: [], cullDistance: 0, scaleBursts: false })

/**
 * Level of detail by camera distance: each level past full detail spawns less and simulates less often,
 * a detail emitter can drop out (Emitter > Detail), and past the cull distance the effect is not drawn.
 * Distances run to the surface of the Bounds, times the renderer's Particle LOD distance.
 */
function LodSection({ system, edit }: {
  system: ParticleSystemDef
  edit: (label: string, mutate: (draft: ParticleSystemDef) => void, coalesceKey?: string) => void
}) {
  const lod = system.lod ?? noLod()
  const editLod = (label: string, mutate: (l: LodDef) => void, key?: string) =>
    edit(label, d => {
      d.lod = d.lod ?? noLod()
      mutate(d.lod)
      d.lod.levels.sort((a, b) => a.distance - b.distance)
    }, key && `lod.${key}`)
  const addLevel = () => editLod('Add LOD level', l => {
    const last = l.levels[l.levels.length - 1]
    l.levels.push(last
      ? { distance: Math.round(last.distance * 2), spawnScale: Math.max(0.05, Math.round(last.spawnScale * 50) / 100), stepScale: Math.min(4, last.stepScale + 1) }
      : { distance: 15, spawnScale: 0.5, stepScale: 2 })
  })
  const beyondCull = lod.cullDistance > 0 ? lod.levels.filter(l => l.distance >= lod.cullDistance) : []
  const active = lod.enabled && (lod.levels.length > 0 || lod.cullDistance > 0)

  return (
    // Cull distance and Scale bursts are rows of the Level of detail table, so their cards come from there.
    <Collapsable title='LOD' doc='editor/particles#level-of-detail' persistKey='particles.lod' defaultOpen={false}
                 badge={active ? lod.levels.length + (lod.cullDistance > 0 ? 1 : 0) : undefined}>
      <div className='p-2'>
        <PropertyTable columns={['40%', '60%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={lod.enabled} onChange={on => editLod('LOD', l => { l.enabled = on })} />
          </PropertyRow>
          <PropertyRow label='Cull distance' divider>
            <NumberInput value={lod.cullDistance} min={0} step={5}
                         onChange={v => editLod('Cull distance', l => { l.cullDistance = Math.max(0, v) }, 'cull')} />
          </PropertyRow>
          <PropertyRow label='Scale bursts'>
            <Toggle checked={lod.scaleBursts} onChange={on => editLod('Scale bursts', l => { l.scaleBursts = on })} />
          </PropertyRow>
        </PropertyTable>

        <div className='mt-2 grid grid-cols-[2.2rem_1fr_1fr_1.3fr_auto] items-center gap-1 text-ui-sm text-dim'>
          <span>Level</span><span title='From this many metres'>From (m)</span><span title='Continuous spawn rate'>Spawn %</span><span title='How often it simulates'>Simulate</span><span />
          <span className='text-fg'>0</span><span>0</span><span>100</span><span>Every frame</span><span />
          {lod.levels.map((level, i) => (
            <LodRow key={i} index={i} level={level}
                    onChange={(label, mutate, key) => editLod(label, l => mutate(l.levels[i]), `${i}.${key}`)}
                    onRemove={() => editLod('Remove LOD level', l => { l.levels.splice(i, 1) })} />
          ))}
        </div>
        <Button size='sm' variant='subtle' className='mt-2' onClick={addLevel} disabled={lod.levels.length >= 6}>+ Level</Button>
        {beyondCull.length > 0 && (
          <Hint className='text-warning'>A level starts beyond the cull distance and will never be seen.</Hint>
        )}
      </div>
    </Collapsable>
  )
}

function LodRow({ index, level, onChange, onRemove }: {
  index: number
  level: LodLevelDef
  onChange: (label: string, mutate: (l: LodLevelDef) => void, key: string) => void
  onRemove: () => void
}) {
  return (
    <>
      <span className='text-fg'>{index + 1}</span>
      <NumberInput value={level.distance} min={0} step={5}
                   onChange={v => onChange('LOD distance', l => { l.distance = Math.max(0, v) }, 'distance')} />
      <NumberInput value={Math.round(level.spawnScale * 100)} min={0} max={100} step={5}
                   onChange={v => onChange('LOD spawn rate', l => { l.spawnScale = Math.min(1, Math.max(0, v / 100)) }, 'spawn')} />
      <Select className='w-full' value={String(level.stepScale)}
              onChange={ev => onChange('LOD simulation rate', l => { l.stepScale = Number(ev.target.value) }, 'step')}>
        {STEP_OPTIONS.map(o => <option key={o.value} value={String(o.value)}>{o.label}</option>)}
      </Select>
      <Button size='icon' variant='remove' title='Remove this level' onClick={onRemove}>x</Button>
    </>
  )
}

// --- Bounds -----------------------------------------------------------------------------------------

function BoundsSection({ system, edit }: {
  system: ParticleSystemDef
  edit: (label: string, mutate: (draft: ParticleSystemDef) => void, coalesceKey?: string) => void
}) {
  return (
    <Collapsable title='Bounds' persistKey='particles.bounds' defaultOpen={false}>
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

