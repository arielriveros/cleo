import { Node } from 'cleo'
import { useState, useEffect } from 'react'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '../../../components/Collapsable'
import { NumberInput, TextInput, Toggle, VectorInput, cn, labelClass, ACCESS_META } from '../../../components/ui'
import { VariablesIcon } from '../sectionIcons'
import type { ScriptVarSchema } from '../../../utils/scripts'

// The reflection view for a class-based script asset. Variables are not created here: they are declared in
// the script as class fields, so name, type and access are read-only. Only each node's own VALUE is editable,
// and it lives as a native own-property on the node. Underscore-prefixed fields are omitted.

export default function ScriptVariablesEditor(props: { node: Node }) {
  const { eventEmitter, scriptAssetOf } = useCleoEngine()
  const asset = scriptAssetOf(props.node)
  const [values, setValues] = useState<Record<string, any>>({})

  const visible: ScriptVarSchema[] = (asset?.variables ?? []).filter(v => !v.hidden)

  const sync = () => {
    const n = props.node as any
    const next: Record<string, any> = {}
    for (const v of visible) next[v.name] = n[v.name]
    setValues(next)
  }
  useEffect(() => { sync() }, [props.node, asset?.id, asset?.variables])

  if (!asset) return null

  const setValue = (name: string, value: any) => {
    (props.node as any)[name] = value
    setValues(prev => ({ ...prev, [name]: value }))
    // Mark the scene dirty so the value persists (fan-out reads native fields at save/play time).
    eventEmitter.emit('SCENE_CHANGED')
  }

  const renderValue = (v: ScriptVarSchema) => {
    const value = values[v.name]
    if (v.type === 'number') return <NumberInput value={typeof value === 'number' ? value : 0} onChange={n => setValue(v.name, n)} />
    if (v.type === 'string') return <TextInput value={value ?? ''} onChange={s => setValue(v.name, s)} />
    if (v.type === 'boolean') return <Toggle checked={!!value} onChange={b => setValue(v.name, b)} />
    const arr = Array.isArray(value) ? value : [0, 0, 0]
    return <VectorInput value={arr} onChange={next => setValue(v.name, next)} />
  }

  return (
    <Collapsable title='Variables' icon={<VariablesIcon />} badge={visible.length || undefined} persistKey='variables'>
      <div className='w-full p-2'>
        <p className='mb-2 text-[11px] text-dim'>
          Declared in <b>{asset.name}</b> as class fields. Type and access come from the script; edit each
          value here. Add a field in the script (<code>public speed: number = 5</code>); a leading{' '}
          <code>_</code> keeps it internal.
        </p>
        {visible.length === 0 && <p className='mb-2 text-[11px] text-dim'>No exposed variables. Declare a public/protected field in the script.</p>}
        {visible.map(v => {
          // Read-only: the access level is declared in the script, not chosen in the inspector.
          const access = ACCESS_META[v.access]
          return (
            <div key={v.name} className='flex items-center gap-1.5 mb-2'>
              <span className={cn(labelClass, 'w-[30%] truncate')} title={`${v.name}: ${v.type} (${v.access})`}>{v.name}</span>
              {access && (
                <span className='inline-flex items-center shrink-0' style={{ color: access.color }}
                  title={`Access: ${access.label} — declared in the script`}>
                  {access.icon}
                </span>
              )}
              <div className='flex-1 min-w-0'>{renderValue(v)}</div>
            </div>
          )
        })}
      </div>
    </Collapsable>
  )
}
