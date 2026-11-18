import { useMemo, useRef, useState } from 'react'
import { applyClipEdits, detectFootLockWindows, footLockKey, humanoidFeet, normalizeFootLockSpans } from 'cleo'
import type { Animation, ClipEdit, Skin } from 'cleo'
import { mat4 } from 'gl-matrix'
import { cn } from '@cleo/app-kit/ui'
import { JOINED_DIVIDER_CLASS, JOINED_GROUP_CLASS } from '@cleo/app-kit/ui/SegmentedControl'
import { RestartIcon, SearchIcon } from '@cleo/app-kit/ui/icons'
import { startPointerDrag } from '@cleo/app-kit/timeline'
import { clamp } from '@cleo/app-kit/utils/math'
import { useAssetLibrary } from '../AssetLibraryContext'
import { useClipAssetEdit } from './useClipEvents'
import { TRACK_GUTTER, TRACK_TAIL } from './ClipEventsTrack'
import { loadSkin, type AnimationAsset, type StoredClip, type StoredSkin } from '../../utils/animationAssets'
import { sourceSkinFor } from '../../utils/rigAssets'

// The Foot lock rows: one per foot, the spans of the clip in which that foot is planted and foot locking may hold
// it (`clip.footLocks`). Under the Events track, in the same row layout, so the spans sit over the frames they cover.
//
// A row with no spans at all is "never" (an empty list, stored); Automatic removes the foot's entry, and the
// Animator then decides by itself as the clip plays. Detect fills the row from the clip's own foot heights: from the
// ball of the foot coming down to the heel lifting 3 cm, so the lock lets the push-off follow the animation.

/** Pixels from a span's end that grab the end rather than the whole span. */
const EDGE_PX = 6
/** Times snap to this many frames a second. */
const FPS = 60
const snap = (t: number) => Math.round(t * FPS) / FPS

const ITEM = 'flex items-center justify-center w-[22px] h-[18px] text-muted hover:text-fg hover:bg-control disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted disabled:cursor-default'

const toMat4 = (a: number[]) => {
  const m = mat4.create()
  for (let i = 0; i < 16 && i < a.length; i++) m[i] = a[i]
  return m
}

const sideLabel = (key: string) => key === 'foot.L' ? 'Left foot' : key === 'foot.R' ? 'Right foot' : key

type Span = [number, number]
type Drag = { key: string; spans: Span[] }

export default function ClipFootLocksTrack({ asset, clipName, duration, time, onSeek }: {
  asset: AnimationAsset
  clipName: string | undefined
  duration: number
  time: number
  onSeek?: (time: number) => void
}) {
  const { animations, rigs } = useAssetLibrary()
  const edit = useClipAssetEdit()
  // The library's record, not the context's copy: a write here must show at once.
  const clip: StoredClip | undefined = clipName ? animations.find(a => a.id === asset.id)?.clips.find(c => c.name === clipName) : undefined
  const stored = sourceSkinFor(asset, rigs)
  const skin = useMemo(() => (stored ? loadSkin(stored as StoredSkin, toMat4) as Skin | null : null), [stored])
  const feet = useMemo(() => (skin ? humanoidFeet(skin) : []), [skin])
  const keys = useMemo(() => {
    const out = feet.map(f => footLockKey(skin?.nodeNames?.get(f.foot) ?? String(f.foot)))
    for (const k of Object.keys(clip?.footLocks ?? {})) if (!out.includes(k)) out.push(k)
    return out
  }, [feet, skin, clip?.footLocks])
  /** The row being dragged, shown live and written once on release: one write, one undo step. */
  const [drag, setDrag] = useState<Drag | null>(null)
  const tracks = useRef(new Map<string, HTMLDivElement | null>())

  if (!clip || keys.length === 0 || duration <= 0) return null

  const pct = (t: number) => `${clamp(t / duration, 0, 1) * 100}%`
  const widthOf = (key: string) => tracks.current.get(key)?.getBoundingClientRect().width ?? 0
  const timeAt = (key: string, clientX: number) => {
    const r = tracks.current.get(key)?.getBoundingClientRect()
    if (!r || r.width === 0) return 0
    return clamp((clientX - r.left) / r.width, 0, 1) * duration
  }
  const spansOf = (key: string): Span[] | undefined => (drag?.key === key ? drag.spans : clip.footLocks?.[key])

  const write = (key: string, spans: Span[] | undefined, label: string) => {
    const next: Record<string, Span[]> = { ...(clip.footLocks ?? {}) }
    if (spans === undefined) delete next[key]
    else next[key] = normalizeFootLockSpans(spans, duration)
    edit(asset.id, clip.name, { footLocks: Object.keys(next).length ? next : undefined }, label)
  }

  /** The clip as it plays (its edits applied), posed on its source skeleton, for Detect. */
  const detect = (key: string) => {
    if (!skin) return
    const poses = (asset as { poses?: { id: string; bones: any[] }[] }).poses
    const played = applyClipEdits(clip as unknown as Animation, (clip as { edits?: ClipEdit[] }).edits,
      { skin, poses: poses?.length ? new Map(poses.map(p => [p.id, p.bones])) : undefined })
    const found = detectFootLockWindows(played, skin, { feet })
    write(key, found[key] ?? [], 'Detect foot lock')
  }

  // Empty track: a drag draws a new span, a press without one scrubs (as on the Events row).
  const onTrackDown = (e: React.PointerEvent, key: string) => {
    if (e.button !== 0) return
    const at = timeAt(key, e.clientX)
    const base = clip.footLocks?.[key] ?? []
    let last: Span[] | null = null
    startPointerDrag(e, {
      onMove: (_dx, _dy, ev) => {
        const now = timeAt(key, ev.clientX)
        last = [...base, [snap(Math.min(at, now)), snap(Math.max(at, now))]]
        setDrag({ key, spans: last })
      },
      onEnd: (moved) => {
        setDrag(null)
        if (moved && last) write(key, last, 'Add foot lock')
        else onSeek?.(at)
      },
    })
  }

  // A span: near an end moves that end, elsewhere slides the whole span. Right-click removes it.
  const onSpanDown = (e: React.PointerEvent, key: string, index: number) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const base = clip.footLocks?.[key] ?? []
    const [a, b] = base[index]
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const local = e.clientX - r.left
    const mode: 'start' | 'end' | 'move' = local < EDGE_PX ? 'start' : r.width - local < EDGE_PX ? 'end' : 'move'
    const secondsPerPx = duration / Math.max(1, widthOf(key))
    let last: Span[] | null = null
    startPointerDrag(e, {
      onMove: (dx) => {
        const dt = dx * secondsPerPx
        let span: Span
        if (mode === 'start') span = [snap(clamp(a + dt, 0, b - 1 / FPS)), b]
        else if (mode === 'end') span = [a, snap(clamp(b + dt, a + 1 / FPS, duration))]
        else {
          const shift = clamp(dt, -a, duration - b)
          span = [snap(a + shift), snap(b + shift)]
        }
        last = base.map((s, i) => (i === index ? span : s))
        setDrag({ key, spans: last })
      },
      onEnd: (moved) => {
        setDrag(null)
        if (moved && last) write(key, last, mode === 'move' ? 'Move foot lock' : 'Resize foot lock')
        else onSeek?.(timeAt(key, e.clientX))
      },
    })
  }

  return (
    <>
      {keys.map(key => {
        const spans = spansOf(key)
        const auto = spans === undefined
        return (
          <div key={key} className='flex items-center gap-2 text-ui-sm'>
            <span className={cn(TRACK_GUTTER, 'shrink-0 text-right text-ui-2xs text-muted whitespace-nowrap')}
              title={`${sideLabel(key)}: when this foot is planted and foot locking may hold it. ${auto
                ? 'No spans set: the animator decides by itself as the clip plays.'
                : spans!.length ? 'Drag an end to move it, the middle to slide the span; drag on empty track to add one; right-click to remove.'
                  : 'No spans: this foot never locks in this clip.'}`}>
              {key === 'foot.L' ? 'Lock L' : key === 'foot.R' ? 'Lock R' : key}
            </span>

            <div ref={el => { tracks.current.set(key, el) }}
              className='relative flex-1 h-4 select-none cursor-crosshair' onPointerDown={e => onTrackDown(e, key)}>
              <div className='absolute inset-x-0 top-1/2 -translate-y-1/2 h-px bg-control-hover' />
              {auto && (
                <span className='absolute inset-0 flex items-center text-ui-2xs text-dim pointer-events-none'>automatic</span>
              )}
              {spans?.map(([a, b], i) => (
                <div key={i}
                  className='absolute top-0.5 bottom-0.5 rounded-sm bg-primary/60 border border-primary cursor-grab active:cursor-grabbing'
                  style={{ left: pct(a), width: `calc(${pct(b)} - ${pct(a)})` }}
                  title={`${sideLabel(key)} locked ${a.toFixed(3)}s to ${b.toFixed(3)}s: drag an end to move it, the middle to slide it, right-click to remove`}
                  onPointerDown={e => onSpanDown(e, key, i)}
                  onContextMenu={e => { e.preventDefault(); e.stopPropagation(); write(key, spans.filter((_, j) => j !== i), 'Remove foot lock') }} />
              ))}
              <div className='absolute top-0 bottom-0 w-px bg-fg/40 pointer-events-none' style={{ left: pct(time) }} />
            </div>

            <div className={cn(TRACK_TAIL, 'shrink-0 flex justify-start')}>
              <div className={JOINED_GROUP_CLASS}>
                <button type='button' className={ITEM} disabled={!skin}
                  title={skin ? `Detect: set ${sideLabel(key).toLowerCase()} spans from the clip, from the ball of the foot coming down to the heel lifting 3 cm` : 'No skeleton to read the clip on'}
                  onClick={() => detect(key)}>
                  <span className='w-3 h-3'><SearchIcon /></span>
                </button>
                <button type='button' className={cn(ITEM, JOINED_DIVIDER_CLASS)} disabled={auto}
                  title='Automatic: remove the spans and let the animator decide when this foot is planted'
                  onClick={() => write(key, undefined, 'Foot lock automatic')}>
                  <span className='w-3 h-3'><RestartIcon /></span>
                </button>
              </div>
            </div>
          </div>
        )
      })}
    </>
  )
}
