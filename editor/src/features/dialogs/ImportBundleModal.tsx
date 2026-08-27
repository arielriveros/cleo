import React from 'react'
import { Modal, ModalHeader, ModalFooter } from '../../components/ui'
import type { BundleData } from '../../utils/bundle'

// Shown after a .zip project/asset-pack is parsed, before anything is written. Three destinations, in
// increasing order of destructiveness: New project, Merge (re-mints colliding ids), Replace (discards the
// open project's contents). All three reload the editor afterwards.
export default function ImportBundleModal(props: {
  bundle: BundleData
  onNewProject: () => void
  onReplace: () => void
  onMerge: () => void
  onCancel: () => void
}) {
  const { bundle, onNewProject, onReplace, onMerge, onCancel } = props
  const isProject = bundle.manifest.kind === 'project'
  const sceneCount = Object.keys(bundle.scenes).length
  const { materials, terrainMaterials, templates, models } = bundle.libraries
  const assetCount = materials.length + terrainMaterials.length + templates.length + models.length

  return (
    <Modal onClose={onCancel} className='w-[440px]'>
      <ModalHeader>
        <div className='text-sm font-semibold'>Import {isProject ? 'project' : 'asset pack'}</div>
      </ModalHeader>

      <div className='px-4 py-3 space-y-3 text-sm text-gray-300'>
        <div className='flex gap-4 text-xs text-gray-400'>
          {isProject && <span>{sceneCount} scene{sceneCount === 1 ? '' : 's'}</span>}
          <span>{assetCount} asset{assetCount === 1 ? '' : 's'}</span>
          <span>{bundle.textures.length} texture{bundle.textures.length === 1 ? '' : 's'}</span>
        </div>
        <div className='space-y-2'>
          <p>
            <span className='font-semibold text-white'>New project</span> — put this in a project of its own.
            Your current project is not touched.
          </p>
          <p>
            <span className='font-semibold text-white'>Merge</span> — add this {isProject ? 'project’s scenes and assets' : 'pack’s assets'} to
            the current project, renaming anything that collides.
          </p>
          <p>
            <span className='font-semibold text-white'>Replace</span> —{' '}
            {isProject
              ? 'discard the current project’s contents and load this one in its place.'
              : 'overwrite the current project’s asset libraries with this pack (its scenes are kept).'}
          </p>
          <p className='text-[11px] text-warning'>Every choice reloads the editor.</p>
        </div>
      </div>

      <ModalFooter>
        <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={onCancel}>Cancel</button>
        <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={onMerge}>Merge</button>
        <button className='px-3 py-1.5 text-xs rounded bg-danger hover:bg-danger-hover font-semibold' onClick={onReplace}>Replace</button>
        <button className='px-3 py-1.5 text-xs rounded bg-primary hover:bg-primary-hover font-semibold' onClick={onNewProject}>New project</button>
      </ModalFooter>
    </Modal>
  )
}
