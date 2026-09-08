import { useState } from 'react'
import { useAiEditor } from './AiEditorContext'

/**
 * The toolbar head every AI canvas shares: the brain's name, editable in place.
 *
 * No Close button and no target picker. A brain is an ASSET now — the tab closes it, and which brain
 * this is was decided by the tab you opened. What is worth having here instead is the name, because
 * renaming in the asset explorer means leaving the thing you are editing.
 */
export default function AiGraphToolbar() {
  const { asset, rename } = useAiEditor()
  const [editing, setEditing] = useState(false)

  if (!asset) return null

  if (editing) {
    return (
      <input autoFocus defaultValue={asset.name}
        className='px-2 py-1 rounded bg-control text-white border border-selected text-xs w-[160px]'
        onBlur={(e) => { rename(e.target.value.trim() || asset.name); setEditing(false) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }} />
    )
  }

  return (
    <button
      className='px-2 py-1 rounded bg-surface-raised border border-border text-xs text-white hover:border-control-hover'
      title='Rename this brain'
      onClick={() => setEditing(true)}>
      {asset.name}
    </button>
  )
}

/**
 * What a canvas shows when there is nothing laid out yet.
 *
 * A brand-new brain always lands here, so it says what to press rather than looking broken.
 */
export function AiEmptyState({ what }: { what: string }) {
  return (
    <div className='absolute inset-0 z-10 flex items-center justify-center bg-surface'>
      <div className='max-w-[380px] text-center text-xs text-muted leading-relaxed px-6'>
        <p className='text-white mb-2'>Nothing in this {what} yet.</p>
        <p>Add the first entry from the toolbar, or double-click the canvas.</p>
      </div>
    </div>
  )
}
