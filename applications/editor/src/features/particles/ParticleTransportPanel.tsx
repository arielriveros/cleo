import { useEffect, useState } from 'react'
import { activeModule, maxLifetime, type Burst } from 'cleo'
import { Button, Hint, NumberInput, Select, Slider, cn } from '../../components/ui'
import { useParticleEditor } from './ParticleEditorContext'

// The particle preview's transport: play state, speed, a one-shot burst, and a per-emitter timeline of
// where each emitter is in its cycle, with its bursts marked. Reads the preview node's CPU clock — the GPU
// is never read back, so the counts here are capacity and spawn figures, not a live particle count.

/** Re-render at ~15 Hz while mounted, to follow the clock. */
function useTicker(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick(t => t + 1), 66)
    return () => window.clearInterval(id)
  }, [])
  return tick
}

export default function ParticleTransportPanel() {
  const { system, previewNode, emitterId, selectEmitter } = useParticleEditor()
  useTicker()
  const [burst, setBurst] = useState(50)
  const node = previewNode()

  if (!system || !node) return <div className='p-3 text-ui text-muted'>Open a particle system to preview it.</div>

  const runtime = node.runtime
  const capacity = runtime.emitters.reduce((sum, e) => sum + e.capacity, 0)

  return (
    <div className='flex h-full flex-col gap-2 overflow-auto p-2'>
      <div className='flex flex-wrap items-center gap-1'>
        <Button size='sm' variant='subtle' onClick={() => node.restart()} title='Clear and play from the start'>⟲ Restart</Button>
        {node.isPlaying
          ? <Button size='sm' variant='subtle' onClick={() => node.pause()} title='Freeze the simulation'>❚❚ Pause</Button>
          : <Button size='sm' variant='subtle' onClick={() => { node.resume(); node.play() }} title='Resume'>▶ Play</Button>}
        <Button size='sm' variant='subtle' onClick={() => node.stop()} title='Stop emitting; live particles finish their lives'>■ Stop</Button>
        <Button size='sm' variant='subtle' onClick={() => node.stop(true)} title='Remove every particle'>✕ Clear</Button>
        <span className='mx-2 h-4 w-px bg-border' />
        <div className='w-16'><NumberInput value={burst} min={1} step={10} onChange={v => setBurst(Math.max(1, Math.round(v)))} /></div>
        <Button size='sm' variant='subtle' onClick={() => node.burst(burst)} title='Emit this many from every emitter, once'>Burst</Button>
        <span className='mx-2 h-4 w-px bg-border' />
        <div className='w-48'>
          <Slider label='Speed' min={0} max={2} step={0.05} value={node.simulationSpeed}
                  onChange={v => { node.simulationSpeed = v }} />
        </div>
        <span className='mx-2 h-4 w-px bg-border' />
        {/* Pin a LOD level to judge it without moving the camera; Auto follows the distance. */}
        <label className='flex items-center gap-1 text-ui-sm text-dim'
               title={'Preview a LOD level. Auto: by the camera\'s distance to the bounds' + (node.forcedLod < 0 ? ` (now ${node.lodDistance.toFixed(1)} m)` : '') + '.'}>
          LOD
          <Select className='w-40' value={String(node.forcedLod)} onChange={e => { node.forcedLod = Number(e.target.value) }}>
            <option value='-1'>Auto ({node.lod.culled ? 'culled' : `level ${node.lod.level}`})</option>
            {Array.from({ length: (system.lod?.levels.length ?? 0) + 1 }, (_, i) => (
              <option key={i} value={String(i)}>Level {i}{i === 0 ? ' (full)' : ''}</option>
            ))}
          </Select>
        </label>
        <span className='flex-1' />
        <Hint className='mt-0'>{runtime.emitters.length} emitter{runtime.emitters.length === 1 ? '' : 's'} · {capacity.toLocaleString()} slots</Hint>
      </div>

      <div className='flex flex-col gap-1'>
        {runtime.emitters.map(emitter => {
          const def = emitter.def
          const cycle = def.duration
          const t = Math.max(0, emitter.time - def.startDelay)
          const inCycle = def.looping ? t % cycle : Math.min(t, cycle)
          const bursts = (activeModule(def, 'spawnBurst')?.params.bursts ?? []) as Burst[]
          const markers: number[] = []
          for (const b of bursts)
            for (let k = 0; b.cycles === 0 || k < b.cycles; k++) {
              const at = b.time + k * Math.max(0.01, b.interval)
              if (at >= cycle || markers.length > 200) break
              markers.push(at)
            }
          return (
            <div key={def.id}
                 className={cn('flex items-center gap-2 rounded px-1 py-0.5 cursor-pointer', def.id === emitterId ? 'bg-selected' : 'hover:bg-control')}
                 onClick={() => selectEmitter(def.id)}>
              <span className='w-28 truncate text-ui text-fg'>{def.name}</span>
              <div className='relative h-3 flex-1 rounded bg-control'>
                <div className='absolute inset-y-0 left-0 rounded bg-primary/40' style={{ width: `${(inCycle / cycle) * 100}%` }} />
                {markers.map((m, i) => (
                  <div key={i} className='absolute inset-y-0 w-0.5 bg-highlight' style={{ left: `${(m / cycle) * 100}%` }} title={`Burst at ${m.toFixed(2)} s`} />
                ))}
              </div>
              <span className='w-36 text-right text-ui-sm tabular-nums text-muted'>
                {inCycle.toFixed(2)} / {cycle.toFixed(2)} s · {emitter.state === 'playing' ? (def.looping ? 'looping' : 'playing') : emitter.isAlive ? 'finishing' : 'idle'}
              </span>
              <span className='w-24 text-right text-ui-sm tabular-nums text-dim' title='Pool capacity · longest lifetime'>
                {emitter.capacity.toLocaleString()} · {maxLifetime(def).toFixed(1)} s
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
