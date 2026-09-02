import { useState } from 'react'
import {
  COMPOSITE_PARTS, DEVICE_KINDS, GAMEPAD_AXES, GAMEPAD_BUTTONS, KEY_CODES, MAX_GAMEPAD_PLAYERS,
  MOUSE_BUTTONS, POINTER_AXES, STATE_FLAGS, TOUCH_GESTURES, sourceKey, sourceLabel,
} from 'cleo'
import type {
  ActionKind, BindingSource, CompositePart, DeviceKind, InputBinding, ModifierSource, Processor,
  ProcessorKind, VirtualControl,
} from 'cleo'
import { Button, Select, hintClass, labelClass } from '../../components/ui'
import ProcessorList from './ProcessorList'
import type { RebindCapture } from './useRebindCapture'

/**
 * One binding: which physical input feeds the action, which slot of a composite it drives, what has to
 * be held for it to count, and how its reading is shaped.
 *
 * The device dropdown and the **Listen** button are two routes to the same field, and both are needed.
 * Listening is how anyone actually rebinds a key — nobody knows they want `IntlBackslash` — while the
 * dropdown is the only way to reach a source you cannot press right now: a gamepad button with no pad
 * plugged in, a touch gesture on a desktop, or Escape (which Listen treats as "cancel").
 */

const DEVICE_LABELS: Record<DeviceKind, string> = {
  key: 'Keyboard',
  mouse: 'Mouse button',
  pointer: 'Mouse axis',
  gamepad: 'Gamepad button',
  gamepadAxis: 'Gamepad axis',
  touch: 'Touch gesture',
  virtual: 'On-screen control',
}

/** Which composite parts an action of this kind can actually use. See `setActionKind`. */
function partsFor(kind: ActionKind): readonly CompositePart[] {
  if (kind === 'axis') return ['positive', 'negative']
  if (kind === 'vector') return COMPOSITE_PARTS.filter(p => p !== 'positive' && p !== 'negative')
  return []
}

/** A source of `device` with every other field at a sensible starting value. */
function defaultSourceFor(device: DeviceKind, controls: readonly VirtualControl[]): BindingSource {
  switch (device) {
    case 'key': return { device: 'key', code: 'KeyF' }
    case 'mouse': return { device: 'mouse', button: 'left' }
    case 'pointer': return { device: 'pointer', axis: 'deltaX' }
    case 'gamepad': return { device: 'gamepad', button: 'a' }
    case 'gamepadAxis': return { device: 'gamepadAxis', axis: 'leftStickX' }
    case 'touch': return { device: 'touch', gesture: 'tap' }
    case 'virtual': return { device: 'virtual', control: controls[0]?.id ?? 'moveStick' }
  }
}

interface Props {
  binding: InputBinding
  actionKind: ActionKind
  virtualControls: readonly VirtualControl[]
  /** `Map/Action` names this binding's source is ALSO bound in. Reported, never prevented. */
  conflicts: readonly string[]
  capture: RebindCapture
  onSource(source: BindingSource): void
  onPart(part: CompositePart | null): void
  onModifiers(modifiers: ModifierSource[]): void
  onAddProcessor(kind: ProcessorKind): void
  onRemoveProcessor(index: number): void
  onUpdateProcessor(index: number, processor: Processor): void
  onMoveProcessor(index: number, delta: number): void
  onRemove(): void
}

export default function BindingRow(props: Props) {
  const { binding, actionKind, virtualControls, conflicts, capture } = props
  const [expanded, setExpanded] = useState(false)
  const listening = capture.listeningFor === binding.id
  const parts = partsFor(actionKind)

  const listen = async () => {
    const source = await capture.start(binding.id)
    if (source) props.onSource(source)
  }

  return (
    <div className='rounded border border-border bg-control/30 p-1.5 flex flex-col gap-1'>
      <div className='flex items-center gap-1'>
        <Select
          className='w-[120px]'
          value={binding.source.device}
          onChange={e => props.onSource(defaultSourceFor(e.target.value as DeviceKind, virtualControls))}
          title='Which device this binding reads from'
        >
          {DEVICE_KINDS.map(d => <option key={d} value={d}>{DEVICE_LABELS[d]}</option>)}
        </Select>

        <SourceValue source={binding.source} virtualControls={virtualControls} onChange={props.onSource} />

        <Button size='sm' variant={listening ? 'primary' : 'ghost'} onClick={listening ? capture.cancel : listen}
          title='Press any key, button or stick to bind it. Escape cancels.'>
          {listening ? 'Press…' : 'Listen'}
        </Button>

        <div className='ml-auto flex items-center gap-0.5'>
          <Button size='sm' variant='ghost' active={expanded} onClick={() => setExpanded(v => !v)}
            title='Modifiers and processors'>⋯</Button>
          <Button size='sm' variant='ghost' onClick={props.onRemove} title='Remove this binding'>✕</Button>
        </div>
      </div>

      {parts.length > 0 && (
        <div className='flex items-center gap-1'>
          <label className={labelClass}>drives</label>
          <Select
            className='w-[110px]'
            value={binding.part ?? ''}
            onChange={e => props.onPart((e.target.value || null) as CompositePart | null)}
            title='Which component of the composite this binding contributes to'
          >
            <option value=''>whole value</option>
            {parts.map(p => <option key={p} value={p}>{p}</option>)}
          </Select>
          {!binding.part && (
            <span className={hintClass}>a 2D source (stick, drag) contributes both axes at once</span>
          )}
        </div>
      )}

      {conflicts.length > 0 && (
        // Reported, not blocked: Escape being both Cancel and Pause is deliberate, and so is a shared
        // key under different modifiers. The author is the one who can tell those from a mistake.
        <p className={hintClass}>Also bound in {conflicts.join(', ')}</p>
      )}

      {expanded && (
        <div className='pl-1 border-l border-border flex flex-col gap-2 mt-1'>
          <div>
            <p className={labelClass}>Only while held</p>
            <ModifierList modifiers={binding.modifiers ?? []} onChange={props.onModifiers} />
            <p className={hintClass}>
              All of these must be held. A plain binding on the same input stands down while a modified
              one is active — so Ctrl+S does not also fire S.
            </p>
          </div>
          <div>
            <p className={labelClass}>Processors</p>
            <ProcessorList
              chain={binding.processors ?? []}
              onAdd={props.onAddProcessor}
              onRemove={props.onRemoveProcessor}
              onUpdate={props.onUpdateProcessor}
              onMove={props.onMoveProcessor}
            />
          </div>
        </div>
      )}
    </div>
  )
}

/** The device-specific half of a source: which key, which button, which axis. */
function SourceValue(
  { source, virtualControls, onChange }:
  { source: BindingSource; virtualControls: readonly VirtualControl[]; onChange(s: BindingSource): void },
) {
  switch (source.device) {
    case 'key':
      return (
        <Select className='flex-1 min-w-0' value={source.code}
          onChange={e => onChange({ device: 'key', code: e.target.value })}>
          {/* A code the picker does not list is still perfectly bindable — it just arrives by Listen
              rather than from here — so an unlisted one is shown as its own option instead of
              silently snapping the dropdown to something else. */}
          {!(KEY_CODES as readonly string[]).includes(source.code) && (
            <option value={source.code}>{source.code}</option>
          )}
          {KEY_CODES.map(code => <option key={code} value={code}>{sourceLabel({ device: 'key', code })}</option>)}
        </Select>
      )
    case 'mouse':
      return (
        <Select className='flex-1 min-w-0' value={source.button}
          onChange={e => onChange({ device: 'mouse', button: e.target.value as typeof MOUSE_BUTTONS[number] })}>
          {MOUSE_BUTTONS.map(b => <option key={b} value={b}>{b}</option>)}
        </Select>
      )
    case 'pointer':
      return (
        <Select className='flex-1 min-w-0' value={source.axis}
          onChange={e => onChange({ device: 'pointer', axis: e.target.value as typeof POINTER_AXES[number] })}>
          {POINTER_AXES.map(a => <option key={a} value={a}>{a}</option>)}
        </Select>
      )
    case 'gamepad':
      return (
        <>
          <Select className='flex-1 min-w-0' value={source.button}
            onChange={e => onChange({ ...source, button: e.target.value as typeof GAMEPAD_BUTTONS[number] })}>
            {GAMEPAD_BUTTONS.map(b => (
              <option key={b} value={b}>{sourceLabel({ device: 'gamepad', button: b })}</option>
            ))}
          </Select>
          <PlayerSelect player={source.player} onChange={player => onChange({ ...source, player })} />
        </>
      )
    case 'gamepadAxis':
      return (
        <>
          <Select className='flex-1 min-w-0' value={source.axis}
            onChange={e => onChange({ ...source, axis: e.target.value as typeof GAMEPAD_AXES[number] })}>
            {GAMEPAD_AXES.map(a => <option key={a} value={a}>{a}</option>)}
          </Select>
          <PlayerSelect player={source.player} onChange={player => onChange({ ...source, player })} />
        </>
      )
    case 'touch':
      return (
        <Select className='flex-1 min-w-0' value={source.gesture}
          onChange={e => onChange({ ...source, gesture: e.target.value as typeof TOUCH_GESTURES[number] })}>
          {TOUCH_GESTURES.map(g => <option key={g} value={g}>{g}</option>)}
        </Select>
      )
    case 'virtual':
      return (
        <Select className='flex-1 min-w-0' value={source.control}
          onChange={e => onChange({ ...source, control: e.target.value })}>
          {virtualControls.length === 0 && <option value={source.control}>{source.control} (missing)</option>}
          {virtualControls.map(c => <option key={c.id} value={c.id}>{c.id}</option>)}
        </Select>
      )
  }
}

/** "Any pad" versus a fixed slot. Omitted means whichever pad is pushing hardest — right for one player. */
function PlayerSelect({ player, onChange }: { player?: number; onChange(p: number | undefined): void }) {
  return (
    <Select
      className='w-[86px]'
      value={player === undefined ? '' : String(player)}
      onChange={e => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
      title='Which local player this pad binding belongs to'
    >
      <option value=''>Any pad</option>
      {Array.from({ length: MAX_GAMEPAD_PLAYERS }, (_, i) => (
        <option key={i} value={i}>P{i + 1}</option>
      ))}
    </Select>
  )
}

/** The held-state gates on a binding. Only devices with an unambiguous on/off reading may gate. */
function ModifierList(
  { modifiers, onChange }: { modifiers: readonly ModifierSource[]; onChange(m: ModifierSource[]): void },
) {
  const options: { key: string; label: string; source: ModifierSource }[] = [
    ...(['ControlLeft', 'ShiftLeft', 'AltLeft', 'MetaLeft'] as const)
      .map(code => ({ key: `key:${code}`, label: sourceLabel({ device: 'key', code }), source: { device: 'key', code } as ModifierSource })),
    ...MOUSE_BUTTONS.map(button => ({
      key: `mouse:${button}`, label: `${button} mouse`, source: { device: 'mouse', button } as ModifierSource,
    })),
    ...STATE_FLAGS.map(flag => ({
      key: `state:${flag}`, label: sourceLabel({ device: 'state', flag }), source: { device: 'state', flag } as ModifierSource,
    })),
  ]
  const active = new Set(modifiers.map(sourceKey))

  return (
    <div className='flex flex-wrap gap-1 mt-1'>
      {options.map(option => {
        const on = active.has(sourceKey(option.source))
        return (
          <Button
            key={option.key}
            size='sm'
            variant='ghost'
            active={on}
            onClick={() => onChange(on
              ? modifiers.filter(m => sourceKey(m) !== sourceKey(option.source))
              : [...modifiers, option.source])}
          >
            {option.label}
          </Button>
        )
      })}
    </div>
  )
}
