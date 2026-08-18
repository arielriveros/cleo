import { useCallback, useEffect, useState } from 'react'
import { Logger } from 'cleo'
import { iconFor } from '../assets/assetKinds'
import { startTask } from '../progress/progressStore'
import {
  ExampleEntry, exampleThumbnailUrl, formatBytes, importExample, loadExampleIndex,
} from '../../utils/examples'

// The gallery of example projects that ship with this build. Picking one downloads its folder from
// examples/ and opens it as a brand-new project — the user's own projects are never touched.
//
// Not another SVAR file manager, unlike the sibling ProjectsExplorer: there are no folders here, nothing can
// be renamed, moved, duplicated or deleted, and the whole interaction is "click a card". None of that
// widget's machinery would earn its weight, and a plain grid is what lets a card show a large cover image.
//
// Nothing in this component may touch scoped storage. It renders on the boot launcher too, where no project
// is open and `scoped()` throws by design — see importExample's note on why that holds.

/** Above this, downloading is a decision rather than a click, so it gets a confirmation. */
const CONFIRM_BYTES = 25 * 1024 * 1024

function Thumbnail({ entry }: { entry: ExampleEntry }) {
  const url = exampleThumbnailUrl(entry)
  const [failed, setFailed] = useState(false)

  if (url && !failed) {
    return (
      <img
        src={url}
        alt=''
        loading='lazy'
        className='w-full h-full object-cover'
        onError={() => setFailed(true)}
      />
    )
  }
  // No cover image (the export carried no scene thumbnail) — fall back to the same scene glyph the project
  // cards use, so an example without art still reads as a project rather than as a broken image.
  return (
    <div className='w-full h-full flex items-center justify-center bg-surface-sunken'>
      <img src={iconFor('scene')} alt='' className='w-8 h-8 opacity-50' />
    </div>
  )
}

export default function ExamplesGallery({ examples, className = '' }: {
  /** Passed in rather than fetched here: the host already loaded the index to decide whether to show a tab. */
  examples: ExampleEntry[]
  className?: string
}) {
  const [busySlug, setBusySlug] = useState<string | null>(null)

  const open = useCallback(async (entry: ExampleEntry) => {
    if (busySlug) return
    if (entry.bytes > CONFIRM_BYTES) {
      const ok = window.confirm(
        `"${entry.name}" is ${formatBytes(entry.bytes)}.\n\n` +
        `It will be downloaded and added as a new project. Your existing projects are not affected.\n\n` +
        `Continue?`,
      )
      if (!ok) return
    }

    setBusySlug(entry.slug)
    const task = startTask({
      title: `Opening "${entry.name}"`,
      steps: ['Downloading', 'Creating project'],
    })
    try {
      task.setStep(0, { status: 'running', detail: formatBytes(entry.bytes), progress: 0 })
      await importExample(entry, fraction => task.setStep(0, { progress: fraction }))
      // importExample ends in openProject's reload, so this is really just what the card shows if the
      // browser is slow to navigate away.
      task.setStep(0, { status: 'done' })
      task.setStep(1, { status: 'done', detail: 'Opening' })
    } catch (e: any) {
      task.setStep(0, { status: 'failed', error: String(e?.message ?? e) })
      Logger.error(`Could not open the example "${entry.name}": ${e?.message ?? e}`, 'Editor')
      setBusySlug(null)
    } finally {
      task.finish()
    }
  }, [busySlug])

  return (
    <div className={`w-full h-full flex flex-col text-sm ${className}`}>
      <div className='h-[28px] flex items-center px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        <span className='min-w-0 truncate text-[11px] text-dim'>
          {busySlug ? 'Downloading…' : 'Click an example to add it as a new project'}
        </span>
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto p-3'>
        <div className='grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(180px,1fr))]'>
          {examples.map(entry => (
            <button
              key={entry.slug}
              type='button'
              disabled={!!busySlug}
              onClick={() => void open(entry)}
              title={entry.description || entry.name}
              className={
                'group flex flex-col text-left rounded-md border border-control bg-surface-raised overflow-hidden ' +
                'cursor-pointer hover:border-highlight focus:outline-none focus:border-highlight ' +
                'disabled:cursor-default disabled:opacity-50 ' +
                (busySlug === entry.slug ? 'border-highlight' : '')
              }>
              <div className='aspect-video w-full overflow-hidden bg-surface-sunken'>
                <Thumbnail entry={entry} />
              </div>
              <div className='flex flex-col gap-0.5 p-2 min-w-0'>
                <span className='truncate text-[12px] font-semibold text-fg'>{entry.name}</span>
                {entry.description && (
                  <span className='line-clamp-2 text-[11px] leading-snug text-muted'>{entry.description}</span>
                )}
                <span className='mt-0.5 text-[10px] text-dim'>
                  {formatBytes(entry.bytes)} · {entry.sceneCount} scene{entry.sceneCount === 1 ? '' : 's'}
                </span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Load the catalogue once for a host that needs to know whether the Examples tab is worth showing.
 *
 * Returns null while loading so the host can hold the tab back rather than flashing it in and out. A build
 * with no examples folder resolves to an empty list, not an error.
 */
export function useExampleIndex(): ExampleEntry[] | null {
  const [examples, setExamples] = useState<ExampleEntry[] | null>(null)
  useEffect(() => {
    let alive = true
    void loadExampleIndex().then(list => { if (alive) setExamples(list) })
    return () => { alive = false }
  }, [])
  return examples
}
