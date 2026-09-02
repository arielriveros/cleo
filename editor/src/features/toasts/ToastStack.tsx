import { useSyncExternalStore } from 'react'
import { dismissToast, getSnapshot, subscribe, type ToastTone } from './toastStore'
import { cn, hintClass, sectionTitleClass, valueClass } from '../../components/ui'

// The transient-notice surface. Top-right: ProgressWindow owns bottom-right (z-40) and the logger's
// DebugOverlay owns bottom-left. Mounted in index.tsx alongside DialogHost so every boot phase has it.

const TONE_BORDER: Record<ToastTone, string> = {
  info: 'border-border',
  success: 'border-success',
  warning: 'border-warning/60',
  error: 'border-danger',
}

// Same vocabulary as ProgressWindow's StatusGlyph, so a verdict reads the same wherever it appears.
const TONE_GLYPH: Record<ToastTone, string> = {
  info: 'ℹ',
  success: '✓',
  warning: '⚠',
  error: '✕',
}

const TONE_TEXT: Record<ToastTone, string> = {
  info: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  error: 'text-danger',
}

export default function ToastStack() {
  const toasts = useSyncExternalStore(subscribe, getSnapshot)
  if (!toasts.length) return null

  return (
    // z-[70] keeps a toast readable over a dialog (z-[60]); pointer-events-none on the column so the
    // empty space beside a card never eats an orbit drag in the viewport underneath.
    <div className='fixed top-3 right-3 z-[70] flex flex-col items-end gap-2 pointer-events-none'>
      {toasts.map(t => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto w-[320px] flex items-start gap-2 px-3 py-2 select-none',
            'bg-surface-raised border rounded-md shadow-panel text-fg',
            TONE_BORDER[t.tone]
          )}
        >
          <span className={cn('leading-none pt-0.5', TONE_TEXT[t.tone])}>{TONE_GLYPH[t.tone]}</span>
          <div className='min-w-0 flex-1'>
            {t.title && <div className={sectionTitleClass}>{t.title}</div>}
            <div className={cn(valueClass, 'whitespace-pre-line break-words')}>{t.message}</div>
          </div>
          {t.count > 1 && <span className={cn(hintClass, 'tabular-nums')}>×{t.count}</span>}
          <button className='px-1 leading-none text-dim hover:text-fg' title='Dismiss' onClick={() => dismissToast(t.id)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  )
}
