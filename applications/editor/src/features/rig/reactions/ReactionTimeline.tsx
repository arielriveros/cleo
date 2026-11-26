import { useEffect, useRef } from 'react'
import { BEHAVIOUR_SPECS } from 'cleo'
import { benchStore } from './benchStore'

// The bench's timeline: the last seconds of a reaction, one row for its state and one per behaviour, each
// behaviour's row as bright as it ran. Click (or drag) to scrub the replay: it pauses the bench there.

const STATES: Record<string, string> = {
  animated: '#3b4252', hitReact: '#ebcb8b', stagger: '#d08770', falling: '#bf616a', tumble: '#b48ead',
  down: '#5e81ac', getUp: '#a3be8c', recover: '#8fbcbb', dead: '#4c566a',
}
const ROW = 7

export default function ReactionTimeline() {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    let raf = 0
    const draw = () => {
      raf = requestAnimationFrame(draw)
      const c = canvas.current
      if (!c) return
      const ctx = c.getContext('2d')
      if (!ctx) return
      const w = c.clientWidth, rows = BEHAVIOUR_SPECS.length + 1, h = rows * ROW + 4
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      ctx.clearRect(0, 0, w, h)
      const rec = benchStore.recorder, n = rec.count
      if (n === 0) return
      for (let i = 0; i < n; i++) {
        const f = rec.at(i)!
        const x = Math.floor(i / n * w), x2 = Math.max(x + 1, Math.floor((i + 1) / n * w))
        ctx.fillStyle = STATES[f.state] ?? '#888'
        ctx.fillRect(x, 0, x2 - x, ROW - 1)
        BEHAVIOUR_SPECS.forEach((b, k) => {
          const weight = f.behaviours[b.id] ?? 0
          if (weight <= 0) return
          ctx.fillStyle = `rgba(136, 192, 208, ${0.25 + 0.75 * weight})`
          ctx.fillRect(x, (k + 1) * ROW + 2, x2 - x, ROW - 1)
        })
      }
      const scrub = benchStore.get().scrub
      if (scrub !== null) {
        ctx.fillStyle = '#fff'
        ctx.fillRect(Math.round(scrub * (w - 1)), 0, 1, h)
      }
    }
    raf = requestAnimationFrame(draw)
    return () => cancelAnimationFrame(raf)
  }, [])

  const scrubAt = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    benchStore.set({ paused: true, scrub: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) })
  }

  return (
    <div>
      <canvas ref={canvas} className='w-full block rounded bg-surface-sunken cursor-col-resize'
        title='What the reaction did: its state on top, then each behaviour by how strongly it ran. Click or drag to replay that moment.'
        onMouseDown={scrubAt} onMouseMove={e => { if (e.buttons & 1) scrubAt(e) }} />
      <div className='flex flex-wrap gap-x-2 text-ui-xs text-muted mt-0.5'>
        {Object.entries(STATES).map(([s, color]) => (
          <span key={s} className='inline-flex items-center gap-0.5'><span className='inline-block w-2 h-2 rounded-sm' style={{ background: color }} />{s}</span>
        ))}
      </div>
    </div>
  )
}
