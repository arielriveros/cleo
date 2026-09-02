import { useEffect, useRef, useState } from 'react'
import { InputSystem } from 'cleo'
import type { ActionState } from 'cleo'
import { hintClass, labelClass } from '../../components/ui'

/**
 * A live readout of what the input system is actually producing, for the selected map.
 *
 * Without this, tuning a deadzone is guesswork: the only feedback is the game's behaviour, and "the
 * character still drifts" does not say whether the stick is at 0.02 or at 0.2. Here the number is on
 * screen while the stick is in your hand.
 *
 * Polls on rAF rather than subscribing to `INPUT_ACTION`, deliberately. That event fires on PHASE
 * changes only, which is exactly right for a handler and useless for a meter: an analog stick sweeping
 * from 0.1 to 0.9 never changes phase, and the number would sit still while the stick moved.
 */
export default function InputMonitor({ mapName }: { mapName: string }) {
  const [rows, setRows] = useState<{ name: string; state: ActionState }[]>([])
  const frame = useRef<number>(0)

  useEffect(() => {
    const tick = () => {
      const system = InputSystem.instance
      const map = [...system.map.maps].find(m => m.name === mapName)
      setRows((map?.actions ?? []).map(a => ({ name: a.name, state: system.state(`${mapName}/${a.name}`) })))
      frame.current = requestAnimationFrame(tick)
    }
    frame.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame.current)
  }, [mapName])

  if (rows.length === 0) return <p className={hintClass}>No actions in this map yet.</p>

  return (
    <div className='flex flex-col gap-0.5 font-mono text-[11px]'>
      {rows.map(({ name, state }) => (
        <div key={name} className='flex items-center gap-2'>
          <span className={`${labelClass} w-24 truncate`} title={name}>{name}</span>
          <Meter value={state.kind === 'vector' ? Math.hypot(...state.vector) : state.value} />
          <span className='w-28 tabular-nums text-muted'>
            {state.kind === 'vector'
              ? `${state.vector[0].toFixed(2)}, ${state.vector[1].toFixed(2)}`
              : state.value.toFixed(3)}
          </span>
          <span className={state.pressed ? 'text-white' : 'text-muted'}>{state.phase}</span>
          {/* Which device won this frame — the same value a HUD would read to swap key prompts for
              pad glyphs, shown here so a binding that never wins is visibly never winning. */}
          <span className='ml-auto text-muted'>{state.device ?? '—'}</span>
        </div>
      ))}
    </div>
  )
}

/** A magnitude bar. Signed values are drawn from the centre, so an axis reads as an axis. */
function Meter({ value }: { value: number }) {
  const magnitude = Math.min(1, Math.abs(value))
  return (
    <span className='relative w-20 h-2 rounded bg-control overflow-hidden shrink-0'>
      <span
        className='absolute top-0 bottom-0 bg-selected'
        style={{
          left: value < 0 ? `${50 - magnitude * 50}%` : '50%',
          width: `${magnitude * 50}%`,
        }}
      />
      <span className='absolute top-0 bottom-0 left-1/2 w-px bg-border' />
    </span>
  )
}
