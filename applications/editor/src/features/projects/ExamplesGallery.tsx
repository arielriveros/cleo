import { useCallback, useEffect, useState } from 'react'
import { Logger } from 'cleo'
import { iconFor } from '../assets/assetKinds'
import { beginLoad } from '@cleo/app-kit/feedback/loadingStore'
import { confirmDiscard } from '../unloadGuard'
import { IMPORT_WRITE_STEPS } from '../../utils/bundleImport'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { LauncherCard, LauncherGlyph, LauncherGrid } from '@cleo/app-kit/launcher/Launcher'
import {
  ExampleEntry, exampleThumbnailUrl, formatBytes, importExample, loadExampleIndex,
} from '../../utils/examples'

// The gallery of example projects that ship with this build. Picking one downloads its folder from
// examples/ and opens it as a brand-new project.
//
// Nothing here may touch scoped storage: it renders on the boot launcher too, where no project is open
// and `scoped()` throws by design.

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
  // No cover image: fall back to the same scene glyph the project cards use.
  return <LauncherGlyph><img src={iconFor('scene')} alt='' className='w-8 h-8 opacity-50' /></LauncherGlyph>
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
      const ok = await confirmDialog({
        title: `Download "${entry.name}"?`,
        message:
          `This example is ${formatBytes(entry.bytes)}.\n\n` +
          'It is downloaded and added as a new project. Your existing projects are not affected.',
        confirmLabel: 'Download',
      })
      if (!ok) return
    }

    // Asked here, before the loading screen goes up: it would cover the dialog.
    if (!await confirmDiscard('Opening an example')) return
    setBusySlug(entry.slug)
    // The full loading screen, continued after the reload by the startup splash: it shows these steps
    // done, then opens the new project. bundleImport reports the write steps into it.
    const load = beginLoad(`Installing ${entry.name}`, [
      { id: 'download', label: `Downloading (${formatBytes(entry.bytes)})`, weight: 4 },
      { id: 'project', label: 'Creating project', weight: 1 },
      ...IMPORT_WRITE_STEPS,
    ])
    let leaving = false
    try {
      const download = load.step('download').start()
      // False means the unsaved-work confirm was declined, before anything was downloaded: put the
      // gallery back rather than leaving a loading screen up for a switch that is not coming.
      if (!await importExample(entry, (done, total) => {
        download.progress(done, total, 'files')
        if (total > 0 && done >= total) download.done()
      }, true)) {
        setBusySlug(null)
        return
      }
      // importExample ends in switchToProject's reload: keep the screen up until the page goes.
      leaving = true
    } catch (e: any) {
      Logger.error(`Could not open the example "${entry.name}": ${e?.message ?? e}`, 'Editor')
      setBusySlug(null)
    } finally {
      if (!leaving) load.finish()
    }
  }, [busySlug])

  return (
    <div className={`w-full h-full flex flex-col text-ui ${className}`}>
      <div className='h-[28px] flex items-center px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        <span className='min-w-0 truncate text-ui-sm text-dim'>
          {busySlug ? 'Downloading…' : 'Click an example to add it as a new project'}
        </span>
      </div>

      <div className='flex-1 min-h-0 overflow-y-auto p-3'>
        <LauncherGrid>
          {examples.map(entry => (
            <LauncherCard
              key={entry.slug}
              name={entry.name}
              description={entry.description || undefined}
              title={entry.description || entry.name}
              meta={<>{formatBytes(entry.bytes)} · {entry.sceneCount} scene{entry.sceneCount === 1 ? '' : 's'}</>}
              thumbnail={<Thumbnail entry={entry} />}
              disabled={!!busySlug}
              active={busySlug === entry.slug}
              onClick={() => void open(entry)} />
          ))}
        </LauncherGrid>
      </div>
    </div>
  )
}

/**
 * Load the catalogue once, for a host deciding whether to show the Examples tab. Returns null while
 * loading; a build with no examples folder resolves to an empty list, not an error.
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
