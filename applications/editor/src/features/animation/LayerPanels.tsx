import { useStateMachine } from './StateMachineContext'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { Button, cn, SegmentedControl, Select, Slider, TextInput, Toggle } from '@cleo/app-kit/ui'
import { FallIcon, OverlayIcon } from '../rig/reactions/reactionIcons'
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
// ACTIVE layer (the layer dropdown on the graph toolbar); this is where a layer's own settings live.
//
// A slot is where a script's `animator.playAction('Reload', { slot: 'UpperBody' })` plays — no graph
// wiring at all. Unity has nothing quite like it; it is Unreal's Montage slot.

/** Dense-row padding for the library controls (their default is px-2 py-1). */
const tight = 'px-1 py-0.5'

const BLEND_OPTIONS = [
  { value: 'override' as const, label: 'Override', title: 'Replace the pose beneath, by weight x mask' },
  { value: 'additive' as const, label: 'Additive', title: 'Add the clip’s motion relative to its first frame (a pose: what it changes from its base pose) — breathing, recoil, a flinch, an aim offset' },
]

const HAND_IK_OPTIONS = [
  { value: 'off' as const, label: 'Off', title: 'No hand IK' },
  { value: 'left' as const, label: 'Left', title: 'The left hand reaches where this layer’s pose has it relative to the right: a rifle’s support hand' },
  { value: 'right' as const, label: 'Right', title: 'The right hand reaches where this layer’s pose has it relative to the left' },
]

/** The dropdown that picks which layer the graph shows, and the button that adds one. */
export function LayerPicker() {
  const { fullSm, activeLayer, setActiveLayer, addLayer } = useStateMachine()
  const layers = fullSm.layers ?? []
  const current = activeLayer > 0 ? layers[activeLayer - 1] : undefined
  // One control of one width however many layers the machine has (a long name is cut short), so the toolbar beside it
  // never moves as layers come and go.
  return (
    <div className='flex items-center gap-1 shrink-0'>
      <Select className={cn(tight, 'w-[136px] truncate')} value={activeLayer}
        onChange={e => setActiveLayer(Number(e.target.value))}
        title={current
          ? `The graph shows and edits the “${current.name}” layer (${current.blend ?? 'override'}). Pick another, or Base`
          : 'The graph shows and edits the base layer: it drives the whole body and the character’s root motion. Pick a layer to edit its states'}>
        <option value={0}>Base</option>
        {layers.map((l, i) => <option key={i} value={i + 1}>{l.name}</option>)}
      </Select>
      <Button size='sm' variant='subtle' className='shrink-0 whitespace-nowrap' onClick={addLayer}
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
    <Collapsable title={`Layer — ${layer.name}`} doc='Layer' defaultOpen>
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
            title='Which bones this layer affects. Masks are edited in the skeleton editor.'
            onChange={e => setLayer(activeLayer, { maskId: e.target.value || undefined, mask: undefined })}>
            <option value=''>Whole body</option>
            {maskMissing && <option value={layer.maskId}>missing mask</option>}
            {boneMasks.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
          </Select>
        </AssetDropRow>
        {maskMissing && <p className='text-ui-xs text-warning'>That mask was deleted, so this layer affects nothing until another is picked.</p>}

        {/* Under a Ragdoll or Get Up state the layers fade out (an aim must not pull at a body getting up), unless
            one plays over them (AnimationLayer.overReactions). */}
        <span className='self-start' title={'Plays over Ragdoll and Get Up states. Off (the default), the layer fades out while '
          + 'the base layer is in one, and back in after, so a weapon or aim pose does not pull at a body lying or getting up.'}>
          <Toggle doc={false} checked={!!layer.overReactions} className='text-ui-xs'
            label={<span className='inline-block w-3.5 h-3.5 align-[-2px]'><FallIcon /></span>}
            onChange={c => setLayer(activeLayer, { overReactions: c || undefined })} />
        </span>

        {/* A reacting body's muscles reach for the pose without this layer (AnimationLayer.body 'overlay'): it is
            drawn over the body instead. For fast additive layers: a weapon's recoil, a flinch. */}
        <span className='self-start' title={'Drawn over the body: while the character reacts with its body (a hit, a stagger), its '
          + 'muscles do not follow this layer; it is drawn on top of the simulated body as authored. For fast additive layers '
          + '(a weapon’s recoil, a flinch): a muscle following one would lag it and overshoot, a wobble.'}>
          <Toggle doc={false} checked={layer.body === 'overlay'} className='text-ui-xs'
            label={<span className='inline-block w-3.5 h-3.5 align-[-2px]'><OverlayIcon /></span>}
            onChange={c => setLayer(activeLayer, { body: c ? 'overlay' : undefined })} />
        </span>

        {/* Support-hand IK (AnimationLayer.handIk): after every layer, one hand reaches where this layer's own
            pose puts it relative to the other, so an aim offset or recoil on the gun hand cannot pull it off. */}
        <div className='flex items-center gap-1'
          title={'Support-hand IK: after every layer, this hand reaches where this layer’s own pose has it relative to the '
            + 'other hand, so a weapon held in the other hand keeps both hands on it whatever the layers above do (an aim '
            + 'offset, recoil) and however its poses are edited.'}>
          <span className='text-ui-xs text-muted w-[46px] shrink-0'>Hand IK</span>
          <SegmentedControl<'off' | 'left' | 'right'> size='sm' value={layer.handIk?.hand ?? 'off'}
            onChange={v => setLayer(activeLayer, { handIk: v === 'off' ? undefined : { ...(layer.handIk ?? {}), hand: v } })}
            options={HAND_IK_OPTIONS} />
        </div>
        {layer.handIk && (
          <>
            <div className='flex items-center gap-1'>
              <span className='text-ui-xs text-muted w-[46px] shrink-0'>Reach</span>
              {layer.handIk.weightParam
                ? <Select className={cn(tight, 'flex-1 min-w-0')} value={layer.handIk.weightParam}
                    title='Read how firmly the hand holds on (0..1) from this parameter every frame: 0 lets go'
                    onChange={e => setLayer(activeLayer, { handIk: { ...layer.handIk!, weightParam: e.target.value || undefined } })}>
                    <option value=''>(fixed)</option>
                    {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </Select>
                : <>
                    <Slider className='flex-1 min-w-0 my-0' editable={false} min={0} max={1} step={0.01} value={layer.handIk.weight ?? 1}
                      onChange={v => setLayer(activeLayer, { handIk: { ...layer.handIk!, weight: v } })} />
                    <Select className={cn(tight, 'w-[64px]')} value='' title='Drive it from a parameter instead (0 lets go: a sprint)'
                      onChange={e => e.target.value && setLayer(activeLayer, { handIk: { ...layer.handIk!, weightParam: e.target.value } })}>
                      <option value=''>param…</option>
                      {weightParams.map(p => <option key={p.name} value={p.name}>{p.name}</option>)}
                    </Select>
                  </>}
            </div>
            <div className='flex items-center gap-1'
              title='Optional: reach this socket (on the other hand) instead of where this layer’s pose has the hand. Then an edit to the hand in the poses is ignored.'>
              <span className='text-ui-xs text-muted w-[46px] shrink-0'>Socket</span>
              <TextInput className={cn(tight, 'flex-1 min-w-0')} value={layer.handIk.socket ?? ''} placeholder='(the pose’s own grip)'
                onChange={v => setLayer(activeLayer, { handIk: { ...layer.handIk!, socket: v.trim() || undefined } })} />
            </div>
          </>
        )}
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
