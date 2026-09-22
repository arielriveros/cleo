import { MAX_PAINT_LAYERS, type LandscapeNode, type SculptTool } from 'cleo'
import { Hint, Select, Slider } from '../../components/ui'
import { useLandscapeBrush, setBrush, activeStrength, setActiveStrength, strengthSpec, activeToolKey, type PaintTool } from './landscapeBrushStore'
import { MODES, SCULPT_TOOLS, PAINT_TOOLS, type LandscapeToolInfo } from './landscapeTools'
import { useActiveLandscape } from './useActiveLandscape'
import { useStackEdit } from './useStackEdit'
import { AddLayerButton } from './LandscapeLayersPanel'
import LandscapeMaterialSlot from './LandscapeMaterialSlot'
import { layerStackOf } from '../../utils/terrainAccess'

// The slim toolbar landscape mode floats over the viewport: the mode, the tools as icons, and the two
// settings that change mid-stroke — size and strength. Everything else (curve, shape, tool options, the
// layer stack) lives in the Landscape Tools and Landscape Layers panels; this bar only saves a trip there.

const SIZE_MIN = 0.5, SIZE_MAX = 250
const toSlider = (r: number) => Math.log(r / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)
const fromSlider = (t: number) => +(SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, t)).toFixed(2)

const bar = 'absolute top-2 left-2 right-2 z-20 flex flex-wrap items-center gap-1 rounded-md border border-control'
  + ' bg-surface-raised/95 px-1.5 py-1 text-white shadow-lg select-none w-fit max-w-[calc(100%-1rem)]'

export default function LandscapeToolbar() {
  const brush = useLandscapeBrush()
  const { node, revision, refresh } = useActiveLandscape()

  if (!node) {
    return (
      <div data-cleo-overlay className={`${bar} max-w-[18rem]`} onMouseDown={e => e.stopPropagation()}>
        <Hint>No landscape in this scene. Add one from the Landscape Layers panel or the scene tree’s Add menu.</Hint>
      </div>
    )
  }

  const spec = strengthSpec(activeToolKey(brush))
  return (
    <div data-cleo-overlay className={bar} onMouseDown={e => e.stopPropagation()}>
      {MODES.map(m => (
        <IconButton key={m.id} active={brush.mode === m.id} title={`${m.label}: ${m.hint}`}
          onClick={() => setBrush({ mode: m.id })}><m.icon /></IconButton>
      ))}
      <Divider />
      {brush.mode === 'sculpt' && <Tools tools={SCULPT_TOOLS} value={brush.sculptTool} onChange={(t: SculptTool) => setBrush({ sculptTool: t })} />}
      {brush.mode === 'paint' && <Tools tools={PAINT_TOOLS} value={brush.paintTool} onChange={(t: PaintTool) => setBrush({ paintTool: t })} />}
      {brush.mode === 'foliage' && (
        <button className={`rounded px-2 py-1 text-xs ${brush.foliageErase ? 'bg-danger' : 'bg-control hover:bg-control-hover'}`}
          title='Erase every foliage instance under the brush instead of scattering (Shift inverts too)'
          onClick={() => setBrush({ foliageErase: !brush.foliageErase })}>{brush.foliageErase ? 'Erasing' : 'Scattering'}</button>
      )}
      {brush.mode === 'paint' && <><Divider /><PaintTarget node={node} revision={revision} refresh={refresh} /></>}
      <Divider />
      <Slider className='w-40 my-0' labelClassName='w-8' label='Size' min={0} max={1} step={0.001} value={toSlider(brush.radius)}
        readout={t => `${fromSlider(t)}`} title='Brush radius in metres ( [ and ], Ctrl+wheel )'
        onChange={t => setBrush({ radius: fromSlider(t) })} />
      {brush.mode !== 'foliage' && (
        <Slider className='w-40 my-0' labelClassName='w-8' label={spec.label === 'Strength' ? 'Str.' : spec.label} min={spec.min} max={spec.max} step={spec.step}
          value={activeStrength(brush)} readout={v => v.toFixed(spec.step < 1 ? 2 : 1)}
          title={`${spec.label}: ${spec.hint} (Shift+[ and Shift+])`} onChange={setActiveStrength} />
      )}
    </div>
  )
}

/**
 * Which layer the paint brush writes into, and the material that layer draws — the two things a paint
 * stroke is about. They live in the Layers panel as well; they are repeated here because this is where
 * the painting happens, and a material slot behind a panel tab is a material slot nobody finds.
 */
function PaintTarget({ node, revision, refresh }: { node: LandscapeNode; revision: number; refresh: () => void }) {
  const brush = useLandscapeBrush()
  const { assignLayer, addLayer } = useStackEdit(node, refresh)
  const stack = layerStackOf(node.terrain)
  const layers = stack ? stack.paintLayers : []
  // Same fallback as the Layers panel: the topmost layer when the remembered one is gone.
  const active = layers.find(l => l.id === brush.paintLayerId) ?? layers[layers.length - 1] ?? null

  if (!active) {
    return (
      <span className='flex items-center gap-2' key={revision}>
        <span className='text-[11px] text-muted'>Nothing to paint into yet.</span>
        <AddLayerButton disabled={false} onAdd={addLayer} />
      </span>
    )
  }

  return (
    <span className='flex items-center gap-1' key={revision}>
      <Select className='text-xs w-28' value={active.id} title='The layer this brush paints into'
        onChange={e => setBrush({ paintLayerId: e.target.value })}>
        {[...layers].reverse().map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
      </Select>
      <span className='w-44'>
        <LandscapeMaterialSlot compact materialId={active.materialId} hasEmbedded={!!active.material}
          onAssign={asset => assignLayer(active.id, asset)} />
      </span>
      <AddLayerButton disabled={layers.length >= MAX_PAINT_LAYERS} onAdd={addLayer} />
    </span>
  )
}

function Tools<T extends string>({ tools, value, onChange }: { tools: LandscapeToolInfo<T>[]; value: T; onChange: (t: T) => void }) {
  return <>
    {tools.map(t => (
      <IconButton key={t.id} active={t.id === value} title={`${t.label}${t.hotkey ? ` (${t.hotkey})` : ''}: ${t.hint}`}
        onClick={() => onChange(t.id)}><t.icon /></IconButton>
    ))}
  </>
}

function IconButton({ active, title, onClick, children }: { active: boolean; title: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button title={title} onClick={onClick}
      className={`w-7 h-7 p-1 rounded border transition-colors ${active
        ? 'bg-selected border-white text-white' : 'bg-transparent border-transparent text-muted hover:bg-control-hover hover:text-white'}`}>
      {children}
    </button>
  )
}

const Divider = () => <span className='mx-0.5 h-5 w-px bg-white/15' />
