import { useEffect, useMemo, useRef, useState } from 'react'
import { humanoidSlotOf, mirrorBoneName } from 'cleo'
import type { BoneMapping, Skin } from 'cleo'
import { DocScope, Modal, ModalHeader, Button, TextInput, cn } from '@cleo/app-kit/ui'
import { token } from '@cleo/app-kit/utils/cssTokens'
import {
  skeletonLayout, retargetView, SOURCE_LABEL, TARGET_LABEL,
  type SkeletonLayout, type SourceStatus, type TargetStatus,
} from '../../utils/retargetView'

// The bone mapper: the clips' skeleton on the left, the character's on the right, both in a front view of
// their bind pose. Drag a bone from the left onto the right to make it drive that bone (or click one, then
// the other). Every bone is coloured by what the retarget will actually do with it, from the engine's own
// plan — so a bone the retarget merges, shares or leaves at rest shows it, instead of failing silently.

export type RetargetMapperProps = {
  sourceLabel: string
  targetLabel: string
  sourceSkin: Skin
  targetSkin: Skin
  /** The mapping as it will be played: automatic matches with the overrides on top. */
  mapping: BoneMapping
  /** Point a source bone at a target bone, or `null` for "don't animate this bone". */
  onRemap: (sourceNode: number, targetNode: number | null) => void
  /** Return one source bone to the automatic match. */
  onAuto: (sourceNode: number) => void
  /** Return every bone to the automatic match. */
  onResetAll: () => void
  onClose: () => void
}

type Side = 'source' | 'target'
type Pan = { k: number; tx: number; ty: number }

/** Joint colours. Read lazily: the CSS tokens are not there at module evaluation. */
function palette() {
  return {
    source: {
      auto: token('--success-fg'), manual: token('--highlight'), merged: '#c084fc', dropped: token('--text-dim', 0.6),
      lost: token('--danger'), static: token('--text-dim', 0.35),
    } as Record<SourceStatus, string>,
    target: {
      driven: token('--success-fg'), merged: '#c084fc', shared: '#2dd4bf', rest: token('--text-dim', 0.45),
    } as Record<TargetStatus, string>,
    bone: token('--text-muted', 0.35),
    link: token('--highlight', 0.9),
    linkFaint: token('--highlight', 0.18),
    text: token('--fg'),
    textMuted: token('--text-muted'),
    halo: token('--surface-sunken'),
    select: token('--warning'),
    divider: token('--border'),
  }
}

const HIT_PX = 10

/** Documented as the bone mapper (Models and materials), whether it opens from an import or a skeleton. */
export default function RetargetMapper(props: RetargetMapperProps) {
  return (
    <DocScope page='editor/models-and-materials' section='the-bone-mapper'>
      <Mapper {...props} />
    </DocScope>
  )
}

function Mapper(props: RetargetMapperProps) {
  const { sourceSkin, targetSkin, mapping, onRemap, onAuto, onResetAll, onClose } = props
  const colors = useMemo(palette, [])
  const layouts = useMemo(() => ({ source: skeletonLayout(sourceSkin), target: skeletonLayout(targetSkin) }), [sourceSkin, targetSkin])
  const view = useMemo(() => retargetView(mapping, sourceSkin, targetSkin), [mapping, sourceSkin, targetSkin])
  const entryOf = useMemo(() => new Map(mapping.entries.map(e => [e.sourceNode, e] as const)), [mapping])

  // ---- geometry ----
  const boxRef = useRef<HTMLDivElement>(null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [size, setSize] = useState({ w: 800, h: 500 })
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setSize({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])
  const [pan, setPan] = useState<Record<Side, Pan>>({ source: { k: 1, tx: 0, ty: 0 }, target: { k: 1, tx: 0, ty: 0 } })
  const half = size.w / 2
  // Fit each skeleton to its half: unit height into 80% of the height, unless a wide T-pose needs less.
  const scaleOf = (side: Side) => {
    const span = Math.max(1e-6, ...layouts[side].joints.map(j => Math.abs(j.x))) * 2
    return Math.min(size.h * 0.8, (half * 0.9) / span)
  }
  const scales = { source: scaleOf('source'), target: scaleOf('target') }
  const origin = (side: Side) => ({ x: (side === 'source' ? 0 : half) + half / 2, y: size.h * 0.9 })
  const screenOf = (side: Side, i: number) => {
    const j = layouts[side].joints[i]
    const o = origin(side), p = pan[side], scale = scales[side]
    return { x: o.x + j.x * scale * p.k + p.tx, y: o.y - j.y * scale * p.k + p.ty }
  }
  const sideAt = (x: number): Side => (x < half ? 'source' : 'target')
  const nearest = (side: Side, x: number, y: number): number | null => {
    let best: number | null = null, bestD = HIT_PX * HIT_PX
    layouts[side].joints.forEach((_, i) => {
      const s = screenOf(side, i)
      const d = (s.x - x) ** 2 + (s.y - y) ** 2
      if (d <= bestD) { bestD = d; best = i }
    })
    return best
  }
  const svgPoint = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // ---- interaction state ----
  const [hover, setHover] = useState<{ side: Side; node: number } | null>(null)
  const [selected, setSelected] = useState<number | null>(null) // a SOURCE node waiting for its target
  const [drag, setDrag] = useState<{ from: number; x: number; y: number; moved: boolean } | null>(null)
  const panning = useRef<{ side: Side; x: number; y: number } | null>(null)
  const [menu, setMenu] = useState<{ node: number; x: number; y: number } | null>(null)
  const [showAll, setShowAll] = useState(true)
  const [showNames, setShowNames] = useState(false)
  const [filter, setFilter] = useState<Record<Side, string>>({ source: '', target: '' })

  const nodeAt = (side: Side, i: number | null) => (i === null ? null : layouts[side].joints[i].node)
  const draggable = (node: number) => view.source.get(node) !== 'static'

  const onPointerDown = (e: React.PointerEvent) => {
    setMenu(null)
    const p = svgPoint(e)
    const side = sideAt(p.x)
    const node = nodeAt(side, nearest(side, p.x, p.y))
    if (e.button === 0 && side === 'source' && node !== null && draggable(node)) {
      setDrag({ from: node, x: p.x, y: p.y, moved: false })
      svgRef.current!.setPointerCapture(e.pointerId)
      return
    }
    if (e.button === 0 && side === 'target' && node !== null && selected !== null) {
      onRemap(selected, node)
      setSelected(null)
      return
    }
    if (e.button === 0 || e.button === 1) {
      panning.current = { side, x: p.x, y: p.y }
      svgRef.current!.setPointerCapture(e.pointerId)
      if (e.button === 0 && node === null) setSelected(null)
    }
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const p = svgPoint(e)
    if (drag) {
      const moved = drag.moved || Math.hypot(p.x - drag.x, p.y - drag.y) > 4
      setDrag({ ...drag, x: p.x, y: p.y, moved })
      const t = sideAt(p.x) === 'target' ? nodeAt('target', nearest('target', p.x, p.y)) : null
      setHover(t === null ? null : { side: 'target', node: t })
      return
    }
    if (panning.current) {
      const { side, x, y } = panning.current
      panning.current = { side, x: p.x, y: p.y }
      setPan(prev => ({ ...prev, [side]: { ...prev[side], tx: prev[side].tx + p.x - x, ty: prev[side].ty + p.y - y } }))
      return
    }
    const side = sideAt(p.x)
    const node = nodeAt(side, nearest(side, p.x, p.y))
    setHover(node === null ? null : { side, node })
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag) {
      if (!drag.moved) setSelected(s => (s === drag.from ? null : drag.from))
      else if (hover?.side === 'target') { onRemap(drag.from, hover.node); setSelected(null) }
      setDrag(null)
    }
    panning.current = null
    if (svgRef.current?.hasPointerCapture(e.pointerId)) svgRef.current.releasePointerCapture(e.pointerId)
  }
  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    const p = svgPoint(e)
    if (sideAt(p.x) !== 'source') return
    const node = nodeAt('source', nearest('source', p.x, p.y))
    if (node !== null && draggable(node)) setMenu({ node, x: p.x, y: p.y })
  }

  // Wheel zoom about the pointer, per side. A native listener: React's is passive and cannot stop the page.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const x = e.clientX - r.left, y = e.clientY - r.top
      const side: Side = x < half ? 'source' : 'target'
      const o = origin(side)
      setPan(prev => {
        const p = prev[side]
        const k = Math.min(40, Math.max(0.5, p.k * Math.exp(-e.deltaY * 0.0015)))
        // Keep the point under the cursor where it is.
        const lx = (x - o.x - p.tx) / p.k, ly = (y - o.y - p.ty) / p.k
        return { ...prev, [side]: { k, tx: x - o.x - lx * k, ty: y - o.y - ly * k } }
      })
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  })

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setSelected(null); setMenu(null) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // ---- mirror ----
  const mirrorLeftToRight = () => {
    const byName = (skin: Skin) => new Map([...(skin.nodeNames ?? [])].map(([n, name]) => [name, n] as const))
    const sNames = byName(sourceSkin), tNames = byName(targetSkin)
    for (const e of mapping.entries) {
      const isLeft = (n: string) => !!humanoidSlotOf(n)?.endsWith('.L') || /left/i.test(n)
      if (!e.sourceName || !(e.kind === 'manual' || e.dropped) || !isLeft(e.sourceName)) continue
      const ms = mirrorBoneName(e.sourceName)
      const msNode = ms ? sNames.get(ms) : undefined
      if (msNode === undefined) continue
      if (e.targetNode === null) { onRemap(msNode, null); continue }
      const tName = targetSkin.nodeNames?.get(e.targetNode)
      const mt = tName ? mirrorBoneName(tName) : null
      const mtNode = mt ? tNames.get(mt) : undefined
      if (mtNode !== undefined) onRemap(msNode, mtNode)
    }
  }

  // ---- links to draw ----
  const focusLinks = (l: { source: number; target: number }) =>
    (selected !== null && l.source === selected) ||
    (hover?.side === 'source' && l.source === hover.node) ||
    (hover?.side === 'target' && l.target === hover.node)
  const posOfNode = (side: Side, node: number) => {
    const i = layouts[side].byNode.get(node)
    return i === undefined ? null : screenOf(side, i)
  }
  const curve = (a: { x: number; y: number }, b: { x: number; y: number }) => {
    const mx = (a.x + b.x) / 2
    return `M${a.x},${a.y} C${mx},${a.y} ${mx},${b.y} ${b.x},${b.y}`
  }

  const renderSkeleton = (side: Side, layout: SkeletonLayout) => {
    const statusColor = (node: number) => side === 'source'
      ? colors.source[view.source.get(node) ?? 'static']
      : colors.target[view.target.get(node) ?? 'rest']
    return (
      <g>
        {layout.joints.map((j, i) => {
          if (j.parent < 0) return null
          const a = screenOf(side, i), b = screenOf(side, j.parent)
          return <line key={`b${i}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={colors.bone} strokeWidth={1.5} />
        })}
        {layout.joints.map((j, i) => {
          const s = screenOf(side, i)
          const isHover = hover?.side === side && hover.node === j.node
          const isSel = side === 'source' && selected === j.node
          const status = side === 'source' ? view.source.get(j.node) : undefined
          const label = showNames || isHover || isSel || (drag && side === 'target' && isHover)
          return (
            <g key={`j${i}`}>
              <circle cx={s.x} cy={s.y} r={isHover || isSel ? 6.5 : 4.5} fill={statusColor(j.node)}
                stroke={isSel ? colors.select : status === 'dropped' ? colors.source.dropped : 'none'}
                strokeWidth={isSel ? 2.5 : 1.5} strokeDasharray={status === 'dropped' ? '2 2' : undefined}>
                <title>{`${j.name}${j.slot ? ` (${j.slot})` : ''} — ${side === 'source' ? SOURCE_LABEL[view.source.get(j.node) ?? 'static'] : TARGET_LABEL[view.target.get(j.node) ?? 'rest']}`}</title>
              </circle>
              {label && (
                <text x={s.x + 8} y={s.y - 6} fontSize={11} fill={colors.text} style={{ pointerEvents: 'none' }}
                  stroke={colors.halo} strokeWidth={3} paintOrder='stroke'>{j.name}</text>
              )}
            </g>
          )
        })}
      </g>
    )
  }

  const list = (side: Side) => {
    const layout = layouts[side]
    const q = filter[side].trim().toLowerCase()
    const rows = layout.joints.filter(j => !q || j.name.toLowerCase().includes(q))
    return (
      <div className='w-[220px] shrink-0 flex flex-col border-control min-h-0' style={{ borderRightWidth: side === 'source' ? 1 : 0, borderLeftWidth: side === 'target' ? 1 : 0 }}>
        <div className='p-1.5 border-b border-control'>
          <TextInput className='w-full px-1 py-0.5' placeholder={`Find a ${side === 'source' ? 'clip' : 'character'} bone…`}
            value={filter[side]} onChange={v => setFilter(f => ({ ...f, [side]: v }))} />
        </div>
        <div className='flex-1 overflow-y-auto min-h-0'>
          {rows.map(j => {
            const st = side === 'source' ? view.source.get(j.node) ?? 'static' : view.target.get(j.node) ?? 'rest'
            const color = side === 'source' ? colors.source[st as SourceStatus] : colors.target[st as TargetStatus]
            const isSel = side === 'source' && selected === j.node
            const tgt = side === 'source' ? entryOf.get(j.node)?.targetNode : undefined
            const tgtName = tgt !== undefined && tgt !== null ? targetSkin.nodeNames?.get(tgt) : undefined
            return (
              <button key={j.node} type='button'
                className={cn('w-full flex items-center gap-1.5 px-2 py-0.5 text-left text-ui-sm hover:bg-control', isSel && 'bg-selected')}
                title={side === 'source' ? SOURCE_LABEL[st as SourceStatus] : TARGET_LABEL[st as TargetStatus]}
                onMouseEnter={() => setHover({ side, node: j.node })} onMouseLeave={() => setHover(null)}
                onClick={() => {
                  if (side === 'source') { if (draggable(j.node)) setSelected(s => (s === j.node ? null : j.node)) }
                  else if (selected !== null) { onRemap(selected, j.node); setSelected(null) }
                }}
                onContextMenu={e => {
                  if (side !== 'source' || !draggable(j.node)) return
                  e.preventDefault()
                  const r = boxRef.current!.getBoundingClientRect()
                  setMenu({ node: j.node, x: Math.max(4, e.clientX - r.left), y: e.clientY - r.top })
                }}>
                <span className='w-2 h-2 rounded-full shrink-0' style={{ background: color }} />
                <span className='truncate flex-1'>{j.name}</span>
                {tgtName && <span className='truncate text-ui-xs text-dim max-w-[80px]'>→ {tgtName}</span>}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  const c = view.counts
  const legend = (items: [string, string][]) => (
    <div className='flex flex-wrap items-center gap-x-3 gap-y-0.5'>
      {items.map(([color, label]) => (
        <span key={label} className='flex items-center gap-1 text-ui-xs text-muted'>
          <span className='w-2 h-2 rounded-full' style={{ background: color }} />{label}
        </span>
      ))}
    </div>
  )

  return (
    // Raised above the dialog that opens it (the import review is a modal too).
    <Modal onClose={onClose} overlayClassName='z-[60]' className='w-[92vw] h-[86vh] max-h-[86vh] flex flex-col overflow-hidden'>
      {/* How to drive it is the bone mapper's docs section, which the title's card shows. */}
      <ModalHeader className='py-2 flex items-center gap-3 shrink-0'
        title={`Map bones: ${props.sourceLabel} → ${props.targetLabel}`} doc='editor/models-and-materials#the-bone-mapper'>
        <div className='ml-auto flex items-center gap-1 shrink-0'>
          <Button size='sm' variant={showAll ? 'subtle' : 'ghost'} active={showAll} onClick={() => setShowAll(v => !v)}
            title='Draw every link, not just the one under the cursor'>All links</Button>
          <Button size='sm' variant={showNames ? 'subtle' : 'ghost'} active={showNames} onClick={() => setShowNames(v => !v)}
            title='Label every bone'>Names</Button>
          <Button size='sm' variant='subtle' onClick={mirrorLeftToRight}
            title='Copy every hand-made change on a left bone to the matching right bone'>Mirror left → right</Button>
          <Button size='sm' variant='subtle' onClick={onResetAll} title='Forget every hand-made change and match by name again'>Auto-match all</Button>
          <Button size='sm' variant='primary' onClick={onClose}>Done</Button>
        </div>
      </ModalHeader>

      <div className='px-4 py-1.5 border-b border-control flex items-start gap-6 shrink-0'>
        <div className='flex-1 min-w-0'>
          <div className='text-ui-xs text-fg mb-0.5'>{props.sourceLabel} — {c.mapped} mapped · {c.merged} merged · {c.lost} lost · {c.dropped} off</div>
          {legend((['auto', 'manual', 'merged', 'lost', 'dropped', 'static'] as SourceStatus[]).map(s => [colors.source[s], SOURCE_LABEL[s]]))}
        </div>
        <div className='flex-1 min-w-0'>
          <div className='text-ui-xs text-fg mb-0.5'>{props.targetLabel} — {c.driven} driven · {c.shared} sharing · {c.rest} at rest</div>
          {legend((['driven', 'merged', 'shared', 'rest'] as TargetStatus[]).map(s => [colors.target[s], TARGET_LABEL[s]]))}
        </div>
      </div>

      <div className='flex-1 flex min-h-0'>
        {list('source')}
        <div ref={boxRef} className='relative flex-1 min-w-0 bg-surface-sunken'>
          <svg ref={svgRef} width={size.w} height={size.h} className='absolute inset-0 select-none'
            style={{ cursor: drag ? 'grabbing' : hover ? 'pointer' : 'default', touchAction: 'none' }}
            onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
            onPointerLeave={() => { if (!drag) setHover(null) }} onContextMenu={onContextMenu}>
            <line x1={half} y1={0} x2={half} y2={size.h} stroke={colors.divider} strokeWidth={1} />
            <text x={12} y={20} fontSize={12} fill={colors.textMuted}>{props.sourceLabel} — the clips</text>
            <text x={half + 12} y={20} fontSize={12} fill={colors.textMuted}>{props.targetLabel} — the character</text>

            {view.links.map(l => {
              const focused = focusLinks(l)
              if (!focused && !showAll) return null
              const a = posOfNode('source', l.source), b = posOfNode('target', l.target)
              if (!a || !b) return null
              return <path key={`${l.source}-${l.target}`} d={curve(a, b)} fill='none'
                stroke={focused ? colors.link : colors.linkFaint} strokeWidth={focused ? 2 : 1}
                strokeDasharray={l.merged ? '4 3' : undefined} style={{ pointerEvents: 'none' }} />
            })}

            {renderSkeleton('source', layouts.source)}
            {renderSkeleton('target', layouts.target)}

            {drag?.moved && (() => {
              const a = posOfNode('source', drag.from)
              return a && <line x1={a.x} y1={a.y} x2={drag.x} y2={drag.y} stroke={colors.select} strokeWidth={2}
                strokeDasharray='5 4' style={{ pointerEvents: 'none' }} />
            })()}
          </svg>

          {selected !== null && (
            <div className='absolute bottom-2 left-1/2 -translate-x-1/2 px-3 py-1 rounded bg-surface-raised border border-control text-ui-sm'>
              Now click the bone on the right that <b>{sourceSkin.nodeNames?.get(selected)}</b> should drive (Esc to cancel)
            </div>
          )}

          {menu && (
            <div className='absolute z-10 min-w-[200px] rounded border border-control bg-surface-raised shadow-lg p-1 text-ui-sm'
              style={{ left: menu.x, top: menu.y }} onPointerDown={e => e.stopPropagation()}>
              <div className='px-2 py-1 text-ui-xs text-dim truncate'>{sourceSkin.nodeNames?.get(menu.node)}</div>
              <button type='button' className='w-full text-left px-2 py-1 rounded hover:bg-control'
                onClick={() => { onRemap(menu.node, null); setMenu(null) }}>Don't animate this bone</button>
              <button type='button' className='w-full text-left px-2 py-1 rounded hover:bg-control'
                onClick={() => { onAuto(menu.node); setMenu(null) }}>Back to automatic</button>
              <button type='button' className='w-full text-left px-2 py-1 rounded hover:bg-control text-dim'
                onClick={() => setMenu(null)}>Cancel</button>
            </div>
          )}
        </div>
        {list('target')}
      </div>
    </Modal>
  )
}
