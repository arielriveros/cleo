import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Button, Hint, MenuItem, Popover, SegmentedControl, Select, cn, hintClass, sectionTitleClass } from '../../components/ui'
import { useActiveLandscape } from './useActiveLandscape'
import { useLandscapeBrush, setBrush, resolvePaintTarget, type WeightView } from './landscapeBrushStore'
import { useStackEdit } from './useStackEdit'
import { layerStackOf } from '../../utils/terrainAccess'
import { buildTerrainMaterialAsset, type TerrainMaterialAsset } from '../../utils/terrainMaterials'
import { createLandscapeNode, defaultLandscapeMaterial, slotDisplayName } from '../../utils/landscapeSlots'
import { useAssetDrop } from '../../utils/useAssetDrop'

// A landscape is painted with ONE landscape material, and only with it. This panel picks that material
// (from the landscape-material library, or a new one) and lists its slots: the ground and the automatic
// slots draw by their rules, and the PAINT-ONLY slots are what the brush paints — roads, paths. What the
// slots are, and which Materials they draw, is authored in the landscape-material editor (✎), never here.
// Every change is one undo step (see useStackEdit).

const sectionTitle = sectionTitleClass

export default function LandscapeLayersPanel() {
  const { eventEmitter, editorScene, materials, enterTerrainMaterialEditor } = useCleoEngine()
  const { node, landscapes, select, revision, refresh } = useActiveLandscape()
  const brush = useLandscapeBrush()
  const { edit, assignBase, saveBaseToLibrary } = useStackEdit(node, refresh)

  const stack = layerStackOf(node?.terrain)
  const base = stack?.base.material ?? null
  const paintSlots = stack ? stack.paintSlots : []
  const target = resolvePaintTarget(paintSlots, brush.paintSlotId)

  // The authoring weight view is terrain state the renderer reads; drive it from here, and switch it off
  // whenever this panel goes away (leaving landscape mode unmounts it).
  useEffect(() => {
    if (!stack) return
    const surfaces = stack.surfaces()
    stack.debugSurface = brush.weightView === 'all' ? -2
      : brush.weightView === 'layer' && target ? surfaces.findIndex(s => s.slotId === target.id)
      : -1
    return () => { stack.debugSurface = -1 }
  }, [stack, brush.weightView, target?.id, revision])

  if (!node) {
    return (
      <div className='p-2 space-y-2 text-ui text-muted'>
        <p>This scene has no landscape.</p>
        <Button size='sm' onClick={() => {
          const landscape = createLandscapeNode()
          editorScene.addNode(landscape)
          eventEmitter.emit('SCENE_CHANGED')
          eventEmitter.emit('SELECT_NODE', landscape.id)
          select(landscape.id)
        }}>Add Landscape</Button>
      </div>
    )
  }
  if (!stack) return <div className='p-2 text-ui text-muted'>This landscape predates the layer stack.</div>

  const mask = (id: string, op: 'fill' | 'clear' | 'invert') => {
    const channel = stack.slotChannel(id)
    if (channel === undefined) return
    edit(op === 'fill' ? 'Fill slot' : op === 'clear' ? 'Clear slot' : 'Invert slot',
      s => op === 'invert' ? s.invertMask(id) : s.fillMask(id, op === 'fill' ? 1 : 0), [channel])
  }
  const thumbOf = (materialId: string | null) => materialId ? materials.find(m => m.id === materialId)?.thumbnail : undefined

  return (
    <div className='flex flex-col text-fg p-2 gap-3'>
      {landscapes.length > 1 && (
        <Select value={node.id} onChange={e => select(e.target.value)} title='Which landscape these panels edit'>
          {landscapes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      )}

      {stack.paintLayers.length > 0 && (
        <div className='rounded border border-warning p-2 space-y-1'>
          <Hint>This landscape still has {stack.paintLayers.length} paint layer(s) from an older version.</Hint>
          <Button size='sm' onClick={() => edit('Convert paint layers', s => s.convertPaintLayersToSlots(), stack.usedChannels())}>
            Convert to paint slots
          </Button>
        </div>
      )}

      <section className='space-y-1'>
        <div className={sectionTitle}>Landscape material</div>
        <LandscapeMaterialPicker materialId={stack.base.materialId} landscapeName={node.name}
          onAssign={assignBase} onEdit={id => enterTerrainMaterialEditor(id)} />
        {base && !stack.base.materialId && (
          <div className='space-y-1'>
            <Hint>This landscape’s material is embedded, not in the library, so it cannot be edited yet.</Hint>
            <Button size='sm' onClick={() => {
              const asset = saveBaseToLibrary(`${node.name} material`)
              if (asset) enterTerrainMaterialEditor(asset.id)
            }}>Save to library and edit</Button>
          </div>
        )}
      </section>

      {base && (
        <section className='space-y-1'>
          <div className={sectionTitle}>Slots</div>
          {[...base.slots].reverse().map(slot => {
            const paintable = slot.manual && stack.slotChannel(slot.id) !== undefined
            const active = paintable && target?.id === slot.id
            return (
              <div key={slot.id}
                className={cn('rounded border p-1.5 space-y-1', active ? 'border-selected bg-control' : 'border-control',
                              paintable && 'cursor-pointer')}
                onClick={() => { if (paintable) setBrush({ paintSlotId: slot.id, mode: 'paint' }) }}>
                <SlotLine name={slotDisplayName(slot, materials)} thumb={thumbOf(slot.surfaceMaterialId)}
                  tag={slot.manual ? 'paint' : 'auto'}
                  tagTitle={slot.manual ? 'Shows only where painted' : 'Blends in by its slope / elevation rule'} />
                {paintable && (
                  <div className='flex items-center gap-1' onClick={e => e.stopPropagation()}>
                    <Button size='sm' variant={active ? 'default' : 'ghost'} active={active} className='flex-1'
                      title='Paint this slot with the landscape brush'
                      onClick={() => setBrush({ paintSlotId: slot.id, mode: 'paint' })}>{active ? 'Painting' : 'Paint'}</Button>
                    <Button size='sm' variant='ghost' title='Cover the whole landscape with this slot' onClick={() => mask(slot.id, 'fill')}>Fill</Button>
                    <Button size='sm' variant='ghost' title='Erase all painting of this slot' onClick={() => mask(slot.id, 'clear')}>Clear</Button>
                    <Button size='sm' variant='ghost' title='Painted becomes unpainted and back' onClick={() => mask(slot.id, 'invert')}>Invert</Button>
                  </div>
                )}
              </div>
            )
          })}
          <div className='rounded border border-control p-1.5'>
            <SlotLine name='Ground' thumb={thumbOf(base.surfaceMaterialId)} tag='covers' tagTitle='Covers the whole landscape' />
          </div>
          {!base.slots.some(s => s.manual) &&
            <Hint>Nothing to paint yet: add a <b>Paint only</b> slot (a road, a path) in the landscape material (✎).</Hint>}
          {stack.truncated && <Hint>More surfaces than the renderer draws at once; the topmost are hidden.</Hint>}
        </section>
      )}

      <section className='space-y-1'>
        <div className={sectionTitle}>View</div>
        <SegmentedControl<WeightView> size='sm' grow
          options={[
            { value: 'off', label: 'Shaded', title: 'The landscape as it renders' },
            { value: 'layer', label: 'Paint slot', title: "Heat map of the active paint slot's weight" },
            { value: 'all', label: 'All', title: 'Every surface in a colour of its own' },
          ]}
          value={brush.weightView} onChange={v => setBrush({ weightView: v })} />
      </section>
    </div>
  )
}

function SlotLine({ name, thumb, tag, tagTitle }: { name: string; thumb?: string; tag: string; tagTitle: string }) {
  return (
    <div className='flex items-center gap-2 min-w-0'>
      <span className='block w-6 h-6 shrink-0 rounded overflow-hidden bg-surface-raised border border-control'>
        {thumb && <img src={thumb} className='w-full h-full object-cover' alt='' />}
      </span>
      <span className='truncate flex-1 text-ui'>{name}</span>
      <span className='text-ui-xs text-muted' title={tagTitle}>{tag}</span>
    </div>
  )
}

/**
 * The landscape's material: thumbnail and name, a menu of the landscape-material library (plus "New
 * landscape material", which creates one, assigns it and opens it), ✎ to edit it, and a drop target.
 */
export function LandscapeMaterialPicker({ materialId, landscapeName, onAssign, onEdit }: {
  materialId: string | null
  landscapeName: string
  onAssign: (asset: TerrainMaterialAsset) => void
  onEdit: (id: string) => void
}) {
  const { terrainMaterials, addTerrainMaterial } = useCleoEngine()
  const asset = materialId ? terrainMaterials.find(m => m.id === materialId) : undefined
  const assignId = (id: string) => { const a = terrainMaterials.find(m => m.id === id); if (a) onAssign(a) }
  const { dragOver, dropProps } = useAssetDrop('text/cleo-terrain-material', assignId, { stopPropagation: true })
  // The editor opens a library asset by id, so a new one is opened once the library holds it.
  const [opening, setOpening] = useState<string | null>(null)
  useEffect(() => {
    if (opening && terrainMaterials.some(m => m.id === opening)) { setOpening(null); onEdit(opening) }
  }, [opening, terrainMaterials, onEdit])
  const createNew = () => {
    const created = buildTerrainMaterialAsset(defaultLandscapeMaterial(), `${landscapeName} material`, '')
    addTerrainMaterial(created)
    onAssign(created)
    setOpening(created.id)
  }

  return (
    <div className='space-y-0.5'>
      <div {...dropProps} title='The landscape material this landscape paints with — drop one here too'
        className={cn('flex items-center gap-1 rounded border px-1 py-0.5', dragOver ? 'border-selected bg-control' : 'border-control')}>
        <Popover rootClassName='flex-1 min-w-0' triggerClassName='w-full' title='Choose or create a landscape material'
          trigger={
            <span className='flex items-center gap-2 min-w-0 text-ui'>
              <span className='block w-7 h-7 shrink-0 rounded overflow-hidden bg-surface-raised border border-control'>
                {asset?.thumbnail && <img src={asset.thumbnail} className='w-full h-full object-cover' alt='' />}
              </span>
              <span className='truncate'>{asset ? asset.name : materialId ? '(missing landscape material)' : 'Choose a landscape material…'}</span>
              <span className='ml-auto text-muted'>▾</span>
            </span>
          }>
          {close => (
            <div data-cleo-overlay className='flex flex-col p-1 min-w-[200px] max-h-[300px] overflow-y-auto text-ui'>
              <MenuItem className='items-center text-highlight' title='Create a landscape material, use it here and open it'
                onClick={() => { createNew(); close() }}>+ New landscape material</MenuItem>
              {terrainMaterials.length > 0 && <div className='my-1 h-px bg-fg/10' />}
              {terrainMaterials.map(m => (
                <MenuItem key={m.id} className='items-center' onClick={() => { onAssign(m); close() }}
                  icon={
                    <span className='block w-5 h-5 rounded overflow-hidden bg-surface-raised'>
                      {m.thumbnail && <img src={m.thumbnail} className='w-full h-full object-cover' alt='' />}
                    </span>
                  }>
                  {m.name}
                </MenuItem>
              ))}
            </div>
          )}
        </Popover>
        {asset && <Button size='sm' variant='ghost' className='px-1 text-highlight hover:text-highlight' title='Edit this landscape material'
          onClick={e => { e.stopPropagation(); onEdit(asset.id) }}>✎</Button>}
      </div>
      {materialId && !asset &&
        <p className={cn(hintClass, 'text-warning')}>The linked landscape material is missing from the library; its copy still draws.</p>}
    </div>
  )
}
