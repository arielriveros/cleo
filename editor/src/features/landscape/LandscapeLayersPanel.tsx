import React, { useEffect, useState } from 'react'
import { LandscapeNode, Terrain, MAX_PAINT_LAYERS } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { Button, Hint, SegmentedControl, Select, Slider, TextInput, Toggle, Popover } from '../../components/ui'
import { useActiveLandscape } from './useActiveLandscape'
import { useLandscapeBrush, setBrush, type WeightView } from './landscapeBrushStore'
import LandscapeMaterialSlot from './LandscapeMaterialSlot'
import { useStackEdit } from './useStackEdit'
import { layerStackOf } from '../../utils/terrainAccess'
import { type TerrainMaterialAsset } from '../../utils/terrainMaterials'

// The landscape's layer stack, as a panel: the BASE material that covers everything, and the PAINT
// layers over it, topmost first — the order a layer stack reads everywhere else. Painting targets the
// ACTIVE layer, chosen here. Every structural change is one undo step (see stackHistory).

const sectionTitle = 'text-[10px] uppercase tracking-wide text-muted'

export default function LandscapeLayersPanel() {
  const { eventEmitter, editorScene } = useCleoEngine()
  const { node, landscapes, select, revision, refresh } = useActiveLandscape()
  const brush = useLandscapeBrush()
  // The same edits the viewport toolbar makes, so an assignment records identically from either place.
  const { edit, assignBase, assignLayer, addLayer } = useStackEdit(node, refresh)

  const stack = layerStackOf(node?.terrain)
  const layers = stack ? [...stack.paintLayers] : []
  const activeId = layers.some(l => l.id === brush.paintLayerId) ? brush.paintLayerId : (layers[layers.length - 1]?.id ?? null)

  // The authoring weight view is terrain state the renderer reads; drive it from here, and switch it off
  // whenever this panel goes away (leaving landscape mode unmounts it).
  useEffect(() => {
    if (!stack) return
    const surfaces = stack.surfaces()
    const layerIndex = layers.findIndex(l => l.id === activeId)
    stack.debugSurface = brush.weightView === 'all' ? -2
      : brush.weightView === 'layer' && layerIndex >= 0 ? surfaces.findIndex(s => s.layer === layerIndex + 1)
      : -1
    return () => { stack.debugSurface = -1 }
  }, [stack, brush.weightView, activeId, revision, layers.length])

  if (!node) {
    return (
      <div className='p-2 space-y-2 text-xs text-muted'>
        <p>This scene has no landscape.</p>
        <Button size='sm' onClick={() => {
          const landscape = new LandscapeNode('landscape', new Terrain({ size: 200, resolution: 129, chunkQuads: 32 }))
          editorScene.addNode(landscape)
          eventEmitter.emit('SCENE_CHANGED')
          eventEmitter.emit('SELECT_NODE', landscape.id)
          select(landscape.id)
        }}>Add Landscape</Button>
      </div>
    )
  }
  if (!stack) return <div className='p-2 text-xs text-muted'>This landscape predates the layer stack.</div>

  const full = layers.length >= MAX_PAINT_LAYERS

  return (
    <div className='flex flex-col text-white p-2 gap-3' key={revision}>
      {landscapes.length > 1 && (
        <Select className='text-xs' value={node.id} onChange={e => select(e.target.value)} title='Which landscape these panels edit'>
          {landscapes.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
        </Select>
      )}

      <section className='space-y-1'>
        <div className={sectionTitle}>Base</div>
        <LandscapeMaterialSlot
          materialId={stack.base.materialId} hasEmbedded={!!stack.base.material}
          onAssign={assignBase}
          onClear={stack.base.material ? () => edit('Clear base', s => { s.setBase(null); return true }) : undefined} />
        <Hint>Covers the whole landscape. Its slots blend by slope and elevation on their own — no painting needed.</Hint>
      </section>

      <section className='space-y-1'>
        <div className='flex items-center justify-between'>
          <span className={sectionTitle}>Paint layers</span>
          <AddLayerButton disabled={full} onAdd={addLayer} />
        </div>
        {layers.length === 0 && <Hint>Add a layer to paint details over the base — a dirt road, a brick path, a riverbed.</Hint>}
        {full && <Hint>{MAX_PAINT_LAYERS} layers is the limit.</Hint>}
        {[...layers].reverse().map(layer => {
          const index = layers.indexOf(layer)
          const active = layer.id === activeId
          return (
            <div key={layer.id}
              className={`border rounded p-1.5 space-y-1 cursor-pointer ${active ? 'border-selected bg-control' : 'border-control'}`}
              onClick={() => setBrush({ paintLayerId: layer.id })}>
              <div className='flex items-center gap-1'>
                <span onClick={e => e.stopPropagation()}>
                  <Toggle checked={layer.visible}
                    onChange={v => edit(v ? 'Show layer' : 'Hide layer', s => s.updatePaintLayer(layer.id, { visible: v }))} />
                </span>
                <RenameField name={layer.name}
                  onCommit={name => edit('Rename layer', s => s.updatePaintLayer(layer.id, { name }))} />
                <button className='px-1 text-xs text-muted hover:text-white disabled:opacity-30' title='Move up'
                  disabled={index === layers.length - 1}
                  onClick={e => { e.stopPropagation(); edit('Move layer up', s => s.movePaintLayer(layer.id, index + 1)) }}>▲</button>
                <button className='px-1 text-xs text-muted hover:text-white disabled:opacity-30' title='Move down'
                  disabled={index === 0}
                  onClick={e => { e.stopPropagation(); edit('Move layer down', s => s.movePaintLayer(layer.id, index - 1)) }}>▼</button>
                <span onClick={e => e.stopPropagation()}>
                  <Popover align='right' title='Layer actions' trigger={<span className='px-1 text-xs'>⋯</span>}>
                    <div data-cleo-overlay className='flex flex-col p-1 min-w-[140px] text-xs'>
                      <MenuItem label='Fill' hint='Cover the whole landscape with this layer'
                        onClick={() => edit('Fill layer', s => s.fillMask(layer.id, 1), [layer.channel])} />
                      <MenuItem label='Clear' hint='Erase all of this layer'
                        onClick={() => edit('Clear layer', s => s.fillMask(layer.id, 0), [layer.channel])} />
                      <MenuItem label='Invert' hint='Painted becomes unpainted and back'
                        onClick={() => edit('Invert layer', s => s.invertMask(layer.id), [layer.channel])} />
                      <MenuItem label='Delete' danger hint='Remove the layer and its painting'
                        onClick={() => edit('Delete layer', s => s.removePaintLayer(layer.id), [layer.channel])} />
                    </div>
                  </Popover>
                </span>
              </div>
              <div onClick={e => e.stopPropagation()}>
                <LandscapeMaterialSlot compact materialId={layer.materialId} hasEmbedded={!!layer.material}
                  onAssign={asset => assignLayer(layer.id, asset)} />
              </div>
              <div onClick={e => e.stopPropagation()}>
                <Slider label='Opacity' min={0} max={1} step={0.05} value={layer.opacity}
                  readout={v => `${Math.round(v * 100)}%`}
                  onChange={v => edit('Layer opacity', s => s.updatePaintLayer(layer.id, { opacity: v }))} />
              </div>
            </div>
          )
        })}
      </section>

      <section className='space-y-1'>
        <div className={sectionTitle}>View</div>
        <SegmentedControl<WeightView> size='sm' grow
          options={[
            { value: 'off', label: 'Shaded', title: 'The landscape as it renders' },
            { value: 'layer', label: 'Active layer', title: "Heat map of the active layer's weight" },
            { value: 'all', label: 'All', title: 'Every surface in a colour of its own' },
          ]}
          value={brush.weightView} onChange={v => setBrush({ weightView: v })} />
        {stack.truncated && <Hint>More surfaces than the renderer draws at once; the topmost are hidden.</Hint>}
      </section>
    </div>
  )
}

/** The layer's name: edited locally, committed as one undo step on blur or Enter. */
function RenameField({ name, onCommit }: { name: string; onCommit: (name: string) => void }) {
  const [value, setValue] = useState(name)
  useEffect(() => setValue(name), [name])
  const commit = () => { const v = value.trim(); if (v && v !== name) onCommit(v); else setValue(name) }
  return (
    <TextInput className='flex-1 min-w-0 text-xs' value={value}
      onChange={setValue}
      onClick={e => e.stopPropagation()}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); if (e.key === 'Escape') setValue(name) }} />
  )
}

function MenuItem({ label, hint, onClick, danger }: { label: string; hint: string; onClick: () => void; danger?: boolean }) {
  return (
    <button className={`text-left px-2 py-1 rounded hover:bg-control-hover ${danger ? 'text-red-300' : 'text-white'}`}
      title={hint} onClick={onClick}>{label}</button>
  )
}

/** "+ Layer", with a picker of landscape materials so the new layer arrives with one. */
export function AddLayerButton({ disabled, onAdd }: { disabled: boolean; onAdd: (asset: TerrainMaterialAsset | null) => void }) {
  const { terrainMaterials } = useCleoEngine()
  return (
    <Popover align='right' disabled={disabled} title='Add a paint layer' trigger={<span className='text-xs px-1'>+ Layer</span>}>
      <div data-cleo-overlay className='flex flex-col p-1 min-w-[180px] max-h-[260px] overflow-y-auto text-xs'>
        {terrainMaterials.map(m => (
          <button key={m.id} className='flex items-center gap-2 text-left px-2 py-1 rounded hover:bg-control-hover' onClick={() => onAdd(m)}>
            <span className='w-5 h-5 rounded overflow-hidden bg-surface-raised shrink-0'>
              {m.thumbnail && <img src={m.thumbnail} className='w-full h-full object-cover' alt='' />}
            </span>
            <span className='truncate'>{m.name}</span>
          </button>
        ))}
        <button className='text-left px-2 py-1 rounded hover:bg-control-hover text-muted' onClick={() => onAdd(null)}>Empty layer</button>
      </div>
    </Popover>
  )
}
