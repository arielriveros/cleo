import { useEffect, useRef, useState } from 'react'
import type { Animator } from 'cleo'

// Every link in the chain from a machine parameter to the pose, sampled live, with the spread each value
// covered over the last second — a settled value reads 0.000, a buzzing one reads its amplitude.
// Shared by the State Machine inspector and the in-Play viewport overlay.

/** How long a value's history is kept, in ms. The window the ± column reports over. */
const WINDOW_MS = 1000
/** Re-render cadence. Sampling stays per-frame; only the DOM is throttled. */
const RENDER_MS = 100

/** `fieldDebug` is a getter, so the property type IS the snapshot type. */
type Snapshot = Animator['fieldDebug']

export default function FieldDebugReadout({ animator }: { animator: Animator }) {
  const [, tick] = useState(0)
  const history = useRef(new Map<string, { v: number; at: number }[]>())
  /** Times the state name changed, newest last. Length over the window IS the ping-pong rate. */
  const flips = useRef<number[]>([])
  /** The last few "from → to" state changes, so a ping-pong names the pair it is bouncing between. */
  const recent = useRef<string[]>([])
  const lastState = useRef<string | null>(null)
  const snap = useRef<Snapshot | null>(null)

  // Sampling runs every frame while the render is throttled separately: a 60Hz state flip is invisible to
  // a 10Hz sampler, and a 60Hz render would cost more than the thing being measured.
  useEffect(() => {
    let raf = 0
    let lastRender = 0
    const loop = () => {
      const now = performance.now()
      const d = animator.fieldDebug
      snap.current = d as Snapshot

      const push = (key: string, v: number) => {
        if (!Number.isFinite(v)) return
        const list = history.current.get(key) ?? []
        list.push({ v, at: now })
        while (list.length && now - list[0].at > WINDOW_MS) list.shift()
        history.current.set(key, list)
      }
      if (d.active) {
        if (d.rawX !== null) push('rx', d.rawX)
        if (d.rawY !== null) push('ry', d.rawY)
        push('tx', d.targetX); push('ty', d.targetY)
        push('px', d.probeX); push('py', d.probeY)
        push('dur', d.duration)
        for (const w of d.weights) push('w:' + w.clipName, w.weight * 100)
      }

      // State ping-pong must be counted per sample, not inferred from `stateTime` at render time: a state
      // that enters and leaves between two renders resets the clock invisibly.
      const name = d.stateName ?? null
      if (name !== lastState.current) {
        if (lastState.current !== null) {
          flips.current.push(now)
          // Record what it flipped BETWEEN, not just how often, so a ping-pong names its pair.
          recent.current.push(`${lastState.current} → ${name ?? '—'}`)
          while (recent.current.length > 4) recent.current.shift()
        }
        lastState.current = name
      }
      while (flips.current.length && now - flips.current[0] > WINDOW_MS) flips.current.shift()

      // Parameters are sampled whether or not a field is active; the field rows vanish when it is not.
      for (const p of d.params) push('p:' + p.name, typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value)

      if (now - lastRender >= RENDER_MS) { lastRender = now; tick(x => x + 1) }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [animator])

  const d = snap.current
  if (!d) return <p className='text-[10px] text-gray-500'>Sampling…</p>

  const spread = (key: string): string => {
    const list = history.current.get(key)
    if (!list || list.length === 0) return '—'
    let lo = Infinity, hi = -Infinity
    for (const e of list) { if (e.v < lo) lo = e.v; if (e.v > hi) hi = e.v }
    return (hi - lo).toFixed(3)
  }

  const Row = ({ label, value, k, hint }: { label: string; value: number | null; k: string; hint: string }) => (
    <div className='flex items-center gap-2 text-[10px] tabular-nums' title={hint}>
      <span className='w-[52px] shrink-0 text-gray-400'>{label}</span>
      <span className='w-[64px] text-right'>{value === null ? 'unbound' : value.toFixed(3)}</span>
      <span className='w-[56px] text-right text-dim'>±{value === null ? '—' : spread(k)}</span>
    </div>
  )

  const flipRate = flips.current.length

  return (
    <div className='flex flex-col gap-0.5'>
      <div className='flex items-center justify-between text-[10px] text-gray-400'>
        <span>value / 1s spread</span>
        <span className='text-dim'>{d.stateName ?? '—'} · {d.stateTime.toFixed(2)}s</span>
      </div>

      {/* The one reading that is a verdict rather than a measurement. A locomotion machine should change state
          when the player does something, so anything above a stray flip or two per second is the machine
          fighting itself — and the fix is `hysteresis` on the condition or `minDwell` on the transition. */}
      <div className={`flex items-center gap-2 text-[10px] tabular-nums ${flipRate > 1 ? 'text-warning' : 'text-dim'}`}
        title={'State changes in the last second. Sustained non-zero means the machine is ping-ponging: two '
          + 'transitions are both satisfied around one threshold. Give the condition a hysteresis band, or the '
          + 'transition a minimum dwell.'}>
        <span className='w-[52px] shrink-0'>flips/s</span>
        <span className='w-[64px] text-right'>{flipRate}</span>
        <span className='w-[56px] text-right'>{flipRate > 1 ? 'ping-pong' : ''}</span>
      </div>

      {/* What it is bouncing BETWEEN. Only worth the space while it is actually bouncing. */}
      {flipRate > 1 && recent.current.length > 0 && (
        <p className='text-[10px] text-warning truncate' title={recent.current.join('\n')}>
          {recent.current[recent.current.length - 1]}
        </p>
      )}

      {/* Shown whether or not a field is active, and that is the point: a machine that keeps LEAVING its
          field state hides every field row below at exactly the moment they would have explained it. The
          parameter that moved is on a transition CONDITION, which is usually none of the axis bindings. */}
      <div className='mt-0.5 border-t border-control pt-0.5'>
        {d.params.map(p => (
          <Row key={p.name} label={p.name} k={'p:' + p.name}
            value={typeof p.value === 'boolean' ? (p.value ? 1 : 0) : p.value}
            hint={`Machine parameter "${p.name}". A spread here on a value used by a transition condition is what a ping-pong is made of.`} />
        ))}
      </div>

      {/* A state that WANTS a field but has none is not the same as a state that plays a clip. The first is a
          fault — the field asset went missing, so the state poses the bind pose — and it is worth saying so
          rather than showing the same grey line either way. */}
      {!d.active && (
        <p className={`text-[10px] mt-0.5 ${d.stateWantsField ? 'text-warning' : 'text-gray-500'}`}>
          {d.stateWantsField
            ? '⚠ This state plays a field, but none is loaded — its asset is missing, so the character holds the bind pose. Re-pick the field on the state and Apply.'
            : 'No animation field in the current state.'}
        </p>
      )}

      {d.active && <>
        <Row label='raw X' value={d.rawX} k='rx' hint='Straight off the machine parameter, before any filtering. Spread here means the noise is upstream — in the script or measurement feeding it.' />
        <Row label='target X' value={d.targetX} k='tx' hint='After the axis deadband. If raw is noisy but this is not, the deadband is absorbing it.' />
        <Row label='probe X' value={d.probeX} k='px' hint='After damping — where the field is actually sampled.' />
        <Row label='raw Y' value={d.rawY} k='ry' hint='As raw X, for the second axis.' />
        <Row label='target Y' value={d.targetY} k='ty' hint='As target X, for the second axis.' />
        <Row label='probe Y' value={d.probeY} k='py' hint='As probe X, for the second axis.' />
        <Row label='cycle' value={d.duration} k='dur' hint='Weighted cycle length in seconds. Moves as the blend shifts; a large spread means the mix is churning.' />
      </>}

      <div className='mt-0.5 border-t border-control pt-0.5'>
        {d.weights.map(w => (
          <div key={w.clipName} className='flex items-center gap-2 text-[10px] tabular-nums'
            title={w.phaseOffset ? `phase offset ${w.phaseOffset.toFixed(2)}` : undefined}>
            <span className={`w-[52px] shrink-0 truncate ${w.clipName === d.dominant ? 'text-highlight' : 'text-gray-400'}`}>
              {w.clipName}
            </span>
            <span className='w-[64px] text-right'>{(w.weight * 100).toFixed(1)}%</span>
            <span className='w-[56px] text-right text-dim'>±{spread('w:' + w.clipName)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
