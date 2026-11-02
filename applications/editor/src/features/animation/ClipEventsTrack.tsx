import { useRef, useState } from 'react'
import { Button, cn } from '@cleo/app-kit/ui'
import { promptDialog } from '@cleo/app-kit/feedback/dialogStore'
import { clamp } from '@cleo/app-kit/utils/math'
import { useClipEvents } from './useClipEvents'
import type { ClipEvent } from '../../utils/clipEvents'

// The Events track: one clip's event markers under a transport — the Clip Player's timeline and the
// Animator / Skeleton transport both mount it. Events are written to the clip's `.anim` (useClipEvents), so
// they fire wherever the clip plays.
//
// It lines up with the host's scrub track by sharing its row layout: a `TRACK_GUTTER` cell, the track, a
// `TRACK_TAIL` cell. A host lays its scrubber out the same way and the markers sit over the frames they name.

/** The left cell of every transport row (the time readout; here, + Event). */
export const TRACK_GUTTER = 'w-[64px]'
/** The right cell of every transport row (the duration readout). */
export const TRACK_TAIL = 'w-[46px]'

/** A marker shown but not editable here: a machine's own (legacy) marker. */
export type ForeignMarker = { time: number; name: string }

export default function ClipEventsTrack({ assetId, clipName, duration, time, onSeek, embedded, legacy }: {
  /** The `.anim` the clip was resolved from (`Animation.assetId`); undefined for a clip embedded in a model. */
  assetId: string | undefined
  clipName: string | undefined
  /** Clip length, for the time axis. */
  duration: number
  /** The playhead — where + Event puts a marker. */
  time: number
  /** Click or drag on the empty track scrubs, like the transport's own track. */
  onSeek?: (time: number) => void
  /** An embedded clip's own events, shown read-only (there is no asset to write them to). */
  embedded?: readonly ClipEvent[]
  /** The animator's own markers on this clip, which still fire but are no longer authored here. */
  legacy?: readonly ForeignMarker[]
}) {
  const { events, editable, add, rename, move, remove } = useClipEvents(assetId, clipName)
  const trackRef = useRef<HTMLDivElement | null>(null)
  /** The marker being dragged and where it is now. Committed once, on release: one write, one undo step. */
  const [drag, setDrag] = useState<{ index: number; time: number } | null>(null)

  const shown: readonly ClipEvent[] = editable ? events : (embedded ?? [])

  const timeAt = (clientX: number) => {
    const r = trackRef.current?.getBoundingClientRect()
    if (!r || r.width === 0 || duration <= 0) return 0
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }
  const pct = (t: number) => `${duration > 0 ? clamp(t / duration, 0, 1) * 100 : 0}%`

  const askName = (title: string, defaultValue: string, message?: string) => promptDialog({
    title, message, defaultValue, validate: v => (v.trim() ? null : 'Give the event a name.'),
  }).then(v => v?.trim() || null)

  const onAdd = async () => {
    const at = time
    const name = await askName('Add an event', 'footstep',
      `Fires at ${at.toFixed(2)}s every time "${clipName}" plays — in any state, layer or action. Scripts receive it in onAnimationEvent(name, clip).`)
    if (name) add(at, name)
  }

  // Listeners go on `window`: a pointer that leaves the track mid-drag must keep being read.
  const onTrackDown = (e: React.PointerEvent) => {
    if (!onSeek || e.button !== 0) return
    onSeek(timeAt(e.clientX))
    const moveTo = (ev: PointerEvent) => onSeek(timeAt(ev.clientX))
    const up = () => { window.removeEventListener('pointermove', moveTo); window.removeEventListener('pointerup', up) }
    window.addEventListener('pointermove', moveTo)
    window.addEventListener('pointerup', up)
  }

  /**
   * Press on a marker: a drag moves it, a click (no movement) renames it. Decided on release rather than in
   * `onClick`, which also fires at the end of a drag.
   */
  const onMarkerDown = (e: React.PointerEvent, index: number) => {
    // Without this the track underneath seeks to wherever the marker was grabbed.
    e.stopPropagation()
    if (!editable || e.button !== 0) return
    const startX = e.clientX
    let moved = false
    let at = shown[index].time
    const moveTo = (ev: PointerEvent) => {
      if (!moved && Math.abs(ev.clientX - startX) < 3) return
      moved = true
      at = timeAt(ev.clientX)
      setDrag({ index, time: at })
    }
    const up = () => {
      window.removeEventListener('pointermove', moveTo)
      window.removeEventListener('pointerup', up)
      setDrag(null)
      if (moved) move(index, at)
      else void askName('Rename event', shown[index].name).then(name => { if (name && name !== shown[index]?.name) rename(index, name) })
    }
    window.addEventListener('pointermove', moveTo)
    window.addEventListener('pointerup', up)
  }

  const readOnlyNote = !editable && clipName
    ? 'This clip is embedded in the model, not in an .anim asset, so its events cannot be edited here.'
    : undefined

  return (
    <div className='flex items-center gap-2 text-ui-sm'>
      <div className={cn(TRACK_GUTTER, 'shrink-0 flex justify-end')}>
        <Button variant='ghost' size='sm'
          className='px-1 py-0 text-ui-sm text-highlight hover:bg-transparent hover:text-fg whitespace-nowrap'
          disabled={!editable}
          title={readOnlyNote ?? (clipName ? `Add an event to "${clipName}" at the playhead` : 'Pick a clip first')}
          onClick={() => void onAdd()}>+ Event</Button>
      </div>

      <div ref={trackRef} className={cn('relative flex-1 h-5 select-none', onSeek && 'cursor-pointer')} onPointerDown={onTrackDown}>
        <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-control-hover' />

        {legacy?.map((m, i) => (
          <div key={`legacy-${i}`}
            className='absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full border border-muted'
            style={{ left: pct(m.time) }}
            title={`“${m.name}” @ ${m.time.toFixed(3)}s — on the animator rather than the clip. It still fires, but is not edited here.`}
            onPointerDown={e => e.stopPropagation()} />
        ))}

        {shown.map((ev, i) => {
          const at = drag?.index === i ? drag.time : ev.time
          return (
            <div key={i}
              className={cn('absolute top-0 -translate-x-1/2 flex flex-col items-center',
                editable ? 'cursor-grab active:cursor-grabbing' : 'opacity-60')}
              style={{ left: pct(at) }}
              title={editable
                ? `“${ev.name}” @ ${at.toFixed(3)}s — drag to move, click to rename, right-click to delete`
                : `“${ev.name}” @ ${at.toFixed(3)}s — ${readOnlyNote ?? 'read-only'}`}
              onPointerDown={e => onMarkerDown(e, i)}
              onContextMenu={e => { e.preventDefault(); e.stopPropagation(); if (editable) remove(i) }}>
              <div className='w-0 h-0 border-l-[5px] border-r-[5px] border-t-[8px] border-l-transparent border-r-transparent border-t-highlight' />
              <span className='text-ui-2xs text-highlight whitespace-nowrap leading-none'>{ev.name}</span>
            </div>
          )
        })}

        {readOnlyNote && shown.length === 0 && !legacy?.length && (
          <span className='absolute inset-0 flex items-center text-ui-2xs text-dim pointer-events-none'>Embedded clip — events are read-only</span>
        )}

        <div className='absolute top-0 bottom-0 w-px bg-fg/40 pointer-events-none' style={{ left: pct(time) }} />
      </div>

      <span className={cn(TRACK_TAIL, 'shrink-0')} />
    </div>
  )
}
