import React from 'react'
import { Modal, ModalHeader, ModalFooter } from '../../components/ui'
import type { BundleData } from '../../utils/bundle'

// Shown after a .zip project/asset-pack is parsed, before anything is written. Replace overwrites the
// project (or, for a pack, the asset libraries) with the bundle; Merge appends it alongside the current
// project, re-minting any colliding ids. Both reload the editor afterwards.
export default function ImportBundleModal(props: {
  bundle: BundleData
  onReplace: () => void
  onMerge: () => void
  onCancel: () => void
}) {
  const { bundle, onReplace, onMerge, onCancel } = props
  const isProject = bundle.manifest.kind === 'project'
  const sceneCount = Object.keys(bundle.scenes).length
  const { materials, terrainMaterials, templates, meshes } = bundle.libraries
  const assetCount = materials.length + terrainMaterials.length + templates.length + meshes.length

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
            <span className='font-semibold text-white'>Replace</span> —{' '}
            {isProject
              ? 'discard the current project and load this one.'
              : 'overwrite the asset libraries with this pack (scenes are kept).'}
          </p>
          <p>
            <span className='font-semibold text-white'>Merge</span> — add this {isProject ? 'project’s scenes and assets' : 'pack’s assets'} to
            the current project, renaming anything that collides.
          </p>
          <p className='text-[11px] text-warning'>Either choice reloads the editor.</p>
        </div>
      </div>

      <ModalFooter>
        <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={onCancel}>Cancel</button>
        <button className='px-3 py-1.5 text-xs rounded bg-control hover:bg-control-hover' onClick={onMerge}>Merge</button>
        <button className='px-3 py-1.5 text-xs rounded bg-danger hover:bg-danger-hover font-semibold' onClick={onReplace}>Replace</button>
      </ModalFooter>
    </Modal>
  )
}
