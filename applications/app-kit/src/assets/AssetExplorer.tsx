import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Filemanager, WillowDark } from '@svar-ui/react-filemanager'
import type { IApi, IFileMenuOption, IParsedEntity, TContextMenuType, TMode } from '@svar-ui/react-filemanager'
// filemanager.css @imports the SVAR stylesheet itself, so the skin's rules deterministically follow it.
import './filemanager.css'
import { Button, TextInput } from '../ui'
import { baseOf } from './paths'
import type { FmEntity } from './fileManagerSync'

// The asset explorer's view, shared by the Cleo Editor (its project's assets) and Cleo Creator (its
// library): SVAR's file manager in the Cleo skin, with one 28 px toolbar row of our own -- the app's
// controls, search, the details pane and the view modes. SVAR's toolbar is hidden (filemanager.css).
//
// What the tree MEANS stays with the app: `data` (frozen at mount; later changes go through the store,
// see fileManagerSync.ts), what a rename or a delete does (the `init` intercepts), icons and thumbnails.

export interface AssetExplorerProps {
  /** The tree at mount. Never re-read: re-passing `data` re-initialises SVAR's store and collapses it. */
  data: FmEntity[]
  /** The store, once SVAR hands it over; `init` is where the app installs its intercepts. */
  apiRef: React.MutableRefObject<IApi | null>
  init: (api: IApi) => void
  /** localStorage key the view mode (cards, table, split) is kept under. */
  modeKey: string
  previews?: (file: Partial<IParsedEntity>) => string | null
  icons?: (file: Partial<IParsedEntity>) => string
  menuOptions?: (mode: TContextMenuType, item?: { id: string }) => IFileMenuOption[]
  /**
   * Context-menu items of the app's own, by option id. SVAR's performAction is a closed switch over its
   * built-in ids, so a custom option's click is caught at the document instead.
   */
  menuActions?: Record<string, () => void>
  /** Toolbar content before the search field (an Add menu, hidden file inputs). */
  toolbarStart?: React.ReactNode
  /** Toolbar content after it (status, audits), before the details and view-mode buttons. */
  toolbarEnd?: React.ReactNode
  /** The element around the file manager, for an app's own drop or hover handlers. */
  wrapperRef?: React.RefObject<HTMLDivElement>
  /** DOM id prefix of the toolbar's controls (`<prefix>-search`, `-preview-toggle`, `-view-modes`). */
  idPrefix?: string
}

export function AssetExplorer(props: AssetExplorerProps) {
  const { data, apiRef, init, modeKey, previews, icons, menuOptions, menuActions, toolbarStart, toolbarEnd, idPrefix = 'asset' } = props
  const ownWrapper = useRef<HTMLDivElement>(null)
  const wrapperRef = props.wrapperRef ?? ownWrapper

  // Stable for SVAR (it memoizes on its props); reads the latest `init` through a ref.
  const initRef = useRef(init)
  initRef.current = init
  const onInit = useCallback((api: IApi) => { apiRef.current = api; initRef.current(api) }, [apiRef])

  // Built once, on mount: see `data`.
  const initialData = useMemo(() => data, [])  // eslint-disable-line react-hooks/exhaustive-deps
  const initialMode = useMemo<TMode>(() => {
    try { return (localStorage.getItem(modeKey) as TMode) || 'cards' } catch { return 'cards' }
  }, [modeKey])

  const [previewOpen, setPreviewOpen] = useState(false)
  const [viewMode, setViewMode] = useState<TMode>(initialMode)
  const [search, setSearch] = useState('')
  const searchStartedRef = useRef(false)
  useEffect(() => {
    if (!searchStartedRef.current) { searchStartedRef.current = true; return }
    const t = window.setTimeout(() => apiRef.current?.exec('filter-files', { text: search }), 200)
    return () => window.clearTimeout(t)
  }, [search, apiRef])

  const togglePreview = () => {
    const next = !previewOpen
    setPreviewOpen(next)
    apiRef.current?.exec('show-preview', { mode: next })
  }
  const setMode = (mode: TMode) => {
    setViewMode(mode)
    apiRef.current?.exec('set-mode', { mode })
    try { localStorage.setItem(modeKey, mode) } catch { /* ignore */ }
  }

  // A card label is ellipsized at 80px and SVAR renders no title of its own. Written on hover, not up
  // front: card elements are React-reused across renames and would keep a stale title.
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const onOver = (e: Event) => {
      const card = (e.target as HTMLElement | null)?.closest?.('.wx-cards .wx-item[data-id]') as HTMLElement | null
      if (!card || card.closest('.wx-breadcrumbs')) return // the breadcrumb bar reuses .wx-item
      const raw = card.getAttribute('data-id') ?? ''
      const path = raw.startsWith(':') ? raw.slice(1) : raw // setID prefixes every DOM id with ':'
      if (!path.startsWith('/')) return
      const name = baseOf(path)
      if (card.getAttribute('title') !== name) card.setAttribute('title', name)
    }
    el.addEventListener('mouseover', onOver)
    return () => el.removeEventListener('mouseover', onOver)
  }, [wrapperRef])

  // The app's custom menu items (see `menuActions`). Read through a ref: the listener registers once.
  const actionsRef = useRef(menuActions)
  actionsRef.current = menuActions
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const item = (e.target as HTMLElement).closest?.('[data-id]') as HTMLElement | null
      const id = item?.getAttribute('data-id')?.replace(/^:/, '')
      const run = id ? actionsRef.current?.[id] : undefined
      if (run) run()
    }
    document.addEventListener('click', onClick, true)
    return () => document.removeEventListener('click', onClick, true)
  }, [])

  const modeButtons: { mode: TMode; title: string; icon: React.ReactNode }[] = [
    { mode: 'table', title: 'Table view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round'><path d='M4 6h16M4 12h16M4 18h16' /></svg> },
    { mode: 'cards', title: 'Cards view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><rect x='3' y='3' width='7' height='7' rx='1' /><rect x='14' y='3' width='7' height='7' rx='1' /><rect x='3' y='14' width='7' height='7' rx='1' /><rect x='14' y='14' width='7' height='7' rx='1' /></svg> },
    { mode: 'panels', title: 'Split view', icon: <svg className='w-3 h-3' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2'><rect x='3' y='4' width='8' height='16' rx='1' /><rect x='13' y='4' width='8' height='16' rx='1' /></svg> },
  ]

  return (
    <div className='w-full h-full flex flex-col text-ui'>
      {/* The explorer's entire chrome is ONE 28px row; every saved pixel goes to the card area below. */}
      <div className='h-[28px] flex items-center gap-1.5 px-2 border-b border-border-subtle shrink-0 bg-surface-sunken'>
        {toolbarStart}
        <TextInput
          id={`${idPrefix}-search`}
          className='shrink min-w-[80px] w-[200px] h-[20px] py-0 text-ui-sm placeholder:text-dim'
          placeholder='Search'
          value={search}
          onChange={setSearch}
        />
        {toolbarEnd ?? <span className='ml-auto' />}
        <Button
          id={`${idPrefix}-preview-toggle`}
          variant='ghost'
          size='icon'
          active={previewOpen}
          className='shrink-0 w-[24px] h-[20px] p-0'
          onClick={togglePreview}
          title='Show the details pane for the selected asset'>
          <svg className='w-3.5 h-3.5' viewBox='0 0 24 24' fill='none' stroke='currentColor' strokeWidth='2' strokeLinecap='round' strokeLinejoin='round'>
            <path d='M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z' /><circle cx='12' cy='12' r='3' />
          </svg>
        </Button>
        <div id={`${idPrefix}-view-modes`} className='shrink-0 flex items-center gap-0.5 p-[2px] rounded bg-surface border border-border-subtle'>
          {modeButtons.map(b => (
            <Button key={b.mode}
              data-mode={b.mode}
              variant='ghost'
              size='icon'
              active={viewMode === b.mode}
              className='w-[24px] h-[16px] p-0 rounded-sm'
              onClick={() => setMode(b.mode)}
              title={b.title}>
              {b.icon}
            </Button>
          ))}
        </div>
      </div>

      <div ref={wrapperRef} className='cleo-fm relative flex-1 min-h-0'>
        <WillowDark fonts={false}>
          <Filemanager
            data={initialData}
            mode={initialMode}
            preview={false}
            previews={previews}
            icons={icons}
            menuOptions={menuOptions}
            init={onInit}
          />
        </WillowDark>
      </div>
    </div>
  )
}
