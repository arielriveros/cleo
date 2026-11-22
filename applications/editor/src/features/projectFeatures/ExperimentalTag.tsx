import { FlaskIcon, cn } from '@cleo/app-kit/ui'
import { experimentalNoteOf, type FeatureDef } from 'cleo'

/**
 * The label an experimental feature (the engine's FeatureDef.experimental) carries: a flask. `pill` adds the word,
 * for a settings list; `icon` is the flask alone, with the note in its tooltip, for the Add grid and other chrome.
 */
export default function ExperimentalTag({ feature, variant = 'pill', className }: {
  feature: FeatureDef
  variant?: 'pill' | 'icon'
  className?: string
}) {
  const title = `Experimental: ${experimentalNoteOf(feature)}`
  if (variant === 'icon')
    return <span className={cn('inline-flex w-3 h-3 shrink-0 text-warning', className)} title={title}><FlaskIcon /></span>
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-ui-xs rounded px-1 shrink-0 bg-warning/15 text-warning', className)} title={title}>
      <span className='inline-flex w-3 h-3'><FlaskIcon /></span>Experimental
    </span>
  )
}
