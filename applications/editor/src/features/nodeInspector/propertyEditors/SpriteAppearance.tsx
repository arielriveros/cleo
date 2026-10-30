import { useEffect, useState } from 'react'
import { SpriteNode } from 'cleo'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { PropertyTable, PropertyRow, Select, Slider, Toggle, ColorInput, Hint } from '@cleo/app-kit/ui'
import { AppearanceIcon } from '../sectionIcons'

// Tint / opacity / blending for a sprite, inline. A sprite's image comes from its tileset, not a material.

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

  useEffect(() => {
    setTint(vec3ToHex(sprite.tint))
    setOpacity(sprite.opacity)
    setTransparent(sprite.transparent)
    setSide(sprite.side)
    setWireframe(sprite.wireframe)
    setBlend(sprite.blend)
    setExposureWeight(sprite.exposureWeight)
    setSoftness(sprite.softness)
  }, [props.node])

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
          <PropertyRow label='Exposure weight'>
            <Slider min={0} max={1} step={0.05} value={exposureWeight} onChange={(v) => {
              sprite.exposureWeight = v; setExposureWeight(v); changed()
            }} />
          </PropertyRow>
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
        {(props.node.tileset?.overdrive ?? 1) !== 1 && (
          // Read-only: overdrive belongs to the tileset (Tileset editor > Atlas), so every sprite from it agrees.
          <Hint>Overdrive ×{props.node.tileset!.overdrive} from the tileset: this sprite glows through bloom.</Hint>
        )}
      </div>
    </Collapsable>
  )
}
