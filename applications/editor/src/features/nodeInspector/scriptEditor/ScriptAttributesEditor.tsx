import { Node, propertyTypeLabel } from 'cleo'
import { useState, useEffect } from 'react'
import { useCleoEngine } from '../../EngineContext'
import Collapsable from '@cleo/app-kit/ui/Collapsable'
import { cn, labelClass, ACCESS_META } from '@cleo/app-kit/ui'
import { SaveIcon, AttributesIcon, AttributeGroupIcon } from '../sectionIcons'
import { upgradeScriptVar, type ScriptVarSchema } from '../../../utils/scripts'
import { isOverridden, setFieldOverride } from '../../../utils/templateOverrides'
import { INSTANCE_LOCKED_TIP, setInstanceAttribute, settableOnInstance } from '../../../utils/instanceAttributes'
import OverrideMark from '../OverrideMark'
import { useVariantBase } from '../useVariantBase'
import { deepClone } from '@cleo/app-kit/utils/deepClone'
import PropertyField from '../../properties/PropertyField'

// The reflection view for a class-based script asset: its `@attribute` fields, in the Attributes section and
// one section per group (`@attribute('Combat')`). Fields are declared in the script, so name, type and access
// are read-only; only each node's own VALUE is editable, and it lives as a native own-property on the node.
// A field without `@attribute` is the script's own and is not shown. Each value is edited by its type
// (PropertyField): a `Color` with a colour picker, a `Material` with the material picker, a `LightNode` with
// a scene node, and so on.

/**
 * `overridable`: the node is inside a placed template instance, so an edited value is recorded as that
 * placement's override (templateOverrides.ts) and survives the instance being rebuilt from its template.
 *
 * `lockPrivate`: inside an instance, only the attributes the script declares public are the placement's to
 * set (instanceAttributes.ts); private and protected ones are shown, disabled, as the template has them.
 *
 * `section`: one inner node's public attributes, shown on its instance root as a single section with this
 * heading (the node's path and script), the groups as sub-headings. `persistScope` keeps each such section's
 * open state apart from the root's own and from each other's.
 */
export default function ScriptAttributesEditor(props: {
  node: Node
  overridable?: boolean
  lockPrivate?: boolean
  section?: string
  persistScope?: string
}) {
  const { eventEmitter, scriptAssetOf, revertTemplateOverride } = useCleoEngine()
  const asset = scriptAssetOf(props.node)
  const [values, setValues] = useState<Record<string, any>>({})
  // In a variant's tab: an inherited node's value differs from what its base holds = this variant's override.
  const origin = useVariantBase(props.node)
  const inherited = origin && origin.baseNode !== 'added' ? origin.baseNode : null

  const fields: ScriptVarSchema[] = (asset?.variables ?? []).map(upgradeScriptVar)
  const visible: ScriptVarSchema[] = fields.filter(v => !v.hidden && (!props.section || settableOnInstance(v)))
  // A field that is not an attribute is never shown, but one tagged @save is still part of what a save keeps: named.
  const hiddenSaved = fields.filter(v => v.hidden && v.save && !v.ref).map(v => v.name)
  // @child / @find fields: filled with a node by the engine, so shown as what they look for, not as values.
  const refs = fields.filter(v => v.ref)

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

  const locked = (v: ScriptVarSchema) => !!props.lockPrivate && !settableOnInstance(v)

  const setValue = (name: string, value: any) => {
    if (props.lockPrivate) {
      // Only what the placement may set: a disabled row cannot get here, but nothing else may either.
      const v = fields.find(f => f.name === name)
      if (!v || !setInstanceAttribute(props.node, v, value)) return
    } else {
      (props.node as any)[name] = value
      if (props.overridable) setFieldOverride(props.node, name, value)
    }
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
    const def = fields.find(f => f.name === v.options)?.default
    return Array.isArray(def) ? def.map(String) : []
  }

  const renderValue = (v: ScriptVarSchema) => {
    const a = v.attribute ?? {}
    return (
      <PropertyField type={v.type} value={values[v.name]} node={props.node} onChange={x => setValue(v.name, x)}
        min={a.min} max={a.max} step={a.step} multiline={a.multiline} title={a.tooltip}
        options={v.options ? choicesFor(v) : undefined} />
    )
  }

  // `showIf`: a row appears only while another attribute says so. It keeps its value while hidden.
  const shown = (v: ScriptVarSchema) => {
    const cond = v.attribute?.showIf
    if (!cond) return true
    if (typeof cond === 'string') return !!values[cond]
    return values[cond[0]] === cond[1]
  }

  const row = (v: ScriptVarSchema) => {
    // Read-only: the access level is declared in the script, not chosen in the inspector.
    const access = ACCESS_META[v.access]
    const a = v.attribute ?? {}
    const kind = propertyTypeLabel(v.type)
    const tip = a.tooltip ? `${a.tooltip}\n\n${v.name}: ${kind} (${v.access})` : `${v.name}: ${kind} (${v.access})`
    return (
      <div key={v.name} className='flex items-center gap-1.5 mb-2'>
        <span className={cn(labelClass, 'w-[30%] truncate')} title={tip}>{a.label ?? v.name}</span>
        {access && (
          <span className='inline-flex items-center shrink-0' style={{ color: access.color }}
            title={`Access: ${access.label} — declared in the script`}>
            {access.icon}
          </span>
        )}
        {v.save && (
          <span className='inline-flex items-center shrink-0 text-dim'
            title='Saved: the game keeps this field in its saves (@save in the script)'>
            <SaveIcon />
          </span>
        )}
        {locked(v)
          ? <div className='flex-1 min-w-0' title={INSTANCE_LOCKED_TIP}>
              <fieldset disabled className='min-w-0 border-0 m-0 p-0 opacity-60 pointer-events-none'>{renderValue(v)}</fieldset>
            </div>
          : <fieldset disabled={!!a.readonly} className={cn('flex-1 min-w-0 border-0 m-0 p-0', a.readonly && 'opacity-70')}
              title={a.readonly ? 'Read-only: the script shows this value without letting it be edited' : undefined}>
              {renderValue(v)}
            </fieldset>}
        {props.overridable && isOverridden(props.node, v.name) &&
          <OverrideMark onRevert={() => revertTemplateOverride(props.node, v.name)} />}
        {!props.overridable && variantOverrides(v) &&
          <OverrideMark title={`Overridden in this variant. Click to take ${origin!.baseName}'s value.`}
            onRevert={() => setValue(v.name, deepClone(baseValue(v)))} />}
      </div>
    )
  }

  // Ungrouped attributes, then each group in the order its first field is declared.
  const ungrouped = visible.filter(v => !v.attribute?.group)
  const groups: [string, ScriptVarSchema[]][] = []
  for (const v of visible) {
    const g = v.attribute?.group
    if (!g) continue
    const hit = groups.find(([name]) => name === g)
    if (hit) hit[1].push(v)
    else groups.push([g, [v]])
  }

  // Each node's sections remember their own open state; the root's keep the keys they always had.
  const scope = props.persistScope ? `@${props.persistScope}` : ''

  if (props.section) {
    return (
      <Collapsable title={props.section} icon={<AttributesIcon />} badge={visible.length} persistKey={`attributes${scope}`}
        doc='editor/scene-authoring::Public attributes'>
        <div className='w-full p-2'>
          {ungrouped.filter(shown).map(row)}
          {groups.map(([name, fields]) => (
            <div key={name}>
              <div className={cn(labelClass, 'flex items-center gap-1.5 mt-1 mb-1.5 text-dim')}>
                <span className='inline-flex w-[13px] h-[13px] [&>svg]:w-full [&>svg]:h-full'><AttributeGroupIcon /></span>
                {name}
              </div>
              {fields.filter(shown).map(row)}
            </div>
          ))}
        </div>
      </Collapsable>
    )
  }

  return (
    <>
      <Collapsable title='Attributes' icon={<AttributesIcon />} badge={ungrouped.length || undefined} persistKey={`attributes${scope}`}>
        <div className='w-full p-2'>
          {visible.length === 0 && <p className='mb-2 text-ui-sm text-dim'>No attributes. Mark a field @attribute in the script to show it here.</p>}
          {ungrouped.filter(shown).map(row)}
          {hiddenSaved.length > 0 &&
            <p className='text-ui-sm text-dim' title='Fields the script keeps in saves without showing them'>Also saved: {hiddenSaved.join(', ')}</p>}
          {refs.length > 0 &&
            <p className='text-ui-sm text-dim' title='Fields the script marks @child or @find: the engine fills each with that node before the script starts'>Finds: {refs.map(v => v.name.replace(/^_/, '') + ' → ' + v.ref!.name).join(', ')}</p>}
        </div>
      </Collapsable>
      {groups.map(([name, fields]) => (
        <Collapsable key={name} title={name} icon={<AttributeGroupIcon />} badge={fields.length}
          persistKey={`attrGroup:${name}${scope}`} doc='editor/scripting-workflow::Attributes'>
          <div className='w-full p-2'>{fields.filter(shown).map(row)}</div>
        </Collapsable>
      ))}
    </>
  )
}
