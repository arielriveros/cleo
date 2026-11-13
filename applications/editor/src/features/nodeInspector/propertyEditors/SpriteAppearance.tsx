import { useEffect, useState } from 'react'
import { SpriteNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { PropertyTable, PropertyRow, Select, Slider, Toggle, ColorInput, Hint, NumberInput } from '@cleo/app-kit/ui'
import { AppearanceIcon } from '../sectionIcons'
import FollowLightRows from './FollowLightRows'

// Tint / opacity / blending for a sprite, inline. A sprite's image comes from its tileset, not a material.

const LIGHTING_HINT = {
  sixWay: 'Lit by the tileset\'s six-way lightmaps: the sun, its shadows and nearby lights relight it from their direction.',
  surface: 'Lit as a surface by the tileset\'s normal map (and ORM map): diffuse and highlights from the scene\'s lights.',
  flat: 'Lit flat: the tileset has no lighting maps (Tileset editor > Lighting maps), so it is shaded as a card facing the camera.',
} as const

export default function SpriteAppearance(props: { node: SpriteNode }) {
  const eventEmitter = useEventBus()
  const sprite = props.node.sprite
  const [tint, setTint] = useState(vec3ToHex(sprite.tint))
  const [opacity, setOpacity] = useState(sprite.opacity)
  const [transparent, setTransparent] = useState(sprite.transparent)
  const [side, setSide] = useState(sprite.side)
  const [wireframe, setWireframe] = useState(sprite.wireframe)
  const [blend, setBlend] = useState(sprite.blend)
  const [exposureWeight, setExposureWeight] = useState(sprite.exposureWeight)
  const [softness, setSoftness] = useState(sprite.softness)
  const [lit, setLit] = useState(sprite.lit)
  const [sortingOrder, setSortingOrder] = useState(sprite.sortingOrder)
  const [pivot, setPivot] = useState<[number, number]>([...sprite.pivot] as [number, number])
  const [flipX, setFlipX] = useState(sprite.flipX)
  const [flipY, setFlipY] = useState(sprite.flipY)

  useEffect(() => {
    setTint(vec3ToHex(sprite.tint))
    setOpacity(sprite.opacity)
    setTransparent(sprite.transparent)
    setSide(sprite.side)
    setWireframe(sprite.wireframe)
    setBlend(sprite.blend)
    setExposureWeight(sprite.exposureWeight)
    setSoftness(sprite.softness)
    setLit(sprite.lit)
    setSortingOrder(sprite.sortingOrder)
    setPivot([...sprite.pivot] as [number, number])
    setFlipX(sprite.flipX)
    setFlipY(sprite.flipY)
  }, [props.node])

  const setPivotTo = (p: [number, number]) => { sprite.pivot = p; setPivot([...sprite.pivot] as [number, number]); changed() }

  const changed = () => eventEmitter.emit('SCENE_CHANGED', { kind: 'component', node: props.node })

  return (
    <Collapsable title='Appearance' icon={<AppearanceIcon />} persistKey='spriteAppearance'>
      <div className='w-full p-2'>
        <PropertyTable columns={['45%', '55%']}>
          <PropertyRow label='Tint'>
            <ColorInput color={tint} onChange={(rgb) => {
              sprite.tint = rgb; setTint(vec3ToHex(rgb)); changed()
            }} />
          </PropertyRow>
          <PropertyRow label='Opacity'>
            <Slider min={0} max={1} step={0.01} value={opacity} onChange={(v) => {
              sprite.opacity = v; setOpacity(v); changed()
            }} />
          </PropertyRow>
          <PropertyRow label='Blending'>
            <Select value={blend} onChange={(e) => {
              const v = e.target.value as typeof blend
              sprite.blend = v; setBlend(v); changed()
            }}>
              <option value='alpha'>Alpha</option>
              <option value='additive'>Additive</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Sorting order' hint='Higher draws later (on top) whatever the distances. In 2D, offsets the sprite from the entity layer.'>
            <NumberInput step={1} value={sortingOrder} onChange={(v) => {
              sprite.sortingOrder = v; setSortingOrder(sprite.sortingOrder); changed()
            }} />
          </PropertyRow>
          <PropertyRow label='Pivot' hint='The point of the image at the node’s position: 0,0 its bottom-left, 1,1 its top-right. A character stands on its feet: about 0.5 across, at the bottom of its body.'>
            <span className='flex items-center gap-1'>
              <NumberInput className='w-14' step={0.05} value={pivot[0]} onChange={(v) => setPivotTo([v, pivot[1]])} />
              <NumberInput className='w-14' step={0.05} value={pivot[1]} onChange={(v) => setPivotTo([pivot[0], v])} />
              <button type='button' className='text-ui-sm text-muted hover:text-fg px-1' title='Centre: 0.5, 0.5'
                onClick={() => setPivotTo([0.5, 0.5])}>Centre</button>
              <button type='button' className='text-ui-sm text-muted hover:text-fg px-1' title='Bottom centre: 0.5, 0'
                onClick={() => setPivotTo([0.5, 0])}>Base</button>
            </span>
          </PropertyRow>
          <PropertyRow label='Flip X' hint='Mirror the image left to right, about the pivot: a character facing the other way.'>
            <Toggle checked={flipX} onChange={(c) => { sprite.flipX = c; setFlipX(c); changed() }} />
          </PropertyRow>
          <PropertyRow label='Flip Y' hint='Mirror the image top to bottom, about the pivot.'>
            <Toggle checked={flipY} onChange={(c) => { sprite.flipY = c; setFlipY(c); changed() }} />
          </PropertyRow>
          <PropertyRow label='Lit'>
            <Toggle checked={lit} onChange={(c) => { sprite.lit = c; setLit(c); changed() }} />
          </PropertyRow>
          <PropertyRow label='Exposure weight'>
            <Slider min={0} max={1} step={0.05} value={exposureWeight} onChange={(v) => {
              sprite.exposureWeight = v; setExposureWeight(v); changed()
            }} />
          </PropertyRow>
          <FollowLightRows node={props.node} target={sprite} onChange={changed} />
          <PropertyRow label='Soft fade'>
            <Slider min={0} max={1} step={0.01} value={softness} onChange={(v) => {
              sprite.softness = v; setSoftness(v); changed()
            }} />
          </PropertyRow>
          <PropertyRow label='Transparent'>
            <Toggle checked={transparent} onChange={(c) => { sprite.transparent = c; setTransparent(c); changed() }} />
          </PropertyRow>
          <PropertyRow label='Sides'>
            <Select value={side} onChange={(e) => {
              const v = e.target.value as typeof side
              sprite.side = v; setSide(v); changed()
            }}>
              <option value='double'>Double</option>
              <option value='front'>Front</option>
              <option value='back'>Back</option>
            </Select>
          </PropertyRow>
          <PropertyRow label='Wireframe' divider={false}>
            <Toggle checked={wireframe} onChange={(c) => { sprite.wireframe = c; setWireframe(c); changed() }} />
          </PropertyRow>
        </PropertyTable>
        {lit && (
          // How it is lit is the tileset's (Tileset editor > Lighting maps), so every sprite from it agrees.
          <Hint>{LIGHTING_HINT[props.node.tileset?.lighting ?? 'flat']}</Hint>
        )}
        {(props.node.tileset?.overdrive ?? 1) !== 1 && (
          // Read-only: overdrive belongs to the tileset (Tileset editor > Atlas), so every sprite from it agrees.
          <Hint>Overdrive ×{props.node.tileset!.overdrive} from the tileset: this sprite glows through bloom.</Hint>
        )}
      </div>
    </Collapsable>
  )
}
