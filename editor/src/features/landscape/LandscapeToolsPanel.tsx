import React, { useState } from 'react'
import type { SculptTool, FalloffCurve, BrushShape } from 'cleo'
import { Button, Hint, NumberInput, SegmentedControl, Select, Slider, Toggle } from '../../components/ui'
import Collapsable from '../../components/Collapsable'
import {
  useLandscapeBrush, setBrush, activeStrength, setActiveStrength, strengthSpec, activeToolKey,
  type LandscapeMode, type PaintTool, type FlattenMode,
} from './landscapeBrushStore'
import { MODES, SCULPT_TOOLS, PAINT_TOOLS, type LandscapeToolInfo } from './landscapeTools'
import { useStamp, setStamp, loadStampFile } from './stampStore'
import { Logger } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useActiveLandscape } from './useActiveLandscape'
import { confirmDialog } from '../dialogs/dialogStore'

// The landscape tools as a panel: the mode, the tool, the brush and whatever the tool itself needs.
// Everything writes the brush store, which the viewport brush reads on every dab.

const row = 'flex items-center justify-between gap-2'
const label = 'text-xs text-gray-300'

/** Brush size runs 0.5..250 m; the slider is logarithmic so both ends are usable. */
const SIZE_MIN = 0.5, SIZE_MAX = 250
const toSlider = (r: number) => Math.log(r / SIZE_MIN) / Math.log(SIZE_MAX / SIZE_MIN)
const fromSlider = (t: number) => +(SIZE_MIN * Math.pow(SIZE_MAX / SIZE_MIN, t)).toFixed(2)

export default function LandscapeToolsPanel() {
  const brush = useLandscapeBrush()
  const stamp = useStamp()
  const key = activeToolKey(brush)
  const spec = strengthSpec(key)
  const strength = activeStrength(brush)

  return (
    <div className='flex flex-col text-white p-2 gap-2'>
      <SegmentedControl<LandscapeMode> grow
        options={MODES.map(m => ({
          value: m.id, title: m.hint,
          label: <span className='flex items-center gap-1'><span className='w-4 h-4'><m.icon /></span>{m.label}</span>,
        }))}
        value={brush.mode} onChange={mode => setBrush({ mode })} />

      {brush.mode === 'sculpt' && (
        <ToolGrid tools={SCULPT_TOOLS} value={brush.sculptTool} onChange={(t: SculptTool) => setBrush({ sculptTool: t })} />
      )}
      {brush.mode === 'paint' && (
        <ToolGrid tools={PAINT_TOOLS} value={brush.paintTool} onChange={(t: PaintTool) => setBrush({ paintTool: t })} />
      )}
      {brush.mode === 'foliage' && (
        <SegmentedControl<'scatter' | 'erase'> grow
          options={[
            { value: 'scatter', label: 'Scatter', title: "Place the foliage each layer's material defines, where that layer dominates" },
            { value: 'erase', label: 'Erase', title: 'Remove every foliage instance under the brush' },
          ]}
          value={brush.foliageErase ? 'erase' : 'scatter'} onChange={v => setBrush({ foliageErase: v === 'erase' })} />
      )}
      {brush.mode === 'foliage' && <GenerateFoliage />}

      <Collapsable title='Brush' persistKey='landscape.brush' defaultOpen>
        <div className='p-1 space-y-1'>
          <Slider label='Size' min={0} max={1} step={0.001} value={toSlider(brush.radius)}
            readout={t => `${fromSlider(t)} m`} title='Brush radius in metres ( [ and ] )'
            onChange={t => setBrush({ radius: fromSlider(t) })} />
          <Slider label={spec.label} min={spec.min} max={spec.max} step={spec.step} value={strength}
            readout={v => v.toFixed(spec.step < 1 ? 2 : 1)} title={`${spec.hint} (Shift+[ and Shift+])`}
            onChange={setActiveStrength} />
          <Slider label='Falloff' min={0} max={1} step={0.05} value={brush.falloff}
            title='0 = a hard edge, 1 = feathered all the way from the centre'
            onChange={v => setBrush({ falloff: v })} />
          <div className={row}>
            <span className={label}>Curve</span>
            <Select className='text-xs w-28' value={brush.curve} onChange={e => setBrush({ curve: e.target.value as FalloffCurve })}>
              <option value='soft'>Soft</option>
              <option value='smooth'>Smooth</option>
              <option value='linear'>Linear</option>
              <option value='sphere'>Sphere</option>
              <option value='tip'>Tip</option>
            </Select>
          </div>
          <div className={row}>
            <span className={label}>Shape</span>
            <SegmentedControl<BrushShape> size='sm'
              options={[{ value: 'circle', label: 'Circle' }, { value: 'square', label: 'Square' }]}
              value={brush.shape} onChange={shape => setBrush({ shape })} />
          </div>
          {(brush.shape === 'square' || (brush.mode === 'sculpt' && brush.sculptTool === 'stamp')) && (
            <Slider label='Rotation' min={0} max={360} step={1} value={brush.rotation}
              readout={v => `${Math.round(v)}°`} onChange={v => setBrush({ rotation: v })} />
          )}
          <div className={row}>
            <span className={label} title='Keep applying while the mouse is held still, not only while it moves'>Hold to apply</span>
            <Toggle checked={brush.continuous} onChange={continuous => setBrush({ continuous })} />
          </div>
        </div>
      </Collapsable>

      <ToolOptions />
      {brush.mode === 'sculpt' && brush.sculptTool === 'stamp' && (
        <div className='space-y-1'>
          <div className={row}>
            <span className={label}>Stamp</span>
            <label className='bg-control hover:bg-control-hover rounded px-2 py-1 text-xs cursor-pointer'>
              {stamp ? stamp.name : 'Choose image…'}
              <input type='file' className='hidden' accept='.png,.jpg,.jpeg,.raw,.r16'
                onChange={async e => {
                  const file = e.target.files?.[0]
                  e.target.value = ''
                  if (!file) return
                  try { setStamp(await loadStampFile(file)) }
                  catch (err) { Logger.error(`Could not load stamp "${file.name}": ${err instanceof Error ? err.message : err}`, 'Editor') }
                }} />
            </label>
          </div>
          {!stamp && <Hint>A grayscale image: white raises, black leaves the ground alone.</Hint>}
        </div>
      )}

      <Collapsable title='Shortcuts' persistKey='landscape.shortcuts'>
        <div className='p-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]'>
          {[
            ['Q / W / E', 'Sculpt / Paint / Foliage'],
            ['1 … 0', 'Pick a tool'],
            ['[ and ]', 'Brush size'],
            ['Shift + [ and ]', 'Strength'],
            ['Ctrl + wheel', 'Brush size'],
            ['Shift + drag', 'Invert: lower, or erase'],
            ['Ctrl + drag', 'Smooth'],
            ['Ctrl + click', 'Flatten: pick the height'],
            ['Esc', 'Cancel a ramp'],
          ].map(([k, v]) => (
            <React.Fragment key={k}><span className='text-muted whitespace-nowrap'>{k}</span><span>{v}</span></React.Fragment>
          ))}
        </div>
      </Collapsable>
    </div>
  )
}

function ToolGrid<T extends string>({ tools, value, onChange }: { tools: LandscapeToolInfo<T>[]; value: T; onChange: (t: T) => void }) {
  return (
    <div className='grid grid-cols-4 gap-1'>
      {tools.map(t => (
        <button key={t.id} title={`${t.label}${t.hotkey ? ` (${t.hotkey})` : ''}: ${t.hint}`}
          className={`relative flex flex-col items-center gap-0.5 rounded border px-1 py-1.5 text-[10px] transition-colors ${
            t.id === value ? 'bg-selected border-white text-white' : 'bg-control border-control text-muted hover:bg-control-hover hover:text-white'}`}
          onClick={() => onChange(t.id)}>
          <span className='w-6 h-6'><t.icon /></span>
          <span className='truncate max-w-full'>{t.label}</span>
          {t.hotkey && <span className='absolute top-0.5 right-1 text-[9px] opacity-60'>{t.hotkey}</span>}
        </button>
      ))}
    </div>
  )
}

/**
 * Scatter every layer's foliage across the whole landscape at once. Replaces what is there, so it asks
 * first whenever there is work to lose.
 */
function GenerateFoliage() {
  const { eventEmitter } = useCleoEngine()
  const { node } = useActiveLandscape()
  /** Outcome of the last run, shown under the button. */
  const [status, setStatus] = useState('')

  const generate = async () => {
    if (!node) return
    const existing = node.terrain.foliage.reduce((n, f) => n + f.count, 0)
    if (existing > 0 && !(await confirmDialog({
      title: 'Replace the existing foliage?',
      message: `${existing.toLocaleString()} scattered instances across this landscape will be replaced.`,
      confirmLabel: 'Regenerate',
      tone: 'warning',
    }))) return
    // Read again after the await: a rebuild in the meantime swaps the terrain.
    const result = node.terrain.generateFoliageEverywhere()
    if (result.reason === 'no-rules')
      setStatus('No foliage placed: no landscape material on this landscape defines any. Add foliage in a Landscape Material tab, then use that material as the base or a paint layer.')
    else if (result.reason === 'no-coverage')
      setStatus('No foliage placed: no ground is dominated by a layer whose material includes foliage (or every candidate point was excluded).')
    else
      setStatus(`Placed ${result.placed.toLocaleString()} instances across ${result.layers} layer(s).` +
        (result.reason === 'clipped' ? ' Hit the 200,000-instance ceiling — lower the density.' : ''))
    eventEmitter.emit('SCENE_CHANGED')
    eventEmitter.emit('TERRAIN_EDITED', node.id)
  }

  return (
    <div className='space-y-1'>
      <Button className='w-full' variant='success' size='sm' disabled={!node} onClick={() => { void generate() }}>Generate foliage everywhere</Button>
      {status && <Hint>{status}</Hint>}
    </div>
  )
}

/** Whatever the active tool needs beyond the brush. */
function ToolOptions() {
  const b = useLandscapeBrush()
  if (b.mode === 'paint') {
    return b.paintTool === 'paint' ? (
      <div className='space-y-1'>
        <Slider label='Target' min={0.05} max={1} step={0.05} value={b.targetOpacity}
          readout={v => `${Math.round(v * 100)}%`} title='The opacity painting moves the layer toward — paint a road at 60% and it stops there'
          onChange={v => setBrush({ targetOpacity: v })} />
        <Hint>Paints the active layer in the Layers panel. Hold Shift to erase.</Hint>
      </div>
    ) : b.paintTool === 'clearToBase' ? <Hint>Erases every paint layer under the brush, back to the base material.</Hint> : null
  }
  if (b.mode !== 'sculpt') return null

  switch (b.sculptTool) {
    case 'flatten':
      return (
        <div className='space-y-1'>
          <SegmentedControl<FlattenMode> size='sm' grow
            options={[
              { value: 'both', label: 'Both', title: 'Raise hollows and lower bumps' },
              { value: 'raise', label: 'Fill only', title: 'Only raise ground below the target' },
              { value: 'lower', label: 'Cut only', title: 'Only lower ground above the target' },
            ]}
            value={b.flattenMode} onChange={flattenMode => setBrush({ flattenMode })} />
          <Hint>Levels to the height where the stroke starts. Ctrl+click picks a height to level to instead.</Hint>
        </div>
      )
    case 'setHeight':
      return (
        <div className={row}>
          <span className={label} title='Terrain-local metres. Ctrl+click the ground to pick one.'>Height (m)</span>
          <NumberInput className='w-20' value={b.setHeight} step={0.5} onChange={setHeight => setBrush({ setHeight })} />
        </div>
      )
    case 'ramp':
      return <Hint>Press where the ramp starts and release where it ends. The brush size is its half-width; Falloff softens its sides.</Hint>
    case 'noise':
      return (
        <div className='space-y-1'>
          <Slider label='Scale' min={0.5} max={200} step={0.5} value={b.noiseScale} readout={v => `${v} m`}
            title='Size of the noise features in metres' onChange={noiseScale => setBrush({ noiseScale })} />
          <div className={row}>
            <span className={label}>Seed</span>
            <span className='flex items-center gap-1'>
              <NumberInput className='w-16' value={b.noiseSeed} step={1} onChange={noiseSeed => setBrush({ noiseSeed })} />
              <Button size='sm' variant='ghost' title='New seed' onClick={() => setBrush({ noiseSeed: Math.floor(Math.random() * 1000) })}>🎲</Button>
            </span>
          </div>
        </div>
      )
    case 'terrace':
      return (
        <div className='space-y-1'>
          <Slider label='Step' min={0.25} max={50} step={0.25} value={b.terraceStep} readout={v => `${v} m`}
            title='Height of each step' onChange={terraceStep => setBrush({ terraceStep })} />
          <Slider label='Sharpness' min={0} max={1} step={0.05} value={b.terraceSharpness}
            title='0 leaves the slope alone, 1 cuts flat treads and steep risers' onChange={terraceSharpness => setBrush({ terraceSharpness })} />
        </div>
      )
    case 'erode':
      return (
        <div className='space-y-1'>
          <Slider label='Talus' min={5} max={80} step={1} value={b.talusDegrees} readout={v => `${Math.round(v)}°`}
            title='The steepest slope loose material rests at; anything steeper slumps' onChange={talusDegrees => setBrush({ talusDegrees })} />
          <Slider label='Passes' min={1} max={20} step={1} value={b.erosionIterations} readout={v => `${v}`}
            onChange={erosionIterations => setBrush({ erosionIterations })} />
        </div>
      )
    case 'hydro':
      return (
        <div className='space-y-1'>
          <Slider label='Passes' min={1} max={10} step={1} value={b.erosionIterations} readout={v => `${v}`}
            title='Rain per dab' onChange={erosionIterations => setBrush({ erosionIterations })} />
          <Hint>Works best in short strokes over steep ground.</Hint>
        </div>
      )
    default:
      return null
  }
}
