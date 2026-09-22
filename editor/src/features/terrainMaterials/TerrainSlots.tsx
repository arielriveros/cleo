import { useState } from 'react'
import {
  Material, TerrainMaterial, TextureManager, newTerrainSlotId, defaultBlendRule, cloneBlendRule,
  MAX_TERRAIN_SURFACES,
} from 'cleo'
import type { TerrainMaterialSlot } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import BlendRuleEditor from './BlendRuleEditor'
import { Button, Hint, NumberInput, Toggle } from '../../components/ui'
import { useAssetDrop } from '../../utils/useAssetDrop'
import type { MaterialAsset } from '../../utils/materials'

// The extra surfaces of a landscape material: rock on the steep parts, snow up high, gravel in the hollows.
//
// A slot is an ordinary Material asset plus a blend rule, composited OVER the slots before it — so the
// material's own surface (slot 0, the editor above) is the floor and no slot ever has to fill the gaps the
// others leave. The preview shows exactly this, which is why every edit ends in `refreshTerrainMaterialPreview`.

/** Slots one landscape material may hold. The base surface takes one of the stack's surfaces too. */
const MAX_SLOTS = MAX_TERRAIN_SURFACES - 1

export default function TerrainSlots(props: { material: TerrainMaterial; onChange: () => void; elevationHint?: string | null }) {
  const { material, onChange } = props
  const [, force] = useState(0)
  const changed = () => { onChange(); force(x => x + 1) }

  const addSlot = (asset?: MaterialAsset) => {
    if (material.slots.length >= MAX_SLOTS) return
    const slot: TerrainMaterialSlot = {
      id: newTerrainSlotId(),
      name: asset?.name ?? `Slot ${material.slots.length + 1}`,
      material: asset ? liveMaterial(asset) : Material.PBR({ baseColor: [0.6, 0.6, 0.6], roughness: 0.9, metallic: 0 }),
      surfaceMaterialId: asset?.id ?? null,
      tiling: material.tiling,
      // A new slot is visible everywhere until it is given a rule; inheriting the base's would hide it.
      rule: defaultBlendRule(),
      allowFoliage: false,
    }
    material.slots.push(slot)
    changed()
  }

  return (
    <Collapsable title={material.slots.length ? `Slots (${material.slots.length})` : 'Slots'} persistKey='terrainMaterial.slots'>
      <div className='p-2 space-y-2'>
        <Hint>
          Extra surfaces blended over this material wherever their rule says so — rock on steep ground, snow
          above a height. The material’s own surface, edited above, always fills what they leave.
        </Hint>
        {material.slots.map((slot, i) => (
          <SlotRow key={slot.id} slot={slot} index={i} count={material.slots.length}
            elevationHint={props.elevationHint}
            onChange={changed}
            onMove={dir => {
              const j = i + dir
              if (j < 0 || j >= material.slots.length) return
              const [s] = material.slots.splice(i, 1)
              material.slots.splice(j, 0, s)
              changed()
            }}
            onDuplicate={() => {
              material.slots.splice(i + 1, 0, {
                ...slot, id: newTerrainSlotId(), name: `${slot.name} copy`,
                material: Material.parse(slot.material.serialize()), rule: cloneBlendRule(slot.rule),
              })
              changed()
            }}
            onRemove={() => { material.slots.splice(i, 1); changed() }} />
        ))}
        <AddSlot disabled={material.slots.length >= MAX_SLOTS} onAdd={addSlot} />
        {material.slots.length >= MAX_SLOTS &&
          <Hint>A landscape material can hold {MAX_SLOTS} slots; the landscape itself can show {MAX_TERRAIN_SURFACES} surfaces at once, base and paint layers together.</Hint>}
      </div>
    </Collapsable>
  )
}

function SlotRow(props: {
  slot: TerrainMaterialSlot
  index: number
  count: number
  elevationHint?: string | null
  onChange: () => void
  onMove: (dir: -1 | 1) => void
  onDuplicate: () => void
  onRemove: () => void
}) {
  const { slot } = props
  const { materials, enterMaterialEditor } = useCleoEngine()
  const asset = slot.surfaceMaterialId ? materials.find(m => m.id === slot.surfaceMaterialId) : undefined
  const link = (id: string) => {
    const a = materials.find(m => m.id === id)
    if (!a) return
    slot.material = liveMaterial(a)
    slot.surfaceMaterialId = a.id
    if (slot.name.startsWith('Slot ')) slot.name = a.name
    props.onChange()
  }
  const { dragOver, dropProps } = useAssetDrop('text/cleo-material', link, { stopPropagation: true })

  return (
    <div {...dropProps} className={`rounded border p-2 space-y-2 ${dragOver ? 'border-selected bg-control' : 'border-control'}`}>
      <div className='flex items-center gap-1'>
        {/* Painted in order: a slot lower in the list is covered by the ones under it in the panel. */}
        <span className='text-[10px] text-muted w-4 text-center' title='Blend order: later slots draw over earlier ones'>{props.index + 1}</span>
        <input className='flex-1 min-w-0 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'
          value={slot.name} onChange={e => { slot.name = e.target.value; props.onChange() }} />
        <Button size='sm' variant='ghost' title='Move up (drawn earlier)' disabled={props.index === 0} onClick={() => props.onMove(-1)}>↑</Button>
        <Button size='sm' variant='ghost' title='Move down (drawn later)' disabled={props.index === props.count - 1} onClick={() => props.onMove(1)}>↓</Button>
        <Button size='sm' variant='ghost' title='Duplicate this slot' onClick={props.onDuplicate}>⧉</Button>
        <Button size='sm' variant='ghost' title='Remove this slot' onClick={props.onRemove}>✕</Button>
      </div>

      <div className='flex items-center gap-1'>
        <select className='flex-1 min-w-0 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'
          value={slot.surfaceMaterialId ?? ''} onChange={e => { if (e.target.value) link(e.target.value) }}
          title='The Material asset this surface draws — drop one here too'>
          <option value=''>{asset ? asset.name : slot.surfaceMaterialId ? '(missing material)' : '(unlinked surface)'}</option>
          {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
        </select>
        {asset && <Button size='sm' variant='ghost' title='Edit that material' onClick={() => enterMaterialEditor(asset.id)}>✎</Button>}
      </div>
      {slot.surfaceMaterialId && !asset &&
        <p className='text-[10px] text-warning'>The linked material is missing from the library; this slot’s copy still draws.</p>}

      <div className='flex items-center justify-between gap-2'>
        <span className='text-xs text-slate-300' title='UV repeats across the whole landscape, like the material’s own tiling'>Tiling</span>
        <NumberInput className='w-16' value={slot.tiling} min={0.01} step={1}
          onChange={v => { slot.tiling = Math.max(0.01, v); props.onChange() }} />
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className='text-xs text-slate-300' title='Let the foliage brush scatter where this slot dominates — off for rock and roads'>Allow foliage</span>
        <Toggle checked={slot.allowFoliage} onChange={c => { slot.allowFoliage = c; props.onChange() }} />
      </div>

      <BlendRuleEditor rule={slot.rule} onChange={props.onChange} elevationHint={props.elevationHint} />
    </div>
  )
}

function AddSlot({ disabled, onAdd }: { disabled: boolean; onAdd: (asset?: MaterialAsset) => void }) {
  const { materials } = useCleoEngine()
  const [pick, setPick] = useState('')
  return (
    <div className='flex gap-1'>
      <select className='flex-1 min-w-0 bg-control text-white border border-border rounded px-1 py-[2px] text-xs'
        value={pick} disabled={disabled} onChange={e => setPick(e.target.value)}>
        <option value=''>(empty surface)</option>
        {materials.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select>
      <Button size='sm' variant='success' disabled={disabled}
        title='Add a surface blended over this material by its own rule'
        onClick={() => { onAdd(materials.find(m => m.id === pick)); setPick('') }}>Add slot</Button>
    </div>
  )
}

/** A library material as a live one, with its textures restored the way `applyMaterialAsset` does. */
function liveMaterial(asset: MaterialAsset): Material {
  for (const t of asset.textures || []) {
    if (t?.id && !TextureManager.Instance.getTexture(t.id))
      TextureManager.Instance.addTextureFromBase64(t.data, t.config, t.id)
  }
  return Material.parse(asset.material)
}
