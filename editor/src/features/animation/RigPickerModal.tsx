import { useEffect, useState } from 'react'
import { useEditorSessions } from '../EditorSessionsContext'
import { Modal, ModalHeader, ModalFooter, Button } from '../../components/ui'

/**
 * "Which rig is this animation for?"
 *
 * An animation file carries clips and a skeleton but no character, so there is nothing in it that says
 * which of the project's rigs it belongs to. Importing one from the asset explorer therefore has to ask.
 *
 * It does NOT ask when the Animation Editor is open: the character on screen is the answer, and prompting
 * for something already decided is noise. See `importAnimationFiles`.
 *
 * The choice is not permanent. Clips are stored in the FILE's own rig space, and the rig picked here only
 * decides which model gets the first link — the same asset can be linked to any other rig later, and is
 * retargeted afresh for each one.
 */
export default function RigPickerModal() {
  const { pendingRigPick, resolveRigPick } = useEditorSessions()
  const [selected, setSelected] = useState<string>('')

  useEffect(() => {
    setSelected(pendingRigPick?.models[0]?.id ?? '')
  }, [pendingRigPick])

  if (!pendingRigPick) return null
  const { fileName, models } = pendingRigPick

  return (
    <Modal onClose={() => resolveRigPick(null)} className='w-[420px]'>
      <ModalHeader>
        <div className='text-sm font-semibold'>Choose a rig</div>
        <div className='text-lg font-bold truncate' title={fileName}>{fileName}</div>
        <div className='text-xs text-gray-400 mt-0.5'>the skeleton its clips will be retargeted onto</div>
      </ModalHeader>

      <div className='max-h-[50vh] overflow-y-auto px-4 py-3 space-y-1'>
        {models.map(m => (
          <label key={m.id}
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm ${
              selected === m.id ? 'bg-primary/15 text-primary' : 'hover:bg-surface-hover text-text'}`}>
            <input type='radio' name='rig' value={m.id} checked={selected === m.id}
              onChange={() => setSelected(m.id)} />
            <span className='truncate'>{m.name}</span>
          </label>
        ))}
      </div>

      <div className='px-4 pb-2 text-[11px] text-text-muted'>
        The clips are stored once, in the file's own skeleton space — picking a rig here links them to that
        model, it does not tie the animation to it.
      </div>

      <ModalFooter>
        <Button variant='ghost' onClick={() => resolveRigPick(null)}>Cancel</Button>
        <Button disabled={!selected} onClick={() => resolveRigPick(selected || null)}>Continue</Button>
      </ModalFooter>
    </Modal>
  )
}
