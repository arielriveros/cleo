import React, { useSyncExternalStore } from 'react'
import { SegmentedControl, cn } from '../../components/ui'

// The frame every Options panel shares: a page switcher across the top, the page below. One store
// remembers each panel's page for the session, so switching modes and back lands where you were.

type Nav = Record<string, string>
let nav: Nav = {}
const listeners = new Set<() => void>()
const navStore = {
  subscribe(l: () => void) { listeners.add(l); return () => { listeners.delete(l) } },
  get: () => nav,
  set(panel: string, page: string) {
    if (nav[panel] === page) return
    nav = { ...nav, [panel]: page }
    listeners.forEach(l => l())
  },
}

/** The page a given Options panel shows. */
export function useOptionsPage<T extends string>(panel: string, fallback: T): [T, (page: T) => void] {
  const current = useSyncExternalStore(navStore.subscribe, navStore.get)
  return [(current[panel] as T) ?? fallback, (page: T) => navStore.set(panel, page)]
}

export interface OptionsPage<T extends string> { value: T; label: string; title?: string }

/** A panel's page switcher + the page body. The body scrolls; the switcher stays put. */
export function OptionsShell<T extends string>({ pages, page, onPage, children }: {
  pages: OptionsPage<T>[]
  page: T
  onPage: (page: T) => void
  children: React.ReactNode
}) {
  return (
    <div className='flex h-full flex-col'>
      <div className='shrink-0 border-b border-border-subtle p-2'>
        <SegmentedControl options={pages} value={page} onChange={onPage} grow />
      </div>
      <div className='min-h-0 flex-1'>{children}</div>
    </div>
  )
}

/** A scrolling page of option sections, capped in width like the renderer panel. */
export function OptionsPageBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn('h-full overflow-y-auto p-3 text-ui text-fg', className)}>
      <div className='w-full max-w-[460px]'>{children}</div>
    </div>
  )
}

/** Label column wide enough for option names ("Max physics substeps") at the ui size. */
export const OPTION_LABEL = 'w-[150px]'

// Which option pages are on screen right now: a page marks itself while mounted, so something outside
// the panel (the viewport's touch-control preview) can follow it. Dockview unmounts a hidden tab, so a
// page in a background tab correctly reads as not shown.
let shown: ReadonlySet<string> = new Set()
const shownListeners = new Set<() => void>()
const shownStore = {
  subscribe(l: () => void) { shownListeners.add(l); return () => { shownListeners.delete(l) } },
  get: () => shown,
  set(id: string, on: boolean) {
    if (shown.has(id) === on) return
    const next = new Set(shown)
    if (on) next.add(id); else next.delete(id)
    shown = next
    shownListeners.forEach(l => l())
  },
}

/** Mark an option page as on screen while the calling component is mounted. */
export function useMarkOptionPageShown(id: string): void {
  React.useEffect(() => {
    shownStore.set(id, true)
    return () => shownStore.set(id, false)
  }, [id])
}

/** True while the given option page is on screen. */
export function useOptionPageShown(id: string): boolean {
  return useSyncExternalStore(shownStore.subscribe, () => shownStore.get().has(id))
}
