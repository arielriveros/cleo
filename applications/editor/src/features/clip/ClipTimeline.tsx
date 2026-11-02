import { useEffect, useRef, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import { useClip } from './ClipContext'
import { getAnimationTarget } from '../animation/skeleton'
import { applyPreviewClips } from './clipPreview'
import ClipEventsTrack, { TRACK_GUTTER, TRACK_TAIL } from '../animation/ClipEventsTrack'
import type { AnimationAsset } from '../../utils/animationAssets'
import { Button, NumberInput, Select, Toggle, cn } from '@cleo/app-kit/ui'
import { clamp } from '@cleo/app-kit/utils/math'

// The Clip Player's transport, in the bottom strip beside Logger and Assets: the clip, play / pause / stop,
// loop and speed, the scrubber, and the clip's Events track under it.
//
// It is `renderer: 'always'` in the dock (see assertRenderers): the rAF loop below is what poses the
// character, and dockview would otherwise unmount it the moment the user looked at the Logger.

/**
 * What decides the pose a clip asset produces: every clip's curves, edit stack and root-motion flag, by
 * identity. Events are left out on purpose — an events write replaces the asset object, and re-binding the
 * preview for it would stop playback for a change that moves no bone.
 */
function poseParts(asset: AnimationAsset | null): unknown[] {
  return asset ? asset.clips.flatMap(c => [c.name, c.samplers, c.channels, c.edits, c.rootMotion]) : []
}
const sameParts = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i])

export default function ClipTimeline() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const { asset, clipName, selectClip } = useClip()

  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)

  const playingRef = useRef(false)
  const lastRef = useRef(0)
  const scrubbingRef = useRef(false)
  const timeRef = useRef(0)
  const trackRef = useRef<HTMLDivElement | null>(null)

  const target = getAnimationTarget(editorScene, skeletonTargetId)

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { timeRef.current = time }, [time])

  /**
   * Put the asset's clips on the preview character when the clip, the character or the clips' motion
   * changes — not on an events write. The playhead is kept, so a change to the clip (removing its legacy
   * edits, switching root motion) is seen on the same frame.
   */
  const applied = useRef<{ key: string; parts: unknown[] }>({ key: '', parts: [] })
  useEffect(() => {
    if (!target || !asset) return
    const key = `${asset.id}:${clipName ?? ''}:${skeletonTargetId ?? ''}`
    const parts = poseParts(asset)
    if (applied.current.key === key && sameParts(applied.current.parts, parts)) return
    applied.current = { key, parts }
    const bound = applyPreviewClips(target, asset, clipName, { time: timeRef.current, loop })
    setDuration(target.animator.duration)
    if (bound && bound !== clipName) selectClip(bound)
    setPlaying(false)
    lastRef.current = performance.now()
  })

  // Leave the character in bind pose on the way out, as every other animation surface does.
  useEffect(() => () => { getAnimationTarget(editorScene, skeletonTargetId)?.animator.showBindPose() },
    [editorScene, skeletonTargetId])

  useEffect(() => {
    const onChanged = () => setDuration(getAnimationTarget(editorScene, skeletonTargetId)?.animator.duration ?? 0)
    eventEmitter.on('ANIM_CLIPS_CHANGED', onChanged)
    return () => { eventEmitter.off('ANIM_CLIPS_CHANGED', onChanged) }
  }, [eventEmitter, editorScene, skeletonTargetId])

  // Per-frame drive loop. The tab's scene has `animationsEnabled = false`, so nothing else ticks it.
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const t = getAnimationTarget(editorScene, skeletonTargetId)
      if (t) {
        const now = performance.now()
        const dt = Math.min((now - lastRef.current) / 1000, 0.1)
        lastRef.current = now
        if (playingRef.current && !scrubbingRef.current) {
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

  if (!asset) return <div className='p-3 text-ui text-muted'>No animation open.</div>
  if (!target) {
    return (
      <div className='p-3 text-ui text-muted'>
        {asset.rigId
          ? 'No character on this clip’s skeleton, so there is nothing to play it on. Link a model to the skeleton to see it.'
          : 'This animation is not linked to a skeleton, so there is no skeleton to play it on.'}
      </div>
    )
  }

  const animator = target.animator
  const clips = asset.clips.map(c => c.name)

  const bind = (name: string) => {
    animator.playAnimationByName(name, loop, false)
    animator.pause()
    animator.seek(0)
    setDuration(animator.duration)
    setPlaying(false)
    setTime(0)
  }

  const onPlay = () => {
    if (clipName && animator.currentAnimation?.name !== clipName) animator.playAnimationByName(clipName, loop, false)
    else animator.play()
    animator.loop = loop
    animator.speed = speed
    lastRef.current = performance.now()
    setPlaying(true)
  }
  const onPause = () => { animator.pause(); setPlaying(false) }
  const onStop = () => { animator.stop(); animator.showBindPose(); setPlaying(false); setTime(0) }

  const onScrub = (v: number) => {
    scrubbingRef.current = true
    if (clipName && animator.currentAnimation?.name !== clipName) animator.playAnimationByName(clipName, loop, false)
    animator.pause()
    animator.seek(v)
    setTime(v)
    setPlaying(false)
    // Cleared next frame, not synchronously: the rAF loop may already be mid-tick and would otherwise
    // advance the clock straight past where the pointer just put it.
    requestAnimationFrame(() => { scrubbingRef.current = false })
  }

  /** Client-space X to clip time, clamped to the track. */
  const timeAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return 0
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }

  // Drag listeners go on `window`, not the track: a pointer that leaves it mid-drag must keep being read.
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
    <div className='flex flex-col gap-2 p-3 h-full overflow-auto'>
      <div className='flex items-center gap-2 text-ui text-fg flex-wrap'>
        <Select
          className='max-w-[200px]'
          value={clipName ?? ''}
          onChange={e => { selectClip(e.target.value); bind(e.target.value) }}
          title='Clip'>
          {clips.length === 0 && <option value=''>No clips</option>}
          {clips.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>

        <Button title='Play' onClick={onPlay} disabled={playing || !clipName}>▶</Button>
        <Button title='Pause' onClick={onPause} disabled={!playing}>❚❚</Button>
        <Button title='Stop (bind pose)' onClick={onStop}>■</Button>

        <Toggle label='loop' className='ml-1' checked={loop} onChange={c => { setLoop(c); animator.loop = c }} />
        <label className='flex items-center gap-1' title='Playback speed — preview only, it does not change the clip'>
          speed
          <NumberInput
            className='w-[52px] px-1 py-0'
            step='0.1' min='0' value={speed}
            onChange={n => { const v = Math.max(0, n); setSpeed(v); animator.speed = v }} />
        </label>
      </div>

      <div className='flex items-center gap-2 text-ui-sm text-muted'>
        <span className={cn(TRACK_GUTTER, 'shrink-0 tabular-nums text-right')}>{fmt(time)}</span>
        <div ref={trackRef} className='relative flex-1 h-4 cursor-pointer select-none' onPointerDown={onTrackDown}>
          <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-control-hover' />
          <div className='absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded bg-primary' style={{ width: pct(time) }} />
          <div className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-fg pointer-events-none'
            style={{ left: pct(time) }} />
        </div>
        <span className={cn(TRACK_TAIL, 'shrink-0 tabular-nums')}>{fmt(duration)}</span>
      </div>

      {/* The clip's events: they fire wherever it plays. Written to the .anim, so nothing to save. */}
      <ClipEventsTrack assetId={asset.id} clipName={clipName ?? undefined} duration={duration} time={time} onSeek={onScrub} />
    </div>
  )
}
