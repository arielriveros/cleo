import { useEffect, useState } from 'react'
import { WeatherNode, WEATHER_PRESETS, type PrecipitationSprite, type WeatherPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import { Button, Hint, NumberInput, PresetMenu, PropertyTable, PropertyRow, Select, TexturePicker } from '@cleo/app-kit/ui'
import { WeatherIcon } from '../../sceneInspector/nodeIcons'
import MaterialPicker, { liveMaterial } from '../../terrainMaterials/MaterialPicker'
import { tilesetGridIsTight, weatherSpriteFromTileset } from '../../../utils/tilesets'
import { DeclaredSection, useNodeTick } from '../../properties/DeclaredSections'

// The Weather inspector: the volume's declared properties (src/properties/weather.ts), and the parts that are the
// editor's libraries': the falling sprite sheet (a tileset's, or a texture's) and the snow material.

/** The Weather inspector: a box of rain or snow, sized with the viewport's face handles, with its snow material. */
export default function WeatherEditor(props: { node: WeatherNode }) {
  const eventEmitter = useEventBus()
  const { instance, tilesets } = useCleoEngine()
  const renderer = instance?.renderer
  useNodeTick(props.node)
  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  const set = (patch: Partial<Pick<WeatherNode, 'size' | 'precipitationSprite'>>) => {
    Object.assign(props.node, patch)
    changed()
  }
  const n = props.node
  const sprite = n.precipitationSprite ? { ...n.precipitationSprite } as PrecipitationSprite : null
  const setSprite = (patch: Partial<PrecipitationSprite>) => {
    const s = props.node.precipitationSprite
    if (s) set({ precipitationSprite: { ...s, ...patch } })
  }
  // 'texture' with no sheet yet: chosen in the select, waiting for a texture to be picked.
  const [pendingTexture, setPendingTexture] = useState(false)
  const spriteMode = !sprite ? (pendingTexture ? 'texture' : 'builtin') : sprite.tilesetId ? 'tileset' : 'texture'
  const spriteTileset = sprite?.tilesetId ? tilesets.find(t => t.id === sprite!.tilesetId) ?? null : null
  const pickSpriteMode = (mode: string) => {
    setPendingTexture(false)
    if (mode === 'builtin') set({ precipitationSprite: null })
    else if (mode === 'tileset') {
      const first = tilesets[0]
      if (first) set({ precipitationSprite: weatherSpriteFromTileset(first) })
    } else if (mode === 'texture') {
      const s = props.node.precipitationSprite
      // Keep the sheet a tileset gave, unlinked; from the built-in, wait for a texture to be picked.
      if (s) set({ precipitationSprite: { ...s, tilesetId: null } })
      else setPendingTexture(true)
    }
  }
  const applyPreset = (p: WeatherPreset) => { props.node.applyPreset(p); changed() }

  // Whether the renderer drew it last frame: polled, since the camera moves on its own.
  const [status, setStatus] = useState<string | null>(null)
  useEffect(() => {
    if (!renderer) return
    const poll = () => {
      const n = props.node
      if (!n.enabled) { setStatus('Not drawn: disabled.'); return }
      if (!(n.wetness > 0) && !(n.snow > 0) && !n.precipitating) { setStatus('Dry: raise Wetness or Snow, or make rain or snow fall (or pick a preset).'); return }
      const drawn = renderer.weatherFrameVolumes.includes(n)
      setStatus(drawn ? null : 'Not drawn this frame: too far from the camera, or over the volume cap (4 at once; priority decides).')
    }
    poll()
    const id = window.setInterval(poll, 500)
    return () => window.clearInterval(id)
  }, [renderer, props.node])

  const makeBounded = () => { set({ size: [40, 20, 40] }) }

  return (
    <Collapsable title='Weather' icon={<WeatherIcon />} persistKey='weather'
      right={<PresetMenu presets={WEATHER_PRESETS} onApply={applyPreset} title='Weather presets — how wet, the puddles, how much snow, what falls how hard' />}>
      <div className='w-full p-2 flex flex-col gap-2'>
        {status && <Hint>{status}</Hint>}
        <DeclaredSection node={n} title=''>
          {!n.bounded && <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Size'>
              <Button size='sm' onClick={makeBounded} title='Give it a 40 x 20 x 40 m box, sized with the viewport handles'>Make bounded</Button>
            </PropertyRow>
          </PropertyTable>}
        </DeclaredSection>
        <DeclaredSection node={n} title='Falling'>
          {n.precipitation !== 'none' && <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Sprite'>
              <Select value={spriteMode} onChange={e => pickSpriteMode(e.target.value)}>
                <option value='builtin'>Built-in</option>
                <option value='tileset' disabled={tilesets.length === 0}>Tileset{tilesets.length === 0 ? ' (none in the library)' : ''}</option>
                <option value='texture'>Texture</option>
              </Select>
            </PropertyRow>
            {spriteMode === 'tileset' && <PropertyRow label='Tileset'>
              <Select value={sprite?.tilesetId ?? ''} onChange={e => {
                const asset = tilesets.find(t => t.id === e.target.value)
                if (asset) set({ precipitationSprite: weatherSpriteFromTileset(asset, props.node.precipitationSprite) })
              }}>
                {!spriteTileset && <option value={sprite?.tilesetId ?? ''}>(missing tileset)</option>}
                {tilesets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </PropertyRow>}
            {spriteMode === 'texture' && <>
              <PropertyRow label='Texture'>
                <TexturePicker value={sprite?.textureId || null} emptyLabel='(pick a texture)' onChange={id => {
                  setPendingTexture(!id)
                  const s = props.node.precipitationSprite
                  set({ precipitationSprite: id ? { ...(s ?? { columns: 1, rows: 1, frames: 1, fps: 0 }), textureId: id, tilesetId: null } : null })
                }} />
              </PropertyRow>
              {sprite && <>
                <PropertyRow label='Columns'>
                  <NumberInput value={sprite.columns} min={1} max={64} step={1} onChange={columns => setSprite({ columns, frames: Math.round(columns) * sprite.rows })} />
                </PropertyRow>
                <PropertyRow label='Rows'>
                  <NumberInput value={sprite.rows} min={1} max={64} step={1} onChange={rows => setSprite({ rows, frames: sprite.columns * Math.round(rows) })} />
                </PropertyRow>
                <PropertyRow label='Frames'>
                  <NumberInput value={sprite.frames} min={1} max={sprite.columns * sprite.rows} step={1} onChange={frames => setSprite({ frames })} />
                </PropertyRow>
              </>}
            </>}
            {sprite && <PropertyRow label='Frame Rate' divider>
              <NumberInput value={sprite.fps} min={0} max={120} step={1} onChange={fps => setSprite({ fps })} />
            </PropertyRow>}
          </PropertyTable>}
        </DeclaredSection>
        <DeclaredSection node={n} title='Snow' keys={['snow']}>
          <PropertyTable columns={['45%', '55%']}>
            <PropertyRow label='Snow Material'>
              <div className='flex items-start gap-1'>
                <div className='flex-1 min-w-0'>
                  <MaterialPicker value={n.snowMaterialId} placeholder={n.snowMaterial ? '(unlinked material)' : '(flat snow)'}
                    newName={() => 'Snow'} title='The material snow is drawn with — drop one here too'
                    onPick={a => { props.node.snowMaterial = liveMaterial(a); props.node.snowMaterialId = a.id; changed() }} />
                </div>
                {!!n.snowMaterial && <Button variant='remove' size='sm' title='Flat white snow instead'
                  onClick={() => { props.node.snowMaterial = null; props.node.snowMaterialId = null; changed() }}>✕</Button>}
              </div>
            </PropertyRow>
          </PropertyTable>
        </DeclaredSection>
        <DeclaredSection node={n} title='Snow' skip={['snow']} bare />
        {n.shelter && renderer && !renderer.weatherShelterEnabled &&
          <Hint>Shelter is switched off in the Renderer settings (Weather) or by the quality tier: the weather reaches everything in the box{n.precipitation !== 'none' ? ', and rain and snow fall indoors' : ''}.</Hint>}
        {n.precipitation !== 'none' && spriteTileset && !tilesetGridIsTight(spriteTileset) &&
          <Hint>The sprite's tileset has a margin, spacing or a grid short of its image: the particles assume a tight grid over the whole image, so its cells draw slightly off.</Hint>}
        {n.precipitation !== 'none' && n.precipitationRate > 0 && props.node.scene?.particlePreview === false &&
          <Hint>Particle preview is off in the viewport: the {n.precipitation} is not drawn while you edit (the ground's raindrops still show).</Hint>}
        {n.precipitation !== 'none' && n.precipitationRate > 0 && renderer && !(renderer.precipitationDensity > 0) &&
          <Hint>Rain &amp; Snow is at 0 in the Renderer settings (Weather): nothing falls.</Hint>}
      </div>
    </Collapsable>
  )
}
