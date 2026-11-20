import { useEffect, useState, type RefObject } from 'react'
import { EYE_TRIGGER_CLASS } from '@cleo/app-kit/ui'
import { getShellBridge } from '@cleo/app-kit/platform/desktopShell'

// Play's fullscreen button, in the viewport's top-right chrome. Fullscreen is what lets the game take EVERY key:
// in a normal tab Chrome keeps Ctrl+W, Ctrl+T and Ctrl+N from the page, so a game that walks on Ctrl and W closes
// the tab. In fullscreen, with the mouse captured, the input system holds the whole keyboard (the Keyboard Lock
// API, src/input/deviceSampler.ts); the release key (Options ▸ Editor ▸ Viewport ▸ Play) then lets the mouse go,
// and holding Esc leaves fullscreen. Web only: the desktop shell binds none of those keys, and its window has its
// own fullscreen.

const EnterIcon = () => (
  <svg viewBox='0 0 16 16' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
    <path d='M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10' />
  </svg>
)

const ExitIcon = () => (
  <svg viewBox='0 0 16 16' width='14' height='14' fill='none' stroke='currentColor' strokeWidth='1.6' strokeLinecap='round' strokeLinejoin='round' aria-hidden>
    <path d='M6 2.5V6H2.5M13.5 6H10V2.5M10 13.5V10h3.5M2.5 10H6v3.5' />
  </svg>
)

/**
 * Marks the element Play goes fullscreen with: the viewport panel, holding the engine's canvas AND what is drawn
 * over it as DOM (the game UI, the touch controls). Fullscreen shows only the fullscreen element's subtree, so
 * the canvas's own wrapper alone would leave the HUD behind.
 */
export const PLAY_SURFACE_ATTR = 'data-cleo-play-surface'

/** What goes fullscreen for the viewport `el`: the play surface round it, else `el` itself. */
export function playFullscreenTarget<T extends { closest(selector: string): unknown }>(el: T): T {
  return (el.closest(`[${PLAY_SURFACE_ATTR}]`) as T | null) ?? el
}

/** Whether this page can go fullscreen itself (a browser that allows it, not the desktop shell). */
export function canPlayFullscreen(): boolean {
  return typeof document !== 'undefined' && !!document.fullscreenEnabled && !getShellBridge()
}

export default function PlayFullscreenButton({ target }: { target: RefObject<HTMLElement | null> }) {
  const [full, setFull] = useState(() => typeof document !== 'undefined' && !!document.fullscreenElement)
  useEffect(() => {
    const sync = () => setFull(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange', sync)
    return () => document.removeEventListener('fullscreenchange', sync)
  }, [])
  // Leaving Play leaves fullscreen too: the editor's own panels are not in it.
  useEffect(() => () => { if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}) }, [])

  const toggle = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
    else if (target.current) void playFullscreenTarget(target.current).requestFullscreen?.().catch(() => {})
  }
  return (
    <button type='button' data-cleo-overlay className={EYE_TRIGGER_CLASS} onClick={toggle}
      title={full ? 'Leave fullscreen (or hold Esc)' : 'Fullscreen: the game takes every key, browser shortcuts included'}>
      {full ? <ExitIcon /> : <EnterIcon />}
    </button>
  )
}
