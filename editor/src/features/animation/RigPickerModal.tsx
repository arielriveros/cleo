import { useEffect, useState } from 'react'
import { useEditorSessions } from '../EditorSessionsContext'
import { Modal, ModalHeader, ModalFooter, Button, cn, hintClass } from '../../components/ui'

/**
 * Asks which rig an imported animation file is for; an animation file names no character of its own.
 * Skipped while the Animation Editor is open — see `importAnimationFiles`. The answer is not permanent:
 * clips are stored in the file's own rig space and are retargeted afresh for every model linked later.
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
        <div className='text-ui-lg font-semibold'>Which character are these clips for?</div>
        <div className='text-ui-lg font-bold truncate' title={fileName}>{fileName}</div>
        <div className={cn(hintClass, 'mt-0.5')}>its skeleton is what the clips are matched and linked to</div>
      </ModalHeader>

      <div className='max-h-[50vh] overflow-y-auto px-4 py-3 space-y-1'>
        {models.map(m => (
          <label key={m.id}
            className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-ui ${
              selected === m.id ? 'bg-primary/15 text-primary' : 'hover:bg-control-hover text-fg'}`}>
            <input type='radio' name='character' value={m.id} checked={selected === m.id}
              onChange={() => setSelected(m.id)} />
            <span className='truncate'>{m.name}</span>
          </label>
        ))}
      </div>

      <div className={cn(hintClass, 'px-4 pb-2')}>
        The clips are linked to that character's skeleton, so every character built on it plays them. They
        are stored once, in the file's own skeleton space, so they can be linked to other skeletons later.
      </div>

      <ModalFooter>
        <Button variant='ghost' onClick={() => resolveRigPick(null)}>Cancel</Button>
        <Button variant='primary' disabled={!selected} onClick={() => resolveRigPick(selected || null)}>Continue</Button>
      </ModalFooter>
    </Modal>
  )
}
