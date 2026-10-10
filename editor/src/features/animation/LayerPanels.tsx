import { useStateMachine } from './StateMachineContext'
import Collapsable from '../../components/Collapsable'
import { SegmentedControl } from '../../components/ui'
import type { AnimationBlendMode } from 'cleo'
import type { ReactNode } from 'react'
import { useAssetDrop } from '../../utils/useAssetDrop'

/**
 * A row that accepts one kind of asset dragged from the explorer — a bone mask onto a Mask row, a pose
 * onto a state. A component rather than a hook call per row, because slots are a list.
 */
export function AssetDropRow({ mime, onDrop, title, children }: { mime: string; onDrop: (id: string) => void; title?: string; children: ReactNode }) {
  const { dragOver, dropProps } = useAssetDrop(mime, onDrop)
  return (
    <div className={`flex items-center gap-1 rounded border ${dragOver ? 'border-selected' : 'border-transparent'}`} title={title} {...dropProps}>
      {children}
    </div>
  )
}

const MASK_MIME = 'text/cleo-bone-mask'

// Controller LAYERS and action SLOTS, as inspector sections beside the state machine.
//
// A layer is a second state machine over the same parameters, blended on top of everything beneath it
// through a bone mask: the base walks, an "Upper body" layer aims or holds a torch. The graph edits the
// ACTIVE layer (the tab strip on the graph toolbar); this is where a layer's own settings live.
//
// A slot is where a script's `animator.playAction('Reload', { slot: 'UpperBody' })` plays — no graph
// wiring at all. Unity has nothing quite like it; it is Unreal's Montage slot.

const input = 'bg-control text-white border border-control-hover rounded px-1 py-0.5 text-xs'
const ghost = 'px-1.5 py-0.5 rounded border border-control-hover hover:bg-control text-xs'
const danger = 'px-1.5 py-0.5 rounded bg-red-700 hover:bg-red-600 text-white text-xs'

const BLEND_OPTIONS = [
  { value: 'override' as const, label: 'Override', title: 'Replace the pose beneath, by weight x mask' },
  { value: 'additive' as const, label: 'Additive', title: 'Add the clip’s motion relative to its first frame — breathing, recoil, a flinch' },
]

/** The tab strip that picks which layer the graph shows. */
export function LayerTabs() {
  const { fullSm, activeLayer, setActiveLayer, addLayer } = useStateMachine()
  const layers = fullSm.layers ?? []
  const tab = (i: number, label: string) => (
    <button key={i}
      className={`px-2 py-0.5 rounded text-xs border ${i === activeLayer ? 'bg-primary border-primary-active text-white' : 'border-control-hover hover:bg-control'}`}
      onClick={() => setActiveLayer(i)}
      title={i === 0 ? 'The base layer: drives the whole body and the character’s root motion' : `Edit the “${label}” layer`}
    >{label}</button>
  )
  return (
    <div className='flex items-center gap-1'>
      {tab(0, 'Base')}
      {layers.map((l, i) => tab(i + 1, l.name))}
      <button className={ghost} onClick={addLayer}
        title='Add a layer: its own states over the same parameters, blended on top through a bone mask'>+ Layer</button>
    </div>
  )
}

/** Settings of the active layer. Renders nothing on the base layer. */
export function LayerSection() {
  const { fullSm, activeLayer, setLayer, removeLayer, boneMasks } = useStateMachine()
  if (activeLayer <= 0) return null
  const layer = fullSm.layers?.[activeLayer - 1]
  if (!layer) return null
  const weightParams = fullSm.parameters.filter(p => p.type === 'float' || (p.type === 'variable' && p.variable?.varType !== 'boolean') || p.type === 'bool')
  const maskMissing = !!layer.maskId && !boneMasks.some(m => m.id === layer.maskId)

  return (
    <Collapsable title={`Layer — ${layer.name}`} defaultOpen>
      <div className='p-2 flex flex-col gap-2'>
        <div className='flex items-center gap-1'>
          <input className={input + ' flex-1 min-w-0'} value={layer.name} title='Layer name (scripts address it by this)'
            onChange={e => setLayer(activeLayer, { name: e.target.value })} />
          <button className={danger} title='Delete this layer and its states' onClick={() => removeLayer(activeLayer)}>✕</button>
        </div>

        <div className='flex items-center gap-1'>
          <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Blend</span>
          <SegmentedControl<AnimationBlendMode> size='sm' value={layer.blend ?? 'override'}
            onChange={v => setLayer(activeLayer, { blend: v })} options={BLEND_OPTIONS} />
        </div>

        <div className='flex items-center gap-1'>
          <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Weight</span>
          {layer.weightParam
            ? <select className={input + ' flex-1 min-w-0'} value={layer.weightParam}
                title='Read the layer weight (0..1) from this parameter every frame'
                onChange={e => setLayer(activeLayer, { weightParam: e.target.value || undefined })}>
                <option value=''>(fixed)</option>
                {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </select>
            : <>
                <input className='flex-1 min-w-0' type='range' min={0} max={1} step={0.01} value={layer.weight ?? 1}
                  onChange={e => setLayer(activeLayer, { weight: parseFloat(e.target.value) })} />
                <span className='text-[10px] tabular-nums w-[30px] text-right'>{(layer.weight ?? 1).toFixed(2)}</span>
                <select className={input + ' w-[64px]'} value='' title='Drive the weight from a parameter instead'
                  onChange={e => e.target.value && setLayer(activeLayer, { weightParam: e.target.value })}>
                  <option value=''>param…</option>
                  {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </select>
              </>}
        </div>

        <AssetDropRow mime={MASK_MIME} onDrop={id => setLayer(activeLayer, { maskId: id, mask: undefined })}
          title='Drop a Bone Mask here'>
          <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Mask</span>
          <select className={input + ' flex-1 min-w-0'} value={layer.maskId ?? ''}
            title='Which bones this layer affects. Masks are edited in the rig editor.'
            onChange={e => setLayer(activeLayer, { maskId: e.target.value || undefined, mask: undefined })}>
            <option value=''>Whole body</option>
            {maskMissing && <option value={layer.maskId}>missing mask</option>}
            {boneMasks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </AssetDropRow>
        {maskMissing && <p className='text-[10px] text-warning'>That mask was deleted, so this layer affects nothing until another is picked.</p>}
        <p className='text-[10px] text-gray-500'>
          An empty state (no clip) on a layer means “add nothing”: the layer fades out while it is there.
        </p>
      </div>
    </Collapsable>
  )
}

/** The machine's action slots, in the Variables panel. */
export function SlotsSection() {
  const { fullSm, addSlot, setSlot, removeSlot, boneMasks } = useStateMachine()
  const slots = fullSm.slots ?? []
  const layers = fullSm.layers ?? []
  return (
    <Collapsable title='Action slots' badge={slots.length || undefined}>
      <div className='p-2 flex flex-col gap-2'>
        <p className='text-[10px] text-gray-500'>
          Scripts play one-shots here without wiring them into the graph:
          <code className='text-gray-300'> animator.playAction('Reload', {'{'} slot: 'UpperBody' {'}'})</code>.
          With none declared, actions play full-body over everything.
        </p>
        {slots.map((slot, i) => (
          <div key={i} className='flex flex-col gap-1 border border-control rounded p-1'>
            <div className='flex items-center gap-1'>
              <input className={input + ' flex-1 min-w-0'} value={slot.name} onChange={e => setSlot(i, { name: e.target.value })} />
              <button className={danger} onClick={() => removeSlot(i)}>✕</button>
            </div>
            <div className='flex items-center gap-1'>
              <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Above</span>
              <select className={input + ' flex-1 min-w-0'} value={slot.afterLayer ?? layers.length}
                onChange={e => setSlot(i, { afterLayer: parseInt(e.target.value, 10) })}>
                <option value={0}>Base</option>
                {layers.map((l, li) => <option key={li} value={li + 1}>{l.name}</option>)}
              </select>
            </div>
            <AssetDropRow mime={MASK_MIME} onDrop={id => setSlot(i, { maskId: id, mask: undefined })} title='Drop a Bone Mask here'>
              <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Mask</span>
              <select className={input + ' flex-1 min-w-0'} value={slot.maskId ?? ''}
                onChange={e => setSlot(i, { maskId: e.target.value || undefined, mask: undefined })}>
                <option value=''>Whole body</option>
                {boneMasks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </AssetDropRow>
            <div className='flex items-center gap-1'>
              <span className='text-[10px] text-gray-400 w-[46px] shrink-0'>Blend</span>
              <SegmentedControl<AnimationBlendMode> size='sm' value={slot.blend ?? 'override'}
                onChange={v => setSlot(i, { blend: v })} options={BLEND_OPTIONS} />
            </div>
          </div>
        ))}
        <button className={ghost} onClick={addSlot}>+ Slot</button>
      </div>
    </Collapsable>
  )
}
