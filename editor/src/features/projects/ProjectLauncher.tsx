import { useState } from 'react'
import ProjectsBrowser from './ProjectsBrowser'
import { ProjectRecord } from '../../utils/projects'

/**
 * The full-screen picker shown before the workspace exists — a fresh install, or a browser whose registry
 * points at nothing openable.
 *
 * It is the SAME explorer the menu-bar modal hosts, so creating a project looks identical whether you are
 * arriving for the first time or switching later. Nothing here may touch scoped storage: no project is open
 * yet, and `scoped()` throws by design until one is.
 */
export default function ProjectLauncher({ projects }: { projects: ProjectRecord[] }) {
  const [list, setList] = useState(projects)

  return (
    <div className='h-screen w-screen flex flex-col items-center justify-center bg-bg text-fg select-none'>
      <div className='w-[720px] max-w-[92vw] flex flex-col gap-6'>
        <div className='flex flex-col items-center gap-2'>
          <h1 className='text-2xl font-semibold tracking-[0.3em] text-slate-200'>CLEO ENGINE</h1>
          <span className='text-[10px] uppercase tracking-[0.3em] text-slate-500'>Editor</span>
        </div>
        <div className='flex flex-col gap-2'>
          <div className='text-sm text-slate-300'>
            {list.length
              ? 'Open a project to continue.'
              : 'Create your first project, or start from one of the examples.'}
          </div>
          <div className='h-[380px] rounded-md border border-control overflow-hidden bg-surface-raised'>
            <ProjectsBrowser projects={list} onChanged={setList} />
          </div>
          <div className='text-[11px] text-dim'>
            A project owns its scenes, models, materials, scripts and textures. Nothing is shared between projects.
          </div>
        </div>
      </div>
    </div>
  )
}
