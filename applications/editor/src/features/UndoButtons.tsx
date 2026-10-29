import { Button } from '../components/ui'
import { useHistory } from './HistoryContext'
import { usePlayback } from './PlaybackContext'

// Undo/Redo for the active tab, sitting beside the Save controls in the menu bar.

const UndoGlyph = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='M9 14 4 9l5-5' /><path d='M4 9h9a7 7 0 0 1 0 14h-3' />
  </svg>
)
const RedoGlyph = () => (
  <svg viewBox='0 0 24 24' width='15' height='15' fill='none' stroke='currentColor' strokeWidth='1.8' strokeLinecap='round' strokeLinejoin='round'>
    <path d='m15 14 5-5-5-5' /><path d='M20 9h-9a7 7 0 0 0 0 14h3' />
  </svg>
)

export default function UndoButtons() {
  const { canUndo, canRedo, undo, redo, undoLabel, redoLabel } = useHistory()
  const { isPlayMode } = usePlayback()

  return (
    <div className='flex items-center gap-1'>
      <Button
        variant='ghost' size='icon' className='h-[25px]'
        disabled={!canUndo || isPlayMode}
        title={canUndo ? `Undo ${undoLabel} (Ctrl+Z)` : 'Nothing to undo'}
        onClick={undo}
      >
        <UndoGlyph />
      </Button>
      <Button
        variant='ghost' size='icon' className='h-[25px]'
        disabled={!canRedo || isPlayMode}
        title={canRedo ? `Redo ${redoLabel} (Ctrl+Shift+Z)` : 'Nothing to redo'}
        onClick={redo}
      >
        <RedoGlyph />
      </Button>
    </div>
  )
}
