import React from 'react'
import { useProject } from '../ProjectContext'
import { Modal, ModalHeader, ModalFooter } from '../../components/ui'

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
        <div className='text-sm font-semibold'>Unsaved changes</div>
      </ModalHeader>

      <div className='px-4 py-3 text-sm text-gray-300'>
        <p>
          <span className='font-semibold text-white'>{sceneName}</span> has unsaved changes. Save them
          before {action === 'close' ? 'closing it' : 'switching scenes'}?
        </p>
      </div>

      <ModalFooter>
        <button
          className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover'
          onClick={() => resolveSceneConfirm('cancel')}
        >
          Cancel
        </button>
        <button
          className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover text-warning'
          onClick={() => resolveSceneConfirm('discard')}
        >
          Discard
        </button>
        <button
          className='px-3 py-1.5 text-xs rounded bg-success hover:bg-success-hover font-semibold'
          onClick={() => resolveSceneConfirm('save')}
        >
          Save
        </button>
      </ModalFooter>
    </Modal>
  )
}
