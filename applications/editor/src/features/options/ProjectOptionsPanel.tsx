import { useEffect, useState } from 'react'
import { useCleoEngine } from '../EngineContext'
import InputMapPanel from '../input/InputMapPanel'
import { Button, Field, NumberInput, Section, Select, TextInput, Toggle, cn } from '@cleo/app-kit/ui'
import { loadProjects, renameProject } from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useMarkOptionPageShown, useOptionsPage } from '@cleo/app-kit/ui/OptionsShell'
import { DEFAULT_PROJECT_SETTINGS, cleanSaveFolder, resolveSaveFolder, type ProjectNetSyncSettings, type ProjectSaveSettings, type PublishWindowSettings } from './projectSettings'
import { useAssetLibrary } from '../AssetLibraryContext'

// Options ▸ Project: what belongs to THIS game and travels with it — its name, the scene it starts in,
// how a published build presents itself, online play, and the input map. Carried in project bundles.

type Page = 'general' | 'netsync' | 'input'

/** The id the viewport watches to preview on-screen touch controls while the input map is open. */
export const INPUT_PAGE_ID = 'project.input'

export default function ProjectOptionsPanel() {
  const [page, setPage] = useOptionsPage<Page>('project', 'general')
  return (
    <OptionsShell
      page={page}
      onPage={setPage}
      pages={[
        { value: 'general', label: 'General', doc: 'editor/options#general' },
        { value: 'netsync', label: 'NetSync', doc: 'editor/options#netsync' },
        { value: 'input', label: 'Input', doc: 'editor/options#input' },
      ]}
    >
      {page === 'general' && <GeneralOptions />}
      {page === 'netsync' && <NetSyncOptions />}
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
  const setSaves = (patch: Partial<ProjectSaveSettings>) =>
    setProjectSettings(prev => ({ ...prev, saves: { ...prev.saves, ...patch } }))

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
      {/* The explanations live in docs/editor/options.md › Project: each Field label's card is its line there. */}
      <Section title='Project'>
        <Field label='Name' labelClassName={OPTION_LABEL}>
          <TextInput value={name} onChange={setName} onBlur={commitName} disabled={!projectId}
            onKeyDown={e => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
        </Field>
        <Field label='Main scene' labelClassName={OPTION_LABEL}>
          <Select className='flex-1' value={mainSceneId} onChange={e => setMainScene(e.target.value)}
            disabled={sceneList.length === 0}>
            {!sceneList.some(s => s.id === mainSceneId) && <option value=''>—</option>}
            {sceneList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
      </Section>

      <Section title='Published game'>
        <Field label='Title' labelClassName={OPTION_LABEL}>
          <TextInput value={w.title} placeholder={name || 'Project name'} maxLength={120}
            onChange={v => setWindow({ title: v })} />
        </Field>
        <Field label='Window size' labelClassName={OPTION_LABEL}>
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
        <Field label='Only used shaders' labelClassName={OPTION_LABEL}>
          <span className='flex flex-1'><Toggle checked={w.onlyUsedShaders} onChange={v => setWindow({ onlyUsedShaders: v })} /></span>
        </Field>
        <Field label='WebGL 2 fallback' labelClassName={OPTION_LABEL}>
          <span className='flex flex-1'><Toggle checked={w.webgl2Fallback} onChange={v => setWindow({ webgl2Fallback: v })} /></span>
        </Field>
      </Section>

      <Button size='sm' variant='ghost' onClick={() => setWindow({ ...d })}>
        Reset publish options
      </Button>

      <Section title='Saves'>
        <Field label='Save version' labelClassName={OPTION_LABEL}>
          <NumberInput value={projectSettings.saves.version} min={0} max={1_000_000} step={1}
            onChange={v => setSaves({ version: clampInt(v, 0, 1_000_000) })} />
        </Field>
        <Field label='Save folder' labelClassName={OPTION_LABEL}>
          <TextInput value={projectSettings.saves.folder} maxLength={64}
            placeholder={resolveSaveFolder({ ...projectSettings, saves: { ...projectSettings.saves, folder: '' } }, name)}
            onChange={v => setSaves({ folder: v })}
            onBlur={() => setSaves({ folder: cleanSaveFolder(projectSettings.saves.folder) })} />
        </Field>
      </Section>
    </OptionsPageBody>
  )
}

/** Options ▸ Project ▸ NetSync: online play (docs/design/netsync.md). The host reads these from the published game. */
function NetSyncOptions() {
  const { projectSettings, setProjectSettings } = useCleoEngine()
  const { templates } = useAssetLibrary()
  const n = projectSettings.netsync
  const set = (patch: Partial<ProjectNetSyncSettings>) =>
    setProjectSettings(prev => ({ ...prev, netsync: { ...prev.netsync, ...patch } }))
  const setSpawn = (i: number, v: number) => set({ spawn: n.spawn.map((x, j) => (j === i ? v : x)) as [number, number, number] })
  const off = !n.enabled
  return (
    <OptionsPageBody>
      {/* The explanations live in docs/editor/options.md › Project › NetSync. */}
      <Section title='Online play'>
        <Field label='Online play' labelClassName={OPTION_LABEL}>
          <span className='flex flex-1'><Toggle checked={n.enabled} onChange={v => set({ enabled: v })} /></span>
        </Field>
      </Section>
      <Section title='Host'>
        <div className={cn('flex flex-col gap-1', off && 'pointer-events-none opacity-60')}>
          <Field label='Tick rate' labelClassName={OPTION_LABEL}>
            <NumberInput value={n.tickRate} min={10} max={120} step={1} onChange={v => set({ tickRate: clampInt(v, 10, 120) })} />
          </Field>
          <Field label='Players per session' labelClassName={OPTION_LABEL}>
            <NumberInput value={n.maxPeers} min={1} max={64} step={1} onChange={v => set({ maxPeers: clampInt(v, 1, 64) })} />
          </Field>
          <Field label='Player template' labelClassName={OPTION_LABEL}>
            <Select className='flex-1' value={n.playerTemplate} onChange={e => set({ playerTemplate: e.target.value })}>
              <option value=''>None (the level's player characters only)</option>
              {n.playerTemplate && !templates.some(t => t.name === n.playerTemplate) && <option value={n.playerTemplate}>{n.playerTemplate} (missing)</option>}
              {templates.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label='Spawn point' labelClassName={OPTION_LABEL}>
            <div className='flex flex-1 items-center gap-1.5'>
              {n.spawn.map((v, i) => <NumberInput key={i} value={v} step={0.5} onChange={x => setSpawn(i, x)} />)}
            </div>
          </Field>
          <Field label='Trust' labelClassName={OPTION_LABEL}>
            <Select className='flex-1' value={n.trust} onChange={e => set({ trust: e.target.value === 'versus' ? 'versus' : 'coop' })}>
              <option value='coop'>Co-op (loose)</option>
              <option value='versus'>Versus (strict)</option>
            </Select>
          </Field>
        </div>
      </Section>
      <Section title='Published game'>
        <div className={cn('flex flex-col gap-1', off && 'pointer-events-none opacity-60')}>
          <Field label='Allocator' labelClassName={OPTION_LABEL}>
            <TextInput value={n.allocator} placeholder='https://play.example.com' maxLength={500} onChange={v => set({ allocator: v })} />
          </Field>
          <Field label='Game mode' labelClassName={OPTION_LABEL}>
            <TextInput value={n.mode} placeholder='coop' maxLength={64} onChange={v => set({ mode: v })} />
          </Field>
        </div>
      </Section>
    </OptionsPageBody>
  )
}

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)))
