import { useEffect, useRef, useState } from 'react'
import { humanoidSlotOf } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import { useHistory } from '../HistoryContext'
import { useClip } from './ClipContext'
import { getAnimationTarget } from '../animation/skeleton'
import { applyPreviewClips } from './clipPreview'
import { tracksOf, withMovedKey, withoutKey, type BoneTrack, type TrackPath } from '../../utils/clipTracks'
import { Button, NumberInput, Select, Toggle } from '../../components/ui'
import { promptDialog } from '../dialogs/dialogStore'
import { clamp } from '../../utils/math'

/** One key colour per property, so a bone driven on more than one reads at a glance. */
const KEY_CLASS: Record<TrackPath, string> = {
  rotation: 'bg-highlight',
  translation: 'bg-success-fg',
  scale: 'bg-warning',
}

// The clip editor's transport, in the bottom strip beside Logger and Assets.
//
// A panel rather than the floating overlay `AnimationPlayer` uses, because the timeline is the work
// surface here rather than a control over one — and because it needs the window's full width once
// per-bone key rows land on it (M5).
//
// It is `renderer: 'always'` in the dock (see assertRenderers): the rAF loop below is what poses the
// character, and dockview would otherwise unmount it the moment the user looked at the Logger.

export default function ClipTimeline() {
  const { editorScene, skeletonTargetId, eventEmitter } = useCleoEngine()
  const { asset, clip, clipName, selectClip, patchClip } = useClip()
  const { beginBatch, endBatch } = useHistory()

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
  /**
   * The clip as of this render, for the drag handlers below.
   *
   * A drag runs off `window` listeners closed over the render that started it, so reading `clip` directly
   * would apply every move to the ORIGINAL clip — each one undoing the last, and the key snapping back to
   * where it began the moment the pointer moved twice.
   */
  const clipRef = useRef(clip)
  clipRef.current = clip
  /** The key being dragged, so the scrub handler on the row underneath stands down. */
  const dragRef = useRef<{ node: number; path: TrackPath; index: number } | null>(null)
  /** Whether the event marker under the pointer was dragged, so its trailing click does not rename it. */
  const eventDraggedRef = useRef(false)

  const target = getAnimationTarget(editorScene, skeletonTargetId)

  useEffect(() => { playingRef.current = playing }, [playing])
  useEffect(() => { timeRef.current = time }, [time])

  /** Select a bone by NODE index. `SELECT_JOINT` carries a joint index, so map it first. */
  const selectJoint = (nodeIndex: number) => {
    const skin = getAnimationTarget(editorScene, skeletonTargetId)?.skin
    const index = skin?.joints.findIndex(j => j.nodeIndex === nodeIndex) ?? -1
    if (index >= 0) eventEmitter.emit('SELECT_JOINT', index)
  }

  /**
   * Re-resolve the working copy onto the character whenever it changes.
   *
   * Keyed on `asset` identity, which every mutator in ClipContext replaces — so adding an edit, changing
   * its parameters, moving a key or toggling one off all land here. The playhead is preserved so the
   * artist watches the SAME frame change rather than being thrown back to zero on every edit, which is
   * the whole point of a live preview.
   *
   * DEBOUNCED for content changes, immediate for structural ones. A key drag replaces the asset on every
   * pointer move, and `applyPreviewClips` re-runs the whole edit stack, the retarget and a re-bind — which
   * is `O(bones x keys)` and far too much to do sixty times a second. Switching clip or character, on the
   * other hand, must land at once: a delay there reads as the click having missed.
   */
  const structuralKey = `${clipName ?? ''}:${skeletonTargetId ?? ''}`
  const lastStructuralRef = useRef(structuralKey)
  useEffect(() => {
    if (!target || !asset) return
    const apply = () => {
      const t = getAnimationTarget(editorScene, skeletonTargetId)
      if (!t) return
      const bound = applyPreviewClips(t, asset, clipName, { time: timeRef.current, loop })
      setDuration(t.animator.duration)
      if (bound && bound !== clipName) selectClip(bound)
      setPlaying(false)
      lastRef.current = performance.now()
    }
    if (lastStructuralRef.current !== structuralKey) {
      lastStructuralRef.current = structuralKey
      apply()
      return
    }
    const timer = window.setTimeout(apply, 60)
    return () => window.clearTimeout(timer)
  }, [asset, structuralKey])

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
          ? 'No character on this clip’s rig, so there is nothing to play it on. Edits still apply — link a model to the rig to see them.'
          : 'This animation is not linked to a rig, so there is no skeleton to play it on.'}
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

  // One row per bone the clip drives. Built from the WORKING COPY, not from the live model, so a key
  // written a moment ago shows immediately rather than after the next re-resolve.
  const tracks: BoneTrack[] = clip ? tracksOf(clip, target.skin as any, humanoidSlotOf) : []

  /**
   * Drag one key along its row.
   *
   * `stopPropagation` is not optional: without it the row underneath seeks to wherever the key was
   * grabbed, so every drag would start by throwing the playhead across the clip. Listeners go on `window`
   * for the same reason the scrub does — a pointer that leaves the row mid-drag must keep being read.
   */
  const onKeyDown = (e: React.PointerEvent, t: BoneTrack, path: TrackPath, index: number) => {
    e.stopPropagation()
    if (!clipName || !clip) return
    dragRef.current = { node: t.nodeIndex, path, index }
    // One undo step for the whole drag. Coalescing would mostly do it, but a drag the user pauses in the
    // middle of would split in two — and "undo my drag" is one thing they did, however they moved the mouse.
    beginBatch('Move key')
    let current = index
    const move = (ev: PointerEvent) => {
      const at = timeAt(ev.clientX)
      const before = clipRef.current
      if (!before) return
      const next = withMovedKey(before, t.nodeIndex, path, current, at)
      if (next === before) return
      // The key may have changed index if it crossed a neighbour; re-find it so the next move drags the
      // same key rather than whichever one now sits at that slot.
      const ch = next.channels.find(c => c.targetNodeIndex === t.nodeIndex && c.targetPath === path)
      if (ch) {
        const input = next.samplers[ch.samplerIndex].input
        current = input.findIndex(k => Math.abs(k - Math.max(0, at)) < 1e-4)
        if (current < 0) current = index
      }
      patchClip(clipName, next, 'Move key')
    }
    const up = () => {
      dragRef.current = null
      endBatch()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  // ---- Clip events ----
  // Markers owned by the clip, so they fire from any state, layer or action slot that plays it.
  const events = clip?.events ?? []
  const setEvents = (next: { time: number; name: string }[], label: string) => {
    if (!clipName || !clipRef.current) return
    patchClip(clipName, { ...clipRef.current, events: next.length ? next : undefined }, label)
  }
  const addEvent = async () => {
    const name = await promptDialog({
      title: 'Add an event', message: `Fires at ${time.toFixed(2)}s every time this clip plays. Scripts receive it in onAnimationEvent(name, clip).`,
      defaultValue: 'footstep', validate: v => (v.trim() ? null : 'Give the event a name.'),
    })
    if (!name?.trim()) return
    setEvents([...events, { time: Math.max(0, time), name: name.trim() }].sort((a, b) => a.time - b.time), 'Add event')
  }
  const renameEvent = async (i: number) => {
    const name = await promptDialog({ title: 'Rename event', defaultValue: events[i].name, validate: v => (v.trim() ? null : 'Give the event a name.') })
    if (!name?.trim()) return
    setEvents(events.map((e, idx) => (idx === i ? { ...e, name: name.trim() } : e)), 'Rename event')
  }
  const onEventDown = (e: React.PointerEvent, index: number) => {
    e.stopPropagation()
    eventDraggedRef.current = false
    beginBatch('Move event')
    const move = (ev: PointerEvent) => {
      eventDraggedRef.current = true
      const at = timeAt(ev.clientX)
      const list = clipRef.current?.events ?? []
      setEvents(list.map((x, idx) => (idx === index ? { ...x, time: at } : x)), 'Move event')
    }
    const up = () => {
      endBatch()
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const deleteKey = (t: BoneTrack, path: TrackPath, index: number) => {
    if (!clipName || !clip) return
    const next = withoutKey(clip, t.nodeIndex, path, index)
    if (next !== clip) patchClip(clipName, next, 'Delete key')
  }

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
        <span className='tabular-nums w-[46px] text-right'>{fmt(time)}</span>
        <div ref={trackRef} className='relative flex-1 h-4 cursor-pointer select-none' onPointerDown={onTrackDown}>
          <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 rounded bg-control-hover' />
          <div className='absolute left-0 top-1/2 -translate-y-1/2 h-1 rounded bg-primary' style={{ width: pct(time) }} />
          <div className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-fg pointer-events-none'
            style={{ left: pct(time) }} />
        </div>
        <span className='tabular-nums w-[46px]'>{fmt(duration)}</span>
      </div>

      {/* Clip events: drag to move, click to rename, double-click to delete. */}
      <div className='flex items-center gap-2 text-ui-sm'>
        <Button variant='ghost' size='sm' className='w-[130px] shrink-0 justify-start px-0 py-0 text-ui-sm text-highlight hover:bg-transparent hover:text-fg' onClick={() => void addEvent()}
          title='Add an event marker at the playhead'>+ Event at playhead</Button>
        <div className='relative flex-1 h-5 cursor-pointer select-none' onPointerDown={onTrackDown}>
          <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-control-hover' />
          {events.map((ev, i) => (
            <div key={i}
              className='absolute top-0 -translate-x-1/2 flex flex-col items-center cursor-grab active:cursor-grabbing'
              style={{ left: pct(ev.time) }}
              title={`“${ev.name}” @ ${ev.time.toFixed(3)}s — drag to move, click to rename, double-click to delete`}
              onPointerDown={e => onEventDown(e, i)}
              // A drag ends in a click on the same marker; only a click that did not move renames.
              onClick={() => { if (!eventDraggedRef.current) void renameEvent(i) }}
              onDoubleClick={() => setEvents(events.filter((_, idx) => idx !== i), 'Delete event')}>
              <div className='w-0 h-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-highlight' />
              <span className='text-ui-2xs text-highlight whitespace-nowrap leading-none'>{ev.name}</span>
            </div>
          ))}
          <div className='absolute top-0 bottom-0 w-px bg-fg/40 pointer-events-none' style={{ left: pct(time) }} />
        </div>
        <span className='w-[46px]' />
      </div>

      {/* Per-bone key rows. Only the bones this clip drives — a full skeleton would be a hundred empty
          rows, and the bone tree is the place to browse those. */}
      <div className='flex flex-col gap-px overflow-auto min-h-0'>
        {tracks.map(t => (
          <div key={t.nodeIndex} className='flex items-center gap-2 text-ui-sm'>
            <button
              className='w-[130px] shrink-0 text-left truncate text-muted hover:text-fg'
              title={`${t.name ?? t.nodeIndex}${t.slot ? ` (${t.slot})` : ''} — select this bone`}
              onClick={() => selectJoint(t.nodeIndex)}>
              {t.name ?? `node ${t.nodeIndex}`}
            </button>
            <div className='relative flex-1 h-4 cursor-pointer select-none' onPointerDown={onTrackDown}>
              <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-control-hover' />
              {(['translation', 'rotation', 'scale'] as TrackPath[]).flatMap(path =>
                (t[path]?.keys ?? []).map((k, i) => (
                  <div
                    key={`${path}-${i}`}
                    className={`absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rotate-45 border border-bg cursor-grab active:cursor-grabbing hover:scale-150 transition-transform ${KEY_CLASS[path]}`}
                    style={{ left: pct(k) }}
                    title={`${path} @ ${k.toFixed(3)}s — drag to move, double-click to delete`}
                    onPointerDown={ev => onKeyDown(ev, t, path, i)}
                    onDoubleClick={() => deleteKey(t, path, i)} />
                )))}
              <div className='absolute top-0 bottom-0 w-px bg-fg/40 pointer-events-none' style={{ left: pct(time) }} />
            </div>
            <span className='w-[46px]' />
          </div>
        ))}
      </div>
    </div>
  )
}
