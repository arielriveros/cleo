import { useEffect, useState } from 'react'
import { DocScope, Modal, ModalHeader } from '@cleo/app-kit/ui'
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
      {/* What a project is, and what this browser does, is docs/editor/projects.md: the title's card. */}
      <DocScope page='editor/projects'>
        <ModalHeader title='Projects' aside={current && `Currently open: ${current.name}`} />
        <div className='h-[420px]'>
          {projects
            ? <ProjectsBrowser projects={projects} onChanged={setProjects} />
            : <div className='w-full h-full flex items-center justify-center text-ui text-muted'>Loading projects…</div>}
        </div>
      </DocScope>
    </Modal>
  )
}
