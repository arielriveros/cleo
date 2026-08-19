import { useEffect, useState } from 'react'
import { SpriteNode } from 'cleo'
import Collapsable from '../../../components/Collapsable'
import { useEventBus } from '../../EventBusContext'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import { PropertyTable, PropertyRow, Select, Slider, Toggle, ColorInput } from '../../../components/ui'
import { AppearanceIcon } from '../sectionIcons'

// Tint / opacity / blending for a sprite, inline.
//
// Sprites used to reach these through a linked Material asset, which meant three hops (node -> material
// slot -> material tab -> texture slot) to change a colour, and exposed a texture slot that no longer
// means anything now that the image comes from the tileset. There are only five knobs; they live here.

export default function SpriteAppearance(props: { node: SpriteNode }) {
  const eventEmitter = useEventBus()
  const sprite = props.node.sprite
  const [tint, setTint] = useState(vec3ToHex(sprite.tint))
  const [opacity, setOpacity] = useState(sprite.opacity)
  const [transparent, setTransparent] = useState(sprite.transparent)
  const [side, setSide] = useState(sprite.side)
  const [wireframe, setWireframe] = useState(sprite.wireframe)

  useEffect(() => {
    setTint(vec3ToHex(sprite.tint))
    setOpacity(sprite.opacity)
    setTransparent(sprite.transparent)
    setSide(sprite.side)
    setWireframe(sprite.wireframe)
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
      </div>
    </Collapsable>
  )
}
