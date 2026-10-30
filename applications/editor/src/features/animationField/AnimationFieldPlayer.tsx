import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useAnimationField } from './AnimationFieldContext'
import { Button, NumberInput, Slider } from '@cleo/app-kit/ui'

// The Animation Field editor's transport, docked under the plot inside the "Blend Space" bottom tab:
// play/scrub plus axis sliders that move the probe. The field tab's scene is paused
// (animationsEnabled = false), so this drives the target animator itself via requestAnimationFrame.

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

  return (
    <div className='flex shrink-0 flex-col gap-2 border-t border-border bg-surface-raised px-3 py-2'>

      {/* Wraps rather than holding a minimum width: the bottom strip can be dragged narrow. */}
      <div className='flex flex-wrap items-center gap-2 text-ui text-fg'>
        <Button title='Play the blend' onClick={onPlay} disabled={playing || !animator}>▶</Button>
        <Button title='Pause' onClick={onPause} disabled={!playing}>❚❚</Button>
        <Button title='Rewind to the start of the cycle' onClick={onStop} disabled={!animator}>■</Button>

        <label className='flex items-center gap-1' title='Playback speed'>
          speed
          <NumberInput
            className='w-[52px] px-1 py-0'
            step='0.1' min='0' value={speed}
            onChange={n => {
              const v = Math.max(0, n)
              setSpeed(v)
              if (animator) animator.speed = v
            }} />
        </label>

        {/* The blended cycle length: the weighted average of the contributing clips' own durations. This is
            what the shared phase is paced against, so it is also the number that gives away a clip whose
            authored length is out of line — if it collapses at one end of the axis, that corner runs fast. */}
        <span className='shrink-0 tabular-nums text-ui-sm text-dim'
          title='Length of one full cycle of the blend at this point — the weighted average of the contributing clips'>
          cycle {animator ? animator.duration.toFixed(2) : '0.00'}s
        </span>

        {/* What is actually mixing right now. */}
        <div className='ml-2 flex min-w-0 flex-1 items-center gap-2 overflow-hidden'>
          {contributing.length === 0
            ? <span className='text-ui-sm text-muted'>No clip is contributing here.</span>
            : contributing.map(w => (
              <span key={w.clipName} className='shrink-0 rounded bg-control px-1.5 py-0.5 text-ui-xs'
                title={`${w.clipName} — ${(w.weight * 100).toFixed(1)}%`}>
                <span className='text-fg'>{w.clipName}</span>
                <span className='ml-1 tabular-nums text-highlight'>{(w.weight * 100).toFixed(0)}%</span>
              </span>
            ))}
        </div>

        <Button className='ml-auto shrink-0' title='Close the Blend Space tab'
          onClick={() => closeTab(activeTabId)}>Close</Button>
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
    <div className='flex items-center gap-2'>
      <Slider
        className='my-0 min-w-0 flex-1' labelClassName='w-[72px]' title={name}
        label={name} readout={false} min={min} max={max} step={step} value={value}
        onChange={onChange} />
      <NumberInput
        className='w-[64px] shrink-0 px-1 py-0 text-right'
        step={step} value={Number(value.toFixed(3))}
        onChange={onChange} />
    </div>
  )
}
