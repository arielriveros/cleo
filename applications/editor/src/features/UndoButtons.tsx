// The Undo / Redo glyphs, used by the menu bar's Edit menu (MenuBar.tsx). The buttons they drew on the bar
// itself went into that menu.

export const UndoGlyph = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M9 14 4 9l5-5' /><path d='M4 9h9a7 7 0 0 1 0 14h-3' />
  </svg>
)
export const RedoGlyph = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='m15 14 5-5-5-5' /><path d='M20 9h-9a7 7 0 0 0 0 14h3' />
  </svg>
)
