import type React from 'react'
import { Glyph } from '@cleo/app-kit/ui/icons'

// The chat panel's glyphs: inline currentColor SVGs on the shared Glyph (24-unit box, sized by the container).

type P = React.SVGProps<SVGSVGElement>

/** A speech bubble with a spark: the Claude chat. */
export const ChatIcon = (p: P) => (
  <Glyph {...p}><path d='M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z' />
    <path d='M12 8.3v4.4M9.8 10.5h4.4' /></Glyph>
)

/** An arrow up: send. */
export const SendIcon = (p: P) => (
  <Glyph {...p}><path d='M12 19V5M6 11l6-6 6 6' /></Glyph>
)

/** A filled square: stop. */
export const StopIcon = (p: P) => (
  <Glyph {...p}><rect x='7' y='7' width='10' height='10' rx='1.5' fill='currentColor' stroke='none' /></Glyph>
)

/** A plus in a page: a new conversation. */
export const NewChatIcon = (p: P) => (
  <Glyph {...p}><path d='M12 5v14M5 12h14' /></Glyph>
)

/** A clock with a back arrow: past conversations. */
export const HistoryIcon = (p: P) => (
  <Glyph {...p}><path d='M4.5 12a7.5 7.5 0 1 0 2.2-5.3' /><path d='M4 3.5v4.5h4.5' /><path d='M12 8v4.5l3 2' /></Glyph>
)

/** A wrench: a tool call. */
export const ToolIcon = (p: P) => (
  <Glyph {...p}><path d='M14.5 4.5a4 4 0 0 0-4.9 5.3L4 15.4V20h4.6l5.6-5.6a4 4 0 0 0 5.3-4.9l-2.7 2.7-2.6-.7-.7-2.6z' /></Glyph>
)

/** A chevron pointing right (rotated when open). */
export const ChevronIcon = (p: P) => (
  <Glyph {...p}><path d='M9 6l6 6-6 6' /></Glyph>
)

/** A key: the API key setting. */
export const KeyIcon = (p: P) => (
  <Glyph {...p}><circle cx='8' cy='14' r='4' /><path d='M11 11l8-8M16 6l2.5 2.5M14 8l2 2' /></Glyph>
)
