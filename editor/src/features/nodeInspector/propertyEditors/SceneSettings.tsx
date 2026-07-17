import { useEffect, useState } from 'react'
import { SkyboxNode } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { PropertyTable, PropertyRow, TextInput, Button, ColorInput, SegmentedControl } from '../../../components/ui'
import { InfoIcon } from '../sectionIcons'

// The inspector for the scene ASSET, shown when the scene tab's root node is selected. The root node
// itself has nothing worth editing (its name is the reserved literal 'root'), so this is what that
// selection means: the settings of the scene the tab is showing.
//
// Everything here lives on SceneMeta (name, main, dimension) or on the live Scene/Renderer (clear color,
// environment map) — never on the root Node.

const rgbToHex = (c: readonly number[] | null | undefined): string => {
  if (!c) return '#000000'
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
  return `#${h(c[0])}${h(c[1])}${h(c[2])}`
}

export default function SceneSettings() {
  const {
    instance, editorScene, eventEmitter, sceneList, openSceneId, mainSceneId,
    renameScene, setMainScene, sceneDimension, setSceneDimension,
  } = useCleoEngine()

  const meta = sceneList.find(s => s.id === openSceneId)
  const [name, setName] = useState(meta?.name ?? '')
  useEffect(() => { setName(meta?.name ?? '') }, [meta?.name])

  if (!meta) return null
  const isMain = mainSceneId === meta.id

  const commitName = () => {
    const next = name.trim()
    if (!next || next === meta.name) { setName(meta.name); return }
    renameScene(meta.id, next)
  }

  // The clear color is the renderer's: applyGameData restores config.render (which carries it) on every
  // scene open, so it is already per-scene state — this is just where you author it, alongside the rest of
  // the scene's settings rather than only in the renderer overlay.
  const clearColor = instance?.renderer.clearColor
  const setClearColor = (rgb: [number, number, number]) => {
    if (!instance) return
    instance.renderer.clearColor = [...rgb, 1]
    eventEmitter.emit('SCENE_CHANGED') // it is saved with the scene, so it counts as an unsaved edit
  }

  // The environment map drives reflections on PBR/Blinn materials. The realistic source is the scene's own
  // skybox — "light this scene with its sky" — so that is what we offer rather than a sixth-face uploader
  // duplicating one. Note it serializes as six base64 images inside the scene blob (Scene.serialize ->
  // serializeCubeMap), so a scene with one is meaningfully bigger.
  const skybox = Array.from(editorScene.nodes).find(n => n.nodeType === 'skybox') as SkyboxNode | undefined
  const hasEnv = !!editorScene.environmentMap
  const setEnvFromSkybox = () => {
    if (!skybox?.skybox?.texture) return
    editorScene.environmentMap = skybox.skybox.texture
    eventEmitter.emit('SCENE_CHANGED')
  }
  const clearEnv = () => {
    editorScene.environmentMap = null
    eventEmitter.emit('SCENE_CHANGED')
  }

  return (
    <>
      <Collapsable title='Scene' icon={<InfoIcon />} persistKey='sceneSettings'>
        <div className='w-full p-2'>
          <PropertyTable columns={['32%', '68%']}>
            <PropertyRow label='Name'>
              <TextInput value={name} onChange={setName} onBlur={commitName}
                onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur() }} />
            </PropertyRow>
            <PropertyRow label='ID'><span className='text-muted'>{meta.id}</span></PropertyRow>
            <PropertyRow label='Saved'>
              <span className='text-muted'>{meta.updatedAt ? new Date(meta.updatedAt).toLocaleString() : 'Never'}</span>
            </PropertyRow>
            <PropertyRow label='Type' divider={false}>
              {/* The camera rig: 2D is an orthographic pan/zoom, 3D is free-fly. Per scene, so a 2D level
                  and a 3D level in one project each open the way they were authored. */}
              <SegmentedControl<'2D' | '3D'>
                size='sm'
                value={sceneDimension}
                onChange={(v) => setSceneDimension(meta.id, v)}
                options={[
                  { value: '3D', label: '3D', title: 'Free-fly camera' },
                  { value: '2D', label: '2D', title: 'Orthographic pan/zoom' },
                ]}
              />
            </PropertyRow>
          </PropertyTable>

          <div className='mt-2'>
            {isMain
              ? <div className='text-xs text-muted px-1'>This is the main scene — the one a published game starts in.</div>
              : <Button variant='subtle' size='sm' className='w-full'
                  title='Make this the scene a published game starts in'
                  onClick={() => setMainScene(meta.id)}>
                  Set as main scene
                </Button>}
          </div>
        </div>
      </Collapsable>

      <Collapsable title='Environment' persistKey='sceneEnvironment'>
        <div className='w-full p-2'>
          <PropertyTable columns={['32%', '68%']}>
            <PropertyRow label='Clear color'>
              <ColorInput color={rgbToHex(clearColor)} onChange={setClearColor} />
            </PropertyRow>
            <PropertyRow label='Reflections' divider={false}>
              <span className='text-muted'>{hasEnv ? 'From a cubemap' : 'None'}</span>
            </PropertyRow>
          </PropertyTable>
          <div className='mt-2 flex gap-1'>
            <Button variant='subtle' size='sm' className='flex-1' disabled={!skybox}
              title={skybox ? "Light this scene's materials with its skybox" : 'Add a Skybox node to the scene first'}
              onClick={setEnvFromSkybox}>
              Use skybox
            </Button>
            <Button variant='subtle' size='sm' className='flex-1' disabled={!hasEnv} onClick={clearEnv}>
              Clear
            </Button>
          </div>
        </div>
      </Collapsable>
    </>
  )
}
