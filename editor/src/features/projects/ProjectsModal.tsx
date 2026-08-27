import { useEffect, useState } from 'react'
import { Modal, ModalHeader } from '../../components/ui'
import ProjectsBrowser from './ProjectsBrowser'
import { ProjectRecord, loadProjects } from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'

/**
 * The in-editor project browser, opened from the menu bar. A fresh mount each time, which satisfies SVAR's
 * "data is passed once" constraint. The explorer needs an explicit height: inside a modal it has no flex
 * parent to fill.
 */
export default function ProjectsModal({ onClose }: { onClose: () => void }) {
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null)
  const activeId = activeProjectId()

  useEffect(() => { void loadProjects().then(setProjects) }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = projects?.find(p => p.id === activeId)

  return (
    <Modal onClose={onClose} className='w-[720px] max-w-[92vw]'>
      <ModalHeader>
        <div className='flex items-baseline gap-2'>
          <span className='font-semibold'>Projects</span>
          {current && <span className='text-xs text-muted'>Currently open: {current.name}</span>}
        </div>
        <div className='mt-1 text-[11px] text-dim'>
          Each project has its own scenes, assets, scripts and layout. Nothing is shared between them.
        </div>
      </ModalHeader>
      <div className='h-[420px]'>
        {projects
          ? <ProjectsBrowser projects={projects} onChanged={setProjects} />
          : <div className='w-full h-full flex items-center justify-center text-xs text-muted'>Loading projects…</div>}
      </div>
    </Modal>
  )
}
