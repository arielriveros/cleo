import { Node } from 'cleo'
import { useState, useEffect } from 'react'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'

type VarType = 'number' | 'string' | 'boolean' | 'vec3'
const TYPES: VarType[] = ['number', 'string', 'boolean', 'vec3']

function defaultValue(type: VarType): any {
  switch (type) {
    case 'number': return 0
    case 'string': return ''
    case 'boolean': return false
    case 'vec3': return [0, 0, 0]
  }
}

const inputCls = 'bg-[#3b3b3b] text-white border border-[#2d2d77] rounded px-2 py-1 w-full'

export default function CustomVariablesEditor(props: { node: Node }) {
  const { eventEmitter } = useCleoEngine()
  const [vars, setVars] = useState<{ name: string, type: VarType, value: any }[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<VarType>('number')

  const sync = () => setVars(Array.from(props.node.variables.entries())
    .map(([name, v]) => ({ name, type: v.type as VarType, value: v.value })))

  useEffect(() => { sync() }, [props.node])

  const addVar = () => {
    const name = newName.trim()
    if (!name) return
    if (props.node.variables.has(name)) return
    props.node.setVariable(name, defaultValue(newType), newType)
    setNewName('')
    sync()
    eventEmitter.emit('SCENE_CHANGED')
  }

  const setValue = (name: string, type: VarType, value: any) => {
    props.node.setVariable(name, value, type)
    sync()
  }

  const changeType = (name: string, type: VarType) => {
    props.node.setVariable(name, defaultValue(type), type)
    sync()
  }

  const removeVar = (name: string) => {
    props.node.removeVariable(name)
    sync()
    eventEmitter.emit('SCENE_CHANGED')
  }

  const renderValue = (v: { name: string, type: VarType, value: any }) => {
    if (v.type === 'number')
      return <input className={inputCls} type='number' value={v.value}
        onChange={e => setValue(v.name, 'number', parseFloat(e.target.value) || 0)} />
    if (v.type === 'string')
      return <input className={inputCls} value={v.value}
        onChange={e => setValue(v.name, 'string', e.target.value)} />
    if (v.type === 'boolean')
      return <input type='checkbox' checked={!!v.value}
        onChange={e => setValue(v.name, 'boolean', e.target.checked)} />
    // vec3
    const arr = Array.isArray(v.value) ? v.value : [0, 0, 0]
    return (
      <div className='flex gap-1'>
        {[0, 1, 2].map(i => (
          <input key={i} className={inputCls} type='number' value={arr[i]}
            onChange={e => {
              const next = [...arr]; next[i] = parseFloat(e.target.value) || 0
              setValue(v.name, 'vec3', next)
            }} />
        ))}
      </div>
    )
  }

  return (
    <Collapsable title='Variables'>
      <div className='w-full p-2'>
        <p className='text-xs text-gray-400 mb-2'>
          Read via <code>getData(node).{'{name}'}</code>, write via <code>setData(node, '{'{name}'}', value)</code>
        </p>
        {vars.length === 0 && <p className='text-xs text-gray-500 mb-2'>No variables yet.</p>}
        {vars.map(v => (
          <div key={v.name} className='flex items-center gap-2 mb-2'>
            <span className='w-1/4 truncate' title={v.name}>{v.name}</span>
            <select className={inputCls + ' w-auto'} value={v.type}
              onChange={e => changeType(v.name, e.target.value as VarType)}>
              {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className='flex-1'>{renderValue(v)}</div>
            <button className='text-red-400 px-1' title='Remove' onClick={() => removeVar(v.name)}>✕</button>
          </div>
        ))}
        <div className='flex items-center gap-2 mt-3 border-t border-[#2d2d77] pt-2'>
          <input className={inputCls} placeholder='new variable name' value={newName}
            onChange={e => setNewName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') addVar() }} />
          <select className={inputCls + ' w-auto'} value={newType}
            onChange={e => setNewType(e.target.value as VarType)}>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <button className='bg-[#2d2d77] text-white rounded px-3 py-1' onClick={addVar}>Add</button>
        </div>
      </div>
    </Collapsable>
  )
}
