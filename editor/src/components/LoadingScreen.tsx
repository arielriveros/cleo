import { useEffect, useState } from 'react'
// Only the store (no engine): the pre-engine boot gate renders this before EngineContext exists.
import { loadFraction, stepFraction, useLoad, type LoadState, type LoadStepState } from '../features/loading/loadingStore'
// A value import is safe here: version.ts compiles to two string constants and pulls in nothing.
import { VERSION_LABEL } from '../version'

// The editor's loading screen: every step of the current load with its own count and time, and a
// total bar weighted across them. Fed by features/loading/loadingStore.ts.

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

function seconds(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`
}

function StepRow({ step, now }: { step: LoadStepState; now: number }) {
  const elapsed = step.startedAt === null ? null : (step.endedAt ?? now) - step.startedAt
  const count = step.total > 0 ? `${step.done.toLocaleString()} / ${step.total.toLocaleString()}` : ''
  const dim = step.status === 'pending'
  return (
    <li className='flex flex-col gap-1'>
      <div className={`flex items-center gap-2 text-xs ${dim ? 'text-dim' : 'text-fg'}`}>
        <StatusIcon status={step.status} />
        <span className='truncate'>{step.label}</span>
        <span className={`ml-auto truncate text-[11px] ${step.status === 'failed' ? 'text-danger' : 'text-muted'}`}
              title={step.detail || undefined}>
          {step.status === 'failed' ? step.detail : count || step.detail}
        </span>
        <span className='w-14 shrink-0 text-right text-[11px] tabular-nums text-dim'>
          {elapsed === null ? '' : seconds(elapsed)}
        </span>
      </div>
      {step.status === 'running' && step.total > 0 && (
        <div className='ml-[22px] h-[3px] overflow-hidden rounded-full bg-surface-sunken'>
          <div className='h-full rounded-full bg-primary/70 transition-[width] duration-150 ease-out'
               style={{ width: `${Math.round(stepFraction(step) * 100)}%` }} />
        </div>
      )}
    </li>
  )
}

/** The screen for one load. `variant` decides whether it covers the window or only its host. */
export function LoadingView({ load }: { load: LoadState }) {
  // Re-render while anything runs, so elapsed times tick.
  const [now, setNow] = useState(() => performance.now())
  const running = load.steps.some(s => s.status === 'running')
  useEffect(() => {
    if (!running) return
    const t = window.setInterval(() => setNow(performance.now()), 100)
    return () => window.clearInterval(t)
  }, [running])

  const pct = Math.round(loadFraction(load) * 100)
  const position = load.variant === 'fullscreen' ? 'fixed inset-0 z-[1000]' : 'absolute inset-0 z-40'
  const current = load.steps.find(s => s.status === 'running')

  return (
    <div className={`${position} flex flex-col items-center justify-center bg-bg text-fg select-none`} role='progressbar'
         aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label={load.title}>
      <div className='flex w-[440px] max-w-[90%] flex-col gap-6'>
        <div className='flex flex-col items-center gap-2'>
          <h1 className='text-2xl font-semibold tracking-[0.3em] text-fg'>CLEO ENGINE</h1>
          <span className='text-[10px] uppercase tracking-[0.3em] text-muted'>Editor</span>
          <span className='text-[10px] tabular-nums tracking-[0.2em] text-dim'>{VERSION_LABEL}</span>
        </div>

        <div className='flex flex-col gap-3 rounded-md border border-border bg-surface/60 p-4'>
          <div className='flex items-baseline justify-between gap-3'>
            <span className='truncate text-sm font-medium'>{load.title}</span>
            <span className='shrink-0 text-[11px] tabular-nums text-dim'>{seconds(now - load.startedAt)}</span>
          </div>
          <ul className='flex max-h-[45vh] flex-col gap-1.5 overflow-y-auto pr-1'>
            {load.steps.map(step => <StepRow key={step.id} step={step} now={now} />)}
          </ul>
        </div>

        <div className='w-full'>
          <div className='h-2 w-full overflow-hidden rounded-full border border-border bg-surface-sunken'>
            <div className='h-full rounded-full bg-gradient-to-r from-border to-primary transition-[width] duration-300 ease-out'
                 style={{ width: `${pct}%` }} />
          </div>
          <div className='mt-2 flex items-center justify-between text-xs text-muted'>
            <span className='truncate'>{current ? `${current.label}…` : 'Loading…'}</span>
            <span className='tabular-nums text-fg'>{pct}%</span>
          </div>
        </div>
      </div>
    </div>
  )
}

/**
 * Shows the current load, if it is of `variant`. Mount one fullscreen host at the app root, and one
 * overlay host inside the viewport for loads that cover only it (opening a scene).
 */
export default function LoadingScreen({ variant = 'fullscreen' }: { variant?: LoadState['variant'] }) {
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
  return <LoadingView load={load} />
}
