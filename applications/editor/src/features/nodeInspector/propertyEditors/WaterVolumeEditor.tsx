import React, { useEffect, useRef, useState } from 'react'
import {
  ModelNode, WaterVolumeNode, WATER_VOLUME_PRESETS, WATER_BODY_TYPES, normaliseWaterPoint, minWaterPoints, carveWater,
  WaterMaterial, WATER_LOOK_PRESETS, DEFAULT_WATER_LOOK, encodeWaterBake, decodeWaterBake,
  newWaterBakeId, GiBakeRegistry, Logger, prepareGroupBake, waterBakeGroup, waterGroupReach, waterGroupSignature, forgetWaterBakeContext, bakeable,
  type LandscapeNode, type WaterLook, type WaterLookPreset, type WaterBakeReport,
  type WaterVolumePreset, type WaterBody, type WaterBodyType, type WaterPoint,
} from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import {
  Button, Hint, NumberInput, PresetMenu, PropertyRow, PropertyTable, Section, SegmentedControl, Select,
  Slider, Toggle, VectorInput, DocScope, ColorInput, cn,
} from '@cleo/app-kit/ui'
import NodeRefInput from '../NodeRefInput'
import { useCleoEngine } from '../../EngineContext'
import { useHistory } from '../../HistoryContext'
import MaterialPicker, { liveMaterial } from '../../terrainMaterials/MaterialPicker'
import { buildMaterialAsset } from '../../../utils/materials'
import { saveGiBake } from '../../../utils/giBakeStore'
import { WaterVolumeIcon } from '../sectionIcons'
import { runWaterBake } from '../../../workers/waterBakeClient'
import {
  WATER_SHAPES_EDITED, setWaterShapeSelection, useWaterShapeSelection,
} from '../../gizmo/waterSelection'
import { onProjectClose } from '../../../utils/projectLifecycle'
import { DeclaredSection } from '../../properties/DeclaredSections'

// The Water inspector. A Water node is ONE body of water — a river, a lake, an ocean or a pool — that buoys
// what floats in it, carries it downstream and draws its surface. A river joins other Water nodes by naming
// them (Flows from, Flows into), and meets their surface. The body is edited here and with its handles in
// the viewport.

// Glyphs in the inspector's section-icon style (15 px, stroke currentColor).
const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
)
export const WATER_BODY_ICONS: Record<WaterBodyType, React.ReactNode> = {
  river: <S><path d='M5 3c4 3-2 6 2 9s-2 6 2 9' /><path d='M15 3c4 3-2 6 2 9s-2 6 2 9' /></S>,
  lake: <S><path d='M4 13c0-4 4-7 8-7 5 0 8 3 8 6 0 4-4 6-8 6s-8-1-8-5Z' /><path d='M8 12c1.3-.8 2.7-.8 4 0s2.7.8 4 0' /></S>,
  ocean: <S><path d='M2 9c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0' /><path d='M2 15c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0' /></S>,
  pool: <S><path d='M12 3l8 4.5v9L12 21l-8-4.5v-9Z' /><path d='M4 7.5l8 4.5 8-4.5M12 12v9' /></S>,
}
const TYPE_LABEL: Record<WaterBodyType, string> = { river: 'River', lake: 'Lake', ocean: 'Ocean', pool: 'Pool' }
const TYPE_HINT: Record<WaterBodyType, string> = {
  river: 'A river: a spline with a width, depth and flow speed at each point. Flows from and Flows into join it to other water.',
  lake: 'A lake: a level surface at the node\u2019s height inside a smooth outline.',
  ocean: 'An ocean: a level surface at the node\u2019s height reaching the horizon, with waves from the wind.',
  pool: 'A pool: a level block of water centred on the node (a tank, a fountain, a flooded room).',
}
const PlusIcon = () => <S><path d='M12 5v14M5 12h14' /></S>

/** One control point of a river (width, depth, flow) or a lake (position only). */
const PointRow = ({ point, index, river, selected, onChange, onRemove, onSelect, canRemove }: {
  point: WaterPoint; index: number; river: boolean; selected: boolean; canRemove: boolean;
  onChange: (p: WaterPoint) => void; onRemove: () => void; onSelect: () => void;
}) => (
  <div className={cn('rounded border px-1.5 py-1 mb-1', selected ? 'border-highlight bg-highlight/10' : 'border-border-subtle')}
    onClick={onSelect}>
    <div className='flex items-center gap-1 mb-1'>
      <span className='text-ui-xs text-muted flex-1'>Point {index + 1}</span>
      <Button variant='remove' size='icon' title='Remove this point' disabled={!canRemove}
        onClick={(e) => { e.stopPropagation(); onRemove() }}>✕</Button>
    </div>
    <PropertyTable columns={['32%', '68%']}>
      <PropertyRow label='Position' hint={river ? 'Where the surface runs along the centre line, in the node\u2019s units.' : 'A point of the outline, in the node\u2019s units (the lake\u2019s level is the node\u2019s height).'}>
        <VectorInput value={point.pos} step={0.25} onChange={pos => onChange({ ...point, pos: pos as [number, number, number] })} />
      </PropertyRow>
      {river && <>
        <PropertyRow label='Width' hint='Metres, bank to bank.'>
          <NumberInput value={point.width} min={0.1} step={0.25} onChange={width => onChange({ ...point, width })} />
        </PropertyRow>
        <PropertyRow label='Depth' hint='Metres, surface to bed on the centre line.'>
          <NumberInput value={point.depth} min={0.05} step={0.1} onChange={depth => onChange({ ...point, depth })} />
        </PropertyRow>
        <PropertyRow label='Flow speed' hint='Metres per second, downstream: how fast it carries what floats.'>
          <NumberInput value={point.flowSpeed} min={0} step={0.1} onChange={flowSpeed => onChange({ ...point, flowSpeed })} />
        </PropertyRow>
      </>}
    </PropertyTable>
  </div>
)

/** Where a point added to the end of a river or lake goes: past the last one, along the last segment. */
function nextPoint(body: WaterBody): WaterPoint {
  const pts = body.points
  const last = pts[pts.length - 1]
  if (!last) return normaliseWaterPoint({})
  if (body.type === 'lake') {
    // Between the last point and the first: the outline closes there.
    const first = pts[0]
    return normaliseWaterPoint({ ...last, pos: [(last.pos[0] + first.pos[0]) / 2, last.pos[1], (last.pos[2] + first.pos[2]) / 2] })
  }
  const prev = pts[pts.length - 2] ?? { pos: [last.pos[0], last.pos[1], last.pos[2] - 10] }
  const d = [last.pos[0] - prev.pos[0], last.pos[1] - prev.pos[1], last.pos[2] - prev.pos[2]]
  return normaliseWaterPoint({ ...last, pos: [last.pos[0] + d[0], last.pos[1] + d[1], last.pos[2] + d[2]] })
}

/**
 * Digs the river's or lake's bed into every landscape under it, as one undo step: the touched rectangle of
 * each terrain, before and after.
 */
function useCarve(node: WaterVolumeNode) {
  const { eventEmitter, editorScene } = useCleoEngine()
  const { push } = useHistory()
  return () => {
    const resolved = node.resolved()
    const edits: { id: string; region: { c0: number; r0: number; c1: number; r1: number }; before: Float32Array; after: Float32Array }[] = []
    for (const land of (editorScene?.landscapes ?? []) as Set<LandscapeNode>) {
      const terrain = land.terrain
      if (!terrain) continue
      const original = terrain.heights.slice()
      const region = carveWater({ heights: terrain.heights, resolution: terrain.resolution, size: terrain.size, origin: terrain.origin },
        node.waterBody, resolved)
      if (!region) continue
      const after = terrain.readHeights(region)
      // The carve wrote straight into the grid: the before copy comes from the saved original, and
      // writing the after copy back is what refreshes the chunks and the collider.
      const R = terrain.resolution, w = region.c1 - region.c0 + 1
      const before = new Float32Array(w * (region.r1 - region.r0 + 1))
      for (let r = region.r0; r <= region.r1; r++) before.set(original.subarray(r * R + region.c0, r * R + region.c1 + 1), (r - region.r0) * w)
      terrain.writeHeights(region, after)
      edits.push({ id: land.id, region, before, after })
    }
    if (!edits.length) return false
    const put = (side: 'before' | 'after') => {
      for (const e of edits) {
        const n = editorScene?.getNodeById(e.id) as LandscapeNode | null
        if (n?.terrain) { n.terrain.writeHeights(e.region, e[side]); eventEmitter.emit('TERRAIN_EDITED', e.id) }
      }
      eventEmitter.emit('SCENE_CHANGED')
    }
    put('after')
    push({ label: 'Carve water into landscape', undo: () => put('before'), redo: () => put('after') })
    return true
  }
}

/** The body of water: its type, that type's fields, and a river's or lake's points. */
function WaterBodyCard({ node, changed }: { node: WaterVolumeNode; changed: () => void }) {
  const { eventEmitter, editorScene } = useCleoEngine()
  const carve = useCarve(node)
  const [carveMiss, setCarveMiss] = useState(false)
  const selection = useWaterShapeSelection(eventEmitter)
  const b = node.waterBody
  const write = (patch: Partial<WaterBody>) => { node.waterBody = { ...b, ...patch }; changed() }
  const selectedPoint = selection && selection.nodeId === node.id ? selection.point : -1
  const selectPoint = (point: number) => setWaterShapeSelection(eventEmitter, { nodeId: node.id, point })
  const others = ([...((editorScene?.waterVolumes ?? []) as Set<WaterVolumeNode>)]).filter(n => n !== node)
  const hasPoints = b.type === 'river' || b.type === 'lake'
  const minPoints = minWaterPoints(b.type)
  const setPoint = (i: number, p: WaterPoint) => write({ points: b.points.map((q, k) => (k === i ? normaliseWaterPoint(p) : q)) })
  const removePoint = (i: number) => write({ points: b.points.filter((_, k) => k !== i) })
  const joined = (id: string | null) => (id && !others.some(o => o.id === id) ? `${id} (missing)` : null)

  return (
    <Section title='Water body'>
      <SegmentedControl joined size='sm' value={b.type} className='mb-2'
        options={WATER_BODY_TYPES.map(t => ({ value: t, label: WATER_BODY_ICONS[t], title: TYPE_HINT[t], doc: `editor/water#water-body::${TYPE_LABEL[t]}` }))}
        onChange={t => { node.waterType = t; setWaterShapeSelection(eventEmitter, null); changed() }} />
      <PropertyTable columns={['40%', '60%']}>
        {b.type === 'pool' &&
          <PropertyRow label='Size' hint='Width, depth, length in metres, before the node scale. The node is its centre; the top face is the surface.'>
            <VectorInput value={b.size} min={0.01} step={0.25} onChange={size => write({ size: size as [number, number, number] })} />
          </PropertyRow>}
        {(b.type === 'lake' || b.type === 'ocean') &&
          <PropertyRow label='Depth' hint='Metres, surface to floor. The landscape, where higher, is the real floor. The node\u2019s height is the surface.'>
            <NumberInput value={b.depth} min={0.05} step={0.5} onChange={depth => write({ depth })} />
          </PropertyRow>}
        {b.type === 'ocean' &&
          <PropertyRow label='Extent' hint='Metres the ocean reaches each way from the node. 0: endless, to the horizon.'>
            <NumberInput value={b.extent} min={0} step={50} onChange={extent => write({ extent })} />
          </PropertyRow>}
        {b.type === 'river' && <>
          <PropertyRow label='Flows from' hint='The Water node the river starts in (a lake it drains, a river it branches from): its first point takes that water\u2019s surface, so the two meet.'>
            <Select value={b.connect.start ?? ''} onChange={e => write({ connect: { ...b.connect, start: e.target.value || null } })}>
              <option value=''>Nothing (a spring)</option>
              {joined(b.connect.start) && <option value={b.connect.start!}>{joined(b.connect.start)}</option>}
              {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Flows into' hint='The Water node the river ends in (a lake, the ocean, another river): its last point takes that water\u2019s surface, and runs into it.'>
            <Select value={b.connect.end ?? ''} onChange={e => write({ connect: { ...b.connect, end: e.target.value || null } })}>
              <option value=''>Nothing</option>
              {joined(b.connect.end) && <option value={b.connect.end!}>{joined(b.connect.end)}</option>}
              {others.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
            </Select>
          </PropertyRow>
        </>}
        {hasPoints && <>
          <PropertyRow label='Carve landscape' hint='Dig the bed into the landscape when Carve is pressed: the bed inside the water, a sloped bank outside it. Only ever lowers the ground.'>
            <Toggle checked={b.carve.enabled} onChange={enabled => write({ carve: { ...b.carve, enabled } })} />
          </PropertyRow>
          {b.carve.enabled && <>
            <PropertyRow label='Bank width' hint='Metres the bank slopes over, from the water\u2019s edge back up to the ground.'>
              <NumberInput value={b.carve.bankWidth} min={0} step={0.5} onChange={bankWidth => write({ carve: { ...b.carve, bankWidth } })} />
            </PropertyRow>
            <PropertyRow label='Dig deeper' hint='Metres dug below the water\u2019s own depth.'>
              <NumberInput value={b.carve.extraDepth} min={0} step={0.1} onChange={extraDepth => write({ carve: { ...b.carve, extraDepth } })} />
            </PropertyRow>
          </>}
        </>}
      </PropertyTable>
      {hasPoints && b.carve.enabled && <div className='mt-2'>
        <Button size='sm' title='Dig the bed into the landscape under the water. One undo step.'
          onClick={() => setCarveMiss(!carve())}>Carve landscape</Button>
        {carveMiss && <Hint className='mt-1'>Nothing to carve: no landscape is under the water, or it is already lower.</Hint>}
      </div>}
      {hasPoints && <div className='mt-2'>
        <div className='flex items-center mb-1'>
          <span className='text-ui-xs text-muted flex-1'>{b.type === 'river' ? 'Points, upstream to downstream' : 'Outline points'}</span>
          <Button variant='ghost' size='icon' title='Add a point at the end'
            onClick={() => write({ points: [...b.points, nextPoint(b)] })}><PlusIcon /></Button>
        </div>
        {b.points.map((p, i) => (
          <PointRow key={i} point={p} index={i} river={b.type === 'river'} selected={selectedPoint === i}
            canRemove={b.points.length > minPoints}
            onSelect={() => selectPoint(i)} onChange={q => setPoint(i, q)} onRemove={() => removePoint(i)} />
        ))}
      </div>}
    </Section>
  )
}

/** Linear RGB as the colour input's sRGB hex (it hands back sRGB 0..1, decoded on the way in). */
const toHex = (c: readonly number[]) => '#' + c.slice(0, 3).map(v => Math.round(Math.pow(Math.min(1, Math.max(0, v)), 1 / 2.2) * 255).toString(16).padStart(2, '0')).join('')

/**
 * How the surface looks: the Water material (a library asset, embedded as a copy) and its parameters,
 * edited here. Editing a linked material updates the library asset, and with it every Water node that
 * draws with it.
 */
function WaterSurface({ node, changed }: { node: WaterVolumeNode; changed: () => void }) {
  const { materials, updateMaterial, propagateMaterialAsset } = useCleoEngine()
  const material = node.waterMaterial
  const look: WaterLook = material?.look ?? DEFAULT_WATER_LOOK
  const linked = node.waterMaterialId ? materials.find(m => m.id === node.waterMaterialId) : undefined
  const setLook = (patch: Partial<WaterLook>) => {
    const next = new WaterMaterial({ ...look, ...patch })
    node.waterMaterial = next
    if (linked) {
      const asset = buildMaterialAsset(next, linked.name, linked.thumbnail ?? '', linked.id)
      updateMaterial(linked.id, asset)
      propagateMaterialAsset(asset)
    }
    changed()
  }
  const applyPreset = (p: WaterLookPreset) => setLook({ ...DEFAULT_WATER_LOOK, ...p.options })
  const color = (key: keyof WaterLook, label: string, hint: string) => (
    <PropertyRow label={label} hint={hint} divider>
      <ColorInput color={toHex(look[key] as number[])} onChange={v => setLook({ [key]: v.map(x => Math.pow(x, 2.2)) } as Partial<WaterLook>)} />
    </PropertyRow>
  )
  const slider = (key: keyof WaterLook, label: string, hint: string, min: number, max: number, step: number) => (
    <PropertyRow label={label} hint={hint} divider>
      <Slider value={look[key] as number} min={min} max={max} step={step} readout onChange={v => setLook({ [key]: v } as Partial<WaterLook>)} />
    </PropertyRow>
  )
  return (
    <Section title='Surface'>
      <div className='flex items-start gap-1 mb-2'>
        <div className='flex-1 min-w-0'>
          <MaterialPicker value={node.waterMaterialId} placeholder={material ? '(unlinked water)' : '(default water)'}
            newName={() => 'Water'} title='The Water material the surface is drawn with: drop one here too'
            seed={() => new WaterMaterial(look)}
            onPick={a => {
              const m = liveMaterial(a)
              if (!(m instanceof WaterMaterial)) return
              node.waterMaterial = m
              node.waterMaterialId = a.id
              changed()
            }} />
        </div>
        <PresetMenu presets={WATER_LOOK_PRESETS} onApply={applyPreset} title='Water looks' />
      </div>
      <PropertyTable columns={['45%', '55%']}>
        {color('shallowColor', 'Shallow colour', 'The tint of light scattered near the surface: what shallow water looks like.')}
        {color('deepColor', 'Deep colour', 'The colour deep water takes: light scattered back from far down.')}
        {color('absorption', 'Absorption', 'How fast each colour dies with depth (brighter = absorbed faster). Clear water loses red first.')}
        {slider('turbidity', 'Murkiness', 'Suspended silt: murky water hides the bed a short way down.', 0, 1, 0.01)}
        {slider('clarity', 'Clarity', 'Metres you can see down before the scattering hides the bed.', 0.1, 50, 0.1)}
        {slider('reflectivity', 'Reflectivity', 'Reflectance looking straight down (water is 0.02); grazing reflection follows Fresnel.', 0, 0.2, 0.005)}
        {slider('roughness', 'Roughness', 'How blurred the reflections are: 0 a mirror.', 0, 1, 0.01)}
        {slider('screenReflections', 'Screen reflections', 'How much the screen-space reflection of the scene is used over the sky.', 0, 1, 0.05)}
        {slider('refraction', 'Refraction', 'How far what is under the surface bends with the waves.', 0, 2, 0.05)}
        {slider('detailStrength', 'Ripples', 'Strength of the waves under a metre long: the ripples the wind raises on the waves. 1 is the wind\u2019s own.', 0, 2, 0.05)}
        {slider('detailScale', 'Foam size', 'Metres across the piece of web the foam is drawn from: its widest holes are about a seventh of that.', 0.1, 10, 0.1)}
        {slider('flowStrength', 'Flow', 'How far the waves and foam ride the current, so a river visibly runs.', 0, 2, 0.05)}
        {slider('flowScatter', 'Churn', 'How much fast water lightens and clouds, as churned water does.', 0, 2, 0.05)}
        {slider('liveWaves', 'Live waves', 'How tall the simulated waves on flowing water stand round the camera: the boil of fast water, the wake below every stone, waves standing below a drop. 0: none.', 0, 2, 0.05)}
        {color('foamColor', 'Foam colour', 'The colour of the foam.')}
        {slider('shoreFoam', 'Shore foam', 'Metres of foam along the shore and in thin water.', 0, 10, 0.1)}
        {slider('crestFoam', 'Crest foam', 'Foam on breaking wave crests.', 0, 1, 0.05)}
        {slider('flowFoam', 'Rapids foam', 'Foam where the water runs fast or drops (rapids, weirs, waterfalls).', 0, 1, 0.05)}
        {slider('caustics', 'Caustics', 'Brightness of the light the waves focus on the bed.', 0, 2, 0.05)}
        {slider('causticsScale', 'Caustics size', 'Metres between the caustic lines.', 0.1, 10, 0.1)}
        {slider('rainRipples', 'Rain rings', 'How much rain from a Weather volume rings the surface.', 0, 2, 0.05)}
        {slider('snowCover', 'Snow and ice', 'How much snow settles on still water as slush, then ice.', 0, 1, 0.05)}
        {slider('windResponse', 'Wind', 'How much the scene wind roughens the surface.', 0, 2, 0.05)}
        {color('scatterColor', 'Scatter colour', 'The colour light takes travelling through the water: what thin wave crests glow with against the sun.')}
        {slider('subsurface', 'Subsurface', 'How strongly light shines through the waves (subsurface scattering). 0: none.', 0, 2, 0.05)}
        {slider('subsurfaceSharpness', 'Scatter focus', 'How tightly the glow gathers round looking toward the sun.', 1, 16, 0.5)}
        {slider('subsurfaceDistortion', 'Scatter spread', 'How far the waves\u2019 slopes bend the light through them, spreading the glow over their faces.', 0, 1, 0.05)}
        {color('underwaterColor', 'Underwater colour', 'The colour of the water seen from inside it.')}
        {slider('underwaterFog', 'Underwater fog', 'How thick the water is to see through from inside it, per metre.', 0, 2, 0.01)}
      </PropertyTable>
    </Section>
  )
}

const BAKE_RESOLUTIONS = [{ value: 256, label: 'Draft (256)' }, { value: 512, label: 'Standard (512)' }, { value: 768, label: 'Fine (768)' }, { value: 1024, label: 'Finest (1024, slow)' }]

/** How each bake made this session went, by bake id: what the card says under the button. */
const BAKE_REPORTS = new Map<string, WaterBakeReport>()
// Keyed by the closed project's bakes.
onProjectClose(() => BAKE_REPORTS.clear())

/** Whether a node's bake is drawn: none, current, stale (the water or the ground round it changed), or missing. */
function bakeStatus(node: WaterVolumeNode): 'none' | 'current' | 'stale' | 'missing' {
  const id = node.bakeId
  if (!id) return 'none'
  const decoded = GiBakeRegistry.has(id) ? decodeWaterBake(GiBakeRegistry.get(id)!, id) : null
  return !decoded ? 'missing' : decoded.signature === node.bakeSignature() ? 'current' : 'stale'
}

const at = (p: [number, number]) => `${Math.round(p[0])}, ${Math.round(p[1])}`

/** A bake's report in plain words: whether it settled, and what the water did that it was not drawn to do. */
function reportLines(report: WaterBakeReport, group: readonly WaterVolumeNode[]): { text: string; warn: boolean }[] {
  const lines: { text: string; warn: boolean }[] = []
  const flow = `${report.inflow.toFixed(1)} m\u00b3/s in, ${(report.outflow + report.lost).toFixed(1)} out`
  if (report.settled) lines.push({ text: `Settled after ${Math.round(report.seconds)} s of flow (${flow}).`, warn: false })
  else {
    const where = report.fillingAt && report.filling > 0 ? ` Water was still gathering near ${at(report.fillingAt)}: a hollow on its way that is a lake; add one there, or fill it in.` : ''
    lines.push({ text: `Not settled after ${Math.round(report.seconds)} s of flow (${flow}).${where}`, warn: true })
  }
  if (report.lost > 0.02 * Math.max(report.inflow, 1e-6)) {
    const share = Math.round(100 * report.lost / Math.max(report.inflow, 1e-6))
    lines.push({
      text: `${Math.min(100, share)}% of the water left the course it was drawn on${report.lostAt ? `, most near ${at(report.lostAt)}` : ''}: the ground has no channel for it there. Carve one, or draw the river where the ground runs.`,
      warn: true,
    })
  }
  const met = report.obstacles
  if (met && met.count > 0) {
    const them = met.count === 1 ? 'it' : 'them'
    let text = `Flowed round ${met.count} static collider${met.count === 1 ? '' : 's'} standing in the water.`
    if (met.narrow > 0) text += ` ${met.narrow === met.count ? (met.count === 1 ? 'It is' : 'They are') : `${met.narrow} of ${them} ${met.narrow === 1 ? 'is' : 'are'}`} narrower than two cells at this resolution: the water is held back by ${met.narrow === 1 ? 'its' : 'their'} drag, but not seen to part round ${met.narrow === 1 ? 'it' : 'them'}. Raise the resolution to see that.`
    lines.push({ text, warn: false })
  }
  for (const l of report.levels) {
    if (Math.abs(l.level - l.drawn) < 0.05) continue
    const name = group.find(n => n.id === l.id)?.name ?? 'A lake'
    lines.push({ text: `${name} stands at ${l.level.toFixed(2)} m, not the ${l.drawn.toFixed(2)} m it was drawn at: that is where its outlet lets it.`, warn: false })
  }
  return lines
}

/**
 * The flow bake: the shallow-water equations run over this water and everything joined to it as one system,
 * over the ground under it and round the static colliders in it, until what flows in is what flows out
 * (water/bake/), in a worker. Each water's settled heights, currents and foam are stored as its bake, which
 * the surface then draws and physics carries floating bodies on.
 */
function WaterBake({ node, changed }: { node: WaterVolumeNode; changed: () => void }) {
  const [res, setRes] = useState(512)
  const [progress, setProgress] = useState<{ fraction: number; seconds: number } | null>(null)
  const cancelRef = useRef<(() => void) | null>(null)
  const stopRef = useRef(false)
  useEffect(() => () => { stopRef.current = true; cancelRef.current?.() }, [])
  const group = waterBakeGroup(node)
  const status = bakeStatus(node)
  const canBake = bakeable(node)
  const bake = async () => {
    if (progress !== null || !group.length) return
    stopRef.current = false
    let prepared
    try { prepared = prepareGroupBake(node, { maxRes: res }) }
    catch (e) { Logger.warn(`Water "${node.name}": ${String((e as Error).message ?? e)}`, 'Water'); return }
    // Signed with what it is baked from, read now.
    forgetWaterBakeContext()
    const signature = waterGroupSignature(node)
    setProgress({ fraction: 0, seconds: 0 })
    const run = runWaterBake(prepared.setup, (fraction, seconds) => setProgress({ fraction, seconds }))
    cancelRef.current = run.cancel
    let output = null
    try { output = await run.result }
    catch (e) { Logger.warn(`Water "${node.name}" bake failed: ${String((e as Error).message ?? e)}`, 'Water') }
    cancelRef.current = null
    if (output && !stopRef.current) {
      for (const m of output.members) {
        const n = prepared.group.find(g => g.id === m.id)
        if (!n) continue
        const bakeId = newWaterBakeId()
        m.info.source = bakeId
        await saveGiBake(bakeId, encodeWaterBake(m.info, signature), n.bakeId)
        n.bakeId = bakeId
        BAKE_REPORTS.set(bakeId, output.report)
      }
      const lines = reportLines(output.report, prepared.group)
      const say = lines.some(l => l.warn) ? Logger.warn : Logger.info
      say.call(Logger, `Water baked (${prepared.group.map(n => n.name).join(', ')}): ${prepared.setup.nx} x ${prepared.setup.nz} cells. ${lines.map(l => l.text).join(' ')}`, 'Water')
    }
    setProgress(null)
    changed()
  }
  const others = group.filter(n => n !== node)
  const report = node.bakeId ? BAKE_REPORTS.get(node.bakeId) : undefined
  // A river narrower than a few cells cannot carry a current the bake can see.
  const reach = waterGroupReach(group)
  const cell = reach ? Math.max(0.25, Math.max(reach[2] - reach[0], reach[3] - reach[1]) / (res - 5)) : 0
  let narrowest = Infinity
  for (const n of group) if (n.waterType === 'river') for (const p of n.points) narrowest = Math.min(narrowest, p.width)
  const coarse = Number.isFinite(narrowest) && cell > narrowest / 6
  return (
    <Section title='Flow bake'>
      {!canBake && <Hint className='mb-1'>An endless ocean has no flow to settle: nothing to bake.</Hint>}
      {canBake && <>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Bake resolution' hint='Cells along the longest side of the water baked together: finer catches narrower channels and smaller rocks, and takes longer (four times the cells, eight times the time).' divider>
            <Select value={String(res)} onChange={e => setRes(Number(e.target.value))}>
              {BAKE_RESOLUTIONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </Select>
          </PropertyRow>
          <PropertyRow label='Bed roughness' hint={"Manning's roughness of the bed: 0.01 smooth concrete, 0.03 a natural channel, 0.1 a weedy, bouldery one. The rougher, the slower and deeper the water runs. A natural bed (0.025 and up) is never taken smoother than a stream on its slope measures."}>
            <Slider value={node.bedRoughness} min={0.01} max={0.12} step={0.005} readout onChange={v => { node.bedRoughness = v; changed() }} />
          </PropertyRow>
        </PropertyTable>
        <div className='flex items-center gap-1.5 mt-2'>
          {progress === null
            ? <Button size='sm' onClick={bake} title='Simulate this water and everything joined to it over the landscape and round the static colliders in it, until what flows in is what flows out, and draw each with its settled heights, currents and foam.'>
                {others.length ? `Bake flow (${group.length} waters)` : 'Bake flow'}
              </Button>
            : <Button size='sm' onClick={() => { stopRef.current = true; cancelRef.current?.() }} title='Stop the bake; every water keeps what it drew before.'>
                Cancel ({Math.round(progress.seconds)} s of flow simulated)
              </Button>}
          {node.bakeId && progress === null && <Button size='sm' variant='ghost' onClick={() => { node.bakeId = null; changed() }}
            title='Draw the unbaked water again (the bake stays in the project until replaced).'>Clear</Button>}
        </div>
        {others.length > 0 && progress === null && <Hint className='mt-1'>Baked with it, as one system: {others.map(n => n.name).join(', ')}.</Hint>}
        {coarse && progress === null && <Hint className='mt-1 text-warning'>At this resolution a cell is {cell.toFixed(1)} m and the narrowest river {narrowest.toFixed(1)} m: too few cells across it to carry a current. Raise the resolution.</Hint>}
        {status === 'current' && <Hint className='mt-1'>Drawing the baked flow.</Hint>}
        {status === 'current' && report && reportLines(report, group).map((l, i) => <Hint key={i} className={cn('mt-1', l.warn && 'text-warning')}>{l.text}</Hint>)}
        {status === 'stale' && <Hint className='mt-1 text-warning'>The water, something joined to it, the ground or the colliders in it changed since the bake: drawing the unbaked water until it is baked again.</Hint>}
        {status === 'missing' && <Hint className='mt-1 text-warning'>The bake is missing from the project: drawing the unbaked water.</Hint>}
      </>}
    </Section>
  )
}

export default function WaterVolumeEditor(props: { node: WaterVolumeNode }) {
  const { eventEmitter, editorScene, templates } = useCleoEngine()
  const [, setTick] = useState(0)
  const node = props.node
  const changed = () => {
    setTick(t => t + 1)
    eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node })
  }
  // The viewport handles edit the body mid-drag: keep the fields live.
  useEffect(() => {
    const onEdited = (p: { nodeId?: string }) => { if (!p || p.nodeId === node.id) setTick(t => t + 1) }
    eventEmitter.on(WATER_SHAPES_EDITED, onEdited)
    return () => { eventEmitter.off(WATER_SHAPES_EDITED, onEdited) }
  }, [eventEmitter, node])

  const set = <K extends keyof WaterVolumeNode>(key: K, value: WaterVolumeNode[K]) => { (node as any)[key] = value; changed() }
  const river = node.waterType === 'river'
  const applyPreset = (p: WaterVolumePreset) => { node.applyPreset(p); changed() }

  return (
    <DocScope page='editor/water'>
    <Collapsable title='Water Volume' icon={<WaterVolumeIcon />} persistKey='waterVolumeEditor' badge={TYPE_LABEL[node.waterType]}
      right={<PresetMenu presets={WATER_VOLUME_PRESETS} onApply={applyPreset} title='Liquid presets' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        <DeclaredSection node={node} title='' />

        <WaterBodyCard node={node} changed={changed} />

        <WaterSurface node={node} changed={changed} />

        <WaterBake node={node} changed={changed} />

        <DeclaredSection node={node} title='Waves'>
          {river && <Hint className='mt-1'>A river's waves are raised by its own current: taller and longer where it runs fast, calm where it is slow.</Hint>}
        </DeclaredSection>
        <DeclaredSection node={node} title='Buoyancy' />
        <DeclaredSection node={node} title='Ripples and splashes' />
      </div>
    </Collapsable>
    </DocScope>
  )
}
