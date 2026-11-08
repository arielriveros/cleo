import { useEffect, useState } from 'react'
import { MIN_WEATHER_VOLUME_SIZE, WeatherNode, WEATHER_PRESETS, type PrecipitationKind, type PrecipitationSprite, type WeatherPreset } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { useCleoEngine } from '../../EngineContext'
import { Button, Hint, NumberInput, PresetMenu, PropertyTable, PropertyRow, Select, Slider, TexturePicker, Toggle, VectorInput } from '@cleo/app-kit/ui'
import { WeatherIcon } from '../../sceneInspector/nodeIcons'
import { BOX_VOLUME_EDITED } from '../../gizmo/BoxVolumeGizmo'
import MaterialPicker, { liveMaterial } from '../../terrainMaterials/MaterialPicker'
import { tilesetGridIsTight, weatherSpriteFromTileset } from '../../../utils/tilesets'

type Vec3 = [number, number, number]

const WETNESS_HINT = 'How wet the ground and the plants inside the box are: 0 dry, 1 soaked. The landscape darkens and turns glossy; foliage materials darken, gloss and bow by their Weather settings.'
const PUDDLES_HINT = 'How much of the wet ground\'s low, flat spots holds standing water: 0 none, 1 every hollow. Water pools in the landscape\'s height maps, and in a noise a few metres across where it has none.'
const SNOW_HINT = 'How much snow lies inside the box: 0 none, 1 thick. It settles on flat ground (low ground first) and on what faces up on foliage materials, and weighs plants down.'
const SHELTER_HINT = 'Covered ground and plants stay dry and free of snow, and no rain or snow falls on them: under a roof, an overhang, a cart, anything solid that casts a shadow from straight above. Off: the weather reaches everything in the box.'
const FALLING_HINT = 'What falls inside the box, drawn as particles round the camera: rain (fast streaks slanting with the wind) or snow (slow fluttering flakes). It falls in from the sky above the box and stops at roofs (Shelter). Falling rain stirs the wet ground: rings ripple in its puddles and drops hit the ground round them.'
const RATE_HINT = 'How hard it falls: 0 nothing, 1 a downpour (or a blizzard). Overlapping volumes never double it: the highest rate in reach is spawned, and each place keeps its own share.'
const SPRITE_HINT = "What each drop or flake looks like. Built-in: the engine's own streaks and flakes. Tileset or Texture: a sprite sheet whose cells each particle picks one of at random (or plays at Frame Rate). A rain cell's TOP is the end that leads as it falls."

/** The Weather inspector: a box of rain or snow, sized with the viewport's face handles, with its snow material. */
export default function WeatherEditor(props: { node: WeatherNode }) {
  const eventEmitter = useEventBus()
  const { instance, tilesets } = useCleoEngine()
  const renderer = instance?.renderer
  const read = () => {
    const n = props.node
    return {
      size: [...n.size] as Vec3, bounded: n.bounded, blendDistance: n.blendDistance, priority: n.priority, enabled: n.enabled,
      wetness: n.wetness, snow: n.snow, puddles: n.puddles, snowMaterialId: n.snowMaterialId, hasSnowMaterial: !!n.snowMaterial,
      snowTiling: n.snowTiling, snowSlope: n.snowSlope, snowBreakup: n.snowBreakup, shelter: n.shelter,
      precipitation: n.precipitation, precipitationRate: n.precipitationRate, precipitationSize: n.precipitationSize,
      precipitationSpeed: n.precipitationSpeed, precipitationWind: n.precipitationWind,
      trailMin: n.precipitationTrailMin, trailMax: n.precipitationTrailMax,
      sprite: n.precipitationSprite ? { ...n.precipitationSprite } as PrecipitationSprite : null as PrecipitationSprite | null,
    }
  }
  const [f, setF] = useState(read)
  useEffect(() => setF(read()), [props.node])

  // The viewport's face handles resize the box (and move the node) behind this panel's back.
  useEffect(() => {
    const onEdited = (e: { nodeId: string }) => { if (e?.nodeId === props.node.id) setF(read()) }
    eventEmitter.on(BOX_VOLUME_EDITED, onEdited)
    return () => { eventEmitter.off(BOX_VOLUME_EDITED, onEdited) }
  }, [eventEmitter, props.node])

  const changed = () => {
    setF(read())
    eventEmitter.emit('SCENE_CHANGED', { kind: 'environment', node: props.node })
  }
  const set = (patch: Partial<Pick<WeatherNode, 'size' | 'blendDistance' | 'priority' | 'enabled' | 'wetness' | 'snow'
    | 'puddles' | 'snowTiling' | 'snowSlope' | 'snowBreakup' | 'shelter' | 'precipitation' | 'precipitationRate'
    | 'precipitationSize' | 'precipitationSpeed' | 'precipitationWind' | 'precipitationSprite'
    | 'precipitationTrailMin' | 'precipitationTrailMax'>>) => {
    Object.assign(props.node, patch)
    changed()
  }
  // Picking a kind on a volume with nothing falling gives it a steady rate, so the pick shows at once.
  const setKind = (precipitation: PrecipitationKind) =>
    set(precipitation !== 'none' && !(props.node.precipitationRate > 0) ? { precipitation, precipitationRate: 0.6 } : { precipitation })
  const setSprite = (patch: Partial<PrecipitationSprite>) => {
    const s = props.node.precipitationSprite
    if (s) set({ precipitationSprite: { ...s, ...patch } })
  }
  // 'texture' with no sheet yet: chosen in the select, waiting for a texture to be picked.
  const [pendingTexture, setPendingTexture] = useState(false)
  const spriteMode = !f.sprite ? (pendingTexture ? 'texture' : 'builtin') : f.sprite.tilesetId ? 'tileset' : 'texture'
  const spriteTileset = f.sprite?.tilesetId ? tilesets.find(t => t.id === f.sprite!.tilesetId) ?? null : null
  // The precipitation block's last row, which closes it with the divider.
  const lastSpriteRow = f.sprite ? 'fps' : spriteMode === 'texture' ? 'texture' : 'sprite'
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
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Enabled' divider>
            <Toggle checked={f.enabled} onChange={enabled => set({ enabled })} />
          </PropertyRow>
          {f.bounded ? <>
            <PropertyRow label='Size' hint='The box, in local units, centred on the node. Drag its faces in the viewport. The weather falls only inside it.'>
              <VectorInput value={f.size} min={MIN_WEATHER_VOLUME_SIZE} step={0.5} onChange={size => set({ size: size as Vec3 })} />
            </PropertyRow>
            <PropertyRow label='Blend Distance' hint='Metres over which the weather fades in at the faces.'>
              <NumberInput value={f.blendDistance} min={0} step={0.5} onChange={blendDistance => set({ blendDistance })} />
            </PropertyRow>
          </> : <PropertyRow label='Size' hint='Unbounded: this weather covers the whole scene, as every weather node saved before volumes does.'>
            <Button size='sm' onClick={makeBounded} title='Give it a 40 x 20 x 40 m box, sized with the viewport handles'>Make bounded</Button>
          </PropertyRow>}
          <PropertyRow label='Priority' divider hint='Where volumes overlap, the higher draws over the lower (a dry box inside a snowy one carves out a dry pocket); it also decides which draw when more than 4 are near.'>
            <NumberInput value={f.priority} step={1} onChange={priority => set({ priority })} />
          </PropertyRow>
          <PropertyRow label='Wetness' hint={WETNESS_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.wetness} readout onChange={wetness => set({ wetness })} />
          </PropertyRow>
          <PropertyRow label='Puddles' divider hint={PUDDLES_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.puddles} readout onChange={puddles => set({ puddles })} />
          </PropertyRow>
          <PropertyRow label='Falling' divider={f.precipitation === 'none'} hint={FALLING_HINT}>
            <Select value={f.precipitation} onChange={e => setKind(e.target.value as PrecipitationKind)}>
              <option value='none'>Nothing</option>
              <option value='rain'>Rain</option>
              <option value='snow'>Snow</option>
            </Select>
          </PropertyRow>
          {f.precipitation !== 'none' && <>
            <PropertyRow label='Rate' hint={RATE_HINT}>
              <Slider min={0} max={1} step={0.01} value={f.precipitationRate} readout onChange={precipitationRate => set({ precipitationRate })} />
            </PropertyRow>
            <PropertyRow label={f.precipitation === 'rain' ? 'Drop Size' : 'Flake Size'} hint="Times the realistic default: a few millimetres across a drop's streak, a centimetre or two a flake.">
              <Slider min={0.25} max={3} step={0.05} value={f.precipitationSize} readout onChange={precipitationSize => set({ precipitationSize })} />
            </PropertyRow>
            <PropertyRow label='Fall Speed' hint='Times the realistic terminal velocity: 8.5 m/s a raindrop, 1 m/s a snowflake.'>
              <Slider min={0.25} max={3} step={0.05} value={f.precipitationSpeed} readout onChange={precipitationSpeed => set({ precipitationSpeed })} />
            </PropertyRow>
            {f.precipitation === 'rain' && <>
              <PropertyRow label='Trail Min' hint="The shortest a drop's streak is, as a multiple of the realistic default (1). Each drop draws its length at random between Trail Min and Trail Max.">
                <Slider min={0.1} max={4} step={0.05} value={f.trailMin} readout onChange={precipitationTrailMin => set({ precipitationTrailMin })} />
              </PropertyRow>
              <PropertyRow label='Trail Max' hint="The longest a drop's streak is, as a multiple of the realistic default (1). Set equal to Trail Min for streaks all one length.">
                <Slider min={0.1} max={4} step={0.05} value={f.trailMax} readout onChange={precipitationTrailMax => set({ precipitationTrailMax })} />
              </PropertyRow>
            </>}
            <PropertyRow label='Wind' hint={"How much the scene's wind slants the rain and drifts the snow: 0 straight down, 1 with all of it."
              + (props.node.scene?.wind ? '' : ' The scene has no Wind node: it falls straight down.')}>
              <Slider min={0} max={1} step={0.01} value={f.precipitationWind} readout onChange={precipitationWind => set({ precipitationWind })} />
            </PropertyRow>
            <PropertyRow label='Sprite' divider={lastSpriteRow === 'sprite'} hint={SPRITE_HINT}>
              <Select value={spriteMode} onChange={e => pickSpriteMode(e.target.value)}>
                <option value='builtin'>Built-in</option>
                <option value='tileset' disabled={tilesets.length === 0}>Tileset{tilesets.length === 0 ? ' (none in the library)' : ''}</option>
                <option value='texture'>Texture</option>
              </Select>
            </PropertyRow>
            {spriteMode === 'tileset' && <PropertyRow label='Tileset' hint='Its atlas and grid are copied in, and follow later edits to the tileset.'>
              <Select value={f.sprite?.tilesetId ?? ''} onChange={e => {
                const asset = tilesets.find(t => t.id === e.target.value)
                if (asset) set({ precipitationSprite: weatherSpriteFromTileset(asset, props.node.precipitationSprite) })
              }}>
                {!spriteTileset && <option value={f.sprite?.tilesetId ?? ''}>(missing tileset)</option>}
                {tilesets.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </Select>
            </PropertyRow>}
            {spriteMode === 'texture' && <>
              <PropertyRow label='Texture' divider={lastSpriteRow === 'texture'} hint='A sprite sheet: Columns x Rows cells over the whole image, no margin or spacing, read from the top-left.'>
                <TexturePicker value={f.sprite?.textureId || null} emptyLabel='(pick a texture)' onChange={id => {
                  setPendingTexture(!id)
                  const s = props.node.precipitationSprite
                  set({ precipitationSprite: id ? { ...(s ?? { columns: 1, rows: 1, frames: 1, fps: 0 }), textureId: id, tilesetId: null } : null })
                }} />
              </PropertyRow>
              {f.sprite && <>
                <PropertyRow label='Columns'>
                  <NumberInput value={f.sprite.columns} min={1} max={64} step={1} onChange={columns => setSprite({ columns, frames: Math.round(columns) * f.sprite!.rows })} />
                </PropertyRow>
                <PropertyRow label='Rows'>
                  <NumberInput value={f.sprite.rows} min={1} max={64} step={1} onChange={rows => setSprite({ rows, frames: f.sprite!.columns * Math.round(rows) })} />
                </PropertyRow>
                <PropertyRow label='Frames' hint='How many cells are used, counted from the top-left.'>
                  <NumberInput value={f.sprite.frames} min={1} max={f.sprite.columns * f.sprite.rows} step={1} onChange={frames => setSprite({ frames })} />
                </PropertyRow>
              </>}
            </>}
            {f.sprite && <PropertyRow label='Frame Rate' divider hint='0: each particle shows one random cell for its whole fall. Above 0: they play through the cells at this rate, from a random one.'>
              <NumberInput value={f.sprite.fps} min={0} max={120} step={1} onChange={fps => setSprite({ fps })} />
            </PropertyRow>}
          </>}
          <PropertyRow label='Snow' hint={SNOW_HINT}>
            <Slider min={0} max={1} step={0.01} value={f.snow} readout onChange={snow => set({ snow })} />
          </PropertyRow>
          <PropertyRow label='Snow Material' hint='What the landscape draws its snow with: a PBR material (its colour, normal and roughness maps). Plants take its colour and roughness. None: flat white snow.'>
            <div className='flex items-start gap-1'>
              <div className='flex-1 min-w-0'>
                <MaterialPicker value={f.snowMaterialId} placeholder={f.hasSnowMaterial ? '(unlinked material)' : '(flat snow)'}
                  newName={() => 'Snow'} title='The material snow is drawn with — drop one here too'
                  onPick={a => { props.node.snowMaterial = liveMaterial(a); props.node.snowMaterialId = a.id; changed() }} />
              </div>
              {f.hasSnowMaterial && <Button variant='remove' size='sm' title='Flat white snow instead'
                onClick={() => { props.node.snowMaterial = null; props.node.snowMaterialId = null; changed() }}>✕</Button>}
            </div>
          </PropertyRow>
          <PropertyRow label='Snow Tiling' hint='Metres per repeat of the snow material on the landscape.'>
            <NumberInput value={f.snowTiling} min={0.05} step={0.5} onChange={snowTiling => set({ snowTiling })} />
          </PropertyRow>
          <PropertyRow label='Snow Slope' hint='Degrees: ground steeper than this sheds its snow.'>
            <Slider min={0} max={90} step={1} value={f.snowSlope} readout onChange={snowSlope => set({ snowSlope })} />
          </PropertyRow>
          <PropertyRow label='Snow Breakup' divider hint='How much a noise breaks the snow into patches at its edge: 0 a clean line, 1 ragged drifts.'>
            <Slider min={0} max={1} step={0.01} value={f.snowBreakup} readout onChange={snowBreakup => set({ snowBreakup })} />
          </PropertyRow>
          <PropertyRow label='Shelter' divider={false} hint={SHELTER_HINT}>
            <Toggle checked={f.shelter} onChange={shelter => set({ shelter })} />
          </PropertyRow>
        </PropertyTable>
        {f.shelter && renderer && !renderer.weatherShelterEnabled &&
          <Hint>Shelter is switched off in the Renderer settings (Weather) or by the quality tier: the weather reaches everything in the box{f.precipitation !== 'none' ? ', and rain and snow fall indoors' : ''}.</Hint>}
        {f.precipitation !== 'none' && spriteTileset && !tilesetGridIsTight(spriteTileset) &&
          <Hint>The sprite's tileset has a margin, spacing or a grid short of its image: the particles assume a tight grid over the whole image, so its cells draw slightly off.</Hint>}
        {f.precipitation !== 'none' && f.precipitationRate > 0 && props.node.scene?.particlePreview === false &&
          <Hint>Particle preview is off in the viewport: the {f.precipitation} is not drawn while you edit (the ground's raindrops still show).</Hint>}
        {f.precipitation !== 'none' && f.precipitationRate > 0 && renderer && !(renderer.precipitationDensity > 0) &&
          <Hint>Rain &amp; Snow is at 0 in the Renderer settings (Weather): nothing falls.</Hint>}
      </div>
    </Collapsable>
  )
}
