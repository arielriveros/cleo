import { useSyncExternalStore } from 'react'
import {
  Task, TaskStep, StepStatus, cancelTask, dismissTask, getSnapshot, isSettled, subscribe, taskFraction,
} from './progressStore'
import { Button, cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'

// The editor's one progress surface: every long operation reports to progressStore and is rendered here.
// Not a modal — it has to stay up underneath the import review modal. Several tasks stack.

/** Leading glyph: spinner while working, a verdict once settled, a pause when it's waiting on a person. */
function StatusGlyph({ status }: { status: StepStatus }) {
  if (status === 'done') return <span className='text-success leading-none'>✓</span>
  if (status === 'failed') return <span className='text-danger leading-none'>✕</span>
  if (status === 'skipped') return <span className='text-dim leading-none'>⊘</span>
  if (status === 'pending') return <span className='text-dim leading-none'>○</span>
  if (status === 'paused') return <span className='text-warning leading-none'>⏸</span>
  return <span className='inline-block w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin' />
}

function StepRow({ step }: { step: TaskStep }) {
  const failed = step.status === 'failed'
  const text = failed ? (step.error || 'Failed') : (step.detail || '')
  return (
    <div className='flex items-start gap-2 px-3 py-1.5 border-b border-border-subtle last:border-b-0'>
      <div className='w-3.5 flex justify-center pt-0.5 shrink-0'><StatusGlyph status={step.status} /></div>
      <div className='min-w-0 flex-1'>
        <div className={cn(valueClass, 'truncate', step.status === 'skipped' && 'text-dim')} title={step.name}>
          {step.name}
        </div>
        {text && (
          <div className={cn(hintClass, 'truncate', failed && 'text-danger')} title={text}>{text}</div>
        )}
      </div>
    </div>
  )
}

function TaskCard({ task }: { task: Task }) {
  const { steps, running, cancelled, cancellable, indeterminate } = task

  const settled = steps.filter(s => isSettled(s.status)).length
  const done = steps.filter(s => s.status === 'done').length
  const failed = steps.filter(s => s.status === 'failed').length
  const skipped = steps.filter(s => s.status === 'skipped').length
  const percent = Math.round(taskFraction(task) * 100)

  // Keyed off what actually happened, not off `cancelled`: hitting Cancel on the last item skips
  // nothing, so that run really did complete.
  const heading = running
    ? (steps.length > 1 ? `${task.title} — ${Math.min(settled + 1, steps.length)} of ${steps.length}` : task.title)
    : failed ? `${task.title} — failed`
    : skipped ? `${task.title} — cancelled`
    : `${task.title} — complete`

  const summary = running
    ? (indeterminate ? 'Working…' : `${percent}%`)
    : [
        done ? `${done} done` : null,
        failed ? `${failed} failed` : null,
        skipped ? `${skipped} skipped` : null,
      ].filter(Boolean).join(' · ') || 'Nothing to do'

  return (
    <div className='w-[340px] bg-surface-raised border border-border rounded-md shadow-panel text-fg select-none'>
      <div className='px-3 py-2 border-b border-border'>
        <div className='flex items-center justify-between gap-2'>
          <span className={cn(sectionTitleClass, 'truncate')} title={heading}>{heading}</span>
          {!running && (
            <button className='text-dim hover:text-fg leading-none px-1' title='Dismiss'
              onClick={() => dismissTask(task.id)}>✕</button>
          )}
        </div>

        <div className='mt-2 h-1.5 rounded-full bg-surface-sunken overflow-hidden'>
          {running && indeterminate ? (
            <div className='h-full w-1/3 rounded-full bg-primary animate-pulse' />
          ) : (
            <div
              className={cn(
                'h-full rounded-full transition-[width] duration-200',
                failed && !running ? 'bg-danger' : running ? 'bg-primary' : 'bg-success',
              )}
              style={{ width: `${running ? percent : 100}%` }}
            />
          )}
        </div>
        <div className={cn(hintClass, 'mt-1')}>{summary}</div>
      </div>

      {/* One row per unit of work. Scrolls once a folder import is more than a few files. A single-step
          task (a save, an export) says everything it needs to in the header, so the row is redundant. */}
      {steps.length > 1 && (
        <div className='max-h-[220px] overflow-y-auto'>
          {steps.map((s, i) => <StepRow key={`${s.name}-${i}`} step={s} />)}
        </div>
      )}
      {steps.length === 1 && steps[0].detail && (
        <div className={cn(hintClass, 'px-3 py-2')}>{steps[0].detail}</div>
      )}

      {running && cancellable && (
        <div className='px-3 py-2 border-t border-border flex items-center justify-between gap-2'>
          {/* Honest about what Cancel can do: the unit in flight is a single uninterruptible task. */}
          <span className={hintClass}>Finishes the current item first</span>
          <Button variant='danger' size='sm' onClick={() => cancelTask(task.id)} disabled={cancelled}>
            {cancelled ? 'Cancelling…' : 'Cancel'}
          </Button>
        </div>
      )}
    </div>
  )
}

export default function ProgressWindow() {
  const tasks = useSyncExternalStore(subscribe, getSnapshot)
  if (!tasks.length) return null

  return (
    // z-40 keeps this under the review modals (z-50).
    <div className='fixed bottom-4 right-4 z-40 flex flex-col gap-2 items-end'>
      {tasks.map(t => <TaskCard key={t.id} task={t} />)}
    </div>
  )
}
