import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Logger, SAVES_CHANNEL, type SaveDocument, type SaveSlotInfo, type SavesChangedMessage } from 'cleo'
import { Button, JOINED_GROUP_CLASS, cn } from '@cleo/app-kit/ui'
import { confirmDialog } from '@cleo/app-kit/feedback/dialogStore'
import { useCleoEngine } from '../EngineContext'
import { activeProjectId } from '../../utils/projectScope'
import { usePlayTarget } from '../playWindow/playTarget'
import { useWindowPlay, windowPlay } from '../playWindow/windowPlay'
import { DeleteIcon, ExportIcon, ImportIcon, PlayEditorIcon, PlayWindowIcon } from '../topbarIcons'
import { PLAY_SAVES_DB, playSaveStore } from './playSaves'
import { exportFileName, formatPlayTime, formatSavedAt, formatSize, importSlot, parseImportedSave, previewJson } from './savesModel'

// The Saves panel: this project's Play saves (what SaveGame wrote while the game played here, in the editor
// or in a window), newest first, with the selected one's document beside them. From here a save can be
// played from, exported as a .cleosave file, imported, or deleted. Documented in docs/editor/saves.md.

const S = (props: React.SVGProps<SVGSVGElement>) => (
  <svg viewBox='0 0 24 24' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round' {...props} />
)
// Delete all: the bin with a cross through it.
const DeleteAllIcon = () => (<S><path d='M4 7h16' /><path d='M9 7V4.5h6V7' /><path d='M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12' /><path d='M9.5 11.5l5 5M14.5 11.5l-5 5' /></S>)

const ACTION_CLASS = 'w-[30px] h-[25px] p-0 rounded-none border-0 border-r border-control-hover last:border-r-0 disabled:opacity-40 text-muted hover:text-fg'

function Action(props: { title: string; disabled?: boolean; onClick: () => void; children: React.ReactNode }) {
  return <Button title={props.title} disabled={props.disabled} onClick={props.onClick} className={ACTION_CLASS}>{props.children}</Button>
}

export default function SavesPanel() {
  const { isPlayMode, projectSettings, buildWindowPlayData, startPlayFromSave } = useCleoEngine()
  const projectId = activeProjectId()
  const store = useMemo(() => playSaveStore(projectId), [projectId])
  const target = usePlayTarget()
  const windowSession = useWindowPlay()
  const [rows, setRows] = useState<SaveSlotInfo[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [doc, setDoc] = useState<SaveDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const refresh = useCallback(async () => {
    try {
      const list = await store.list()
      setRows(list)
      setError(null)
      setSelected(prev => (prev && list.some(r => r.slot === prev) ? prev : list[0]?.slot ?? null))
    } catch (e) {
      setError(`The Play saves cannot be read: ${(e as Error)?.message ?? e}`)
    }
  }, [store])

  useEffect(() => { void refresh() }, [refresh])

  // Every write and delete is announced (the game's store, in this page or a game window's): the list keeps up.
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const channel = new BroadcastChannel(SAVES_CHANNEL)
    channel.onmessage = (e: MessageEvent<SavesChangedMessage>) => {
      if (e.data?.type === 'saves-changed' && e.data.db === PLAY_SAVES_DB) void refresh()
    }
    return () => channel.close()
  }, [refresh])

  // The selected save's document, for the view beside the list.
  useEffect(() => {
    let live = true
    setDoc(null)
    if (!selected) return
    store.read(selected).then(d => { if (live) setDoc(d) }).catch(e => { if (live) setError(`"${selected}" cannot be read: ${(e as Error)?.message ?? e}`) })
    return () => { live = false }
  }, [store, selected, rows])

  const running = isPlayMode || windowSession.active
  const inWindow = target === 'window'

  const playFrom = () => {
    if (!selected || running) return
    if (inWindow) {
      // The window opens inside this click, as Play's does (a web popup needs the click's activation).
      const title = projectSettings.publish.title.trim() || 'Cleo Game'
      windowPlay().start(() => buildWindowPlayData({ fromSlot: selected }), { width: projectSettings.publish.width, height: projectSettings.publish.height, title })
    } else {
      void startPlayFromSave(selected)
    }
  }

  const exportSelected = async () => {
    if (!selected) return
    const d = await store.read(selected)
    if (!d) return
    const url = URL.createObjectURL(new Blob([JSON.stringify(d, null, 2)], { type: 'application/json' }))
    const a = document.createElement('a')
    a.href = url
    a.download = exportFileName(selected, projectSettings.publish.title)
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const importFile = async (file: File) => {
    try {
      const parsed = parseImportedSave(await file.text())
      const slot = importSlot(parsed.slot, rows.map(r => r.slot))
      await store.write({ ...parsed, slot })
      Logger.info(`Imported "${file.name}" as the save "${slot}"`, 'Editor')
      await refresh()
      setSelected(slot)
    } catch (e) {
      setError(`"${file.name}" cannot be imported: ${(e as Error)?.message ?? e}`)
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    if (!await confirmDialog({ title: `Delete the save "${selected}"?`, message: 'It is removed from this project\'s Play saves.', confirmLabel: 'Delete', tone: 'danger' })) return
    await store.delete(selected)
    await refresh()
  }

  const deleteAll = async () => {
    if (!rows.length) return
    if (!await confirmDialog({ title: `Delete all ${rows.length} Play saves?`, message: 'Every save this project\'s games wrote while playing in the editor is removed. Saves in published games are not touched.', confirmLabel: 'Delete all', tone: 'danger' })) return
    for (const row of rows) await store.delete(row.slot)
    await refresh()
  }

  const preview = useMemo(() => (doc ? previewJson(doc) : null), [doc])

  return (
    <div className='flex h-full w-full flex-col overflow-hidden'>
      <div className='flex items-center gap-2 border-b border-border px-2 py-1'>
        <div className={JOINED_GROUP_CLASS}>
          <Action title={inWindow ? 'Play from this save, in a window' : 'Play from this save, in the editor'}
            disabled={!selected || running} onClick={playFrom}>
            {inWindow ? <PlayWindowIcon /> : <PlayEditorIcon />}
          </Action>
          <Action title='Export this save as a .cleosave file' disabled={!selected} onClick={() => void exportSelected()}><ExportIcon /></Action>
          <Action title='Import a .cleosave file' onClick={() => fileInput.current?.click()}><ImportIcon /></Action>
          <Action title='Delete this save' disabled={!selected} onClick={() => void deleteSelected()}><DeleteIcon /></Action>
          <Action title='Delete all Play saves' disabled={!rows.length} onClick={() => void deleteAll()}><DeleteAllIcon /></Action>
        </div>
        <input ref={fileInput} type='file' accept='.cleosave,application/json' className='hidden'
          onChange={e => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f) }} />
        {error && <span className='truncate text-ui-sm text-danger-fg' title={error}>{error}</span>}
      </div>

      {rows.length === 0
        ? <div className='p-3 text-ui-sm text-dim'>No saves yet. A game saves with <code>SaveGame.save()</code> while it plays, and its saves appear here.</div>
        : <div className='flex min-h-0 flex-1'>
            <div className='min-w-0 flex-1 overflow-auto'>
              <table className='w-full border-collapse text-ui'>
                <thead className='sticky top-0 bg-surface text-left text-ui-sm text-dim'>
                  <tr>
                    {['Slot', 'Label', 'Scene', 'Saved', 'Play time', 'Size'].map(h => <th key={h} className='px-2 py-1 font-normal'>{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {rows.map(row => (
                    <tr key={row.slot} onClick={() => setSelected(row.slot)}
                      onDoubleClick={() => { setSelected(row.slot); if (!running) playFrom() }}
                      className={cn('cursor-default hover:bg-control/60', row.slot === selected && 'bg-control text-fg')}>
                      <td className='px-2 py-0.5 font-mono'>{row.slot}</td>
                      <td className='max-w-[12rem] truncate px-2 py-0.5'>{row.label}</td>
                      <td className='px-2 py-0.5 text-muted'>{row.scene.name || row.scene.id}</td>
                      <td className='px-2 py-0.5 text-muted' title={row.savedAt}>{formatSavedAt(row.savedAt)}</td>
                      <td className='px-2 py-0.5 text-muted'>{formatPlayTime(row.playTime)}</td>
                      <td className='px-2 py-0.5 text-muted'>{formatSize(row.size)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className='min-w-0 flex-1 overflow-auto border-l border-border'>
              {preview
                ? <pre className='m-0 whitespace-pre p-2 font-mono text-ui-sm text-muted'>{preview.text}{preview.truncated ? '\n…' : ''}</pre>
                : <div className='p-2 text-ui-sm text-dim'>{selected ? 'Reading…' : ''}</div>}
            </div>
          </div>}
    </div>
  )
}
