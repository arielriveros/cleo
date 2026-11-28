import { useState } from 'react'
import { useAiEditor } from './AiEditorContext'
import { Button, Select, cn, controlClass } from '@cleo/app-kit/ui'

/**
 * Which of a behaviour brain's layers the canvas shows (the top level, or a layer: a machine of its own over the
 * same parameters, running beside it and setting outputs, never steering), and the button that adds one.
 */
export function BrainLayerPicker() {
  const { asset, layer, setLayer, layers, addLayer } = useAiEditor()
  if (!asset || asset.kind === 'goals') return null
  return (
    <div className='flex items-center gap-1 shrink-0'>
      <Select className='w-[136px] truncate' value={layer} onChange={e => setLayer(e.target.value)}
        title={layer
          ? `The canvas shows and edits the “${layer}” layer: it runs beside the top level over the same parameters, sets its states’ outputs, and never steers. Pick another, or Base`
          : 'The canvas shows and edits the top level: the states that steer. Pick a layer to edit its states'}>
        <option value=''>Base</option>
        {layers.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
      </Select>
      <Button size='sm' variant='subtle' className='shrink-0 whitespace-nowrap' onClick={addLayer}
        title='Add a layer: its own states over the same parameters, running beside the top level (a Health layer, a Weapon layer), setting outputs'>+ Layer</Button>
    </div>
  )
}

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
    // Uncontrolled (commits on blur), so it cannot be a TextInput; it borrows the shared control chrome.
    return (
      <input autoFocus defaultValue={asset.name}
        className={cn(controlClass, 'border-selected w-[160px]')}
        onBlur={(e) => { rename(e.target.value.trim() || asset.name); setEditing(false) }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') setEditing(false)
        }} />
    )
  }

  return (
    <Button
      variant='subtle'
      className='px-2 py-1 font-normal hover:bg-surface-raised hover:border-control-hover'
      title='Rename this brain'
      onClick={() => setEditing(true)}>
      {asset.name}
    </Button>
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
      <div className='max-w-[380px] text-center text-ui text-muted leading-relaxed px-6'>
        <p className='text-fg mb-2'>Nothing in this {what} yet.</p>
        <p>Add the first entry from the toolbar, or double-click the canvas.</p>
      </div>
    </div>
  )
}
