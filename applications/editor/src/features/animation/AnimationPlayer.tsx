import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { getAnimationTarget } from './skeleton'
import { useStateMachine } from './StateMachineContext'
import ClipEventsTrack, { TRACK_GUTTER, TRACK_TAIL } from './ClipEventsTrack'
import { Button, NumberInput, Select, Toggle, cn } from '@cleo/app-kit/ui'
import { clamp } from '@cleo/app-kit/utils/math';

// Floating bottom transport for the Animator and Skeleton parts: play/scrub a clip on the preview character,
// with the clip's Events track under it. The editor scene is paused (animators do not tick), so this drives
// the animator itself via requestAnimationFrame.
//
// Events are the CLIP's, written to its `.anim` (ClipEventsTrack) — the animator no longer holds its own.
// A machine still carrying markers from before shows them read-only on the track; they keep firing.

export default function AnimationPlayer() {
  const { editorScene, skeletonTargetId, closeTab, activeTabId, eventEmitter } = useCleoEngine()
  const { sm, simulate, setSimulate } = useStateMachine()

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
  const [, force] = useState(0)

  const target = getAnimationTarget(editorScene, skeletonTargetId)
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
  }, [skeletonTargetId])

  // Per-frame drive loop.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = getAnimationTarget(editorScene, skeletonTargetId)
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
  }, [editorScene, skeletonTargetId])

  if (!target) {
    return (
      <div data-cleo-overlay className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 bg-surface-raised/95 border border-border rounded px-3 py-2 text-ui text-muted'>
        No skinned model selected — <Button variant='ghost' size='sm' className='px-0 py-0 underline' onClick={() => closeTab(activeTabId)}>close</Button>
      </div>
    )
  }

  const animator = target.animator
  /** The clip on screen as the character holds it: `assetId` names the `.anim` its events are written to. */
  const current = target.model.animations.find(a => a.name === clip)
  /** The animator's own markers on this clip — what `liftMachineEvents` could not move (an embedded clip). */
  const legacy = sm.events.filter(e => e.clipName === clip).map(e => ({ time: e.time, name: e.eventName }))

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

  // Drag listeners go on `window`, not the panel: a pointer that leaves the track mid-drag must keep
  // being tracked.
  const onTrackDown = (e: React.PointerEvent) => {
    onScrub(timeAt(e.clientX))
    const move = (ev: PointerEvent) => onScrub(timeAt(ev.clientX))
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const fmt = (s: number) => `${s.toFixed(2)}s`
  const pct = (t: number) => `${duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0}%`

  return (
    <div
      data-cleo-overlay
      className='absolute bottom-3 left-1/2 -translate-x-1/2 z-20 flex flex-col gap-2 bg-surface-raised/95 border border-border rounded px-3 py-2 shadow-lg'
      style={{ minWidth: 520 }}
      onMouseDown={(e) => e.stopPropagation()}>
      <div className='flex items-center gap-2 text-ui text-fg'>
        <Select
          className='max-w-[160px]'
          value={clip}
          onChange={(e) => selectClip(e.target.value)}
          title='Animation clip'>
          {clips.length === 0 && <option value=''>No clips</option>}
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>

        <Button title='Play' onClick={onPlay} disabled={playing}>▶</Button>
        <Button title='Pause' onClick={onPause} disabled={!playing}>❚❚</Button>
        <Button title='Stop (T-pose)' onClick={onStop}>■</Button>

        <Toggle label='loop' className='ml-1' checked={loop}
          onChange={(c) => { setLoop(c); animator.loop = c }} />
        <label className='flex items-center gap-1' title='Playback speed'>
          speed
          <NumberInput
            className='w-[52px] px-1 py-0'
            step='0.1' min='0' value={speed}
            onChange={(n) => { const v = Math.max(0, n); setSpeed(v); animator.speed = v }} />
        </label>

        <Button className='ml-auto' title='Close the Animation Editor tab' onClick={() => closeTab(activeTabId)}>Close</Button>
      </div>

      <div className='flex items-center gap-2 text-ui-sm text-muted'>
        <span className={cn(TRACK_GUTTER, 'shrink-0 tabular-nums text-right')}>{fmt(time)}</span>

        {/* Track: click/drag anywhere to seek. */}
        <div ref={trackRef} className='relative flex-1 h-4 cursor-pointer select-none' onPointerDown={onTrackDown}>
          <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-control-hover' />
          <div className='absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded bg-primary' style={{ width: pct(time) }} />
          {/* Playhead */}
          <div className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-fg pointer-events-none'
            style={{ left: pct(time) }} />
        </div>

        <span className={cn(TRACK_TAIL, 'shrink-0 tabular-nums')}>{fmt(duration)}</span>
      </div>

      <ClipEventsTrack assetId={current?.assetId} clipName={clip || undefined} duration={duration} time={time}
        onSeek={onScrub} embedded={current?.events} legacy={legacy} />

      {simulate && hasStateMachine && <span className='text-ui-sm text-highlight'>state: {animator.currentStateName ?? '—'}</span>}
    </div>
  )
}
