import { useMemo } from 'react'
import { useCleoEngine } from '../EngineContext'
import { Select, cn } from '../../components/ui'

/**
 * Picks one of the project's input ACTIONS by name.
 *
 * Reads the live `inputMap` off the engine context — the same state the Input panel edits and the same
 * one pushed into `InputSystem` on every change — so the list here can never drift from what actually
 * resolves at runtime. That is why this lives under `features/input/` rather than beside its consumers:
 * the Input panel stays the single owner of "what actions exist".
 *
 * A value that names no existing action is KEPT and shown as missing rather than being snapped to
 * something else. Silently rewriting it would lose the author's intent the moment a map failed to load,
 * and it is the same treatment `ConditionTree` gives a deleted animation parameter.
 */
export interface ActionSelectProps {
  value: string
  onChange: (name: string) => void
  /** Offer an explicit "unbound" entry. The controller reads an empty name as idle. */
  allowNone?: boolean
  disabled?: boolean
  className?: string
  title?: string
}

export default function ActionSelect({ value, onChange, allowNone, disabled, className, title }: ActionSelectProps) {
  const { inputMap } = useCleoEngine()

  // Bare names, deduplicated across maps: a controller addresses an action the way a script does, and an
  // unqualified name resolves against the first enabled map that defines it.
  const names = useMemo(() => {
    const seen = new Set<string>()
    for (const map of inputMap.maps)
      for (const action of map.actions) seen.add(action.name)
    return [...seen]
  }, [inputMap])

  const missing = value !== '' && !names.includes(value)

  return (
    <Select
      className={cn(missing && 'text-danger', className)}
      value={value}
      disabled={disabled}
      title={missing ? `"${value}" is not an action in this project` : title}
      onChange={e => onChange(e.target.value)}
    >
      {allowNone && <option value=''>— none —</option>}
      {missing && <option value={value}>{value} — missing</option>}
      {names.map(name => <option key={name} value={name}>{name}</option>)}
    </Select>
  )
}
