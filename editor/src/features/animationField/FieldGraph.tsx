import { useCallback, useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAnimationField } from './AnimationFieldContext'
import { clamp } from '../../utils/math';

// The blend-space plot: the Animation Field mode's work surface, docked as the "Blend Space" tab in the
// bottom strip beside Logger and Assets (see panels.tsx / DockLayout.tsx) so the viewport stays clear for
// the pose it is authoring against. Hand-rolled SVG because a sample's position IS its data, in real axis
// units. Drag a sample to move it in axis space; drag anywhere else to move the probe.

const PAD = { left: 56, right: 20, top: 20, bottom: 44 }
/** How close (in px) a pointer must be to grab a sample instead of moving the probe. */
const GRAB_RADIUS = 14

export default function FieldGraph() {
  const { editorMode } = useCleoEngine()
  const { field, clips, weights, probe, setProbe, setSample, addSample, selected, setSelected, removeSample } = useAnimationField()

  const boxRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ w: 640, h: 420 })
  /** Index of the sample being dragged, or -1 (the probe is being dragged). */
  const dragRef = useRef<number | null>(null)

  // The plot is drawn in pixel coordinates, so it must re-measure on every box change, not just on window
  // resize: panel drags, sidebar resizes and mode switches all move it.
  const measure = useCallback((el: HTMLDivElement | null) => {
    boxRef.current = el
  }, [])
  useEffect(() => {
    const el = boxRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      if (!r) return
      setSize(prev => (Math.abs(r.width - prev.w) > 1 || Math.abs(r.height - prev.h) > 1
        ? { w: r.width, h: r.height } : prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
    // Re-observed when the box appears: the early return below means it does not exist until a field is open.
  }, [editorMode, !!field])

  if (editorMode !== 'animationField') return null
  // A message rather than null: this is a dock panel now, and an empty tab body reads as a broken panel.
  if (!field) return <div className='flex h-full w-full flex-col bg-surface-raised p-3 text-sm text-gray-400'>No animation field open.</div>

  const is2D = field.mode === '2d'
  const plotW = Math.max(1, size.w - PAD.left - PAD.right)
  const plotH = Math.max(1, size.h - PAD.top - PAD.bottom)

  // Axis <-> pixel. The Y axis is inverted: SVG grows downward, a graph's Y grows upward. In 1D every
  // sample sits at the vertical midpoint.
  const spanX = field.xAxis.max - field.xAxis.min || 1
  const spanY = field.yAxis.max - field.yAxis.min || 1
  const px = (x: number) => PAD.left + ((x - field.xAxis.min) / spanX) * plotW
  const py = (y: number) => (is2D ? PAD.top + plotH - ((y - field.yAxis.min) / spanY) * plotH : PAD.top + plotH / 2)
  const ux = (clientX: number, rect: DOMRect) =>
    field.xAxis.min + clamp((clientX - rect.left - PAD.left) / plotW, 0, 1) * spanX
  const uy = (clientY: number, rect: DOMRect) =>
    field.yAxis.min + (1 - clamp((clientY - rect.top - PAD.top) / plotH, 0, 1)) * spanY

  const weightOf = (clipName: string) => weights.find(w => w.clipName === clipName)?.weight ?? 0

  /** The sample within grab range of a point, nearest first, or -1. */
  const sampleAt = (clientX: number, clientY: number, rect: DOMRect): number => {
    let best = -1
    let bestD = GRAB_RADIUS * GRAB_RADIUS
    field.samples.forEach((s, i) => {
      const dx = clientX - rect.left - px(s.x)
      const dy = clientY - rect.top - py(s.y ?? 0)
      const d = dx * dx + dy * dy
      if (d <= bestD) { bestD = d; best = i }
    })
    return best
  }

  const onPointerDown = (e: React.PointerEvent) => {
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const hit = sampleAt(e.clientX, e.clientY, rect)
    dragRef.current = hit
    if (hit >= 0) setSelected(hit)
    else setProbe(ux(e.clientX, rect), is2D ? uy(e.clientY, rect) : probe.y)

    // Listeners must go on `window`, not the SVG: a pointer that leaves the plot mid-drag has to keep
    // being tracked.
    const move = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect()
      const i = dragRef.current
      if (i === null) return
      if (i >= 0) {
        const patch: { x: number; y?: number } = { x: ux(ev.clientX, r) }
        if (is2D) patch.y = uy(ev.clientY, r)
        setSample(i, patch)
      } else {
        setProbe(ux(ev.clientX, r), is2D ? uy(ev.clientY, r) : probe.y)
      }
    }
    const up = () => {
      dragRef.current = null
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const onDoubleClick = (e: React.MouseEvent) => {
    const el = boxRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    if (sampleAt(e.clientX, e.clientY, rect) >= 0) return // double-clicking an existing sample is not "add"
    addSample({ x: ux(e.clientX, rect), y: uy(e.clientY, rect) })
  }

  const ticks = (min: number, max: number, n = 4) =>
    Array.from({ length: n + 1 }, (_, i) => min + ((max - min) * i) / n)

  const fmt = (v: number) => (Math.abs(v) >= 100 || Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1))

  return (
    <div className='flex h-full w-full flex-col overflow-hidden bg-surface-raised'>

      <div className='m-3 mb-1 flex items-center gap-2 self-start rounded border border-border bg-surface-raised/95 px-2 py-1 text-[11px] text-muted shadow-panel'>
        <span className='text-white'>{field.name}</span>
        <span className='text-dim'>·</span>
        <span>{is2D ? '2D' : '1D'} blend space</span>
        <span className='text-dim'>·</span>
        <span className='text-dim'>double-click to add · drag a point to move it · drag elsewhere to preview</span>
      </div>

      <div ref={measure} className='relative mx-3 mb-3 flex-1 rounded border border-border bg-surface-raised/80 shadow-panel'>
        <svg
          width='100%' height='100%'
          className='cursor-crosshair'
          onPointerDown={onPointerDown}
          onDoubleClick={onDoubleClick}>

          {/* Grid + axes */}
          {ticks(field.xAxis.min, field.xAxis.max).map((t, i) => (
            <g key={`x${i}`}>
              <line x1={px(t)} y1={PAD.top} x2={px(t)} y2={PAD.top + plotH}
                stroke='currentColor' className='text-border' strokeOpacity={0.5} />
              <text x={px(t)} y={PAD.top + plotH + 16} textAnchor='middle'
                className='fill-current text-dim' style={{ fontSize: 10 }}>{fmt(t)}</text>
            </g>
          ))}
          {is2D && ticks(field.yAxis.min, field.yAxis.max).map((t, i) => (
            <g key={`y${i}`}>
              <line x1={PAD.left} y1={py(t)} x2={PAD.left + plotW} y2={py(t)}
                stroke='currentColor' className='text-border' strokeOpacity={0.5} />
              <text x={PAD.left - 8} y={py(t) + 3} textAnchor='end'
                className='fill-current text-dim' style={{ fontSize: 10 }}>{fmt(t)}</text>
            </g>
          ))}
          {!is2D && (
            <line x1={PAD.left} y1={py(0)} x2={PAD.left + plotW} y2={py(0)}
              stroke='currentColor' className='text-muted' strokeWidth={1.5} />
          )}

          {/* Axis names */}
          <text x={PAD.left + plotW / 2} y={size.h - 10} textAnchor='middle'
            className='fill-current text-muted' style={{ fontSize: 11 }}>{field.xAxis.name}</text>
          {is2D && (
            <text x={14} y={PAD.top + plotH / 2} textAnchor='middle'
              transform={`rotate(-90 14 ${PAD.top + plotH / 2})`}
              className='fill-current text-muted' style={{ fontSize: 11 }}>{field.yAxis.name}</text>
          )}

          {/* Probe: crosshair + the point the field is sampled at. */}
          <g pointerEvents='none'>
            <line x1={px(probe.x)} y1={PAD.top} x2={px(probe.x)} y2={PAD.top + plotH}
              className='stroke-current text-highlight' strokeDasharray='3 3' strokeOpacity={0.8} />
            {is2D && (
              <line x1={PAD.left} y1={py(probe.y)} x2={PAD.left + plotW} y2={py(probe.y)}
                className='stroke-current text-highlight' strokeDasharray='3 3' strokeOpacity={0.8} />
            )}
            <circle cx={px(probe.x)} cy={py(probe.y)} r={5}
              className='fill-current text-highlight' fillOpacity={0.85} />
          </g>

          {/* Samples. Radius and fill track the live weight, so which clips are contributing — and how
              much — is readable straight off the plot instead of only in a list. */}
          {field.samples.map((s, i) => {
            const w = weightOf(s.clipName)
            const active = w > 0.001
            const r = 6 + w * 8
            const missing = !!s.clipName && !clips.includes(s.clipName)
            return (
              <g key={i} className='cursor-grab'>
                {active && (
                  <circle cx={px(s.x)} cy={py(s.y ?? 0)} r={r + 6}
                    className='fill-current text-primary' fillOpacity={0.12 + w * 0.18} pointerEvents='none' />
                )}
                <circle
                  cx={px(s.x)} cy={py(s.y ?? 0)} r={r}
                  className={`fill-current ${missing ? 'text-red-500' : active ? 'text-primary' : 'text-control-hover'}`}
                  stroke='currentColor'
                  strokeWidth={selected === i ? 2.5 : 1}
                  strokeOpacity={selected === i ? 1 : 0.6} />
                <text
                  x={px(s.x)} y={py(s.y ?? 0) - r - 6} textAnchor='middle' pointerEvents='none'
                  className={`fill-current ${missing ? 'text-red-400' : active ? 'text-white' : 'text-dim'}`}
                  style={{ fontSize: 10 }}>
                  {s.clipName || '(no clip)'}{active ? ` ${(w * 100).toFixed(0)}%` : ''}
                </text>
                {missing && (
                  <title>{`"${s.clipName}" is not a clip on this model`}</title>
                )}
              </g>
            )
          })}
        </svg>

        {field.samples.length === 0 && (
          <div className='pointer-events-none absolute inset-0 flex items-center justify-center'>
            <p className='rounded border border-border bg-surface-raised px-3 py-2 text-xs text-muted'>
              {clips.length === 0
                ? 'This model has no animation clips to blend.'
                : 'Double-click anywhere to drop the first clip.'}
            </p>
          </div>
        )}

        {/* Delete the selected sample without hunting for its row in the sidebar. */}
        {selected >= 0 && selected < field.samples.length && (
          <button
            className='absolute right-2 top-2 rounded bg-red-700 px-2 py-0.5 text-[11px] text-white hover:bg-red-600'
            title='Remove the selected sample'
            onClick={() => removeSample(selected)}>
            ✕ Remove “{field.samples[selected].clipName || 'sample'}”
          </button>
        )}
      </div>
    </div>
  )
}
