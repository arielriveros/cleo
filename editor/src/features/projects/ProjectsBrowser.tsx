import { useState } from 'react'
import ProjectsExplorer from './ProjectsExplorer'
import ExamplesGallery, { useExampleIndex } from './ExamplesGallery'
import { ProjectRecord } from '../../utils/projects'

// Hosts the two ways to arrive at a project: existing ones and the examples this build ships with.
// Rendered by both the boot launcher and the in-editor Projects modal.
//
// Switching tabs unmounts the explorer, which is the lifecycle SVAR's file manager requires: mount once,
// `data` passed once.

type Tab = 'projects' | 'examples'

export default function ProjectsBrowser({ projects, onChanged, className = '' }: {
  projects: ProjectRecord[]
  onChanged: (projects: ProjectRecord[]) => void
  className?: string
}) {
  const [tab, setTab] = useState<Tab>('projects')
  // null while loading, [] when this build carries no examples; the tab stays hidden either way.
  const examples = useExampleIndex()
  const hasExamples = !!examples?.length

  return (
    <div className={`w-full h-full flex flex-col ${className}`}>
      {hasExamples && (
        <div className='h-[26px] flex items-stretch gap-1 px-1 shrink-0 border-b border-border-subtle bg-surface'>
          {([['projects', 'My Projects'], ['examples', 'Examples']] as const).map(([id, label]) => (
            <button
              key={id}
              type='button'
              onClick={() => setTab(id)}
              className={
                'px-3 text-[11px] font-semibold leading-none cursor-pointer border-b-2 -mb-px ' +
                (tab === id
                  ? 'text-fg border-highlight'
                  : 'text-dim border-transparent hover:text-fg')
              }>
              {label}
            </button>
          ))}
        </div>
      )}

      <div className='flex-1 min-h-0'>
        {tab === 'examples' && examples
          ? <ExamplesGallery examples={examples} />
          : <ProjectsExplorer projects={projects} onChanged={onChanged} />}
      </div>
    </div>
  )
}
