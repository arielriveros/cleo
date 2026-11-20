// The project's WebGPU pipelines, built ahead of use from what the editor built for it in its last sessions.
//
// On WebGPU a pipeline's shader compiles when the pipeline is made, and on Windows the big PBR, water and GI
// programs take seconds each (Chromium's D3D12 backend compiles them with FXC, and caches none of it across
// runs). A draw that finds its pipeline missing has it built off the main thread and waits for it
// (PipelineCache.getOrDefer): the object shows up late instead of the window freezing. Warming the recipes the
// project needed last time, as it opens (Renderer.warmPipelines, off the main thread too), has them ready by
// the time the camera turns to them. A no-op on WebGL2, which links every program at boot.
//
// Per machine and per project: the recipes name this machine's target formats, so localStorage, under the
// project's own prefix (projectScope.ts), which goes with the project when it is deleted.

import { scoped } from './projectScope'

const KEY = 'cleo_pipeline_recipes'
/** The most recipes kept for a project: a large one records a few hundred; any more is noise from old sessions. */
export const MAX_RECIPES = 600

interface RecipeSource { pipelineRecipes(): unknown[] }
interface Warmer { warmPipelines(onProgress?: (done: number, total: number) => void, recipes?: unknown): Promise<number> }

function read(): unknown[] {
  try {
    const raw = JSON.parse(localStorage.getItem(scoped(KEY)) ?? 'null')
    return Array.isArray(raw) ? raw : []
  } catch {
    return []
  }
}

/**
 * `stored` and this session's `recorded`, one of each recipe (the same JSON), the newest kept when over
 * `max`: this session's first, then the stored ones it did not build again. Pure, for the tests.
 */
export function mergeRecipes(stored: readonly unknown[], recorded: readonly unknown[], max: number = MAX_RECIPES): unknown[] {
  const seen = new Set<string>()
  const out: unknown[] = []
  for (const r of [...recorded, ...stored]) {
    const key = JSON.stringify(r)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
    if (out.length >= max) break
  }
  return out
}

/** Remember this session's pipelines for the open project, with what earlier sessions recorded. */
export function savePipelineRecipes(renderer: RecipeSource | null | undefined): void {
  if (!renderer) return
  try {
    const recorded = renderer.pipelineRecipes()
    if (!recorded.length) return
    const merged = mergeRecipes(read(), recorded)
    localStorage.setItem(scoped(KEY), JSON.stringify(merged))
  } catch { /* no storage, or no project open: the next session builds them as it draws */ }
}

/** Build the open project's remembered pipelines in the background. Resolves with how many were built. */
export function warmProjectPipelines(renderer: Warmer | null | undefined): Promise<number> {
  if (!renderer) return Promise.resolve(0)
  let recipes: unknown[]
  try { recipes = read() } catch { return Promise.resolve(0) }
  if (!recipes.length) return Promise.resolve(0)
  return renderer.warmPipelines(undefined, recipes).catch(() => 0)
}
