import { useEffect, useMemo, useRef, useState } from 'react'
import { heightsFromImage, type LandscapeNode } from 'cleo'
import { Modal, ModalHeader, ModalFooter } from '@cleo/app-kit/ui/Modal'
import { Button, DocScope, Hint, NumberInput, Section, SegmentedControl, Select, Toggle } from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { setTerrainHeights } from '../../utils/terrainAccess'
import {
  DEFAULT_ORIENTATION, GROUND, defaultMapping, missingSlotLayers, reapplyMapping, ruleWarnings,
  type CreatorWorldLink, type WorldOrientation,
} from './worldImport'
import { NEW_SLOT, importSlotsOf, useWorldImport } from './useWorldImport'
import type { LoadedWorld } from './worldSources'

// Import a World Creator export into a landscape: the heights, and each world surface onto a paint-only
// slot of the landscape's material. The heightmap half behaves like Import heightmap -- a range, flips
// and a turn, previewed live on the landscape, Cancel restores it exactly. The surfaces are written on
// Import, in one undo step with the heights (see useWorldImport for the commit order).
//
// The world never brings materials: its layers say WHERE sand or rock is, and the landscape material's
// slots say what sand and rock look like. A layer with no slot to land on can get one ("Add missing
// slots"), made paint-only in the landscape material and tinted with the world's colour hint until a
// real material is chosen for it in the landscape-material editor.

export interface WorldImportDialogProps {
  node: LandscapeNode
  world: LoadedWorld
  /** The landscape's previous import of this world: its mapping and orientation are where the dialog starts. */
  previous?: CreatorWorldLink | null
  onClose: () => void
}

/** Select values that are not slot ids. Slot ids are `slot_…`, so these never collide. */
const IGNORE = '__ignore'

/** Linear 0..1 -> an sRGB CSS colour (the manifest's colour hints are linear). */
const srgb = (c: number) => Math.round(255 * Math.pow(Math.min(Math.max(c, 0), 1), 1 / 2.2))
const cssColor = (rgb: readonly number[]) => `rgb(${srgb(rgb[0])}, ${srgb(rgb[1])}, ${srgb(rgb[2])})`
/** For a layer without a colour hint. */
const FALLBACK = [[0.3, 0.3, 0.3], [0.5, 0.4, 0.25], [0.2, 0.35, 0.15], [0.6, 0.6, 0.62]] as const

export default function WorldImportDialog({ node, world, previous, onClose }: WorldImportDialogProps) {
  const { materials, closeTab } = useCleoEngine()
  const { commit, materialTab, slotRoom } = useWorldImport(node)
  const { manifest } = world
  const layers = world.weights ? manifest.layers : []
  // Bumped after the blocking tab is closed (or anything else outside React changes the material).
  const [, setRevision] = useState(0)

  const slots = importSlotsOf(node.terrain.layerStack.base.material, materials)
  const manualSlots = slots.filter(s => s.manual)

  const [range, setRange] = useState({ min: manifest.minHeight, max: manifest.maxHeight })
  const [orientation, setOrientation] = useState<WorldOrientation>(previous?.orientation ?? DEFAULT_ORIENTATION)
  const [matchSize, setMatchSize] = useState(previous?.matchSize ?? true)
  const [live, setLive] = useState(true)
  const [mapping, setMapping] = useState<Record<string, string | null>>(() => {
    const start = previous?.mapping ? reapplyMapping(previous.mapping, layers, slots) : defaultMapping(layers, slots)
    // A remembered slot that is gone, or no longer paint-only, would fold into the Ground anyway: show it
    // as what it now is rather than as a choice the menu cannot display.
    for (const [id, v] of Object.entries(start)) if (v && v !== GROUND && !manualSlots.some(s => s.id === v)) start[id] = null
    return start
  })
  const [resetRules, setResetRules] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The ground as it was when the dialog opened: what Cancel restores and what the undo step records.
  const original = useRef<Float32Array>(node.terrain.heights.slice())
  const applied = useRef(false)

  // Live preview of the heights only, at the landscape's current size (Match world size rebuilds on
  // Import). Debounced so typing a number does not rebuild every chunk per keystroke.
  useEffect(() => {
    if (!live) return
    const t = setTimeout(() => {
      const h = heightsFromImage(world.height, node.terrain.resolution, { ...range, ...orientation })
      if (setTerrainHeights(node.terrain, h)) applied.current = true
    }, 120)
    return () => clearTimeout(t)
  }, [range, orientation, live])

  const restore = () => {
    if (applied.current) setTerrainHeights(node.terrain, original.current)
    applied.current = false
  }

  // Warnings are about the slots that exist: a slot this import adds has a neutral rule and goes on top.
  const existingMapping = Object.fromEntries(Object.entries(mapping).map(([k, v]) => [k, v === NEW_SLOT ? null : v]))
  const warnings = ruleWarnings(layers.filter(l => mapping[l.id] !== NEW_SLOT), slots, existingMapping)
  const ruleIssues = warnings.filter(w => w.kind === 'rule')
  const aboveIssues = warnings.filter(w => w.kind === 'above')

  const adding = layers.filter(l => mapping[l.id] === NEW_SLOT)
  const room = slotRoom() - adding.length
  const missing = missingSlotLayers(layers, mapping, room)
  const tab = materialTab()
  const editsLibrary = adding.length > 0 || (resetRules && ruleIssues.length > 0)
  const blocked = editsLibrary && !!tab
  const sizeDiffers = Math.abs(node.terrain.config.size - manifest.size) > 1e-3

  const preview = useMemo(() => renderPreview(world), [world])

  const cancel = () => { restore(); onClose() }
  const ok = () => {
    if (blocked) return
    restore()
    const err = commit({ world, range, orientation, matchSize, mapping, resetRules })
    if (err) { setError(err); return }
    onClose()
  }

  const setTarget = (layerId: string, value: string) =>
    setMapping(m => ({ ...m, [layerId]: value === IGNORE ? null : value }))
  const addMissing = () => setMapping(m => {
    const next = { ...m }
    for (const l of missing.add) next[l.id] = NEW_SLOT
    return next
  })
  const coverageOf = (i: number) => {
    const c = layers[i].coverage
    if (c !== undefined) return c
    const plane = world.weights!.planes[i]
    let sum = 0
    for (let t = 0; t < plane.length; t++) sum += plane[t]
    return sum / (plane.length * 255)
  }

  const aside = [
    `${manifest.resolution}×${manifest.resolution}`, `${manifest.size} m`,
    layers.length ? `${layers.length} surface${layers.length === 1 ? '' : 's'}` : null,
  ].filter(Boolean).join(' · ')

  // Opened from the Landscape node inspector (scene authoring), documented with the terrain.
  return (
    <DocScope page='editor/terrain' section='import-world'>
      <Modal onClose={cancel} className='w-[620px]'>
        <ModalHeader title='Import world' aside={`${world.name} · ${aside}`} />
        <div className='p-4 space-y-4 max-h-[70vh] overflow-y-auto'>
          <div className='flex gap-4'>
            <img src={preview} alt='' className='w-40 h-40 rounded border border-control object-cover shrink-0'
              style={{ transform: `rotate(${orientation.rotate}deg) scale(${orientation.flipX ? -1 : 1}, ${orientation.flipY ? -1 : 1})` }} />
            <div className='flex-1 space-y-2 text-ui'>
              <div className='flex items-center justify-between'>
                <span title='Height of a black heightmap pixel, terrain-local metres. The world’s own range to start with.'>Lowest (black)</span>
                <NumberInput className='w-24' value={range.min} step={1} onChange={min => setRange(r => ({ ...r, min }))} />
              </div>
              <div className='flex items-center justify-between'>
                <span title='Height of a white heightmap pixel, terrain-local metres'>Highest (white)</span>
                <NumberInput className='w-24' value={range.max} step={1} onChange={max => setRange(r => ({ ...r, max }))} />
              </div>
              <div className='flex items-center justify-between'>
                <span title='Turns the heights and the surfaces together'>Rotate</span>
                <SegmentedControl<number> size='sm'
                  options={[0, 90, 180, 270].map(r => ({ value: r, label: `${r}°` }))}
                  value={orientation.rotate} onChange={r => setOrientation(o => ({ ...o, rotate: r as WorldOrientation['rotate'] }))} />
              </div>
              <div className='flex items-center justify-between'>
                <span>Flip horizontally</span>
                <Toggle checked={orientation.flipX} onChange={flipX => setOrientation(o => ({ ...o, flipX }))} />
              </div>
              <div className='flex items-center justify-between'>
                <span>Flip vertically</span>
                <Toggle checked={orientation.flipY} onChange={flipY => setOrientation(o => ({ ...o, flipY }))} />
              </div>
              <div className='flex items-center justify-between'>
                <span title={`Rebuild the landscape at the world’s ${manifest.size} m on Import, so a metre in the world is a metre here. Not undoable, like Rebuild terrain.`}>Match world size</span>
                <Toggle checked={matchSize} onChange={setMatchSize} />
              </div>
              <div className='flex items-center justify-between'>
                <span title='Apply the heights to the landscape as you change the settings; the surfaces are written on Import'>Live preview</span>
                <Toggle checked={live} onChange={v => { setLive(v); if (!v) restore() }} />
              </div>
              {matchSize && sizeDiffers && (
                <Hint>The landscape is {node.terrain.config.size} m across; Import rebuilds it at {manifest.size} m.</Hint>
              )}
              {!matchSize && sizeDiffers && (
                <Hint>The world is {manifest.size} m across and is stretched over this {node.terrain.config.size} m landscape.</Hint>
              )}
            </div>
          </div>

          {world.weightsError && <Hint>{world.weightsError}. Only the heights import.</Hint>}
          {manifest.layers.length === 0 && <Hint>This world has no surfaces (an export from before surfaces existed): only the heights import.</Hint>}

          {layers.length > 0 && (
            <Section title='Surfaces' right={
              <Button size='sm' variant='ghost' disabled={!missing.add.length} onClick={addMissing}
                title='Give every ignored surface a paint-only slot of its own in the landscape material'>Add missing slots</Button>
            }>
              <div className='space-y-1 text-ui'>
                {/* Topmost first with the base last, as the Layers panel and the Creator list them. */}
                {[...layers.keys()].reverse().map(i => {
                  const l = layers[i]
                  const value = mapping[l.id]
                  const color = l.color ?? FALLBACK[i % FALLBACK.length]
                  return (
                    <div key={l.id} className='flex items-center gap-2'>
                      <span className='block w-4 h-4 shrink-0 rounded-sm border border-control' style={{ background: cssColor(color) }}
                        title={l.kind ? `The world drew it as ${l.kind}` : undefined} />
                      <span className='flex-1 min-w-0 truncate'>{l.name}</span>
                      <span className='w-12 text-right text-muted' title='How much of the world it covers'>{formatShare(coverageOf(i))}</span>
                      <Select className='w-44 px-1 py-[2px]' value={value === null || value === undefined ? IGNORE : value}
                        onChange={e => setTarget(l.id, e.target.value)}>
                        {manualSlots.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                        <option value={GROUND}>Ground</option>
                        {(value === NEW_SLOT || room > 0) && <option value={NEW_SLOT}>New paint slot “{l.name}”</option>}
                        <option value={IGNORE}>Ignore (shows the Ground)</option>
                      </Select>
                    </div>
                  )
                })}
                {!node.terrain.layerStack.base.material && (
                  <Hint>This landscape has no landscape material yet. Mapping a surface to a new paint slot creates one with those slots.</Hint>
                )}
                {node.terrain.layerStack.base.material && manualSlots.length === 0 && (
                  <Hint>The landscape material has no paint-only slots. <b>Add missing slots</b> adds one per surface; choose their materials in the landscape-material editor afterwards.</Hint>
                )}
                {missing.overflow.length > 0 && (
                  <Hint>No room for {missing.overflow.length} more slot(s): a landscape material holds 15 slots and a landscape 15 paint channels.</Hint>
                )}
                {adding.length > 0 && (
                  <Hint>{adding.length} paint-only slot(s) will be added to the landscape material, tinted with the world’s colours until you choose their materials.</Hint>
                )}
                {aboveIssues.map(w => (
                  <Hint key={w.slotId}>“{w.name}” blends in by its own rule above {w.detail.join(', ')}, so it will cover them where its rule allows. Make it paint-only in the landscape material if the world should decide.</Hint>
                ))}
                {ruleIssues.length > 0 && (
                  <div className='flex items-start gap-2'>
                    <Hint className='flex-1'>
                      {ruleIssues.map(w => `“${w.name}” (${w.detail.join(', ')})`).join('; ')} {ruleIssues.length === 1 ? 'has a rule' : 'have rules'} that
                      {' '}reshape{ruleIssues.length === 1 ? 's' : ''} the imported mask.
                    </Hint>
                    <Button size='sm' variant={resetRules ? 'default' : 'ghost'} active={resetRules} onClick={() => setResetRules(v => !v)}
                      title='On Import, switch off the elevation and slope tests, noise and height blend of the mapped slots and set their opacity to full. Their numbers are kept.'>
                      Reset rules on mapped slots
                    </Button>
                  </div>
                )}
                {blocked && tab && (
                  <div className='flex items-center gap-2 rounded border border-warning/50 bg-warning/10 px-2 py-1'>
                    <span className='flex-1'>“{tab.title}” is open in a tab. Close it first: saving it afterwards would remove what this import adds.</span>
                    <Button size='sm' onClick={() => { void Promise.resolve(closeTab(tab.id)).then(() => setRevision(r => r + 1)) }}>Close tab</Button>
                  </div>
                )}
              </div>
            </Section>
          )}
          {error && <Hint className='text-danger'>{error}</Hint>}
        </div>
        <ModalFooter>
          <Button variant='ghost' onClick={cancel}>Cancel</Button>
          <Button variant='primary' disabled={blocked} onClick={ok}>Import</Button>
        </ModalFooter>
      </Modal>
    </DocScope>
  )
}

function formatShare(share: number): string {
  const pct = share * 100
  return pct > 0 && pct < 1 ? '<1%' : `${Math.round(pct)}%`
}

/**
 * A small picture of the world for the dialog: each texel's surfaces mixed by weight in their colour
 * hints, shaded by height so the relief reads. The heightmap alone when there are no surfaces.
 */
function renderPreview(world: LoadedWorld): string {
  const size = 160
  const canvas = document.createElement('canvas')
  canvas.width = size; canvas.height = size
  const ctx = canvas.getContext('2d')
  if (!ctx) return ''
  const out = ctx.createImageData(size, size)
  const { height } = world
  const weights = world.weights
  const colors = world.manifest.layers.map((l, i) => l.color ?? FALLBACK[i % FALLBACK.length])
  for (let y = 0; y < size; y++) {
    const hy = Math.min(height.height - 1, Math.floor((y / size) * height.height))
    for (let x = 0; x < size; x++) {
      const hx = Math.min(height.width - 1, Math.floor((x / size) * height.width))
      const h = height.data[hy * height.width + hx]
      const o = (y * size + x) * 4
      if (!weights) {
        out.data[o] = out.data[o + 1] = out.data[o + 2] = Math.round(h * 255)
      } else {
        const n = weights.size
        const t = Math.min(n - 1, Math.floor((y / size) * n)) * n + Math.min(n - 1, Math.floor((x / size) * n))
        let r = 0, g = 0, b = 0
        weights.planes.forEach((p, i) => { const w = p[t] / 255; r += w * colors[i][0]; g += w * colors[i][1]; b += w * colors[i][2] })
        const shade = 0.55 + 0.45 * h
        out.data[o] = srgb(r * shade); out.data[o + 1] = srgb(g * shade); out.data[o + 2] = srgb(b * shade)
      }
      out.data[o + 3] = 255
    }
  }
  ctx.putImageData(out, 0, 0)
  return canvas.toDataURL()
}
