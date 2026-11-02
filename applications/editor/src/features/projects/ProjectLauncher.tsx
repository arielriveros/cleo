import { useState } from 'react'
import ProjectsBrowser from './ProjectsBrowser'
import { ProjectRecord } from '../../utils/projects'
import { VERSION_LABEL } from '../../version'
import { LauncherPage } from '@cleo/app-kit/launcher/Launcher'

/**
 * The full-screen picker shown before the workspace exists: a fresh install, or a registry pointing at
 * nothing openable. Nothing here may touch scoped storage — no project is open yet, and `scoped()` throws
 * by design until one is.
 */
export default function ProjectLauncher({ projects }: { projects: ProjectRecord[] }) {
  const [list, setList] = useState(projects)

  return (
    <LauncherPage title='CLEO ENGINE' subtitle='Editor' version={VERSION_LABEL} className='h-screen w-screen'
      frameClassName='h-[380px]'
      prompt={list.length
        ? 'Open a project to continue.'
        : 'Create your first project, or start from one of the examples.'}>
      <ProjectsBrowser projects={list} onChanged={setList} />
    </LauncherPage>
  )
}
