import type { WorkRow } from './delayedTask'

// The rows of the cards for the bakes the engine runs on its own render frames, read from what it publishes:
// the GI volumes' capture (Renderer.gi.describe()) and the light probe job in flight (Renderer.probeBakeProgress).
// Pure, for the tests.

/** One GI volume as `GiSystem.describe()` gives it. */
export interface GiVolumeState { id: string; name: string; probes: number; captured: number }

/** The volumes still capturing: every probe of each has to be drawn once before it lights anything right. */
export function giRows(volumes: readonly GiVolumeState[]): WorkRow[] {
  return volumes
    .filter(v => v.probes > 0 && v.captured < v.probes)
    .map(v => ({
      key: `gi:${v.id}`,
      name: v.name || 'GI Volume',
      detail: `${v.captured} of ${v.probes} probes`,
      progress: v.captured / v.probes,
    }))
}

/** The light probe job in flight, as `Renderer.probeBakeProgress` gives it. */
export interface ProbeJobState { probe: { id: string; name: string }; kind: 'bake' | 'relight' | 'filter'; fraction: number }

const PROBE_WORK: Record<ProbeJobState['kind'], string> = {
  bake: 'Capturing the scene',
  relight: 'Relighting',
  filter: 'Filtering the reflections',
}

/** The probe being baked now, or nothing. One job runs at a time: the others are queued behind it. */
export function probeRows(job: ProbeJobState | null): WorkRow[] {
  if (!job) return []
  return [{
    key: `probe:${job.probe.id}`,
    name: job.probe.name || 'Light Probe',
    detail: PROBE_WORK[job.kind],
    progress: job.fraction,
  }]
}
