import { useEffect, useState } from 'react'
import { CustomMaterial, TextureManager } from 'cleo'
import type { CustomUniform, CustomUniformType } from 'cleo'
import { useCleoEngine } from '../../EngineContext'
import { colorToVec3, vec3ToHex } from '../../../utils/UtilFunctions'
import Collapsable from '../../../components/Collapsable'

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

const inputCls = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-full'

/**
 * Editor for a custom material's user uniforms (name / GLSL type / default). Mirrors CustomVariablesEditor
 * but with the GLSL uniform types the engine can introspect. Scalar/vector values are written to
 * `material.properties` (bare name); sampler values to `material.textures` (bare name -> texture id).
 * Structural edits (add/remove/retype) change the assembled shader, so they call `onChange(true)` to make
 * the parent recompile; value-only edits call `onChange(false)`.
 */
export default function CustomUniformsEditor(props: { material: CustomMaterial, onChange: (structural: boolean) => void }) {
  const { eventEmitter } = useCleoEngine()
  const mat = props.material
  const [list, setList] = useState<CustomUniform[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<CustomUniformType>('float')
  const [texIds, setTexIds] = useState<string[]>([])

  const sync = () => setList(mat.uniforms.map(u => ({ ...u })))
  useEffect(() => { sync() }, [props.material])

  useEffect(() => {
    const refresh = () => setTexIds(Array.from(TextureManager.Instance.textures.keys())
      .filter(k => !(k.includes('__editor__') || k.includes('__debug__'))))
    refresh()
    eventEmitter.on('TEXTURES_CHANGED', refresh)
    return () => { eventEmitter.off('TEXTURES_CHANGED', refresh) }
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

  const setTexture = (name: string, texId: string) => {
    if (texId === 'None') mat.textures.delete(name)
    else mat.textures.set(name, texId)
    sync()
    props.onChange(false)
  }

  const renderValue = (u: CustomUniform) => {
    const val = mat.properties.has(u.name) ? mat.properties.get(u.name) : u.value
    if (u.type === 'float' || u.type === 'int')
      return <input className={inputCls} type='number' value={val ?? 0}
        onChange={e => setValue(u.name, u.type === 'int' ? Math.round(parseFloat(e.target.value) || 0) : (parseFloat(e.target.value) || 0))} />
    if (u.type === 'bool')
      return <input type='checkbox' checked={!!val}
        onChange={e => setValue(u.name, e.target.checked)} />
    if (isSampler(u.type)) {
      const cur = mat.textures.get(u.name) ?? 'None'
      return (
        <select className={inputCls} value={cur} onChange={e => setTexture(u.name, e.target.value)}>
          <option value='None'>None</option>
          {texIds.map(id => <option key={id} value={id}>{id}</option>)}
        </select>
      )
    }
    // vecN — per-component number inputs, plus a color swatch for vec3 (values are treated as 0..1 RGB).
    const n = u.type === 'vec2' ? 2 : u.type === 'vec3' ? 3 : 4
    const arr = Array.isArray(val) ? val : defaultValue(u.type)
    return (
      <div className='flex items-center gap-1'>
        {u.type === 'vec3' && (
          <input type='color' title='Pick as color (0..1 RGB)'
            className='w-[28px] h-[28px] p-0 border border-[#2d2d77] rounded bg-transparent shrink-0 cursor-pointer'
            value={vec3ToHex(arr as any)}
            onChange={e => setValue(u.name, colorToVec3(e.target.value))} />
        )}
        {Array.from({ length: n }).map((_, i) => (
          <input key={i} className={inputCls} type='number' value={arr[i] ?? 0}
            onChange={e => { const next = [...arr]; next[i] = parseFloat(e.target.value) || 0; setValue(u.name, next) }} />
        ))}
      </div>
    )
  }

  return (
    <Collapsable title='Uniforms'>
      <div className='w-full p-2'>
        <p className='text-xs text-gray-400 mb-2'>
          Declared uniforms are available in the shader as <code>u_&lt;name&gt;</code>. Samplers bind to your
          chosen texture; scalars/vectors upload their value each frame.
        </p>
        {list.length === 0 && <p className='text-xs text-gray-500 mb-2'>No uniforms yet.</p>}
        {list.map(u => (
          <div key={u.name} className='flex items-center gap-2 mb-2'>
            <span className='w-1/4 truncate' title={u.name}>{u.name}</span>
            <select className={inputCls + ' w-auto'} value={u.type}
              onChange={e => changeType(u.name, e.target.value as CustomUniformType)}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className='flex-1'>{renderValue(u)}</div>
            <button className='text-red-400 px-1' title='Remove' onClick={() => removeUniform(u.name)}>✕</button>
          </div>
        ))}
        <div className='flex items-center gap-2 mt-3 border-t border-[#2d2d77] pt-2'>
          <input className={inputCls} placeholder='new uniform name' value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addUniform() }} />
          <select className={inputCls + ' w-auto'} value={newType}
            onChange={e => setNewType(e.target.value as CustomUniformType)}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className='bg-[#2d2d77] text-white rounded px-3 py-1' onClick={addUniform}>Add</button>
        </div>
      </div>
    </Collapsable>
  )
}
