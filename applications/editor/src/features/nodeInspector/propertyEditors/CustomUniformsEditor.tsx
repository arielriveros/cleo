import { useEffect, useReducer, useState } from 'react'
import { CustomMaterial, TextureManager } from 'cleo'
import type { CustomUniform, CustomUniformType } from 'cleo'
import { useEventBus } from '../../EventBusContext'
import { vec3ToHex } from '../../../utils/UtilFunctions'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { NumberInput, TextInput, Toggle, VectorInput, ColorInput, TypeSelect, Button, Hint, cn, labelClass } from '@cleo/app-kit/ui'
import TextureSlotPicker from '../../texture/TextureSlotPicker'
import { UniformsIcon } from '../sectionIcons'

const TYPES: CustomUniformType[] = ['float', 'vec2', 'vec3', 'vec4', 'int', 'bool', 'sampler2D', 'samplerCube']
const isSampler = (t: CustomUniformType) => t === 'sampler2D' || t === 'samplerCube'

function defaultValue(type: CustomUniformType): any {
  switch (type) {
    case 'float': case 'int': return 0
    case 'vec2': return [0, 0]
    case 'vec3': return [0, 0, 0]
    case 'vec4': return [0, 0, 0, 1]
    case 'bool': return false
    default: return null // samplers store their texture id in material.textures, not here
  }
}

/**
 * Under a cubemap uniform's tile: it takes a 2:1 equirectangular panorama, which the engine wraps onto a
 * cube (render/panoramaCubes.ts). A bound image of another shape still wraps, stretched, so it says so.
 */
function PanoramaCaption({ id }: { id: string | null }) {
  const texture = id ? TextureManager.Instance.getTexture(id) : undefined
  const w = texture?.width ?? 0, h = texture?.height ?? 0
  const aspect = h > 0 ? w / h : 2
  const off = w > 0 && (aspect < 1.9 || aspect > 2.1)
  return (
    <span className={cn('max-w-[120px] text-ui-2xs', off ? 'text-warning' : 'text-dim')}
      title='A cubemap uniform takes a 2 : 1 equirectangular panorama, wrapped onto a cube when it is bound'>
      {off ? `${w} × ${h}, not 2 : 1` : '2 : 1 panorama'}
    </span>
  )
}

/**
 * Editor for a custom material's user uniforms (name / GLSL type / default). Scalar/vector values are
 * written to `material.properties` (bare name); sampler values to `material.textures`, through the same
 * texture slot a material's maps use. Structural edits (add/remove/retype) change the assembled shader →
 * `onChange(true)` recompiles; value edits `onChange(false)`.
 */
export default function CustomUniformsEditor(props: { material: CustomMaterial, onChange: (structural: boolean) => void }) {
  const eventEmitter = useEventBus()
  const mat = props.material
  const [list, setList] = useState<CustomUniform[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<CustomUniformType>('float')
  // A bound texture's size lands after it decodes: the panorama caption re-reads it then.
  const [, bump] = useReducer((n: number) => n + 1, 0)

  const sync = () => setList(mat.uniforms.map(u => ({ ...u })))
  useEffect(() => { sync() }, [props.material])

  useEffect(() => {
    eventEmitter.on('TEXTURES_CHANGED', bump)
    return () => { eventEmitter.off('TEXTURES_CHANGED', bump) }
  }, [eventEmitter])

  const validName = (n: string) => /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(n)

  const addUniform = () => {
    const name = newName.trim()
    if (!validName(name)) return
    if (mat.uniforms.some(u => u.name === name)) return
    const type = newType
    mat.uniforms.push({ name, type, value: defaultValue(type) })
    if (!isSampler(type)) mat.properties.set(name, defaultValue(type))
    setNewName('')
    sync()
    props.onChange(true)
  }

  const removeUniform = (name: string) => {
    mat.uniforms = mat.uniforms.filter(u => u.name !== name)
    mat.properties.delete(name)
    mat.textures.delete(name)
    sync()
    props.onChange(true)
  }

  const changeType = (name: string, type: CustomUniformType) => {
    const u = mat.uniforms.find(u => u.name === name)
    if (!u) return
    u.type = type
    u.value = defaultValue(type)
    mat.properties.delete(name)
    mat.textures.delete(name)
    if (!isSampler(type)) mat.properties.set(name, u.value)
    sync()
    props.onChange(true)
  }

  const setValue = (name: string, value: any) => {
    const u = mat.uniforms.find(u => u.name === name)
    if (!u) return
    u.value = value
    mat.properties.set(name, value)
    sync()
    props.onChange(false)
  }

  const setTexture = (name: string, texId: string | null) => {
    if (!texId) mat.textures.delete(name)
    else mat.textures.set(name, texId)
    sync()
    props.onChange(false)
  }

  const renderValue = (u: CustomUniform) => {
    const val = mat.properties.has(u.name) ? mat.properties.get(u.name) : u.value
    if (u.type === 'float' || u.type === 'int')
      return <NumberInput value={val ?? 0} step={u.type === 'int' ? 1 : 0.1}
        onChange={n => setValue(u.name, u.type === 'int' ? Math.round(n) : n)} />
    if (u.type === 'bool')
      return <Toggle checked={!!val} onChange={b => setValue(u.name, b)} />
    if (isSampler(u.type)) {
      // The tile a material's maps use: Select, Upload, drop from Assets, ✕ to clear.
      const id = mat.textures.get(u.name) ?? null
      const cube = u.type === 'samplerCube'
      return (
        <div className='flex flex-col items-start gap-1'>
          <TextureSlotPicker value={id} fit={cube ? 'contain' : 'cover'} onChange={next => setTexture(u.name, next)} />
          {cube && <PanoramaCaption id={id} />}
        </div>
      )
    }
    // vecN — component fields, plus a color swatch for vec3 (values treated as 0..1 RGB).
    const n = u.type === 'vec2' ? 2 : u.type === 'vec3' ? 3 : 4
    const arr = Array.isArray(val) ? val : defaultValue(u.type)
    return (
      <div className='flex items-center gap-1 flex-1 min-w-0'>
        {u.type === 'vec3' && (
          <ColorInput className='h-7 w-8 shrink-0' color={vec3ToHex(arr as any)}
            onChange={c => setValue(u.name, [c[0], c[1], c[2]])} />
        )}
        <VectorInput className='flex-1' value={arr.slice(0, n)} labels={['X', 'Y', 'Z', 'W'].slice(0, n)}
          onChange={next => setValue(u.name, next)} />
      </div>
    )
  }

  return (
    <Collapsable title='Uniforms' icon={<UniformsIcon />} badge={list.length || undefined} persistKey='uniforms'>
      <div className='w-full p-2'>
        {list.length === 0 && <Hint className='mb-2'>No uniforms yet.</Hint>}
        {list.map(u => (
          <div key={u.name} className={cn('flex gap-1.5 mb-2', isSampler(u.type) ? 'items-start' : 'items-center')}>
            <span className={cn(labelClass, 'w-[26%] truncate')} title={u.name}>{u.name}</span>
            <TypeSelect value={u.type} options={TYPES} onChange={t => changeType(u.name, t)} />
            <div className='flex-1 min-w-0'>{renderValue(u)}</div>
            <Button variant='remove' size='icon' title='Remove' onClick={() => removeUniform(u.name)}>✕</Button>
          </div>
        ))}
        <div className='flex items-center gap-1.5 mt-3 border-t border-border pt-2'>
          <TextInput className='flex-1' placeholder='new uniform name' value={newName}
            onChange={setNewName}
            onKeyDown={e => { if (e.key === 'Enter') addUniform() }} />
          <TypeSelect value={newType} options={TYPES} onChange={setNewType} />
          <Button variant='primary' onClick={addUniform}>Add</Button>
        </div>
      </div>
    </Collapsable>
  )
}
