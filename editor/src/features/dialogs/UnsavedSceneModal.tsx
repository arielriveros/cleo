import React from 'react'
import { useProject } from '../ProjectContext'
import { Modal, ModalHeader, ModalFooter, Button } from '../../components/ui'

// Shown when unsaved edits are about to be lost. `openScene` and `closeTab` park a promise
// (confirmUnsavedScene) that this modal resolves: Save writes then proceeds, Discard drops the edits and
// proceeds, Cancel aborts. Mounted globally in Editor.
export default function UnsavedSceneModal() {
  const { pendingSceneConfirm, resolveSceneConfirm } = useProject()

  if (!pendingSceneConfirm) return null
  const { sceneName, action } = pendingSceneConfirm

  return (
    <Modal onClose={() => resolveSceneConfirm('cancel')} className='w-[400px]'>
      <ModalHeader>
        <div className='text-ui-lg font-semibold'>Unsaved changes</div>
      </ModalHeader>

      <div className='px-4 py-3 text-ui text-fg'>
        <p>
          <span className='font-semibold text-fg'>{sceneName}</span> has unsaved changes. Save them
          before {action === 'close' ? 'closing it' : 'switching scenes'}?
        </p>
      </div>

      <ModalFooter>
        <Button onClick={() => resolveSceneConfirm('cancel')}>
          Cancel
        </Button>
        <Button
          className='text-warning'
          onClick={() => resolveSceneConfirm('discard')}
        >
          Discard
        </Button>
        <Button
          variant='success'
          className='font-semibold'
          onClick={() => resolveSceneConfirm('save')}
        >
          Save
        </Button>
      </ModalFooter>
    </Modal>
  )
}
