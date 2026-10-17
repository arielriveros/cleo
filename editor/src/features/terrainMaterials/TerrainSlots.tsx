import { useState } from 'react'
import { Material, TerrainMaterial, newTerrainSlotId, cloneBlendRule, MAX_TERRAIN_SURFACES } from 'cleo'
import type { TerrainMaterialSlot } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import Collapsable from '../../components/Collapsable'
import BlendRuleEditor from './BlendRuleEditor'
import MaterialPicker, { MaterialMenu, liveMaterial, useCreateMaterial } from './MaterialPicker'
import { Button, Hint, NumberInput, Popover, TextInput, Toggle, cn, labelClass } from '../../components/ui'
import type { MaterialAsset } from '../../utils/materials'
import { newLandscapeSlot, slotDisplayName } from '../../utils/landscapeSlots'

// The extra surfaces of a landscape material: rock on the steep parts, snow up high, a road where it is
// painted. The landscape-material editor's slot section; landscape mode only paints them.
//
// A slot is a Material plus a blend rule, composited OVER the slots before it — so the material's own
// surface (slot 0, the ground) is the floor and no slot ever has to fill the gaps the others leave. A
// PAINT-ONLY slot shows nowhere until it is brushed on (its rule can still limit where the brush takes).
//
// Every change goes through `edit` (which edits the preview material in place and refreshes it), so a
// change can look its slot up again by id rather than holding a stale reference.

/** Slots one landscape material may hold. The ground takes one of the stack's surfaces too. */
export const MAX_SLOTS = MAX_TERRAIN_SURFACES - 1

export type SlotEdit = (
  label: string,
  fn: (tm: TerrainMaterial) => void | false,
  opts?: { channels?: readonly number[]; coalesceKey?: string },
) => void

/** The slot of `tm` with this id (edits look a slot up again in the copy they are handed). */
const find = (tm: TerrainMaterial, id: string) => tm.slots.find(s => s.id === id)

/** Slots 1..n of `material` as rows, in blend order. */
function SlotList(props: { material: TerrainMaterial; edit: SlotEdit; elevationHint?: string | null }) {
  const { material, edit } = props
  const n = material.slots.length
  const order = material.slots.map((_, i) => i)

  return <>
    {order.map(i => {
      const slot = material.slots[i]
      const move = (dir: number) => edit('Move slot', tm => {
        const j = i + dir
        if (j < 0 || j >= tm.slots.length) return false
        const [s] = tm.slots.splice(i, 1)
        tm.slots.splice(j, 0, s)
      })
      return (
        <SlotRow key={slot.id} slot={slot} index={i} edit={edit}
          elevationHint={props.elevationHint}
          canUp={i > 0} canDown={i < n - 1}
          onUp={() => move(-1)} onDown={() => move(1)} />
      )
    })}
  </>
}

function SlotRow(props: {
  slot: TerrainMaterialSlot
  index: number
  edit: SlotEdit
  elevationHint?: string | null
  canUp: boolean
  canDown: boolean
  onUp: () => void
  onDown: () => void
}) {
  const { slot, edit } = props
  const id = slot.id
  const [showRule, setShowRule] = useState(false)
  const { materials } = useCleoEngine()
  const linked = slot.surfaceMaterialId ? materials.find(m => m.id === slot.surfaceMaterialId) : undefined
  const set = (label: string, fn: (s: TerrainMaterialSlot) => void, coalesceKey?: string,
               channels?: readonly number[]) =>
    edit(label, tm => { const s = find(tm, id); if (!s) return false; fn(s) },
         { coalesceKey: coalesceKey && `${id}:${coalesceKey}`, channels })
  const link = (a: MaterialAsset) => set(`Slot material: ${a.name}`, s => {
    s.material = liveMaterial(a)
    s.surfaceMaterialId = a.id
    // The stored name follows the material too, for wherever the library is not at hand to look it up.
    s.name = a.name
  })
  // A draft the rule editor mutates; each change is copied into the edited material as a new rule.
  const rule = cloneBlendRule(slot.rule)

  return (
    <div className='rounded border border-control p-2 space-y-2'>
      <div className='flex items-center gap-1'>
        <span className='text-ui-xs text-muted w-4 text-center' title='Blend order: higher numbers draw over lower ones'>{props.index + 1}</span>
        {linked
          ? <span className='flex-1 min-w-0 truncate px-1 text-ui' title='Named after its material — rename the material to rename the slot'>{linked.name}</span>
          : <TextInput className='flex-1 min-w-0 px-1 py-0.5'
              value={slot.name} onChange={v => set('Rename slot', s => { s.name = v }, 'name')} />}
        <Button size='sm' variant='ghost' title='Move up' disabled={!props.canUp} onClick={props.onUp}>↑</Button>
        <Button size='sm' variant='ghost' title='Move down' disabled={!props.canDown} onClick={props.onDown}>↓</Button>
        <Button size='sm' variant='ghost' title='Duplicate this slot' onClick={() => edit('Duplicate slot', tm => {
          const i = tm.slots.findIndex(s => s.id === id)
          if (i < 0) return false
          tm.slots.splice(i + 1, 0, {
            ...slot, id: newTerrainSlotId(), name: `${slotDisplayName(slot, materials)} copy`,
            material: Material.parse(slot.material.serialize()), rule: cloneBlendRule(slot.rule),
          })
        })}>⧉</Button>
        <Button variant='remove' size='sm' title='Remove this slot (and its painting)'
          onClick={() => edit('Remove slot', tm => {
            const i = tm.slots.findIndex(s => s.id === id)
            if (i < 0) return false
            tm.slots.splice(i, 1)
          })}>✕</Button>
      </div>

      <MaterialPicker value={slot.surfaceMaterialId} onPick={link} newName={() => slot.name} />

      <div className='flex items-center justify-between gap-2'>
        <span className={labelClass} title='Show this surface ONLY where it is painted with the landscape brush — roads, paths, riverbeds. Off: it appears wherever its rule says.'>Paint only</span>
        <Toggle checked={slot.manual}
          onChange={c => set(c ? 'Make slot paint-only' : 'Make slot automatic', s => {
            s.manual = c
            if (c) s.allowFoliage = false
          })} />
      </div>
      {slot.manual &&
        <Hint>Paint only: brushed on in Landscape mode; the preview here does not show it.</Hint>}

      <div className='flex items-center justify-between gap-2'>
        <span className={labelClass} title='UV repeats across the whole landscape, like the ground’s own tiling'>Tiling</span>
        <NumberInput className='w-16' value={slot.tiling} min={0.01} step={1}
          onChange={v => set('Slot tiling', s => { s.tiling = Math.max(0.01, v) }, 'tiling')} />
      </div>
      <div className='flex items-center justify-between gap-2'>
        <span className={labelClass} title='Let the foliage brush scatter where this slot dominates — off for rock and roads'>Allow foliage</span>
        <Toggle checked={slot.allowFoliage} onChange={c => set('Slot foliage', s => { s.allowFoliage = c })} />
      </div>

      <div>
        {slot.manual && (
          <button type='button' className={cn(labelClass, 'w-full text-left hover:text-fg')}
            title='Optionally keep the painting off some ground — e.g. a road that never climbs cliffs'
            onClick={() => setShowRule(v => !v)}>
            {showRule ? '▾' : '▸'} Limit by slope / elevation
          </button>
        )}
        {(!slot.manual || showRule) &&
          <BlendRuleEditor rule={rule} elevationHint={props.elevationHint}
            onChange={() => set('Slot rule', s => { s.rule = cloneBlendRule(rule) }, 'rule')} />}
      </div>
    </div>
  )
}

/**
 * "+ Slot" and "+ Paint slot": each opens the material menu, so a slot arrives with its surface — a
 * library material or a new one, made right here.
 */
function AddSlotButtons({ material, edit }: { material: TerrainMaterial; edit: SlotEdit }) {
  const create = useCreateMaterial()
  const count = material.slots.length
  const full = count >= MAX_SLOTS
  const add = (manual: boolean, asset: MaterialAsset) => {
    const slot = newLandscapeSlot({
      name: asset.name, material: liveMaterial(asset), surfaceMaterialId: asset.id,
      tiling: material.tiling, manual,
    })
    edit(manual ? 'Add paint slot' : 'Add slot', tm => {
      if (tm.slots.length >= MAX_SLOTS) return false
      tm.slots.push(slot)
    })
  }
  const menu = (manual: boolean, label: string, title: string) => (
    <Popover align='right' disabled={full} title={title}
      trigger={<span className='text-ui px-1'>{label}</span>}>
      {close => <MaterialMenu close={close} onPick={a => add(manual, a)}
        onNew={() => add(manual, create(`${manual ? 'Paint' : 'Slot'} ${count + 1}`))} />}
    </Popover>
  )
  return (
    <span className='flex items-center gap-1'>
      {menu(false, '+ Slot', 'Add a surface that blends in by slope and elevation')}
      {menu(true, '+ Paint slot', 'Add a surface that shows only where you paint it — a road, a path')}
    </span>
  )
}

/** The landscape-material editor's slot section: the list, edited in place on its preview material. */
export default function TerrainSlots(props: { material: TerrainMaterial; onChange: () => void; elevationHint?: string | null }) {
  const { material, onChange } = props
  const [, force] = useState(0)
  const edit: SlotEdit = (_label, fn) => { if (fn(material) !== false) { onChange(); force(x => x + 1) } }
  // Read so the list re-renders when the library changes (a new material's name appears in its picker).
  useCleoEngine()

  return (
    <Collapsable title={material.slots.length ? `Slots (${material.slots.length})` : 'Slots'} persistKey='terrainMaterial.slots'>
      <div className='p-2 space-y-2'>
        <Hint>
          Extra surfaces blended over this material wherever their rule says so — rock on steep ground, snow
          above a height — or, paint only, just where they are brushed in Landscape mode. The ground,
          above, always fills what they leave.
        </Hint>
        <SlotList material={material} edit={edit} elevationHint={props.elevationHint} />
        <div className='flex justify-end'><AddSlotButtons material={material} edit={edit} /></div>
        {material.slots.length >= MAX_SLOTS &&
          <Hint>A landscape material can hold {MAX_SLOTS} slots; the landscape itself can show {MAX_TERRAIN_SURFACES} surfaces at once.</Hint>}
      </div>
    </Collapsable>
  )
}
