import type { Burst, CollisionPlane, CompiledCustomCode, EmitterDef, ParamSpec } from 'cleo'
import { Button, NumberInput, Select, VectorInput } from '@cleo/app-kit/ui'
import { GenericParamField, isGenericParam } from '@cleo/app-kit/params/ParamField'
import { useCleoEngine } from '../EngineContext'
import CustomCodeField from './CustomCodeField'

// One module parameter, drawn from its `ParamSpec`. Every module card is these and nothing else, so a new
// module in the engine's catalogue shows up in the editor without a line of UI code — the same bargain
// Niagara's generated module UI makes.

export interface ParamFieldProps {
  spec: ParamSpec
  value: unknown
  /** `coalesce` true for a continuous gesture (a slider drag) — one undo step for the whole drag. */
  onChange: (value: unknown, coalesce?: boolean) => void
  /** Every param of the module, for the fields that write more than their own key (custom code). */
  params?: Record<string, unknown>
  /** Several keys at once. */
  onPatch?: (patch: Record<string, unknown>, coalesce?: boolean) => void
  /** The system's emitters, for an `emitter` field. */
  emitters?: readonly EmitterDef[]
  /** The emitter this field belongs to, which an `emitter` field must not offer. */
  selfId?: string
}

export default function ParamField({ spec, value, onChange, params, onPatch, emitters, selfId }: ParamFieldProps) {
  // Numbers, toggles, vectors, colours, curves, gradients and enums are the app-kit's, shared with every
  // tool that draws a parameter schema; what is left reaches into the editor's own state.
  if (isGenericParam(spec)) return <GenericParamField spec={spec} value={value} onChange={onChange} />
  switch (spec.kind) {
    case 'bursts':
      return <BurstList value={Array.isArray(value) ? value as Burst[] : []} onChange={onChange} />
    case 'planes':
      return <PlaneList value={Array.isArray(value) ? value as CollisionPlane[] : []} onChange={onChange} />
    case 'asset':
      return <AssetPicker kind={spec.assetKind} value={typeof value === 'string' ? value : null} onChange={onChange} />
    case 'code':
      return (
        <CustomCodeField source={String(value ?? '')}
                         compiled={(params?.compiled as CompiledCustomCode | null | undefined) ?? null}
                         onChange={(patch, coalesce) => onPatch ? onPatch(patch, coalesce) : patch.source !== undefined && onChange(patch.source, coalesce)} />
      )
    case 'emitter':
      return (
        <Select value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || null)} className='w-full'>
          <option value=''>(none)</option>
          {(emitters ?? []).filter(e => e.id !== selfId).map(e => <option key={e.id} value={e.id}>{e.name}</option>)}
        </Select>
      )
  }
}

function BurstList({ value, onChange }: { value: Burst[]; onChange: (v: unknown, coalesce?: boolean) => void }) {
  const set = (i: number, patch: Partial<Burst>) => onChange(value.map((b, j) => (j === i ? { ...b, ...patch } : b)), true)
  return (
    <div className='flex flex-col gap-1'>
      {value.length > 0 && (
        <div className='grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1 text-ui-xs text-dim'>
          <span title='Seconds into the cycle'>Time</span><span>Count</span>
          <span title='Repetitions; 0 repeats for the rest of the cycle'>Cycles</span>
          <span title='Seconds between repetitions'>Interval</span><span />
        </div>
      )}
      {value.map((b, i) => (
        <div key={i} className='grid grid-cols-[1fr_1fr_1fr_1fr_auto] gap-1'>
          <NumberInput value={b.time} min={0} step={0.1} onChange={time => set(i, { time })} />
          <NumberInput value={b.count} min={0} step={1} onChange={count => set(i, { count: Math.round(count) })} />
          <NumberInput value={b.cycles} min={0} step={1} onChange={cycles => set(i, { cycles: Math.round(cycles) })} />
          <NumberInput value={b.interval} min={0.01} step={0.1} onChange={interval => set(i, { interval })} />
          <Button variant='remove' size='icon' title='Remove burst' onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</Button>
        </div>
      ))}
      <Button size='sm' variant='subtle' className='self-start'
              onClick={() => onChange([...value, { time: 0, count: 30, cycles: 1, interval: 0.5, probability: 1 }])}>
        + Burst
      </Button>
    </div>
  )
}

function PlaneList({ value, onChange }: { value: CollisionPlane[]; onChange: (v: unknown, coalesce?: boolean) => void }) {
  const set = (i: number, patch: Partial<CollisionPlane>) => onChange(value.map((p, j) => (j === i ? { ...p, ...patch } : p)), true)
  return (
    <div className='flex flex-col gap-1'>
      {value.map((p, i) => (
        <div key={i} className='flex flex-col gap-1 rounded border border-border p-1'>
          <div className='flex items-center gap-1 text-ui-xs text-dim'>
            <span className='w-10'>Point</span>
            <VectorInput value={p.point} step={0.1} onChange={point => set(i, { point: point as [number, number, number] })} />
          </div>
          <div className='flex items-center gap-1 text-ui-xs text-dim'>
            <span className='w-10'>Normal</span>
            <VectorInput value={p.normal} step={0.1} onChange={normal => set(i, { normal: normal as [number, number, number] })} />
            <Button variant='remove' size='icon' title='Remove plane' onClick={() => onChange(value.filter((_, j) => j !== i))}>✕</Button>
          </div>
        </div>
      ))}
      {value.length < 4 && (
        <Button size='sm' variant='subtle' className='self-start'
                onClick={() => onChange([...value, { point: [0, 0, 0], normal: [0, 1, 0] }])}>
          + Plane (emitter space)
        </Button>
      )}
    </div>
  )
}

function AssetPicker({ kind, value, onChange }: { kind: 'model' | 'tileset' | 'texture'; value: string | null; onChange: (v: unknown) => void }) {
  const { textures, models, tilesets } = useCleoEngine()
  const options: { id: string; name: string }[] =
    kind === 'texture' ? textures.map(t => ({ id: t.id, name: t.name }))
    : kind === 'model' ? models.map(m => ({ id: m.id, name: m.name }))
    : tilesets.map(t => ({ id: t.id, name: t.name }))
  return (
    <Select value={value ?? ''} onChange={e => onChange(e.target.value || null)} className='w-full'>
      <option value=''>{kind === 'texture' ? '(soft disc)' : '(none)'}</option>
      {options.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      {value && !options.some(o => o.id === value) && <option value={value}>(missing) {value}</option>}
    </Select>
  )
}
