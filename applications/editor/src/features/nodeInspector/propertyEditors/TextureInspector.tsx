import { useReducer } from 'react'
import type { Material } from 'cleo'
import { useEventBus } from '../../EventBusContext'
import TextureSlotPicker from '../../texture/TextureSlotPicker'

// One texture slot of a Material (base colour, normal map, mask…): the editor's shared texture slot picker,
// reading and writing `material.textures[tex]` and the `has<Slot>` flag the shaders branch on.

export default function TextureInspector(props: { tex: string, material: Material }) {
  const eventEmitter = useEventBus()
  // The binding lives on the material, which React does not observe: a write re-renders through this.
  const [, bump] = useReducer((n: number) => n + 1, 0)
  const flag = `has${props.tex.charAt(0).toUpperCase() + props.tex.slice(1)}`
  const value = props.material.textures.get(props.tex) ?? null

  const onChange = (id: string | null) => {
    if (id) {
      props.material.textures.set(props.tex, id)
      props.material.properties.set(flag, true)
    } else {
      props.material.textures.delete(props.tex)
      props.material.properties.set(flag, false)
    }
    bump()
    eventEmitter.emit('TEXTURES_CHANGED')
    eventEmitter.emit('SCENE_CHANGED', { kind: 'texture' })
  }

  return <TextureSlotPicker value={value} onChange={onChange} />
}
