import { Node } from 'cleo'
import type { NodeVariableAccess } from 'cleo'
import { useState, useEffect } from 'react'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { NumberInput, TextInput, Toggle, VectorInput, TypeSelect, AccessSelect, Button, Hint } from '../../../components/ui'
import { VariablesIcon } from '../sectionIcons'

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

export default function CustomVariablesEditor(props: { node: Node }) {
  const { eventEmitter } = useCleoEngine()
  const [vars, setVars] = useState<{ name: string, type: VarType, value: any, access: NodeVariableAccess }[]>([])
  const [newName, setNewName] = useState('')
  const [newType, setNewType] = useState<VarType>('number')
  const [newAccess, setNewAccess] = useState<NodeVariableAccess>('public')

  // Hide internal/reserved variables (e.g. the __templateId instance marker) from the UI.
  const sync = () => setVars(Array.from(props.node.variables.entries())
    .filter(([name]) => !name.startsWith('__'))
    .map(([name, v]) => ({ name, type: v.type as VarType, value: v.value, access: (v.access ?? 'public') as NodeVariableAccess })))

  useEffect(() => { sync() }, [props.node])

  const addVar = () => {
    const name = newName.trim()
    if (!name) return
    if (props.node.variables.has(name)) return
    props.node.setVariable(name, defaultValue(newType), newType, newAccess)
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

  const changeAccess = (name: string, access: NodeVariableAccess) => {
    const v = props.node.variables.get(name)
    if (!v) return
    props.node.setVariable(name, v.value, v.type, access)
    sync()
    eventEmitter.emit('SCENE_CHANGED')
  }

  const removeVar = (name: string) => {
    props.node.removeVariable(name)
    sync()
    eventEmitter.emit('SCENE_CHANGED')
  }

  const renderValue = (v: { name: string, type: VarType, value: any }) => {
    if (v.type === 'number')
      return <NumberInput value={v.value} onChange={n => setValue(v.name, 'number', n)} />
    if (v.type === 'string')
      return <TextInput value={v.value ?? ''} onChange={s => setValue(v.name, 'string', s)} />
    if (v.type === 'boolean')
      return <Toggle checked={!!v.value} onChange={b => setValue(v.name, 'boolean', b)} />
    const arr = Array.isArray(v.value) ? v.value : [0, 0, 0]
    return <VectorInput value={arr} onChange={next => setValue(v.name, 'vec3', next)} />
  }

  return (
    <Collapsable title='Variables' icon={<VariablesIcon />} badge={vars.length || undefined} persistKey='variables'>
      <div className='w-full p-2'>
        <Hint className='mb-2'>
          Read via <code>getData(node).{'{name}'}</code>, write via <code>setData(node, '{'{name}'}', value)</code>.
          Access: <b>public</b> = any node, <b>private</b> = this node only, <b>protected</b> = this node + descendants.
        </Hint>
        {vars.length === 0 && <Hint className='mb-2'>No variables yet.</Hint>}
        {vars.map(v => (
          <div key={v.name} className='flex items-center gap-1.5 mb-2'>
            <span className='w-[26%] truncate text-xs' title={v.name}>{v.name}</span>
            <TypeSelect value={v.type} options={TYPES} onChange={t => changeType(v.name, t)} />
            <AccessSelect value={v.access} onChange={a => changeAccess(v.name, a as NodeVariableAccess)} />
            <div className='flex-1 min-w-0'>{renderValue(v)}</div>
            <Button variant='ghost' size='icon' className='text-danger' title='Remove' onClick={() => removeVar(v.name)}>✕</Button>
          </div>
        ))}
        <div className='flex items-center gap-1.5 mt-3 border-t border-border pt-2'>
          <TextInput className='flex-1' placeholder='new variable name' value={newName}
            onChange={setNewName}
            onKeyDown={e => { if (e.key === 'Enter') addVar() }} />
          <TypeSelect value={newType} options={TYPES} onChange={setNewType} />
          <AccessSelect value={newAccess} onChange={a => setNewAccess(a as NodeVariableAccess)} />
          <Button variant='primary' onClick={addVar}>Add</Button>
        </div>
      </div>
    </Collapsable>
  )
}
