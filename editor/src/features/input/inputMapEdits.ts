import { defaultProcessor, DEFAULT_TOUCH_CONFIG } from 'cleo'
import type {
  ActionKind, BindingSource, CompositePart, InputAction, InputActionMap, InputBinding, InputMap,
  ModifierSource, Processor, ProcessorKind, VirtualControl,
} from 'cleo'

/**
 * Every edit the Input panel can make to an action map, as PURE functions: map in, new map out.
 *
 * Kept out of the React components on purpose. An input map is a four-level tree (map → action →
 * binding → processor) and almost every edit is an immutable splice several levels down — the kind of
 * code that is easy to get subtly wrong (a rename that also renumbers ids, a delete that orphans a
 * virtual control) and impossible to test through a component. Here it is a table of small functions a
 * unit test can drive directly.
 *
 * Every function returns a NEW map and never mutates its argument, so React's identity comparison does
 * the right thing and undo can hold onto an old one.
 */

// ----- ids ---------------------------------------------------------------------------------------

/**
 * A binding id that is unique within its action. Prefixed by the action name, matching what
 * `normalizeAction` mints for a record that has none, so ids stay recognizable in a saved file.
 */
function mintBindingId(action: InputAction): string {
  const taken = new Set(action.bindings.map(b => b.id))
  const base = action.name.toLowerCase().replace(/\s+/g, '-')
  for (let i = action.bindings.length; ; i++) {
    const id = `${base}:${i}`
    if (!taken.has(id)) return id
  }
}

/** `name`, or `name 2`, `name 3`… until it is free. Used for both map and action names. */
function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.includes(name)) return name
  for (let i = 2; ; i++) {
    const candidate = `${name} ${i}`
    if (!taken.includes(candidate)) return candidate
  }
}

// ----- maps --------------------------------------------------------------------------------------

function withMaps(map: InputMap, maps: InputActionMap[]): InputMap {
  return { ...map, maps }
}

/** Replace one map in place, leaving order untouched — order IS the name-shadowing priority. */
function patchMap(map: InputMap, name: string, fn: (m: InputActionMap) => InputActionMap): InputMap {
  return withMaps(map, map.maps.map(m => (m.name === name ? fn(m) : m)))
}

function patchAction(
  map: InputMap, mapName: string, actionName: string, fn: (a: InputAction) => InputAction,
): InputMap {
  return patchMap(map, mapName, m => ({
    ...m,
    actions: m.actions.map(a => (a.name === actionName ? fn(a) : a)),
  }))
}

export function addMap(map: InputMap, name = 'New Map'): InputMap {
  const unique = uniqueName(name, map.maps.map(m => m.name))
  return withMaps(map, [...map.maps, { name: unique, enabled: true, actions: [] }])
}

export function removeMap(map: InputMap, name: string): InputMap {
  return withMaps(map, map.maps.filter(m => m.name !== name))
}

export function renameMap(map: InputMap, from: string, to: string): InputMap {
  const trimmed = to.trim()
  if (!trimmed || trimmed === from) return map
  const unique = uniqueName(trimmed, map.maps.filter(m => m.name !== from).map(m => m.name))
  return patchMap(map, from, m => ({ ...m, name: unique }))
}

export function setMapEnabled(map: InputMap, name: string, enabled: boolean): InputMap {
  return patchMap(map, name, m => ({ ...m, enabled }))
}

// ----- actions -----------------------------------------------------------------------------------

export function addAction(map: InputMap, mapName: string, kind: ActionKind = 'button', name = 'New Action'): InputMap {
  return patchMap(map, mapName, m => ({
    ...m,
    actions: [...m.actions, { name: uniqueName(name, m.actions.map(a => a.name)), kind, bindings: [] }],
  }))
}

export function removeAction(map: InputMap, mapName: string, actionName: string): InputMap {
  return patchMap(map, mapName, m => ({ ...m, actions: m.actions.filter(a => a.name !== actionName) }))
}

export function renameAction(map: InputMap, mapName: string, from: string, to: string): InputMap {
  const trimmed = to.trim()
  if (!trimmed || trimmed === from) return map
  return patchMap(map, mapName, m => {
    const unique = uniqueName(trimmed, m.actions.filter(a => a.name !== from).map(a => a.name))
    // Binding ids are NOT reminted. They are opaque row identities, and churning them on a rename
    // would move the panel's selection and make every saved diff noisier than the edit.
    return { ...m, actions: m.actions.map(a => (a.name === from ? { ...a, name: unique } : a)) }
  })
}

/**
 * Change what an action produces. Composite parts that make no sense for the new kind are dropped from
 * its bindings rather than left behind — a `part: 'up'` on an axis action would silently contribute
 * nothing, which reads as a binding that does not work.
 */
export function setActionKind(map: InputMap, mapName: string, actionName: string, kind: ActionKind): InputMap {
  const allowed: Record<ActionKind, readonly CompositePart[]> = {
    button: [],
    axis: ['positive', 'negative'],
    vector: ['up', 'down', 'left', 'right', 'x', 'y'],
  }
  return patchAction(map, mapName, actionName, a => ({
    ...a,
    kind,
    bindings: a.bindings.map(b => {
      if (!b.part || allowed[kind].includes(b.part)) return b
      const { part, ...rest } = b
      return rest
    }),
    // pressPoint and holdSeconds only mean anything on a button.
    ...(kind === 'button' ? {} : { pressPoint: undefined, holdSeconds: undefined }),
  }))
}

export function setPressPoint(map: InputMap, mapName: string, actionName: string, pressPoint: number): InputMap {
  return patchAction(map, mapName, actionName, a => ({ ...a, pressPoint }))
}

export function setHoldSeconds(map: InputMap, mapName: string, actionName: string, holdSeconds: number): InputMap {
  return patchAction(map, mapName, actionName, a =>
    (holdSeconds > 0 ? { ...a, holdSeconds } : { ...a, holdSeconds: undefined }))
}

// ----- bindings ----------------------------------------------------------------------------------

const UNBOUND: BindingSource = { device: 'key', code: 'KeyF' }

export function addBinding(
  map: InputMap, mapName: string, actionName: string, source: BindingSource = UNBOUND,
): InputMap {
  return patchAction(map, mapName, actionName, a => ({
    ...a,
    bindings: [...a.bindings, { id: mintBindingId(a), source }],
  }))
}

export function removeBinding(map: InputMap, mapName: string, actionName: string, bindingId: string): InputMap {
  return patchAction(map, mapName, actionName, a => ({
    ...a,
    bindings: a.bindings.filter(b => b.id !== bindingId),
  }))
}

function patchBinding(
  map: InputMap, mapName: string, actionName: string, bindingId: string,
  fn: (b: InputBinding) => InputBinding,
): InputMap {
  return patchAction(map, mapName, actionName, a => ({
    ...a,
    bindings: a.bindings.map(b => (b.id === bindingId ? fn(b) : b)),
  }))
}

export function setBindingSource(
  map: InputMap, mapName: string, actionName: string, bindingId: string, source: BindingSource,
): InputMap {
  return patchBinding(map, mapName, actionName, bindingId, b => ({ ...b, source }))
}

export function setBindingPart(
  map: InputMap, mapName: string, actionName: string, bindingId: string, part: CompositePart | null,
): InputMap {
  return patchBinding(map, mapName, actionName, bindingId, b => {
    if (!part) { const { part: _drop, ...rest } = b; return rest }
    return { ...b, part }
  })
}

export function setBindingModifiers(
  map: InputMap, mapName: string, actionName: string, bindingId: string, modifiers: ModifierSource[],
): InputMap {
  return patchBinding(map, mapName, actionName, bindingId, b => {
    // An empty list is written as ABSENT, not as `[]`: the tolerant reader omits empty lists, and
    // leaving one here would make a round trip through save/load change the object.
    if (modifiers.length === 0) { const { modifiers: _drop, ...rest } = b; return rest }
    return { ...b, modifiers }
  })
}

// ----- processors --------------------------------------------------------------------------------

/**
 * Processor chains hang off either a binding (`bindingId` given) or the action itself (`bindingId`
 * null). One set of functions for both, because the ordering rules and the UI are identical — only the
 * place the array lives differs.
 */
function patchProcessors(
  map: InputMap, mapName: string, actionName: string, bindingId: string | null,
  fn: (chain: Processor[]) => Processor[],
): InputMap {
  const apply = <T extends { processors?: Processor[] }>(target: T): T => {
    const next = fn([...(target.processors ?? [])])
    if (next.length === 0) { const { processors: _drop, ...rest } = target; return rest as T }
    return { ...target, processors: next }
  }
  return bindingId === null
    ? patchAction(map, mapName, actionName, apply)
    : patchBinding(map, mapName, actionName, bindingId, apply)
}

export function addProcessor(
  map: InputMap, mapName: string, actionName: string, bindingId: string | null, kind: ProcessorKind,
): InputMap {
  return patchProcessors(map, mapName, actionName, bindingId, chain => [...chain, defaultProcessor(kind)])
}

export function removeProcessor(
  map: InputMap, mapName: string, actionName: string, bindingId: string | null, index: number,
): InputMap {
  return patchProcessors(map, mapName, actionName, bindingId, chain => chain.filter((_, i) => i !== index))
}

export function updateProcessor(
  map: InputMap, mapName: string, actionName: string, bindingId: string | null, index: number,
  processor: Processor,
): InputMap {
  return patchProcessors(map, mapName, actionName, bindingId, chain =>
    chain.map((p, i) => (i === index ? processor : p)))
}

/** Move a processor by `delta` places. Order is the author's meaning, so this is a real edit. */
export function moveProcessor(
  map: InputMap, mapName: string, actionName: string, bindingId: string | null, index: number, delta: number,
): InputMap {
  return patchProcessors(map, mapName, actionName, bindingId, chain => {
    const target = index + delta
    if (index < 0 || index >= chain.length || target < 0 || target >= chain.length) return chain
    const next = [...chain]
    const [moved] = next.splice(index, 1)
    next.splice(target, 0, moved)
    return next
  })
}

// ----- on-screen controls ------------------------------------------------------------------------

export function upsertVirtualControl(map: InputMap, control: VirtualControl): InputMap {
  const existing = map.virtualControls.some(c => c.id === control.id)
  return {
    ...map,
    virtualControls: existing
      ? map.virtualControls.map(c => (c.id === control.id ? control : c))
      : [...map.virtualControls, control],
  }
}

/**
 * Remove an on-screen control, AND every binding that named it.
 *
 * Leaving the bindings behind is the tempting shortcut and the wrong one: a `{device:'virtual'}` source
 * pointing at nothing is perfectly valid JSON, survives the tolerant reader, and simply never fires —
 * so the panel would keep showing a binding row that does nothing, with nothing to say why.
 */
export function removeVirtualControl(map: InputMap, id: string): InputMap {
  return {
    ...map,
    virtualControls: map.virtualControls.filter(c => c.id !== id),
    maps: map.maps.map(m => ({
      ...m,
      actions: m.actions.map(a => ({
        ...a,
        bindings: a.bindings.filter(b => !(b.source.device === 'virtual' && b.source.control === id)),
      })),
    })),
  }
}

export function setTouchConfig(map: InputMap, patch: Partial<typeof DEFAULT_TOUCH_CONFIG>): InputMap {
  return { ...map, touch: { ...map.touch, ...patch } }
}

// ----- queries -----------------------------------------------------------------------------------

/**
 * Every place `source` is already bound, as `Map/Action` strings. What the panel's conflict warning
 * shows — two actions on one key is legal (and sometimes intended, as Escape being both Cancel and
 * Pause), so this reports rather than prevents.
 */
export function bindingsUsing(map: InputMap, key: string, sourceKeyOf: (s: BindingSource) => string): string[] {
  const out: string[] = []
  for (const m of map.maps)
    for (const a of m.actions)
      for (const b of a.bindings)
        if (sourceKeyOf(b.source) === key) out.push(`${m.name}/${a.name}`)
  return out
}
