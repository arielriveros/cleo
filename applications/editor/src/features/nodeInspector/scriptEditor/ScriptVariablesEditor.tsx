import { Node } from 'cleo'
import { useState, useEffect } from 'react'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { NumberInput, TextInput, Toggle, VectorInput, Select, StringListInput, ComboSelect, cn, labelClass, ACCESS_META } from '@cleo/app-kit/ui'
import { VariablesIcon } from '../sectionIcons'
import type { ScriptVarSchema } from '../../../utils/scripts'
import { isOverridden, setFieldOverride } from '../../../utils/templateOverrides'
import OverrideMark from '../OverrideMark'
import { useVariantBase } from '../useVariantBase'
import { deepClone } from '@cleo/app-kit/utils/deepClone'
import { pickChoices, PICK_LABEL, type PickContext } from './pickSources'

// The reflection view for a class-based script asset. Variables are not created here: they are declared in
// the script as class fields, so name, type and access are read-only. Only each node's own VALUE is editable,
// and it lives as a native own-property on the node. Underscore-prefixed fields are omitted.

/**
 * `overridable`: the node is inside a placed template instance, so an edited value is recorded as that
 * placement's override (templateOverrides.ts) and survives the instance being rebuilt from its template.
 */
export default function ScriptVariablesEditor(props: { node: Node; overridable?: boolean }) {
  const { eventEmitter, scriptAssetOf, revertTemplateOverride, editorScene, rigs, animations, templates } = useCleoEngine()
  const asset = scriptAssetOf(props.node)
  const [values, setValues] = useState<Record<string, any>>({})
  // In a variant's tab: an inherited node's value differs from what its base holds = this variant's override.
  const origin = useVariantBase(props.node)
  const inherited = origin && origin.baseNode !== 'added' ? origin.baseNode : null

  const visible: ScriptVarSchema[] = (asset?.variables ?? []).filter(v => !v.hidden)

  const sync = () => {
    const n = props.node as any
    const next: Record<string, any> = {}
    // A field the node holds no value for runs with the script's own default, so show that default rather
    // than 0 / empty. A node rebuilt from a template carries only the fields the template set.
    for (const v of visible) next[v.name] = n[v.name] === undefined ? v.default : n[v.name]
    setValues(next)
  }
  useEffect(() => { sync() }, [props.node, asset?.id, asset?.variables])

  if (!asset) return null

  const setValue = (name: string, value: any) => {
    (props.node as any)[name] = value
    if (props.overridable) setFieldOverride(props.node, name, value)
    setValues(prev => ({ ...prev, [name]: value }))
    // Mark the scene dirty so the value persists (fan-out reads native fields at save/play time).
    eventEmitter.emit('SCENE_CHANGED')
  }

  // What the base holds for a field: its stored value, or the script default when it stores none.
  const baseValue = (v: ScriptVarSchema) => {
    const stored = inherited?.scriptVars?.[v.name]
    return stored === undefined ? v.default : stored
  }
  const variantOverrides = (v: ScriptVarSchema) =>
    !!inherited && JSON.stringify(values[v.name]) !== JSON.stringify(baseValue(v))

  // The choices of an `@options` field: the node's own list (it may override the template's), else the
  // list field's script default.
  const choicesFor = (v: ScriptVarSchema): string[] => {
    const own = values[v.options!]
    if (Array.isArray(own)) return own.map(String)
    const def = asset.variables.find(f => f.name === v.options)?.default
    return Array.isArray(def) ? def.map(String) : []
  }

  // A typed name field (`clip: ClipName`): the names valid where this node sits. See pickSources.ts.
  const pickCtx: PickContext = { sceneRoot: editorScene?.root, rigs, animations, templates }
  const namePicker = (v: ScriptVarSchema, current: string, onChange: (value: string) => void) => {
    const noun = PICK_LABEL[v.pick!]
    return (
      <ComboSelect value={current} onChange={onChange} noun={noun}
        choices={pickChoices(v.pick!, props.node, pickCtx)} title={`A ${noun} name`} />
    )
  }

  const renderValue = (v: ScriptVarSchema) => {
    const value = values[v.name]
    if (v.choices) {
      const current = typeof value === 'string' ? value : ''
      return (
        <Select className='w-full' value={current} onChange={e => setValue(v.name, e.target.value)}>
          {!v.choices.includes(current) && <option value={current}>{current || '(none)'} (not in list)</option>}
          {v.choices.map(c => <option key={c} value={c}>{c}</option>)}
        </Select>
      )
    }
    if (v.pick && v.type === 'string') {
      return namePicker(v, typeof value === 'string' ? value : '', s => setValue(v.name, s))
    }
    if (v.options) {
      const choices = choicesFor(v)
      const current = typeof value === 'string' ? value : ''
      return (
        <Select className='w-full' value={current} onChange={e => setValue(v.name, e.target.value)}
          title={`Picked from ${v.options}`}>
          {!choices.includes(current) && <option value={current}>{current || '(none)'} (not in list)</option>}
          {choices.map((c, i) => <option key={`${i}:${c}`} value={c}>{c}</option>)}
        </Select>
      )
    }
    if (v.type === 'stringList') {
      return <StringListInput value={Array.isArray(value) ? value.map(String) : []} onChange={next => setValue(v.name, next)}
        renderItem={v.pick ? (item, set) => namePicker(v, item, set) : undefined} />
    }
    if (v.type === 'number') return <NumberInput value={typeof value === 'number' ? value : 0} onChange={n => setValue(v.name, n)} />
    if (v.type === 'string') return <TextInput value={value ?? ''} onChange={s => setValue(v.name, s)} />
    if (v.type === 'boolean') return <Toggle checked={!!value} onChange={b => setValue(v.name, b)} />
    const arr = Array.isArray(value) ? value : [0, 0, 0]
    return <VectorInput value={arr} onChange={next => setValue(v.name, next)} />
  }

  return (
    <Collapsable title='Variables' icon={<VariablesIcon />} badge={visible.length || undefined} persistKey='variables'>
      <div className='w-full p-2'>
        {visible.length === 0 && <p className='mb-2 text-ui-sm text-dim'>No exposed variables. Declare a public/protected field in the script.</p>}
        {visible.map(v => {
          // Read-only: the access level is declared in the script, not chosen in the inspector.
          const access = ACCESS_META[v.access]
          return (
            <div key={v.name} className='flex items-center gap-1.5 mb-2'>
              <span className={cn(labelClass, 'w-[30%] truncate')} title={`${v.name}: ${v.pick ? `${v.pick} name` : v.type}${v.type === 'stringList' && v.pick ? ' list' : ''} (${v.access})`}>{v.name}</span>
              {access && (
                <span className='inline-flex items-center shrink-0' style={{ color: access.color }}
                  title={`Access: ${access.label} — declared in the script`}>
                  {access.icon}
                </span>
              )}
              <div className='flex-1 min-w-0'>{renderValue(v)}</div>
              {props.overridable && isOverridden(props.node, v.name) &&
                <OverrideMark onRevert={() => revertTemplateOverride(props.node, v.name)} />}
              {!props.overridable && variantOverrides(v) &&
                <OverrideMark title={`Overridden in this variant. Click to take ${origin!.baseName}'s value.`}
                  onRevert={() => setValue(v.name, deepClone(baseValue(v)))} />}
            </div>
          )
        })}
      </div>
    </Collapsable>
  )
}
