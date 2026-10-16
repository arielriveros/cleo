import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import InputMapPanel from '../input/InputMapPanel'
import { Button, Field, Hint, NumberInput, Section, Select, TextInput, Toggle, cn } from '../../components/ui'
import { loadProjects, renameProject } from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useMarkOptionPageShown, useOptionsPage } from './OptionsShell'
import { DEFAULT_PROJECT_SETTINGS, type PublishWindowSettings } from './projectSettings'

// Options ▸ Project: what belongs to THIS game and travels with it — its name, the scene it starts in,
// how a published build presents itself, and the input map. Carried in project bundles.

type Page = 'general' | 'input'

/** The id the viewport watches to preview on-screen touch controls while the input map is open. */
export const INPUT_PAGE_ID = 'project.input'

export default function ProjectOptionsPanel() {
  const [page, setPage] = useOptionsPage<Page>('project', 'general')
  return (
    <OptionsShell
      page={page}
      onPage={setPage}
      pages={[
        { value: 'general', label: 'General', title: 'Name, main scene and how a published build presents itself' },
        { value: 'input', label: 'Input', title: 'Actions, bindings and on-screen touch controls' },
      ]}
    >
      {page === 'general' && <GeneralOptions />}
      {page === 'input' && <InputPage />}
    </OptionsShell>
  )
}

function InputPage() {
  useMarkOptionPageShown(INPUT_PAGE_ID)
  return <div className='flex h-full flex-col overflow-hidden'><InputMapPanel /></div>
}

function GeneralOptions() {
  const { sceneList, mainSceneId, setMainScene, projectSettings, setProjectSettings } = useCleoEngine()
  const w = projectSettings.publish
  const setWindow = (patch: Partial<PublishWindowSettings>) =>
    setProjectSettings(prev => ({ ...prev, publish: { ...prev.publish, ...patch } }))
  const d = DEFAULT_PROJECT_SETTINGS.publish

  // The project's name lives on the project record (machine-local metadata), not in project storage.
  const projectId = activeProjectId()
  const [savedName, setSavedName] = useState('')
  const [name, setName] = useState('')
  useEffect(() => {
    void loadProjects().then(list => {
      const n = list.find(p => p.id === projectId)?.name ?? ''
      setSavedName(n); setName(n)
    })
  }, [projectId])
  const commitName = () => {
    const trimmed = name.trim()
    if (!projectId || !trimmed || trimmed === savedName) { setName(savedName); return }
    void renameProject(projectId, trimmed).then(() => {
      setSavedName(trimmed); setName(trimmed)
      window.dispatchEvent(new CustomEvent('cleo:project-renamed', { detail: trimmed }))
    })
  }

  return (
    <OptionsPageBody>
      <Section title='Project'>
        <Field label='Name' labelClassName={OPTION_LABEL} hint='Shown in the projects list and the menu bar.'>
          <TextInput value={name} onChange={setName} onBlur={commitName} disabled={!projectId}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </Field>
        <Field label='Main scene' labelClassName={OPTION_LABEL}
          hint='The scene a published game starts in. Scenes load each other from scripts after that.'>
          <Select className='flex-1' value={mainSceneId} onChange={e => setMainScene(e.target.value)}
            disabled={sceneList.length === 0}>
            {!sceneList.some(s => s.id === mainSceneId) && <option value=''>—</option>}
            {sceneList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      </Section>

      <Section title='Published game'
        hint='How a published build presents itself. The size and window flags apply to the desktop build.'>
        <Field label='Title' labelClassName={OPTION_LABEL}
          hint='The window / browser-tab title, the desktop installer’s product name and the folder a publish saves into. Empty = the project name.'>
          <TextInput value={w.title} placeholder={name || 'Project name'} maxLength={120}
            onChange={v => setWindow({ title: v })} />
        </Field>
        <Field label='Window size' labelClassName={OPTION_LABEL} hint='Desktop window size at launch, in pixels.'>
          <div className='flex flex-1 items-center gap-1.5'>
            <NumberInput value={w.width} min={320} max={7680} step={1}
              onChange={v => setWindow({ width: clampInt(v, 320, 7680) })} />
            <span className='text-ui-sm text-dim'>×</span>
            <NumberInput value={w.height} min={240} max={4320} step={1}
              onChange={v => setWindow({ height: clampInt(v, 240, 4320) })} />
          </div>
        </Field>
        <Field label='Start fullscreen' labelClassName={OPTION_LABEL}>
          <span className='flex flex-1'><Toggle checked={w.fullscreen} onChange={v => setWindow({ fullscreen: v })} /></span>
        </Field>
        <Field label='Resizable window' labelClassName={OPTION_LABEL}>
          <span className={cn('flex flex-1', w.fullscreen && 'opacity-60')}>
            <Toggle checked={w.resizable} onChange={v => setWindow({ resizable: v })} />
          </span>
        </Field>
        <Field label='Only used shaders' labelClassName={OPTION_LABEL}
          hint='Compile just the shaders this game uses at startup, not all of them: a much shorter first launch. Anything missed still compiles when first needed.'>
          <span className='flex flex-1'><Toggle checked={w.onlyUsedShaders} onChange={v => setWindow({ onlyUsedShaders: v })} /></span>
        </Field>
        <Hint className='mt-1'>A web build fills the page it is embedded in; only the title applies there.</Hint>
      </Section>

      <Button size='sm' variant='ghost' onClick={() => setWindow({ ...d })}>
        Reset publish options
      </Button>
    </OptionsPageBody>
  )
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))
