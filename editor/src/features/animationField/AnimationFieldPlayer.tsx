import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAnimationField } from './AnimationFieldContext'

// Floating bottom transport for the Animation Field editor: play/scrub plus axis sliders that move the
// probe. The field tab's scene is paused (animationsEnabled = false), so this drives the target animator
// itself via requestAnimationFrame.

export default function AnimationFieldPlayer() {
  const { editorMode, closeTab, activeTabId } = useCleoEngine()
  const { field, target, probe, setProbe, weights } = useAnimationField()

  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const playingRef = useRef(false)
  const lastRef = useRef(0)

  useEffect(() => { playingRef.current = playing }, [playing])

  // The drive loop must read the target through this ref each tick, not close over it, or a mid-flight tab
  // switch leaves it advancing a detached animator.
  const targetRef = useRef(target)
  targetRef.current = target
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = targetRef.current
      if (t && playingRef.current) {
        const now = performance.now()
        const dt = Math.min((now - lastRef.current) / 1000, 0.1)
        lastRef.current = now
        t.animator.update(dt)
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])

  if (editorMode !== 'animationField' || !field) return null

  const animator = target?.animator ?? null
  const is2D = field.mode === '2d'
  const contributing = weights.filter(w => w.weight > 0.001).sort((a, b) => b.weight - a.weight)

  const onPlay = () => {
    if (!animator) return
    animator.play()
    animator.speed = speed
    lastRef.current = performance.now()
    setPlaying(true)
  }
  const onPause = () => { animator?.pause(); setPlaying(false) }
  const onStop = () => {
    if (!animator) return
    animator.stop()
    animator.seek(0)
    setPlaying(false)
  }

  const btn = 'px-2 py-1 rounded bg-control hover:bg-control-hover border border-control-hover text-white'

  return (
    <div
      data-cleo-overlay
      className='absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 flex-col gap-2 rounded border border-border bg-surface-raised/95 px-3 py-2 shadow-lg'
      style={{ minWidth: 540 }}
      onMouseDown={e => e.stopPropagation()}>

      <div className='flex items-center gap-2 text-xs text-white'>
        <button className={btn} title='Play the blend' onClick={onPlay} disabled={playing || !animator}>▶</button>
        <button className={btn} title='Pause' onClick={onPause} disabled={!playing}>❚❚</button>
        <button className={btn} title='Rewind to the start of the cycle' onClick={onStop} disabled={!animator}>■</button>

        <label className='flex items-center gap-1' title='Playback speed'>
          speed
          <input
            className='w-[52px] rounded border border-control-hover bg-control px-1 text-white'
            type='number' step='0.1' min='0' value={speed}
            onChange={e => {
              const v = Math.max(0, parseFloat(e.target.value) || 0)
              setSpeed(v)
              if (animator) animator.speed = v
            }} />
        </label>

        {/* The blended cycle length: the weighted average of the contributing clips' own durations. This is
            what the shared phase is paced against, so it is also the number that gives away a clip whose
            authored length is out of line — if it collapses at one end of the axis, that corner runs fast. */}
        <span className='shrink-0 tabular-nums text-[11px] text-dim'
          title='Length of one full cycle of the blend at this point — the weighted average of the contributing clips'>
          cycle {animator ? animator.duration.toFixed(2) : '0.00'}s
        </span>

        {/* What is actually mixing right now. */}
        <div className='ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-hidden'>
          {contributing.length === 0
            ? <span className='text-[11px] text-gray-400'>No clip is contributing here.</span>
            : contributing.map(w => (
              <span key={w.clipName} className='shrink-0 rounded bg-control px-1.5 py-0.5 text-[10px]'
                title={`${w.clipName} — ${(w.weight * 100).toFixed(1)}%`}>
                <span className='text-white'>{w.clipName}</span>
                <span className='ml-1 tabular-nums text-highlight'>{(w.weight * 100).toFixed(0)}%</span>
              </span>
            ))}
        </div>

        <button className={btn + ' ml-auto shrink-0'} title='Close the Animation Field tab'
          onClick={() => closeTab(activeTabId)}>Close</button>
      </div>

      <AxisSlider
        name={field.xAxis.name} min={field.xAxis.min} max={field.xAxis.max} value={probe.x}
        onChange={v => setProbe(v, probe.y)} />
      {is2D && (
        <AxisSlider
          name={field.yAxis.name} min={field.yAxis.min} max={field.yAxis.max} value={probe.y}
          onChange={v => setProbe(probe.x, v)} />
      )}
    </div>
  )
}

function AxisSlider({ name, min, max, value, onChange }: {
  name: string
  min: number
  max: number
  value: number
  onChange: (v: number) => void
}) {
  // A degenerate range would give the slider a zero step and freeze it.
  const step = Math.abs(max - min) / 100 || 0.01
  return (
    <div className='flex items-center gap-2 text-[11px] text-gray-300'>
      <span className='w-[72px] shrink-0 truncate' title={name}>{name}</span>
      <input
        className='flex-1 accent-[var(--color-primary)]'
        type='range' min={min} max={max} step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value))} />
      <input
        className='w-[64px] shrink-0 rounded border border-control-hover bg-control px-1 text-right tabular-nums text-white'
        type='number' step={step} value={Number(value.toFixed(3))}
        onChange={e => onChange(parseFloat(e.target.value) || 0)} />
    </div>
  )
}
