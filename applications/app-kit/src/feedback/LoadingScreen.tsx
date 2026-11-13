import { useEffect, useState } from 'react'
// Only the store (no engine): the pre-engine boot gate renders this before EngineContext exists.
import { loadFraction, stepFraction, useLoad, type LoadState, type LoadStepState } from './loadingStore'
import { queueSlots, slotOpacity, type QueueSlot } from './loadQueue'
import LogoLoader from './LogoLoader'
import './loadingQueue.css'

// The Cleo loading screen, shared by every app, in one column with no card: the app's logo, which fills
// as the total bar (weighted across the steps), coming into focus from pixels as it does, over the CLEO
// ENGINE title and the app's name, then the load's title with its total, and its steps as a queue:
// finished ones slide up and fade out, the running ones show their count and percentage, and the pending
// ones wait below, fading out past the window's height. Each step's timing goes to the console when the
// load ends (loadingStore.finish). Fed by loadingStore.ts.

/**
 * Who is loading: the logo (and its pixelated copy, which the logo fills from), the subtitle under CLEO
 * ENGINE ('Editor', 'Creator') and an optional version line. Without a logo the total is a plain bar
 * under the steps.
 */
export interface LoadingBrand {
  subtitle: string
  versionLabel?: string
  logo?: string
  /** brand/logo-pixel.png (tools/brandIcons.mjs). Without it the unloaded logo is only dimmed. */
  logoPixels?: string
}

function StatusIcon({ status }: { status: LoadStepState['status'] }) {
  const common = 'w-3.5 h-3.5 shrink-0'
  if (status === 'running') {
    return (
      <svg className={`${common} animate-spin text-primary`} viewBox='0 0 16 16' fill='none' aria-label='running'>
        <circle cx='8' cy='8' r='6' stroke='currentColor' strokeOpacity='0.25' strokeWidth='2' />
        <path d='M14 8a6 6 0 0 0-6-6' stroke='currentColor' strokeWidth='2' strokeLinecap='round' />
      </svg>
    )
  }
  if (status === 'done') {
    return (
      <svg className={`${common} text-success`} viewBox='0 0 16 16' fill='none' aria-label='done'>
        <path d='M3.5 8.5l3 3 6-7' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round' />
      </svg>
    )
  }
  if (status === 'failed') {
    return (
      <svg className={`${common} text-danger`} viewBox='0 0 16 16' fill='none' aria-label='failed'>
        <path d='M8 2.5l6 11H2z' stroke='currentColor' strokeWidth='1.6' strokeLinejoin='round' />
        <path d='M8 7v3M8 11.8v.2' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
      </svg>
    )
  }
  if (status === 'skipped') {
    return (
      <svg className={`${common} text-dim`} viewBox='0 0 16 16' fill='none' aria-label='skipped'>
        <path d='M4 8h8' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' />
      </svg>
    )
  }
  return (
    <svg className={`${common} text-dim`} viewBox='0 0 16 16' aria-label='pending'>
      <circle cx='8' cy='8' r='2' fill='currentColor' />
    </svg>
  )
}

// The queue window: rows of ROW_PX, WINDOW_ROWS of them, the focus (the first step still to finish)
// HISTORY_ROWS down from the top so the last finished steps are seen leaving. See loadingQueue.css.
const ROW_PX = 22
const WINDOW_ROWS = 8
const HISTORY_ROWS = 2

/**
 * One step in the queue: its status, its name, and its count with a percentage ("12/40 (30%)") only
 * while it is running and has something to count. A failure shows its message instead. Placed and faded by its slot (loadQueue.ts).
 */
function QueueRow({ entry }: { entry: QueueSlot }) {
  const { step, slot } = entry
  const failed = step.status === 'failed'
  // "12/40 (30%)": how many of how many, and how far that is.
  const progress = step.status === 'running' && step.total > 0
    ? `${Math.min(step.done, step.total).toLocaleString()}/${step.total.toLocaleString()} (${Math.round(stepFraction(step) * 100)}%)`
    : ''
  const gone = slot < -HISTORY_ROWS && !failed
  return (
    <li className={`flex items-center gap-2 text-ui ${step.status === 'pending' ? 'text-muted' : 'text-fg'}`}
        style={{ transform: `translateY(${(slot + HISTORY_ROWS) * ROW_PX}px)`, opacity: slotOpacity(entry) }}
        aria-hidden={gone || undefined}>
      <StatusIcon status={step.status} />
      {/* A failure's message gives way before its name does. */}
      <span className={`truncate ${failed ? 'shrink-0 max-w-[55%] text-danger-fg' : ''}`}>{step.label}</span>
      {failed
        ? <span className='ml-auto min-w-0 truncate text-ui-sm text-danger-fg' title={step.detail || undefined}>{step.detail}</span>
        : progress && <span className='ml-auto shrink-0 text-ui-sm tabular-nums text-muted'>{progress}</span>}
    </li>
  )
}

/** The screen for one load. `variant` decides whether it covers the window or only its host. */
export function LoadingView({ load, subtitle, versionLabel, logo, logoPixels }: { load: LoadState } & LoadingBrand) {
  const fraction = loadFraction(load)
  const pct = Math.round(fraction * 100)
  const position = load.variant === 'fullscreen' ? 'fixed inset-0 z-[1000]' : 'absolute inset-0 z-40'
  const queue = queueSlots(load.steps)
  const running = load.steps.filter(s => s.status === 'running').map(s => s.label).join(', ')

  // One column, all at one level: the logo (the total, filling), the title, then the queue of steps.
  return (
    <div className={`${position} flex flex-col items-center justify-center bg-bg text-fg select-none`} role='progressbar'
         aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={load.title}>
      <div className='flex w-[340px] max-w-[90%] flex-col items-center gap-5'>
        <div className='flex flex-col items-center gap-2'>
          {logo && <LogoLoader src={logo} pixels={logoPixels} progress={fraction} className='mb-3 w-[180px]' />}
          <h1 className='text-2xl font-semibold tracking-[0.3em] text-fg'>CLEO ENGINE</h1>
          <span className='text-ui-xs uppercase tracking-[0.3em] text-muted'>{subtitle}</span>
          {versionLabel && <span className='text-ui-xs tabular-nums tracking-[0.2em] text-dim'>{versionLabel}</span>}
        </div>

        <div className='flex w-full flex-col gap-2'>
          <div className='flex items-baseline justify-center gap-2 text-ui-lg'>
            <span className='truncate font-medium'>{load.title}</span>
            <span className='shrink-0 tabular-nums text-muted'>{pct}%</span>
          </div>
          {!logo && (
            <div className='h-2 w-full overflow-hidden rounded-full border border-border bg-surface-sunken'>
              <div className='h-full rounded-full bg-gradient-to-r from-border to-primary transition-[width] duration-300 ease-out'
                   style={{ width: `${pct}%` }} />
            </div>
          )}
          <ul className='cleo-load-queue w-full' aria-label='Steps'
              style={{ ['--row' as string]: `${ROW_PX}px`, height: WINDOW_ROWS * ROW_PX }}>
            {queue.map(entry => <QueueRow key={entry.step.id} entry={entry} />)}
          </ul>
          <span className='sr-only' aria-live='polite'>{running}</span>
        </div>
      </div>
    </div>
  )
}

/**
 * Shows the current load, if it is of `variant`. Mount one fullscreen host at the app root, and one
 * overlay host inside the viewport for loads that cover only it (opening a scene).
 */
export default function LoadingScreen({ variant = 'fullscreen', subtitle, versionLabel, logo, logoPixels }: { variant?: LoadState['variant'] } & LoadingBrand) {
  const load = useLoad()
  // A load with a show delay renders nothing until the delay is up — re-checked by a timer, since
  // nothing in the store changes just because time passed.
  const [, wake] = useState(0)
  const hiddenFor = load ? load.showAfterMs - (performance.now() - load.startedAt) : 0
  useEffect(() => {
    if (!load || hiddenFor <= 0) return
    const t = window.setTimeout(() => wake(x => x + 1), hiddenFor + 5)
    return () => window.clearTimeout(t)
  }, [load?.id, hiddenFor > 0])
  if (!load || load.variant !== variant || hiddenFor > 0) return null
  return <LoadingView load={load} subtitle={subtitle} versionLabel={versionLabel} logo={logo} logoPixels={logoPixels} />
}
