import { useStateMachine } from './StateMachineContext'
import Collapsable from '../../components/Collapsable'
import { Button, cn, hintClass, SegmentedControl, Select, Slider, TextInput } from '../../components/ui'
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

/** Dense-row padding for the library controls (their default is px-2 py-1). */
const tight = 'px-1 py-0.5'

const BLEND_OPTIONS = [
  { value: 'override' as const, label: 'Override', title: 'Replace the pose beneath, by weight x mask' },
  { value: 'additive' as const, label: 'Additive', title: 'Add the clip’s motion relative to its first frame — breathing, recoil, a flinch' },
]

/** The tab strip that picks which layer the graph shows. */
export function LayerTabs() {
  const { fullSm, activeLayer, setActiveLayer, addLayer } = useStateMachine()
  const layers = fullSm.layers ?? []
  const tab = (i: number, label: string) => (
    <Button key={i} size='sm' variant='subtle' active={i === activeLayer}
      onClick={() => setActiveLayer(i)}
      title={i === 0 ? 'The base layer: drives the whole body and the character’s root motion' : `Edit the “${label}” layer`}
    >{label}</Button>
  )
  return (
    <div className='flex items-center gap-1'>
      {tab(0, 'Base')}
      {layers.map((l, i) => tab(i + 1, l.name))}
      <Button size='sm' variant='subtle' onClick={addLayer}
        title='Add a layer: its own states over the same parameters, blended on top through a bone mask'>+ Layer</Button>
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
          <TextInput className={cn(tight, 'flex-1 min-w-0')} value={layer.name} title='Layer name (scripts address it by this)'
            onChange={v => setLayer(activeLayer, { name: v })} />
          <Button variant='remove' size='sm' title='Delete this layer and its states' onClick={() => removeLayer(activeLayer)}>✕</Button>
        </div>

        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[46px] shrink-0'>Blend</span>
          <SegmentedControl<AnimationBlendMode> size='sm' value={layer.blend ?? 'override'}
            onChange={v => setLayer(activeLayer, { blend: v })} options={BLEND_OPTIONS} />
        </div>

        <div className='flex items-center gap-1'>
          <span className='text-ui-xs text-muted w-[46px] shrink-0'>Weight</span>
          {layer.weightParam
            ? <Select className={cn(tight, 'flex-1 min-w-0')} value={layer.weightParam}
                title='Read the layer weight (0..1) from this parameter every frame'
                onChange={e => setLayer(activeLayer, { weightParam: e.target.value || undefined })}>
                <option value=''>(fixed)</option>
                {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
              </Select>
            : <>
                <Slider className='flex-1 min-w-0 my-0' editable={false} min={0} max={1} step={0.01} value={layer.weight ?? 1}
                  onChange={v => setLayer(activeLayer, { weight: v })} />
                <Select className={cn(tight, 'w-[64px]')} value='' title='Drive the weight from a parameter instead'
                  onChange={e => e.target.value && setLayer(activeLayer, { weightParam: e.target.value })}>
                  <option value=''>param…</option>
                  {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                </Select>
              </>}
        </div>

        <AssetDropRow mime={MASK_MIME} onDrop={id => setLayer(activeLayer, { maskId: id, mask: undefined })}
          title='Drop a Bone Mask here'>
          <span className='text-ui-xs text-muted w-[46px] shrink-0'>Mask</span>
          <Select className={cn(tight, 'flex-1 min-w-0')} value={layer.maskId ?? ''}
            title='Which bones this layer affects. Masks are edited in the rig editor.'
            onChange={e => setLayer(activeLayer, { maskId: e.target.value || undefined, mask: undefined })}>
            <option value=''>Whole body</option>
            {maskMissing && <option value={layer.maskId}>missing mask</option>}
            {boneMasks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </AssetDropRow>
        {maskMissing && <p className='text-ui-xs text-warning'>That mask was deleted, so this layer affects nothing until another is picked.</p>}
        <p className={hintClass}>
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
        <p className={hintClass}>
          Scripts play one-shots here without wiring them into the graph:
          <code className='text-fg'> animator.playAction('Reload', {'{'} slot: 'UpperBody' {'}'})</code>.
          With none declared, actions play full-body over everything.
        </p>
        {slots.map((slot, i) => (
          <div key={i} className='flex flex-col gap-1 border border-control rounded p-1'>
            <div className='flex items-center gap-1'>
              <TextInput className={cn(tight, 'flex-1 min-w-0')} value={slot.name} onChange={v => setSlot(i, { name: v })} />
              <Button variant='remove' size='sm' onClick={() => removeSlot(i)}>✕</Button>
            </div>
            <div className='flex items-center gap-1'>
              <span className='text-ui-xs text-muted w-[46px] shrink-0'>Above</span>
              <Select className={cn(tight, 'flex-1 min-w-0')} value={slot.afterLayer ?? layers.length}
                onChange={e => setSlot(i, { afterLayer: parseInt(e.target.value, 10) })}>
                <option value={0}>Base</option>
                {layers.map((l, li) => <option key={li} value={li + 1}>{l.name}</option>)}
              </Select>
            </div>
            <AssetDropRow mime={MASK_MIME} onDrop={id => setSlot(i, { maskId: id, mask: undefined })} title='Drop a Bone Mask here'>
              <span className='text-ui-xs text-muted w-[46px] shrink-0'>Mask</span>
              <Select className={cn(tight, 'flex-1 min-w-0')} value={slot.maskId ?? ''}
                onChange={e => setSlot(i, { maskId: e.target.value || undefined, mask: undefined })}>
                <option value=''>Whole body</option>
                {boneMasks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
              </Select>
            </AssetDropRow>
            <div className='flex items-center gap-1'>
              <span className='text-ui-xs text-muted w-[46px] shrink-0'>Blend</span>
              <SegmentedControl<AnimationBlendMode> size='sm' value={slot.blend ?? 'override'}
                onChange={v => setSlot(i, { blend: v })} options={BLEND_OPTIONS} />
            </div>
          </div>
        ))}
        <Button size='sm' variant='subtle' onClick={addSlot}>+ Slot</Button>
      </div>
    </Collapsable>
  )
}
