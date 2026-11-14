import type React from 'react'
import { Glyph } from '@cleo/app-kit/ui/icons'

// The Claude panel's glyphs: inline currentColor SVGs on the shared Glyph (24-unit box, sized by the container).

type P = React.SVGProps<SVGSVGElement>

/** A speech bubble with a spark: the Claude panel. */
export const ChatIcon = (p: P) => (
  <Glyph {...p}><path d='M4.5 5.5h15a1.5 1.5 0 0 1 1.5 1.5v8.5a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.5V17H4.5A1.5 1.5 0 0 1 3 15.5V7a1.5 1.5 0 0 1 1.5-1.5z' />
    <path d='M12 8.3v4.4M9.8 10.5h4.4' /></Glyph>
)

/** A plus: a new session. */
export const NewChatIcon = (p: P) => (
  <Glyph {...p}><path d='M12 5v14M5 12h14' /></Glyph>
)

/** A clock with an arrow running back round it: pick up the last conversation. */
export const ContinueIcon = (p: P) => (
  <Glyph {...p}><path d='M4.5 12a7.5 7.5 0 1 0 2.2-5.3' /><path d='M4 3.5v4.5h4.5' /><path d='M12 8v4.2l2.8 1.8' /></Glyph>
)

/** A square in a ring: stop the running session. */
export const StopSessionIcon = (p: P) => (
  <Glyph {...p}><circle cx='12' cy='12' r='8.5' /><rect x='9' y='9' width='6' height='6' rx='1' fill='currentColor' stroke='none' /></Glyph>
)
