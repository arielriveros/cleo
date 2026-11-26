import { useEffect, useState } from 'react'
import { PHYSICS_BACKENDS } from 'cleo'
import { useCleoEngine } from '../EngineContext'
import InputMapPanel from '../input/InputMapPanel'
import { Button, Field, Hint, NumberInput, Section, Select, TextInput, Toggle, cn } from '@cleo/app-kit/ui'
import { readBackendPreference } from '@cleo/app-kit/renderer/backendPreference'
import { loadProjects, renameProject } from '../../utils/projects'
import { activeProjectId } from '../../utils/projectScope'
import { OptionsPageBody, OptionsShell, OPTION_LABEL, useMarkOptionPageShown, useOptionsPage } from '@cleo/app-kit/ui/OptionsShell'
import {
  BUILT_IN_COLLISION_LAYERS, COLLISION_LAYER_NAME_MAX, DEFAULT_PROJECT_SETTINGS, cleanSaveFolder, resolveSaveFolder,
  type ProjectNetSyncSettings, type ProjectSaveSettings, type PublishWindowSettings, type PhysicsBackendSetting,
  type PublishGraphicsSetting, excludedScenesOf, publishGraphicsOf,
} from './projectSettings'
import { useAssetLibrary } from '../AssetLibraryContext'
import GameIdentityRows from './GameIdentityRows'

// Options ▸ Project: what belongs to THIS game and travels with it — its name, its saves, its published game (the
// scene it starts in and the scenes it carries, what it runs on, how it presents itself), online play, the input map
// and the collision layers' names. Carried in project bundles.

type Page = 'general' | 'publish' | 'netsync' | 'input' | 'layers'

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
        { value: 'publish', label: 'Published game', doc: 'editor/options#published-game' },
        { value: 'netsync', label: 'NetSync', doc: 'editor/options#netsync' },
        { value: 'input', label: 'Input', doc: 'editor/options#input' },
        { value: 'layers', label: 'Layers', doc: 'editor/options#layers' },
      ]}
    >
      {page === 'general' && <GeneralOptions />}
      {page === 'publish' && <PublishedGameOptions />}
      {page === 'netsync' && <NetSyncOptions />}
      {page === 'input' && <InputPage />}
      {page === 'layers' && <CollisionLayersPage />}
    </OptionsShell>
  )
}

function InputPage() {
  useMarkOptionPageShown(INPUT_PAGE_ID)
  return <div className='flex h-full flex-col overflow-hidden'><InputMapPanel /></div>
}

/**
 * The names of the project's 16 collision layers: one table for its 3D physics and its 2D physics alike, shown by
 * every layer picker (a Collider's or a 2D body's Layer, a camera rig's Blocked by, foot placement's Trace layers)
 * and what scripts find layers by. The engine's four are fixed.
 */
function CollisionLayersPage() {
  const { projectSettings, setProjectSettings } = useCleoEngine()
  const names = projectSettings.collisionLayers
  const rename = (i: number, name: string) =>
    setProjectSettings(prev => ({ ...prev, collisionLayers: prev.collisionLayers.map((n, k) => (k === i ? name : n)) }))
  return (
    <OptionsPageBody>
      <Section title='Collision layers'>
        {names.map((name, i) => {
          const builtIn = i < BUILT_IN_COLLISION_LAYERS.length
          return (
            <Field key={i} label={`${i + 1}`} labelClassName='w-[28px] text-right text-muted' doc={false}>
              <TextInput value={name} disabled={builtIn} maxLength={COLLISION_LAYER_NAME_MAX}
                className={builtIn ? 'opacity-60' : undefined} placeholder={`Layer ${i + 1}`}
                onChange={v => rename(i, v)} />
            </Field>
          )
        })}
      </Section>
    </OptionsPageBody>
  )
}

function GeneralOptions() {
  const { sceneList, mainSceneId, setMainScene, projectSettings, setProjectSettings } = useCleoEngine()
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

/** The project's name, as the project record has it (machine-local metadata, not project storage). */
function useProjectName(): string {
  const projectId = activeProjectId()
  const [name, setName] = useState('')
  useEffect(() => {
    void loadProjects().then(list => setName(list.find(p => p.id === projectId)?.name ?? ''))
    const renamed = (e: Event) => setName(String((e as CustomEvent).detail ?? ''))
    window.addEventListener('cleo:project-renamed', renamed)
    return () => window.removeEventListener('cleo:project-renamed', renamed)
  }, [projectId])
  return name
}

/**
 * Options ▸ Project ▸ Published game: everything a publish (web, desktop, desktop installer) makes the game from that
 * is not its content. The scene it starts in and the scenes it carries; the graphics API and the physics it runs on;
 * how its window and its installer present it.
 */
function PublishedGameOptions() {
  const { sceneList, mainSceneId, setMainScene, projectSettings, setProjectSettings, instance } = useCleoEngine()
  const name = useProjectName()
  const w = projectSettings.publish
  const setWindow = (patch: Partial<PublishWindowSettings>) =>
    setProjectSettings(prev => ({ ...prev, publish: { ...prev.publish, ...patch } }))
  const d = DEFAULT_PROJECT_SETTINGS.publish
  const excluded = new Set(excludedScenesOf(w))
  const startId = sceneList.some(s => s.id === mainSceneId) ? mainSceneId : sceneList[0]?.id
  const include = (id: string, on: boolean) => setProjectSettings(prev => {
    const rest = excludedScenesOf(prev.publish).filter(x => x !== id)
    return { ...prev, publish: { ...prev.publish, excludedScenes: on ? rest : [...rest, id] } }
  })
  const shipped = sceneList.filter(s => s.id === startId || !excluded.has(s.id)).length
  const leftOut = sceneList.length - shipped
  // The editor's own graphics API, which "same as the editor" publishes with.
  const editorBackend = readBackendPreference()
  const apiName = (b: 'webgpu' | 'webgl2') => (b === 'webgpu' ? 'WebGPU' : 'WebGL 2')
  const runsOn = publishGraphicsOf(w) === 'editor' ? editorBackend : publishGraphicsOf(w)
  const physicsBackend = projectSettings.engine.physicsBackend
  const setPhysics = (b: PhysicsBackendSetting) =>
    setProjectSettings(prev => ({ ...prev, engine: { ...prev.engine, physicsBackend: b } }))
  const physics = instance?.physics
  const physicsNote = physics && physics.backend !== physicsBackend
    ? `The editor runs on ${PHYSICS_BACKENDS.find(b => b.request === physics.backend)?.label ?? physics.backend} until the project is opened again; a publish uses this.`
    : null

  return (
    <OptionsPageBody>
      {/* The explanations live in docs/editor/options.md › Project › Published game: each Field label's card is its line there. */}
      <Section title='Start'>
        <Field label='Start scene' labelClassName={OPTION_LABEL}>
          <Select className='flex-1' value={mainSceneId} onChange={e => setMainScene(e.target.value)}
            disabled={sceneList.length === 0}>
            {!sceneList.some(s => s.id === mainSceneId) && <option value=''>—</option>}
            {sceneList.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <Field label='Scenes' labelClassName={OPTION_LABEL} as='div'>
          <span className='flex-1 text-ui-xs text-muted'>{shipped} of {sceneList.length} ship</span>
        </Field>
        <div className='flex flex-col gap-0.5 pl-2'>
          {sceneList.map(s => {
            const start = s.id === startId
            return (
              <div key={s.id} className={cn('flex items-center gap-2 text-ui-sm', start && 'opacity-70')}
                title={start ? 'The start scene always ships' : excluded.has(s.id) ? 'Left out of the published game' : 'Ships in the published game'}>
                <span className={cn('flex', start && 'pointer-events-none')}>
                  <Toggle checked={start || !excluded.has(s.id)} onChange={v => include(s.id, v)} />
                </span>
                <span className='truncate'>{s.name}</span>
                {start && <span className='text-ui-xs text-dim'>start</span>}
              </div>
            )
          })}
        </div>
        {leftOut > 0 && <Hint>A script that loads a scene left out (Game.loadScene) does not find it in the published game.</Hint>}
      </Section>

      <Section title='Rendering and physics'>
        <Field label='Graphics API' labelClassName={OPTION_LABEL}>
          <Select className='flex-1' value={publishGraphicsOf(w)}
            onChange={e => setWindow({ graphicsBackend: e.target.value as PublishGraphicsSetting })}>
            <option value='editor'>Same as the editor ({apiName(editorBackend)})</option>
            <option value='webgpu'>WebGPU</option>
            <option value='webgl2'>WebGL 2</option>
          </Select>
        </Field>
        <Field label='WebGL 2 fallback' labelClassName={OPTION_LABEL}>
          <span className={cn('flex flex-1', runsOn === 'webgl2' && 'pointer-events-none opacity-60')}>
            <Toggle checked={runsOn === 'webgl2' || w.webgl2Fallback} onChange={v => setWindow({ webgl2Fallback: v })} />
          </span>
        </Field>
        <Field label='Only used shaders' labelClassName={OPTION_LABEL}>
          <span className='flex flex-1'><Toggle checked={w.onlyUsedShaders} onChange={v => setWindow({ onlyUsedShaders: v })} /></span>
        </Field>
        <Field label='Physics backend' labelClassName={OPTION_LABEL}>
          <Select className='flex-1' value={physicsBackend} onChange={e => setPhysics(e.target.value as PhysicsBackendSetting)}>
            {PHYSICS_BACKENDS.map(b => (
              <option key={b.request} value={b.request} disabled={!b.implemented}>
                {b.implemented ? b.label : `${b.label} (not implemented yet)`}
              </option>
            ))}
          </Select>
        </Field>
        {physicsNote && <div className='text-ui-xs text-warning leading-snug'>{physicsNote}</div>}
      </Section>

      <Section title='Window and identity'>
        <Field label='Title' labelClassName={OPTION_LABEL}>
          <TextInput value={w.title} placeholder={name || 'Project name'} maxLength={120}
            onChange={v => setWindow({ title: v })} />
        </Field>
        <GameIdentityRows projectName={name} />
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
      </Section>

      <Button size='sm' variant='ghost' onClick={() => setWindow({ ...d })}>
        Reset publish options
      </Button>
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
