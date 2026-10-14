import type { Burst, CollisionPlane, CompiledCustomCode, Curve, EmitterDef, Gradient, ParamSpec } from 'cleo'
import {
  Button, ColorInput, CurveInput, GradientInput, NumberInput, RangeInput, Select, Slider, Toggle, VectorInput,
} from '../../components/ui'
import { useCleoEngine } from '../EngineContext'
import { vec3ToHex } from '../../utils/UtilFunctions'
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

const num = (x: unknown, fallback = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : fallback)
const arr = (x: unknown, n: number, fallback = 0): number[] =>
  Array.from({ length: n }, (_, i) => (Array.isArray(x) ? num(x[i], fallback) : fallback))

export default function ParamField({ spec, value, onChange, params, onPatch, emitters, selfId }: ParamFieldProps) {
  switch (spec.kind) {
    case 'float':
      if (spec.min !== undefined && spec.max !== undefined)
        return <Slider min={spec.min} max={spec.max} step={spec.step ?? 0.01} value={num(value)} onChange={v => onChange(v, true)} />
      return <NumberInput value={num(value)} min={spec.min} max={spec.max} step={spec.step ?? 0.1} onChange={v => onChange(v, true)} />
    case 'int':
      return <NumberInput value={num(value)} min={spec.min} max={spec.max} step={1} onChange={v => onChange(Math.round(v), true)} />
    case 'bool':
      return <Toggle checked={!!value} onChange={v => onChange(v)} />
    case 'vec3': {
      // A vec3 spec may carry four components (custom code's u_custom); keep whatever length is there.
      const n = Array.isArray(value) ? Math.max(3, value.length) : 3
      return <VectorInput value={arr(value, n)} step={0.1} onChange={v => onChange(v, true)} />
    }
    case 'range':
      return <RangeInput value={arr(value, 2) as [number, number]} min={spec.min} max={spec.max} step={spec.step ?? 0.1}
                         onChange={v => onChange(v, true)} />
    case 'color': {
      const c = arr(value, 4, 1)
      return (
        <div className='flex items-center gap-2'>
          <ColorInput color={vec3ToHex(c.slice(0, 3) as [number, number, number])} onChange={rgb => onChange([rgb[0], rgb[1], rgb[2], c[3]])} />
          <Slider min={0} max={1} step={0.01} value={c[3]} label='A' onChange={a => onChange([c[0], c[1], c[2], a], true)} />
        </div>
      )
    }
    case 'curve':
      return <CurveInput value={value as Curve} onChange={v => onChange(v, true)} />
    case 'gradient':
      return <GradientInput value={value as Gradient} onChange={v => onChange(v, true)} />
    case 'enum':
      return (
        <Select value={String(value)} onChange={e => onChange(e.target.value)} className='w-full'>
          {spec.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      )
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
