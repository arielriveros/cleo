import { useCallback, useEffect, useRef, useState } from 'react'
import type { Peaks } from './waveform'

// The waveform view: the envelope, the playhead, and the loop region as two draggable handles.
//
// Dragging the region is the point of this component. Loop points are the one setting you cannot author
// as a number — "start it just after the transient" is a thing you find by eye and ear, not by typing
// 1.37 — so the panel offers both, and this is the half that makes the numbers discoverable.
//
// Everything is drawn on one canvas at device-pixel resolution and repainted whenever the playhead or the
// region moves. The envelope itself is precomputed (see waveform.ts), so a repaint is a few hundred
// lineTo calls and costs nothing.

type Props = {
  peaks: Peaks | null
  duration: number
  position: number
  playing: boolean
  loop: boolean
  loopStart: number
  /** 0 means "to the end of the file". */
  loopEnd: number
  onLoopRegion: (start: number, end: number) => void
  /** Click on the waveform body — used to scrub, and to clear a region by clicking outside it. */
  onSeek?: (seconds: number) => void
}

/** Which handle a pointer-down grabbed. */
type Drag = 'start' | 'end' | null

const HANDLE_HIT_PX = 7

export default function SoundWaveform(props: Props) {
  const { peaks, duration, position, playing, loop, loopStart, loopEnd, onLoopRegion, onSeek } = props
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [drag, setDrag] = useState<Drag>(null)
  const [hover, setHover] = useState<Drag>(null)

  // The region as actual seconds, resolving the "0 means the whole file" convention once so neither the
  // painter nor the hit test has to know about it.
  const regionStart = loop ? Math.min(loopStart, duration) : 0
  const regionEnd = loop ? (loopEnd > loopStart ? Math.min(loopEnd, duration) : duration) : 0
  const hasRegion = loop && duration > 0 && regionEnd > regionStart

  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const observer = new ResizeObserver(() => {
      setSize({ width: el.clientWidth, height: el.clientHeight })
    })
    observer.observe(el)
    setSize({ width: el.clientWidth, height: el.clientHeight })
    return () => observer.disconnect()
  }, [])

  // ---- Paint ------------------------------------------------------------------------------------

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.width || !size.height) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(size.width * dpr)
    canvas.height = Math.round(size.height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, size.width, size.height)

    const w = size.width
    const h = size.height
    const mid = h / 2
    const xOf = (seconds: number) => (duration > 0 ? (seconds / duration) * w : 0)

    // Region shading first, so the waveform draws over it.
    if (hasRegion) {
      const x0 = xOf(regionStart)
      const x1 = xOf(regionEnd)
      // Outside the loop is dimmed rather than the inside being highlighted: what plays is the normal
      // state, and what is skipped is the exception.
      ctx.fillStyle = 'rgba(0,0,0,0.28)'
      ctx.fillRect(0, 0, x0, h)
      ctx.fillRect(x1, 0, w - x1, h)
      ctx.fillStyle = 'rgba(127,178,217,0.10)'
      ctx.fillRect(x0, 0, x1 - x0, h)
    }

    // Zero line.
    ctx.strokeStyle = 'rgba(255,255,255,0.14)'
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.moveTo(0, mid + 0.5)
    ctx.lineTo(w, mid + 0.5)
    ctx.stroke()

    if (peaks && peaks.buckets > 0) {
      ctx.strokeStyle = '#7fb2d9'
      ctx.lineWidth = 1
      ctx.beginPath()
      // One vertical stroke per PIXEL column, folding however many buckets fall in it — drawing per
      // bucket instead would overdraw at narrow widths and alias badly at wide ones.
      for (let px = 0; px < w; px++) {
        const from = Math.floor((px / w) * peaks.buckets)
        const to = Math.max(from + 1, Math.floor(((px + 1) / w) * peaks.buckets))
        let lo = 0
        let hi = 0
        for (let i = from; i < to && i < peaks.buckets; i++) {
          if (peaks.min[i] < lo) lo = peaks.min[i]
          if (peaks.max[i] > hi) hi = peaks.max[i]
        }
        const y0 = mid - hi * mid * 0.94
        const y1 = mid - lo * mid * 0.94
        ctx.moveTo(px + 0.5, y0)
        ctx.lineTo(px + 0.5, Math.max(y1, y0 + 0.5))
      }
      ctx.stroke()
    }

    // Loop handles, on top of the waveform so they stay grabbable over a loud passage.
    if (hasRegion) {
      for (const [seconds, which] of [[regionStart, 'start'], [regionEnd, 'end']] as const) {
        const x = xOf(seconds)
        ctx.strokeStyle = hover === which || drag === which ? '#ffd27a' : '#7fb2d9'
        ctx.lineWidth = hover === which || drag === which ? 2 : 1.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, h)
        ctx.stroke()
        ctx.fillStyle = hover === which || drag === which ? '#ffd27a' : '#7fb2d9'
        ctx.fillRect(which === 'start' ? x : x - 5, 0, 5, 9)
        ctx.fillRect(which === 'start' ? x : x - 5, h - 9, 5, 9)
      }
    }

    // Playhead last — it must be visible over everything else.
    if (playing || position > 0) {
      const x = xOf(position)
      ctx.strokeStyle = '#ffffff'
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(x + 0.5, 0)
      ctx.lineTo(x + 0.5, h)
      ctx.stroke()
    }
  }, [peaks, size, duration, position, playing, hasRegion, regionStart, regionEnd, hover, drag])

  // ---- Interaction ------------------------------------------------------------------------------

  const secondsAt = useCallback((clientX: number): number => {
    const canvas = canvasRef.current
    if (!canvas || duration <= 0) return 0
    const rect = canvas.getBoundingClientRect()
    const t = ((clientX - rect.left) / rect.width) * duration
    return Math.min(duration, Math.max(0, t))
  }, [duration])

  const handleAt = useCallback((clientX: number): Drag => {
    if (!hasRegion) return null
    const canvas = canvasRef.current
    if (!canvas || duration <= 0) return null
    const rect = canvas.getBoundingClientRect()
    const x = clientX - rect.left
    const xOf = (seconds: number) => (seconds / duration) * rect.width
    if (Math.abs(x - xOf(regionStart)) <= HANDLE_HIT_PX) return 'start'
    if (Math.abs(x - xOf(regionEnd)) <= HANDLE_HIT_PX) return 'end'
    return null
  }, [hasRegion, duration, regionStart, regionEnd])

  const onPointerDown = (e: React.PointerEvent) => {
    const grabbed = handleAt(e.clientX)
    if (grabbed) {
      setDrag(grabbed)
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    onSeek?.(secondsAt(e.clientX))
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) { setHover(handleAt(e.clientX)); return }
    const t = secondsAt(e.clientX)
    // A minimum width keeps the two handles from crossing, which would produce a region the engine reads
    // as "no region at all" and silently drop.
    const min = Math.min(0.01, duration / 100)
    if (drag === 'start') onLoopRegion(Math.min(t, regionEnd - min), regionEnd)
    else onLoopRegion(regionStart, Math.max(t, regionStart + min))
  }

  const endDrag = (e: React.PointerEvent) => {
    if (!drag) return
    setDrag(null)
    try { e.currentTarget.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
  }

  return (
    <div ref={wrapRef} className='relative w-full h-full min-h-[120px]'>
      <canvas
        ref={canvasRef}
        className='w-full h-full block'
        style={{ cursor: drag || hover ? 'ew-resize' : 'crosshair' }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onPointerLeave={() => setHover(null)}
      />
      {!peaks && (
        <div className='absolute inset-0 flex items-center justify-center text-xs opacity-60 pointer-events-none'>
          {duration > 0 ? 'Waveform unavailable for this format' : 'Decoding…'}
        </div>
      )}
    </div>
  )
}
