import * as Cleo from 'cleo'
import {
  Node, assetRef, defaultOf, isAssetRef, isNodePathRef, nodeAtRelativePath, nodePathRef, relativeNodePath,
  type AssetFieldKind, type NameKind, type PropertyType,
} from 'cleo'
import {
  Button, ColorInput, ComboSelect, NumberInput, Select, Slider, StringListInput, TextInput, Toggle, VectorInput,
  colorToHex, controlClass, cn,
} from '@cleo/app-kit/ui'
import { useCleoEngine } from '../EngineContext'
import { useAssetLibrary } from '../AssetLibraryContext'
import MaterialPicker from '../terrainMaterials/MaterialPicker'
import TextureSlotPicker from '../texture/TextureSlotPicker'
import NodeRefInput from '../nodeInspector/NodeRefInput'
import { pickChoices, PICK_LABEL, PICK_ONLY, type PickContext } from '../nodeInspector/scriptEditor/pickSources'
import { LayerDropdown, LayerMaskDropdown } from '../nodeInspector/physicsEditors/layerPickers'
import { useAssetDrop } from '../../utils/useAssetDrop'
import type { ScriptAsset } from '../../utils/scripts'

// THE editor of a value, by its property type (src/core/properties/types.ts): a script's `@attribute` field
// and an engine node's declared property both come here, so a colour, a material or a node reads the same in
// every inspector. The value is in its STORED form: an asset is `{ $asset, id }`, a node `{ $nodePath }`
// relative to `node` -- the editor never holds the resolved objects (fieldRefs.ts).

export interface PropertyFieldProps {
  type: PropertyType
  value: unknown
  onChange: (value: unknown) => void
  /** The node the value belongs to: name lists read its surroundings, and node paths start from it. */
  node: Node | null
  /** A number's range: a slider when both are given, and values clamped to it. */
  min?: number
  max?: number
  step?: number
  /** A string edited in a text area. */
  multiline?: boolean
  /** The choices of an `@options` field, drawn from another field's list. */
  options?: readonly string[]
  /** How a slider shows its number. */
  readout?: (value: number) => string
  /** Which nodes a node field may name, beyond its type (an engine node's declaration narrows it). */
  nodeFilter?: (node: Node) => boolean
  title?: string
}

/** What the name lists read, from the editor's state. */
export function usePickContext(): PickContext {
  const { editorScene, rigs, animations, templates, animControllers, inputMap, sceneList, projectSettings } = useCleoEngine()
  const actions: string[] = []
  for (const map of inputMap?.maps ?? []) for (const a of map.actions) if (!actions.includes(a.name)) actions.push(a.name)
  return {
    sceneRoot: editorScene?.root, rigs, animations, templates, animControllers,
    actions, scenes: (sceneList ?? []).map(s => s.name), layers: projectSettings?.collisionLayers ?? [],
  }
}

/** One name of `kind` where `node` sits: a searchable list, typed in too unless only declared names exist. */
function NamePicker(props: { kind: NameKind; value: string; onChange: (v: string) => void; node: Node | null; ctx: PickContext }) {
  const noun = PICK_LABEL[props.kind]
  return (
    <ComboSelect value={props.value} onChange={props.onChange} noun={noun}
      choices={props.node ? pickChoices(props.kind, props.node, props.ctx) : []} title={`A ${noun} name`}
      allowCustom={!PICK_ONLY.has(props.kind)} />
  )
}

/** Whether `node` runs the script class `className`, or one that extends it. */
function runsScript(node: Node, className: string, scriptAssetOf: (n: Node) => ScriptAsset | undefined, assets: readonly ScriptAsset[]): boolean {
  const classOf = (src: string) => /\bexport\s+default\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)(?:\s+extends\s+([A-Za-z_$][\w$]*))?/.exec(src)
  let src = scriptAssetOf(node)?.source
  for (let depth = 0; src && depth < 8; depth++) {
    const m = classOf(src)
    if (!m) return false
    if (m[1] === className) return true
    if (!m[2]) return false
    src = assets.find(a => classOf(a.source)?.[1] === m[2])?.source
  }
  return false
}

/** A node field: a scene node of the declared class, stored as the path to it from `node`. */
function NodeField(props: { type: Extract<PropertyType, { kind: 'node' }>; value: unknown; onChange: (v: unknown) => void; node: Node | null; accepts?: (n: Node) => boolean }) {
  const { scriptAssetOf, scriptAssets } = useCleoEngine()
  const from = props.node
  const scene = from?.scene
  if (!from || !scene) return <span className='text-ui-sm text-dim'>A node in the scene</span>
  const path = isNodePathRef(props.value) ? props.value.$nodePath : null
  const target = path !== null ? nodeAtRelativePath(from, path) : null
  const ctor = props.type.script ? null : (Cleo as any)[props.type.className]
  const filter = (n: Node) => n !== from && (!props.accepts || props.accepts(n)) && (props.type.script
    ? runsScript(n, props.type.className, scriptAssetOf, scriptAssets)
    : typeof ctor === 'function' ? n instanceof ctor : true)
  return (
    <div className='w-full'>
      <NodeRefInput scene={scene} value={target?.id ?? null} filter={filter}
        placeholder={`— No ${props.type.className} —`}
        onChange={id => {
          const picked = id ? scene.getNodeById(id) : null
          const rel = picked ? relativeNodePath(from, picked) : null
          props.onChange(rel ? nodePathRef(rel) : null)
        }} />
      {path !== null && !target &&
        <div className='type-hint text-danger-fg mt-1' title='The node this field points at is not there'>Missing: {path}</div>}
    </div>
  )
}

/** A sound sample or a tileset: the library's list, a drop target, and none. */
function LibraryAssetField(props: { kind: 'sound' | 'tileset'; value: unknown; onChange: (v: unknown) => void }) {
  const { soundSamples, tilesets } = useAssetLibrary()
  const list: readonly { id: string; name: string }[] = props.kind === 'sound' ? soundSamples : tilesets
  const id = isAssetRef(props.value) ? props.value.id : ''
  const set = (next: string) => props.onChange(next ? assetRef(props.kind, next) : null)
  const mime = props.kind === 'sound' ? 'text/cleo-sound-sample' : 'text/cleo-tileset'
  const { dragOver, dropProps } = useAssetDrop(mime, set, { stopPropagation: true })
  const missing = !!id && !list.some(a => a.id === id)
  return (
    <div {...dropProps} className='w-full' title={`Pick a ${props.kind === 'sound' ? 'sound sample' : 'tileset'}, or drop one from the Assets panel`}>
      <Select className={cn('w-full', dragOver && 'border-primary', missing && 'border-danger-border')} value={id}
        onChange={e => set(e.target.value)}>
        <option value=''>— None —</option>
        {missing && <option value={id}>{id} (missing)</option>}
        {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
      </Select>
    </div>
  )
}

function AssetField(props: { kind: AssetFieldKind; value: unknown; onChange: (v: unknown) => void; node: Node | null }) {
  const id = isAssetRef(props.value) && props.value.$asset === props.kind ? props.value.id : null
  if (props.kind === 'material')
    return (
      <div className='flex items-start gap-1 w-full'>
        <div className='flex-1 min-w-0'>
          <MaterialPicker value={id} placeholder='(none)' newName={() => `${props.node?.name ?? 'Script'} Material`}
            onPick={asset => props.onChange(assetRef('material', asset.id))} />
        </div>
        {id && <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='No material'
          onClick={() => props.onChange(null)}>✕</Button>}
      </div>
    )
  if (props.kind === 'texture')
    return <TextureSlotPicker value={id} onChange={next => props.onChange(next ? assetRef('texture', next) : null)} />
  return <LibraryAssetField kind={props.kind} value={props.value} onChange={props.onChange} />
}

/** A list of any type that is not text: one row per entry, a ✕ per row and an Add button. */
function ValueList(props: { of: PropertyType; value: unknown; onChange: (v: unknown) => void; node: Node | null }) {
  const items = Array.isArray(props.value) ? props.value : []
  return (
    <div className='flex flex-col gap-1 w-full'>
      {items.map((item, i) => (
        <div key={i} className='flex items-center gap-1'>
          <div className='flex-1 min-w-0'>
            <PropertyField type={props.of} value={item} node={props.node}
              onChange={v => props.onChange(items.map((old, k) => (k === i ? v : old)))} />
          </div>
          <Button variant='remove' size='sm' className='px-1 py-0 shrink-0' title='Remove entry'
            onClick={() => props.onChange(items.filter((_, k) => k !== i))}>✕</Button>
        </div>
      ))}
      <Button size='sm' className='self-start' onClick={() => props.onChange([...items, defaultOf(props.of)])}>+ Add</Button>
    </div>
  )
}

/** The editor for one value of `type`. */
export default function PropertyField(props: PropertyFieldProps) {
  const ctx = usePickContext()
  const { type, value, onChange, node } = props

  if (props.options) {
    const current = typeof value === 'string' ? value : ''
    return (
      <Select className='w-full' value={current} onChange={e => onChange(e.target.value)} title={props.title}>
        {!props.options.includes(current) && <option value={current}>{current || '(none)'} (not in list)</option>}
        {props.options.map((c, i) => <option key={`${i}:${c}`} value={c}>{c}</option>)}
      </Select>
    )
  }

  switch (type.kind) {
    case 'number': {
      const n = typeof value === 'number' ? value : 0
      const fit = (x: number) => {
        const v = Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, x))
        return type.integer ? Math.round(v) : v
      }
      const step = props.step ?? (type.integer ? 1 : undefined)
      if (props.min !== undefined && props.max !== undefined && props.max > props.min)
        return <Slider value={n} min={props.min} max={props.max} step={step ?? (props.max - props.min) / 100} readout={props.readout ?? true} doc={false}
          title={props.title} onChange={x => onChange(fit(x))} />
      return <NumberInput value={n} min={props.min} max={props.max} step={step} onChange={x => onChange(fit(x))} />
    }
    case 'boolean':
      return <Toggle checked={!!value} onChange={b => onChange(b)} />
    case 'string':
      if (props.multiline)
        return <textarea className={cn(controlClass, 'w-full min-h-[3.5rem] resize-y')} value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value)} />
      return <TextInput value={typeof value === 'string' ? value : ''} onChange={s => onChange(s)} />
    case 'choice': {
      const current = typeof value === 'string' ? value : ''
      return (
        <Select className='w-full' value={current} onChange={e => onChange(e.target.value)} title={props.title}>
          {!type.values.includes(current) && <option value={current}>{current || '(none)'} (not in list)</option>}
          {type.values.map((c, i) => <option key={c} value={c}>{type.labels?.[i] ?? c}</option>)}
        </Select>
      )
    }
    case 'vector': {
      const arr = Array.isArray(value) ? value : (defaultOf(type) as number[])
      return <VectorInput value={arr} step={props.step} min={props.min} max={props.max} onChange={next => onChange(next)} />
    }
    case 'color': {
      const arr = Array.isArray(value) ? value : (defaultOf(type) as number[])
      return (
        <div className='flex items-center gap-1.5 w-full'>
          <ColorInput color={colorToHex(arr)} onChange={rgb => onChange(type.alpha ? [...rgb, arr[3] ?? 1] : rgb)} />
          <VectorInput value={arr} labels={type.alpha ? ['R', 'G', 'B', 'A'] : ['R', 'G', 'B']} step={0.01} min={0}
            onChange={next => onChange(next)} />
        </div>
      )
    }
    case 'name':
      return <NamePicker kind={type.name} value={typeof value === 'string' ? value : ''} onChange={onChange} node={node} ctx={ctx} />
    case 'asset':
      return <AssetField kind={type.asset} value={value} onChange={onChange} node={node} />
    case 'node':
      return <NodeField type={type} value={value} onChange={onChange} node={node} accepts={props.nodeFilter} />
    case 'layers': {
      const bits = typeof value === 'number' ? value : (defaultOf(type) as number)
      return type.mask
        ? <LayerMaskDropdown value={bits} onChange={onChange} />
        : <LayerDropdown value={bits} onChange={onChange} />
    }
    case 'list': {
      const of = type.of
      if (of.kind === 'string' || of.kind === 'name') {
        const items = Array.isArray(value) ? value.map(String) : []
        return <StringListInput value={items} onChange={next => onChange(next)}
          renderItem={of.kind === 'name'
            ? (item, set) => <NamePicker kind={of.name} value={item} onChange={set} node={node} ctx={ctx} />
            : undefined} />
      }
      return <ValueList of={of} value={value} onChange={onChange} node={node} />
    }
  }
}
