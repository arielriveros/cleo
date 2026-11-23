import {
  Logger, encodeWaterBake, forgetWaterBakeContext, newWaterBakeId, prepareGroupBake, waterBakeGroup, waterGroupSignature,
  type WaterBakeReport, type WaterVolumeNode,
} from 'cleo'
import { startTask } from '@cleo/app-kit/feedback/progressStore'
import { saveGiBake } from '../../utils/giBakeStore'
import { runWaterBake, type WaterBakeRun } from '../../workers/waterBakeClient'
import { onProjectClose, onProjectUnload } from '../../utils/projectLifecycle'

// The water flow bakes running now. A bake is the shallow-water equations run over a water and everything joined
// to it as one system (water/bake/), in a worker, for up to minutes. It used to live in the Water inspector, and
// selecting another node cancelled it. It is owned here instead: it goes on with the inspector closed, its card in
// the progress popup (app-kit ProgressWindow) is where it is followed and cancelled, and the inspector just shows
// the job of the water it is on. Closing the project cancels it.

export interface WaterBakeJob {
  /** The waters baked together, by id. */
  readonly ids: ReadonlySet<string>
  /** Toward the bake's time limit, 0..1. */
  readonly fraction: number
  /** Seconds of flow simulated so far. */
  readonly seconds: number
  cancel(): void
}

let jobs: readonly WaterBakeJob[] = []
const listeners = new Set<() => void>()

function publish(next: readonly WaterBakeJob[]): void {
  jobs = next
  for (const listener of [...listeners]) listener()
}

/** The jobs as an external store (`useSyncExternalStore`): the list is replaced on every change. */
export const waterBakeJobs = {
  subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  },
  getSnapshot(): readonly WaterBakeJob[] { return jobs },
}

/** The bake running for `node` (baked with others or alone), or null. */
export function waterBakeJobOf(list: readonly WaterBakeJob[], node: WaterVolumeNode): WaterBakeJob | null {
  return list.find(j => j.ids.has(node.id)) ?? null
}

/** How each bake made this session went, by bake id: what the inspector says under the button. */
export const BAKE_REPORTS = new Map<string, WaterBakeReport>()
// Keyed by the closed project's bakes.
onProjectClose(() => BAKE_REPORTS.clear())
// A bake must not land in the next project: stop every one before the open project goes.
onProjectUnload(() => { for (const job of jobs) job.cancel() })

const at = (p: [number, number]) => `${Math.round(p[0])}, ${Math.round(p[1])}`

/** A bake's report in plain words: whether it settled, and what the water did that it was not drawn to do. */
export function reportLines(report: WaterBakeReport, group: readonly WaterVolumeNode[]): { text: string; warn: boolean }[] {
  const lines: { text: string; warn: boolean }[] = []
  const flow = `${report.inflow.toFixed(1)} m³/s in, ${(report.outflow + report.lost).toFixed(1)} out`
  if (report.settled) lines.push({ text: `Settled after ${Math.round(report.seconds)} s of flow (${flow}).`, warn: false })
  else {
    const where = report.fillingAt && report.filling > 0 ? ` Water was still gathering near ${at(report.fillingAt)}: a hollow on its way that is a lake; add one there, or fill it in.` : ''
    lines.push({ text: `Not settled after ${Math.round(report.seconds)} s of flow (${flow}).${where}`, warn: true })
  }
  if (report.lost > 0.02 * Math.max(report.inflow, 1e-6)) {
    const share = Math.round(100 * report.lost / Math.max(report.inflow, 1e-6))
    lines.push({
      text: `${Math.min(100, share)}% of the water left the course it was drawn on${report.lostAt ? `, most near ${at(report.lostAt)}` : ''}: the ground has no channel for it there. Carve one, or draw the river where the ground runs.`,
      warn: true,
    })
  }
  const met = report.obstacles
  if (met && met.count > 0) {
    const them = met.count === 1 ? 'it' : 'them'
    let text = `Flowed round ${met.count} static collider${met.count === 1 ? '' : 's'} standing in the water.`
    if (met.narrow > 0) text += ` ${met.narrow === met.count ? (met.count === 1 ? 'It is' : 'They are') : `${met.narrow} of ${them} ${met.narrow === 1 ? 'is' : 'are'}`} narrower than two cells at this resolution: the water is held back by ${met.narrow === 1 ? 'its' : 'their'} drag, but not seen to part round ${met.narrow === 1 ? 'it' : 'them'}. Raise the resolution to see that.`
    lines.push({ text, warn: false })
  }
  for (const l of report.levels) {
    if (Math.abs(l.level - l.drawn) < 0.05) continue
    const name = group.find(n => n.id === l.id)?.name ?? 'A lake'
    lines.push({ text: `${name} stands at ${l.level.toFixed(2)} m, not the ${l.drawn.toFixed(2)} m it was drawn at: that is where its outlet lets it.`, warn: false })
  }
  return lines
}

/** How often a running bake's progress reaches the store and its card. */
const PROGRESS_MS = 250

/**
 * Bake `node` and every water joined to it at `maxRes` cells along the longest side. `changed` is called when the
 * waters' bakes change (the scene is dirty). Does nothing while one of them is baking already.
 */
export function startWaterBake(node: WaterVolumeNode, maxRes: number, changed: () => void): void {
  // This water, or one joined to it, may be baking already (started from its own inspector).
  const joined = waterBakeGroup(node)
  if (jobs.some(j => j.ids.has(node.id) || joined.some(n => j.ids.has(n.id)))) return
  let prepared
  try { prepared = prepareGroupBake(node, { maxRes }) }
  catch (e) { Logger.warn(`Water "${node.name}": ${String((e as Error).message ?? e)}`, 'Water'); return }
  if (!prepared.group.length) return
  // Signed with what it is baked from, read now.
  forgetWaterBakeContext()
  const signature = waterGroupSignature(node)
  const names = prepared.group.map(n => n.name).join(', ')

  let cancelled = false
  let lastShown = 0
  // Made before the run: without a worker the bake runs here, and reports its first progress before
  // `runWaterBake` has even returned.
  let run: WaterBakeRun | null = null
  let job: WaterBakeJob = {
    ids: new Set(prepared.group.map(n => n.id)),
    fraction: 0,
    seconds: 0,
    cancel: () => { cancelled = true; run?.cancel() },
  }
  publish([...jobs, job])
  const task = startTask({
    title: `Baking water flow — ${names}`,
    steps: [{ name: names, status: 'running', detail: 'Starting', progress: 0 }],
    cancellable: true,
    onCancel: () => job.cancel(),
  })
  const progress = (fraction: number, seconds: number) => {
    const now = performance.now()
    if (now - lastShown < PROGRESS_MS) return
    lastShown = now
    const next: WaterBakeJob = { ...job, fraction, seconds }
    publish(jobs.map(j => (j === job ? next : j)))
    job = next
    task.setStep(0, { progress: fraction, detail: `${Math.round(seconds)} s of flow simulated` })
  }
  run = runWaterBake(prepared.setup, progress)
  const result = run.result

  void (async () => {
    let output = null
    let failure: string | null = null
    try { output = await result }
    catch (e) {
      failure = String((e as Error).message ?? e)
      Logger.warn(`Water "${node.name}" bake failed: ${failure}`, 'Water')
      task.setStep(0, { status: 'failed', error: failure })
    }
    try {
      if (failure !== null) { /* said above */ }
      else if (output && !cancelled) {
        for (const m of output.members) {
          const n = prepared.group.find(g => g.id === m.id)
          if (!n) continue
          const bakeId = newWaterBakeId()
          m.info.source = bakeId
          await saveGiBake(bakeId, encodeWaterBake(m.info, signature), n.bakeId)
          n.bakeId = bakeId
          BAKE_REPORTS.set(bakeId, output.report)
        }
        const lines = reportLines(output.report, prepared.group)
        const say = lines.some(l => l.warn) ? Logger.warn : Logger.info
        say.call(Logger, `Water baked (${names}): ${prepared.setup.nx} x ${prepared.setup.nz} cells. ${lines.map(l => l.text).join(' ')}`, 'Water')
        task.setStep(0, { status: 'done', progress: 1, detail: lines[0]?.text ?? 'Baked' })
        changed()
      } else {
        task.setStep(0, { status: 'skipped', detail: 'Cancelled: every water keeps what it drew before' })
      }
    } catch (e) {
      const message = String((e as Error).message ?? e)
      Logger.warn(`Water "${node.name}": the bake could not be saved: ${message}`, 'Water')
      task.setStep(0, { status: 'failed', error: message })
    } finally {
      task.finish()
      publish(jobs.filter(j => j !== job))
    }
  })()
}
