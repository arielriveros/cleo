import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget } from './skeleton'
import { useStateMachine } from './StateMachineContext'
import { Toggle } from '../../components/ui'
import { clamp } from '../../utils/math';

// Floating bottom transport for the Animation Editor: play/scrub the target clip and host its event
// markers. The editor scene is paused (animators do not tick), so this drives the animator itself
// via requestAnimationFrame.

export default function AnimationPlayer() {
  const { editorScene, animationTargetId, closeTab, activeTabId, eventEmitter } = useCleoEngine()
  const { sm, simulate, setSimulate, addEvent, setEvent } = useStateMachine()

  const [clip, setClip] = useState<string>('')
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)

  const playingRef = useRef(false)
  const simulateRef = useRef(false)
  const lastRef = useRef(0)
  const scrubbingRef = useRef(false)
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** Index into sm.events of the marker being dragged, or -1. */
  const dragRef = useRef(-1)
  const [, force] = useState(0)

  const target = getAnimationTarget(editorScene, animationTargetId)
  const clips = target ? target.model.animations.map(a => a.name) : []
  const hasStateMachine = !!target?.animator.hasStateMachine

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { simulateRef.current = simulate }, [simulate])

  useEffect(() => {
    const onChanged = () => force(x => x + 1)
    eventEmitter.on('ANIM_SM_CHANGED', onChanged)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onChanged)
    return () => { eventEmitter.off('ANIM_SM_CHANGED', onChanged); eventEmitter.off('ANIM_CLIPS_CHANGED', onChanged) }
  }, [eventEmitter])

  // On (re)entry, park on the first clip's first frame in bind pose.
  useEffect(() => {
    if (!target) return
    const first = target.model.animations[0]?.name ?? ''
    setClip(first)
    if (first) {
      target.animator.playAnimationByName(first, loop, false)
      target.animator.pause()
      target.animator.seek(0)
      setDuration(target.animator.duration)
    }
    target.animator.showBindPose()
    setPlaying(false)
    setTime(0)
    lastRef.current = performance.now()
    // Leave the model in bind pose when exiting the Animation Editor.
    return () => { target.animator.showBindPose() }
  }, [animationTargetId])

  // Per-frame drive loop.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = getAnimationTarget(editorScene, animationTargetId)
      if (t) {
        const now = performance.now()
        const dt = Math.min((now - lastRef.current) / 1000, 0.1)
        lastRef.current = now
        if (playingRef.current && !scrubbingRef.current) {
          if (simulateRef.current && t.animator.hasStateMachine) t.animator.checkTriggers()
          t.animator.update(dt)
          setTime(t.animator.currentTime)
          setDuration(t.animator.duration)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [editorScene, animationTargetId])

  if (!target) {
    return (
      <div data-cleo-overlay className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 bg-surface-raised/95 border border-border rounded px-3 py-2 text-xs text-gray-400'>
        No skinned model selected — <button className='underline' onClick={() => closeTab(activeTabId)}>close</button>
      </div>
    )
  }

  const animator = target.animator
  /** Markers for the clip on screen, carrying their index so a drag can write straight back to sm.events. */
  const markers = sm.events.map((e, i) => ({ e, i })).filter(({ e }) => e.clipName === clip)

  const selectClip = (name: string) => {
    setClip(name)
    setSimulate(false)
    animator.playAnimationByName(name, loop, false)
    animator.pause()
    animator.seek(0)
    setDuration(animator.duration)
    setPlaying(false)
    setTime(0)
  }

  const onPlay = () => {
    if (simulate && hasStateMachine) {
      animator.resetStateMachine()
    } else if (clip && animator.currentAnimation?.name !== clip) {
      animator.playAnimationByName(clip, loop, false)
    } else {
      animator.play()
    }
    animator.loop = loop
    animator.speed = speed
    lastRef.current = performance.now()
    setPlaying(true)
  }
  const onPause = () => { animator.pause(); setPlaying(false) }
  const onStop = () => {
    animator.stop()
    animator.showBindPose()
    setPlaying(false)
    setTime(0)
  }
  const onScrub = (v: number) => {
    scrubbingRef.current = true
    if (clip && animator.currentAnimation?.name !== clip) animator.playAnimationByName(clip, loop, false)
    animator.pause()
    animator.seek(v)
    setTime(v)
    setPlaying(false)
    requestAnimationFrame(() => { scrubbingRef.current = false })
  }

  /** Clientspace X → clip time, clamped to the track. */
  const timeAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return 0
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }

  const onTrackDown = (e: React.PointerEvent) => {
    if (dragRef.current >= 0) return // a marker grabbed it first
    onScrub(timeAt(e.clientX))
    const move = (ev: PointerEvent) => onScrub(timeAt(ev.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // Drag listeners go on `window`, not the panel: a pointer that leaves the track mid-drag must keep
  // being tracked.
  const onMarkerDown = (e: React.PointerEvent, index: number) => {
    e.stopPropagation() // otherwise the track underneath seeks to wherever the marker was grabbed
    dragRef.current = index
    const move = (ev: PointerEvent) => setEvent(index, { time: timeAt(ev.clientX) })
    const up = () => {
      dragRef.current = -1
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const btn = 'px-2 py-1 rounded bg-control hover:bg-control-hover border border-control-hover text-white'
  const fmt = (s: number) => `${s.toFixed(2)}s`
  const pct = (t: number) => `${duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0}%`

  return (
    <div
      data-cleo-overlay
      className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col gap-2 bg-surface-raised/95 border border-border rounded px-3 py-2 shadow-lg'
      style={{ minWidth: 520 }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className='flex items-center gap-2 text-xs text-white'>
        <select
          className='bg-control text-white border border-control-hover rounded px-2 py-1 max-w-[160px]'
          value={clip}
          onChange={(e) => selectClip(e.target.value)}
          title='Animation clip'>
          {clips.length === 0 && <option value=''>No clips</option>}
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </select>

        <button className={btn} title='Play' onClick={onPlay} disabled={playing}>▶</button>
        <button className={btn} title='Pause' onClick={onPause} disabled={!playing}>❚❚</button>
        <button className={btn} title='Stop (T-pose)' onClick={onStop}>■</button>

        <Toggle label='loop' className='ml-1' checked={loop}
          onChange={(c) => { setLoop(c); animator.loop = c }} />
        <label className='flex items-center gap-1' title='Playback speed'>
          speed
          <input
            className='w-[52px] bg-control text-white border border-control-hover rounded px-1'
            type='number' step='0.1' min='0' value={speed}
            onChange={(e) => { const v = Math.max(0, parseFloat(e.target.value) || 0); setSpeed(v); animator.speed = v }} />
        </label>

        <button
          className={btn + ' ml-1 border-red-700'}
          disabled={!clip}
          title={clip ? `Drop an event marker on "${clip}" at the playhead — drag it to move it` : 'Pick a clip first'}
          onClick={() => addEvent({ clipName: clip, time, eventName: 'event' })}>
          + Event
        </button>

        <button className={btn + ' ml-auto'} title='Close the Animation Editor tab' onClick={() => closeTab(activeTabId)}>Close</button>
      </div>

      <div className='flex items-center gap-2 text-[11px] text-gray-300'>
        <span className='tabular-nums w-[46px] text-right'>{fmt(time)}</span>

        {/* Track: click/drag anywhere to seek; red circles are this clip's event markers. */}
        <div ref={trackRef} className='relative flex-1 h-4 cursor-pointer select-none' onPointerDown={onTrackDown}>
          <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-control-hover' />
          <div className='absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded bg-primary' style={{ width: pct(time) }} />
          {/* Playhead */}
          <div className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-white pointer-events-none'
            style={{ left: pct(time) }} />
          {markers.map(({ e, i }) => (
            <div
              key={i}
              className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2.5 h-2.5 rounded-full bg-red-500 border border-red-300 cursor-grab active:cursor-grabbing hover:scale-125 transition-transform'
              style={{ left: pct(e.time) }}
              title={`${e.eventName} @ ${e.time.toFixed(2)}s — drag to move`}
              onPointerDown={ev => onMarkerDown(ev, i)} />
          ))}
        </div>

        <span className='tabular-nums w-[46px]'>{fmt(duration)}</span>
        {simulate && hasStateMachine && <span className='text-highlight'>state: {animator.currentStateName ?? '—'}</span>}
      </div>
    </div>
  )
}
