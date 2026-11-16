import React, { useEffect, useRef, useState } from 'react'
import {
  ModelNode, WaterVolumeNode, WATER_VOLUME_PRESETS, normaliseWaterShape, normaliseWaterPoint, newWaterShapeId, carveWater,
  type LandscapeNode,
  type WaterVolumePreset, type WaterShape, type WaterShapeType, type WaterPoint,
} from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import {
  Button, Hint, MenuItem, NumberInput, Popover, PresetMenu, PropertyRow, PropertyTable, Section, SectionTitle, Select,
  Slider, Toggle, VectorInput, DocScope, cn,
} from '@cleo/app-kit/ui'
import NodeRefInput from '../NodeRefInput'
import { useCleoEngine } from '../../EngineContext'
import { useHistory } from '../../HistoryContext'
import { WaterVolumeIcon } from '../sectionIcons'
import {
  WATER_SHAPE_FRAME, WATER_SHAPES_EDITED, setWaterShapeSelection, useWaterShapeSelection,
} from '../../gizmo/waterSelection'

// The Water inspector. A Water node is a list of shapes (rivers, lakes, boxes, oceans), joined where a
// river's start or end is connected to another shape; together they are one body of water that buoys what
// floats in it, carries it downstream and draws one surface. Shapes are edited like a Collider's: a row
// per shape, and the selected row's handles in the viewport.

// Glyphs in the inspector's section-icon style (15 px, stroke currentColor).
const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
)
export const WATER_SHAPE_ICONS: Record<WaterShapeType, React.ReactNode> = {
  river: <S><path d='M5 3c4 3-2 6 2 9s-2 6 2 9' /><path d='M15 3c4 3-2 6 2 9s-2 6 2 9' /></S>,
  lake: <S><path d='M4 13c0-4 4-7 8-7 5 0 8 3 8 6 0 4-4 6-8 6s-8-1-8-5Z' /><path d='M8 12c1.3-.8 2.7-.8 4 0s2.7.8 4 0' /></S>,
  box: <S><path d='M12 3l8 4.5v9L12 21l-8-4.5v-9Z' /><path d='M4 7.5l8 4.5 8-4.5M12 12v9' /></S>,
  ocean: <S><path d='M2 9c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0' /><path d='M2 15c2.5-2 5-2 7.5 0s5 2 7.5 0 3.5-1.5 5 0' /></S>,
}
const TYPE_LABEL: Record<WaterShapeType, string> = { river: 'River', lake: 'Lake', box: 'Box', ocean: 'Ocean' }
const ADD_HINT: Record<WaterShapeType, string> = {
  river: 'Add a river: a spline with a width, depth and flow speed at each point. Connect its end to a lake or the ocean.',
  lake: 'Add a lake: a level surface inside a smooth outline.',
  box: 'Add a box of level water: a pool, a tank, a flooded room.',
  ocean: 'Add an ocean: a level surface reaching the horizon, with waves from the wind.',
}
const FrameIcon = () => <S><path d='M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5' /><circle cx='12' cy='12' r='2.5' /></S>
const MoreIcon = () => <S><circle cx='5.5' cy='12' r='1.2' fill='currentColor' /><circle cx='12' cy='12' r='1.2' fill='currentColor' /><circle cx='18.5' cy='12' r='1.2' fill='currentColor' /></S>
const PlusIcon = () => <S><path d='M12 5v14M5 12h14' /></S>
const Caret = ({ open }: { open: boolean }) => (
  <S width='11' height='11' className={cn('transition-transform', open ? 'rotate-90' : '')}><path d='M9 6l6 6-6 6' /></S>
)

const rowTitle = (s: WaterShape, i: number) => s.name || `${TYPE_LABEL[s.type]} ${i + 1}`

/** A copy of `shape` with a fresh id, its connections dropped (they would join the same ends twice). */
function duplicateWaterShape(shape: WaterShape): WaterShape {
  const copy = normaliseWaterShape(JSON.parse(JSON.stringify(shape)))
  return { ...copy, id: newWaterShapeId(), name: shape.name ? `${shape.name} copy` : '', connect: { start: null, end: null } }
}

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
      <PropertyRow label='Position' hint={river ? 'Where the surface runs along the centre line, in the node’s units.' : 'A point of the outline, in the node’s units (height is the lake’s level).'}>
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
function nextPoint(shape: WaterShape): WaterPoint {
  const pts = shape.points
  const last = pts[pts.length - 1]
  if (!last) return normaliseWaterPoint({})
  if (shape.type === 'lake') {
    // Between the last point and the first: the outline closes there.
    const first = pts[0]
    return normaliseWaterPoint({ ...last, pos: [(last.pos[0] + first.pos[0]) / 2, last.pos[1], (last.pos[2] + first.pos[2]) / 2] })
  }
  const prev = pts[pts.length - 2] ?? { pos: [last.pos[0], last.pos[1], last.pos[2] - 10] }
  const d = [last.pos[0] - prev.pos[0], last.pos[1] - prev.pos[1], last.pos[2] - prev.pos[2]]
  return normaliseWaterPoint({ ...last, pos: [last.pos[0] + d[0], last.pos[1] + d[1], last.pos[2] + d[2]] })
}

/** One row of the shape list: a header that selects the shape, and, open, its fields. */
function WaterShapeRow(props: {
  shape: WaterShape; index: number; all: readonly WaterShape[]; selected: boolean; selectedPoint: number; open: boolean;
  onToggleOpen: () => void; onChange: (s: WaterShape) => void; onSelect: (point: number) => void; onFrame: () => void;
  onDuplicate: () => void; onRemove: () => void; onMoveUp?: () => void; onMoveDown?: () => void;
}) {
  const s = props.shape
  const patch = (p: Partial<WaterShape>) => props.onChange({ ...s, ...p })
  const rowRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (props.selected) rowRef.current?.scrollIntoView({ block: 'nearest' }) }, [props.selected])
  const others = props.all.filter(o => o.id !== s.id)
  const hasPoints = s.type === 'river' || s.type === 'lake'
  const setPoint = (i: number, p: WaterPoint) => patch({ points: s.points.map((q, k) => (k === i ? normaliseWaterPoint(p) : q)) })
  const removePoint = (i: number) => patch({ points: s.points.filter((_, k) => k !== i) })
  const minPoints = s.type === 'river' ? 2 : 3

  return (
    <div ref={rowRef} className={cn('w-full rounded border mb-1.5', props.selected ? 'border-highlight bg-highlight/10' : 'border-border-subtle')}>
      <div className='flex items-center gap-1 px-1 py-0.5 cursor-pointer select-none' onClick={() => props.onSelect(-1)}
        title='Select this shape: the viewport shows its handles.'>
        <button type='button' className='p-0.5 text-muted hover:text-fg' aria-label={props.open ? 'Collapse' : 'Expand'}
          onClick={(e) => { e.stopPropagation(); props.onToggleOpen() }}>
          <Caret open={props.open} />
        </button>
        <span className={cn('shrink-0', props.selected ? 'text-highlight' : 'text-muted')}>{WATER_SHAPE_ICONS[s.type]}</span>
        <SectionTitle title={rowTitle(s, props.index)} doc='editor/water#shapes::Shape' className='flex-1 min-w-0 truncate' />
        <Button variant='ghost' size='icon' title='Select and frame in the viewport'
          onClick={(e) => { e.stopPropagation(); props.onFrame() }}><FrameIcon /></Button>
        <span onClick={(e) => e.stopPropagation()}>
          <Popover align='right' title='Shape actions' className='p-1 w-[200px]'
            trigger={<span className='inline-flex p-1 text-muted hover:text-fg'><MoreIcon /></span>}>
            {close => (
              <div className='flex flex-col'>
                <MenuItem onClick={() => { props.onDuplicate(); close() }}>Duplicate</MenuItem>
                <MenuItem disabled={!props.onMoveUp} onClick={() => { props.onMoveUp?.(); close() }}>Move up</MenuItem>
                <MenuItem disabled={!props.onMoveDown} onClick={() => { props.onMoveDown?.(); close() }}>Move down</MenuItem>
                <MenuItem danger onClick={() => { props.onRemove(); close() }}>Remove</MenuItem>
              </div>
            )}
          </Popover>
        </span>
        <Button variant='remove' size='icon' title='Remove this shape'
          onClick={(e) => { e.stopPropagation(); props.onRemove() }}>✕</Button>
      </div>

      {props.open && <div className='px-2 pb-2'>
        <PropertyTable columns={['32%', '68%']}>
          <PropertyRow label='Priority' hint='Where two shapes overlap, the higher priority is the water there (a river through a lake, say).'>
            <NumberInput value={s.priority} step={1} onChange={priority => patch({ priority: Math.round(priority) })} />
          </PropertyRow>
          {s.type === 'box' && <>
            <PropertyRow label='Centre' hint='The box centre, in the node’s units. The top face is the surface.'>
              <VectorInput value={s.offset} step={0.25} onChange={offset => patch({ offset: offset as [number, number, number] })} />
            </PropertyRow>
            <PropertyRow label='Size' hint='Width, depth, length in metres, before the node scale.'>
              <VectorInput value={s.size} min={0.01} step={0.25} onChange={size => patch({ size: size as [number, number, number] })} />
            </PropertyRow>
          </>}
          {(s.type === 'lake' || s.type === 'ocean') && <>
            <PropertyRow label='Level' hint='The surface height, and the outline’s centre, in the node’s units.'>
              <VectorInput value={s.offset} step={0.25} onChange={offset => patch({ offset: offset as [number, number, number] })} />
            </PropertyRow>
            <PropertyRow label='Depth' hint='Metres, surface to floor. The landscape, where higher, is the real floor.'>
              <NumberInput value={s.depth} min={0.05} step={0.5} onChange={depth => patch({ depth })} />
            </PropertyRow>
          </>}
          {s.type === 'ocean' &&
            <PropertyRow label='Extent' hint='Metres the ocean reaches each way from its centre. 0: endless, to the horizon.'>
              <NumberInput value={s.extent} min={0} step={50} onChange={extent => patch({ extent })} />
            </PropertyRow>}
          {s.type === 'river' && <>
            <PropertyRow label='Offset' hint='Moves the whole river, in the node’s units.'>
              <VectorInput value={s.offset} step={0.25} onChange={offset => patch({ offset: offset as [number, number, number] })} />
            </PropertyRow>
            <PropertyRow label='Flows from' hint='The shape the river starts in: its first point takes that shape’s surface, so the two meet.'>
              <Select value={s.connect.start ?? ''} onChange={e => patch({ connect: { ...s.connect, start: e.target.value || null } })}>
                <option value=''>Nothing (a spring)</option>
                {others.map((o, i) => <option key={o.id} value={o.id}>{rowTitle(o, props.all.indexOf(o) ?? i)}</option>)}
              </Select>
            </PropertyRow>
            <PropertyRow label='Flows into' hint='The shape the river ends in: its last point takes that shape’s surface, so the river runs into it.'>
              <Select value={s.connect.end ?? ''} onChange={e => patch({ connect: { ...s.connect, end: e.target.value || null } })}>
                <option value=''>Nothing</option>
                {others.map((o, i) => <option key={o.id} value={o.id}>{rowTitle(o, props.all.indexOf(o) ?? i)}</option>)}
              </Select>
            </PropertyRow>
          </>}
          {hasPoints && <>
            <PropertyRow label='Carve landscape' hint='Dig this shape’s bed into the landscape when Carve is pressed: the bed inside the water, a sloped bank outside it. Only ever lowers the ground.'>
              <Toggle checked={s.carve.enabled} onChange={enabled => patch({ carve: { ...s.carve, enabled } })} />
            </PropertyRow>
            {s.carve.enabled && <>
              <PropertyRow label='Bank width' hint='Metres the bank slopes over, from the water’s edge back up to the ground.'>
                <NumberInput value={s.carve.bankWidth} min={0} step={0.5} onChange={bankWidth => patch({ carve: { ...s.carve, bankWidth } })} />
              </PropertyRow>
              <PropertyRow label='Dig deeper' hint='Metres dug below the water’s own depth.'>
                <NumberInput value={s.carve.extraDepth} min={0} step={0.1} onChange={extraDepth => patch({ carve: { ...s.carve, extraDepth } })} />
              </PropertyRow>
            </>}
          </>}
        </PropertyTable>
        {hasPoints && <div className='mt-2'>
          <div className='flex items-center mb-1'>
            <span className='text-ui-xs text-muted flex-1'>{s.type === 'river' ? 'Points, upstream to downstream' : 'Outline points'}</span>
            <Button variant='ghost' size='icon' title='Add a point at the end'
              onClick={() => patch({ points: [...s.points, nextPoint(s)] })}><PlusIcon /></Button>
          </div>
          {s.points.map((p, i) => (
            <PointRow key={i} point={p} index={i} river={s.type === 'river'} selected={props.selected && props.selectedPoint === i}
              canRemove={s.points.length > minPoints}
              onSelect={() => props.onSelect(i)} onChange={q => setPoint(i, q)} onRemove={() => removePoint(i)} />
          ))}
        </div>}
      </div>}
    </div>
  )
}

/** The shape list and its add row. */
/**
 * Digs every shape with Carve landscape on into every landscape under it, as one undo step: the touched
 * rectangle of each terrain, before and after.
 */
function useCarve(node: WaterVolumeNode) {
  const { eventEmitter, editorScene } = useCleoEngine()
  const { push } = useHistory()
  return () => {
    const resolved = node.resolvedShapes()
    const edits: { id: string; region: { c0: number; r0: number; c1: number; r1: number }; before: Float32Array; after: Float32Array }[] = []
    for (const land of (editorScene?.landscapes ?? []) as Set<LandscapeNode>) {
      const terrain = land.terrain
      if (!terrain) continue
      const original = terrain.heights.slice()
      const region = carveWater({ heights: terrain.heights, resolution: terrain.resolution, size: terrain.size, origin: terrain.origin },
        node.shapes, resolved)
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

function WaterShapes({ node, changed }: { node: WaterVolumeNode; changed: () => void }) {
  const { eventEmitter } = useCleoEngine()
  const carve = useCarve(node)
  const [carveMiss, setCarveMiss] = useState(false)
  const anyCarve = node.shapes.some(s => s.carve.enabled && (s.type === 'river' || s.type === 'lake'))
  const selection = useWaterShapeSelection(eventEmitter)
  const [closed, setClosed] = useState<ReadonlySet<string>>(() => new Set())
  const shapes = node.shapes
  const write = (next: WaterShape[]) => { node.shapes = next; changed() }
  const select = (shapeId: string | null, point = -1) =>
    setWaterShapeSelection(eventEmitter, shapeId ? { nodeId: node.id, shapeId, point } : null)
  const add = (type: WaterShapeType) => {
    const shape = normaliseWaterShape({ type })
    // A new river flows into the node's first lake or ocean, so the obvious layout needs no connecting.
    if (type === 'river') {
      const target = shapes.find(s => s.type === 'lake' || s.type === 'ocean')
      if (target) shape.connect = { start: null, end: target.id }
    }
    write([...shapes, shape])
    select(shape.id)
  }
  const move = (i: number, delta: number) => {
    const to = Math.min(shapes.length - 1, Math.max(0, i + delta))
    const next = [...shapes]
    next.splice(to, 0, next.splice(i, 1)[0])
    write(next)
  }
  const remove = (i: number) => {
    const gone = shapes[i].id
    // Whatever flowed into the removed shape now flows into nothing.
    write(shapes.filter((_, k) => k !== i).map(s => ({
      ...s, connect: { start: s.connect.start === gone ? null : s.connect.start, end: s.connect.end === gone ? null : s.connect.end },
    })))
    if (selection?.shapeId === gone) select(null)
  }
  const toggle = (id: string) => setClosed(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  return (
    <Section title='Shapes'>
      <div className='flex items-center gap-1 mb-2'>
        {(['river', 'lake', 'box', 'ocean'] as WaterShapeType[]).map(t => (
          <Button key={t} variant='ghost' size='icon' title={ADD_HINT[t]} aria-label={`Add ${TYPE_LABEL[t].toLowerCase()}`}
            onClick={() => add(t)}>{WATER_SHAPE_ICONS[t]}</Button>
        ))}
      </div>
      {shapes.length === 0 && <Hint className='mb-2'>No shapes: there is no water yet.</Hint>}
      {anyCarve && <div className='mb-2'>
        <Button size='sm' title='Dig the beds of the shapes with Carve landscape on into the landscape under them. One undo step.'
          onClick={() => setCarveMiss(!carve())}>Carve landscape</Button>
        {carveMiss && <Hint className='mt-1'>Nothing to carve: no landscape is under those shapes, or it is already lower.</Hint>}
      </div>}
      {shapes.map((shape, i) => {
        const selected = selection?.nodeId === node.id && selection.shapeId === shape.id
        return (
          <WaterShapeRow key={shape.id} shape={shape} index={i} all={shapes}
            selected={selected} selectedPoint={selected ? selection!.point : -1}
            open={selected || !closed.has(shape.id)} onToggleOpen={() => toggle(shape.id)}
            onChange={s => write(shapes.map((q, k) => (k === i ? normaliseWaterShape(s) : q)))}
            onSelect={point => select(shape.id, point)}
            onFrame={() => { select(shape.id); eventEmitter.emit(WATER_SHAPE_FRAME, { nodeId: node.id, shapeId: shape.id, point: -1 }) }}
            onDuplicate={() => {
              const copy = duplicateWaterShape(shape)
              write([...shapes.slice(0, i + 1), copy, ...shapes.slice(i + 1)])
              select(copy.id)
            }}
            onRemove={() => remove(i)}
            onMoveUp={i > 0 ? () => move(i, -1) : undefined}
            onMoveDown={i < shapes.length - 1 ? () => move(i, 1) : undefined}
          />
        )
      })}
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
  // The viewport handles edit the shapes mid-drag: keep the fields live.
  useEffect(() => {
    const onEdited = (p: { nodeId?: string }) => { if (!p || p.nodeId === node.id) setTick(t => t + 1) }
    eventEmitter.on(WATER_SHAPES_EDITED, onEdited)
    return () => { eventEmitter.off(WATER_SHAPES_EDITED, onEdited) }
  }, [eventEmitter, node])

  const set = <K extends keyof WaterVolumeNode>(key: K, value: WaterVolumeNode[K]) => { (node as any)[key] = value; changed() }
  const applyPreset = (p: WaterVolumePreset) => { node.applyPreset(p); changed() }

  return (
    <DocScope page='editor/water'>
    <Collapsable title='Water Volume' icon={<WaterVolumeIcon />} persistKey='waterVolumeEditor' badge={node.shapes.length || undefined}
      right={<PresetMenu presets={WATER_VOLUME_PRESETS} onApply={applyPreset} title='Liquid presets' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled'>
            <Toggle checked={node.enabled} onChange={enabled => set('enabled', enabled)} />
          </PropertyRow>
        </PropertyTable>

        <WaterShapes node={node} changed={changed} />

        <Section title='Waves'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Wind speed' hint='m/s the waves are shaped for: longer, taller, faster waves as it rises, limited by how much open water the shapes give it. 0: no waves.' divider>
              <NumberInput value={node.windSpeed} min={0} step={0.5} onChange={v => set('windSpeed', v)} />
            </PropertyRow>
            <PropertyRow label='Direction' hint='Degrees the waves travel toward: 0 is +Z, 90 is +X.' divider>
              <NumberInput value={node.waveDirection} step={5} onChange={v => set('waveDirection', v)} />
            </PropertyRow>
            <PropertyRow label='Height' hint='Multiplies the wave height the wind gives.' divider>
              <Slider value={node.waveScale} min={0} max={3} step={0.05} onChange={v => set('waveScale', v)} />
            </PropertyRow>
            <PropertyRow label='Choppiness' hint='Rounded swells (0) to sharp crests (1).' divider>
              <Slider value={node.choppiness} min={0} max={1} step={0.05} onChange={v => set('choppiness', v)} />
            </PropertyRow>
            <PropertyRow label='Shore fade' hint='Metres from a shore over which the waves die down.' divider>
              <NumberInput value={node.shoreFade} min={0} step={0.5} onChange={v => set('shoreFade', v)} />
            </PropertyRow>
            <PropertyRow label='Swell' hint='Metres the whole surface rises and falls, so floating bodies bob. 0 = none.' divider>
              <NumberInput value={node.waveAmplitude} min={0} step={0.01} onChange={v => set('waveAmplitude', v)} />
            </PropertyRow>
            <PropertyRow label='Swell rate' hint='Hz.'>
              <NumberInput value={node.waveFrequency} min={0} step={0.05} onChange={v => set('waveFrequency', v)} />
            </PropertyRow>
          </PropertyTable>
        </Section>

        <Section title='Buoyancy'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Density' hint='kg/m³ (fresh water 1000). A body denser than this sinks; lighter ones float, riding higher the lighter they are.' divider>
              <NumberInput value={node.density} min={1} step={25} onChange={v => set('density', v)} />
            </PropertyRow>
            <PropertyRow label='Drag' hint='Per second, at full submersion: how quickly bodies in the water take on its speed.' divider>
              <NumberInput value={node.linearDrag} min={0} step={0.1} onChange={v => set('linearDrag', v)} />
            </PropertyRow>
            <PropertyRow label='Spin drag' hint='Per second, at full submersion: how quickly a body stops tumbling.' divider>
              <NumberInput value={node.angularDrag} min={0} step={0.1} onChange={v => set('angularDrag', v)} />
            </PropertyRow>
            <PropertyRow label='Currents' hint='Flowing water (rivers) carries what floats in it downstream.' divider>
              <Toggle checked={node.currents} onChange={v => set('currents', v)} />
            </PropertyRow>
            <PropertyRow label='Buoy characters' hint='Off: character capsules are mostly air and would be launched out of the water.'>
              <Toggle checked={node.affectCharacters} onChange={v => set('affectCharacters', v)} />
            </PropertyRow>
          </PropertyTable>
        </Section>

        <Section title='Splashes'>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Splash' hint='Template spawned at the surface where something enters the water or wades through it.' divider>
              <Select value={node.splashTemplate} onChange={e => set('splashTemplate', e.target.value)}>
                <option value=''>None</option>
                {(templates ?? []).map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </Select>
            </PropertyRow>
            <PropertyRow label='Wading splash' hint='Template for the footsteps of a character wading through. Same as Splash when not set.' divider>
              <Select value={node.wadeSplashTemplate} onChange={e => set('wadeSplashTemplate', e.target.value)}>
                <option value=''>Same as Splash</option>
                {(templates ?? []).map((t: any) => <option key={t.id} value={t.name}>{t.name}</option>)}
              </Select>
            </PropertyRow>
            <PropertyRow label='Surface model' hint='Legacy: a model drawing the water whose custom material declares vec4 uniforms ripple0..ripple11, filled with ripples from what moves through.'>
              <NodeRefInput value={node.surfaceNodeId} scene={editorScene} filter={n => n instanceof ModelNode}
                onChange={v => set('surfaceNodeId', v)} />
            </PropertyRow>
          </PropertyTable>
        </Section>
      </div>
    </Collapsable>
    </DocScope>
  )
}
