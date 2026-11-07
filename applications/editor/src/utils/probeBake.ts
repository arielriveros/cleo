import { useEffect, useState } from 'react'
import { CleoEngine, Logger, describeLightChanges, probeBakeStaleness, type LightNode, type LightProbeNode, type Scene, type StaleProbe } from 'cleo'
import { useEventBus } from '../features/EventBusContext'

/**
 * Whether the scene's light probes are out of date with its lights: a light set to bake (LightNode.bake)
 * moved, turned, recoloured, dimmed... after the probes were captured (probeBakeState.ts). Shown in the
 * Asset Explorer's toolbar, on the light's and the probe's inspector cards, and as one console row.
 *
 * AUTHORING ONLY: in Play and Simulate the scene is a throwaway copy, and a script moving a light is the
 * game running, not a bake going stale. Re-read on SCENE_CHANGED and on a slow poll, because a bake lands
 * on a render frame (time-sliced over several), not on an editor event.
 */
export interface ProbeBakeStatus {
  stale: StaleProbe[]
  /** The stale probes that baked `light`. */
  probesOf: (light: LightNode) => StaleProbe[]
  /** The entry for one probe, or null when it is current. */
  of: (probe: LightProbeNode) => StaleProbe | null
}

const EMPTY: ProbeBakeStatus = { stale: [], probesOf: () => [], of: () => null }

function readStatus(scene: Scene | null): ProbeBakeStatus {
  if (!scene || !CleoEngine.authoringMode) return EMPTY
  // The probe being baked right now is about to match; it is not out of date.
  const busy = CleoEngine.instance?.renderer?.probeBakeProgress?.probe ?? null
  const stale = probeBakeStaleness([...scene.lightProbes].filter(p => p !== busy), scene.lights)
  if (stale.length === 0) return EMPTY
  return {
    stale,
    probesOf: (light) => stale.filter(s => s.lights.some(l => l.id === light.id)),
    of: (probe) => stale.find(s => s.probe === probe) ?? null,
  }
}

/** The stale-bake status of `scene`, kept current. */
export function useProbeBakeStatus(scene: Scene | null): ProbeBakeStatus {
  const eventEmitter = useEventBus()
  const [status, setStatus] = useState<ProbeBakeStatus>(() => readStatus(scene))
  useEffect(() => {
    let last = ''
    const refresh = () => {
      const next = readStatus(scene)
      // Only a real change re-renders: the poll runs every second whether anything moved or not.
      const key = next.stale.map(s => `${s.probe.id}:${s.lights.map(l => `${l.id}=${l.what.join('+')}`).join(',')}`).join('|')
      if (key === last) return
      last = key
      setStatus(next)
    }
    refresh()
    eventEmitter.on('SCENE_CHANGED', refresh)
    const id = window.setInterval(refresh, 1000)
    return () => { eventEmitter.off('SCENE_CHANGED', refresh); window.clearInterval(id) }
  }, [eventEmitter, scene])
  return status
}

/**
 * Bring the stale probes up to date: a RELIGHT, since only lights changed — each probe's captured scene is
 * lit again, a few frames each, no geometry redrawn (a probe never captured is baked instead).
 */
export function rebakeStale(stale: readonly StaleProbe[]): void {
  for (const s of stale) s.probe.relight()
}

/** One line for a light's inspector card: what it did and how many probes are out of date for it. */
export function lightBakeWarning(light: LightNode, probes: readonly StaleProbe[]): string | null {
  if (probes.length === 0) return null
  const what = probes[0].lights.find(l => l.id === light.id)?.what ?? []
  const n = probes.length
  return `${capitalise(describeLightChanges(what) || 'changed')} since the light probes were baked: ${n} probe${n === 1 ? ' is' : 's are'} out of date.`
}

/** One line for a probe's inspector card: which lights changed since its bake. */
export function probeBakeWarning(entry: StaleProbe | null): string | null {
  if (!entry) return null
  const parts = entry.lights.slice(0, 3).map(l => `${l.name || 'a deleted light'} ${describeLightChanges(l.what)}`)
  const more = entry.lights.length > 3 ? `, and ${entry.lights.length - 3} more` : ''
  return `Out of date: ${parts.join(', ')}${more}.`
}

function capitalise(s: string): string { return s ? s[0].toUpperCase() + s.slice(1) : s }

/**
 * One console row for the whole scene (a flush key, so it is rewritten in place rather than repeated), put
 * there when the set of stale probes changes, and cleared when none is.
 */
export function useProbeBakeConsole(status: ProbeBakeStatus): void {
  useEffect(() => {
    const n = status.stale.length
    if (n === 0) return
    const lights = new Set(status.stale.flatMap(s => s.lights.map(l => l.name || 'a deleted light')))
    Logger.warn(`${n} light probe${n === 1 ? ' is' : 's are'} out of date: ${[...lights].slice(0, 4).join(', ')}${lights.size > 4 ? '…' : ''} changed since the bake. Re-bake them from the Assets toolbar or a probe's inspector.`,
                'Lighting', { flush: 'probe-bake' })
  }, [status])
}
