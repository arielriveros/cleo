import React from 'react'
import { Modal, ModalHeader, ModalFooter, Button } from '@cleo/app-kit/ui'
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
      <ModalHeader title={`Import ${isProject ? 'project' : 'asset pack'}`} doc='editor/projects#import' />

      <div className='px-4 py-3 space-y-3 text-ui text-fg'>
        <div className='flex gap-4 text-ui text-muted'>
          {isProject && <span>{sceneCount} scene{sceneCount === 1 ? '' : 's'}</span>}
          <span>{assetCount} asset{assetCount === 1 ? '' : 's'}</span>
          <span>{bundle.textures.length} texture{bundle.textures.length === 1 ? '' : 's'}</span>
        </div>
        <div className='space-y-2'>
          <p>
            <span className='font-semibold text-fg'>New project</span> — put this in a project of its own.
            Your current project is not touched.
          </p>
          <p>
            <span className='font-semibold text-fg'>Merge</span> — add this {isProject ? 'project’s scenes and assets' : 'pack’s assets'} to
            the current project, renaming anything that collides.
          </p>
          <p>
            <span className='font-semibold text-fg'>Replace</span> —{' '}
            {isProject
              ? 'discard the current project’s contents and load this one in its place.'
              : 'overwrite the current project’s asset libraries with this pack (its scenes are kept).'}
          </p>
          <p className='text-ui-sm text-warning'>Every choice reloads the editor.</p>
        </div>
      </div>

      <ModalFooter>
        <Button onClick={onCancel}>Cancel</Button>
        <Button onClick={onMerge}>Merge</Button>
        <Button variant='danger' className='font-semibold' onClick={onReplace}>Replace</Button>
        <Button variant='primary' className='font-semibold' onClick={onNewProject}>New project</Button>
      </ModalFooter>
    </Modal>
  )
}
