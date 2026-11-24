// Every shader the open scene can draw with, built before the editor shows it: the loading screen of a project
// (or of a scene opened in it) holds on this step until the renderer has nothing left to compile for the scene
// (Renderer.prepareShaders). Custom materials included, and every camera's screen materials, which nothing
// looks through until Play.
//
// Why: on WebGPU a pipeline's shader compiles when the pipeline is made, and Chromium's D3D12 backend compiles
// the big ones with FXC for seconds each (the Sketch project's pencil screen material took 45 s). Built while
// the project was already open, a material popped in late, and the game camera's effect arrived well into Play.

import { CustomMaterial, type Scene } from 'cleo'
import type { LoadStepHandle } from '@cleo/app-kit/feedback/loadingStore'
import { ensureWgslTranslator } from '@cleo/app-kit/engine/wgslTranslator'

/** What this module needs of the renderer. */
export interface ShaderPreparer {
  readonly backend: string
  prepareShaders(scene: Scene, options: {
    onProgress?: (done: number, total: number) => void
    signal?: AbortSignal
  }): Promise<{ built: number; remaining: number; timedOut: boolean; seconds: number }>
}

/** Whether `scene` draws with a custom material anywhere: a model, a landscape, or any camera's screen materials. */
export function sceneHasCustomMaterials(scene: Scene): boolean {
  for (const node of scene.modelsExceptTerrain)
    if (node.model?.materials?.some(m => m instanceof CustomMaterial)) return true
  for (const landscape of scene.landscapes)
    if (landscape.terrain?.material instanceof CustomMaterial) return true
  for (const camera of scene.cameras)
    if (camera.screenMaterials.some(m => m instanceof CustomMaterial)) return true
  return false
}

/**
 * On WebGPU a custom material draws through WGSL translated from its GLSL by naga, which the editor otherwise
 * loads only with the material inspector; the translation saved with the material goes stale with any engine
 * change to its prelude. Load the translator before the scene first draws when the scene has custom materials,
 * or they draw nothing (or the magenta fallback) until the inspector is opened.
 */
export async function ensureTranslatorFor(renderer: { readonly backend: string } | null | undefined, scene: Scene): Promise<void> {
  if (renderer?.backend === 'webgpu' && sceneHasCustomMaterials(scene)) await ensureWgslTranslator()
}

/** Shaders a step has already counted before the scene's: the engine's own programs, at startup. */
export interface CountedShaders { readonly done: number; readonly total: number }

/**
 * The startup's shaders step while the engine's own programs build: their count, with one more to come (the
 * scene's shaders, counted once they are known), so the step reads as under way, not finished, through the
 * loading between the two.
 */
export function engineShaderProgress(step: LoadStepHandle, done: number, total: number): CountedShaders {
  step.progress(Math.min(done, total), total + 1)
  return { done: Math.min(done, total), total }
}

/**
 * Report `renderer.prepareShaders(scene)` as `step`: its count while it runs, then what it built. Settles the step
 * whatever happens (an error fails it), so the loading screen never waits on it forever. `already`: what the step
 * counted before (the engine's programs, when it is the startup's one shaders step), carried in its count.
 */
export async function prepareSceneShaders(renderer: ShaderPreparer | null | undefined, scene: Scene,
                                          step: LoadStepHandle, signal?: AbortSignal,
                                          already: CountedShaders = { done: 0, total: 0 }): Promise<void> {
  if (!renderer) { step.skip('no renderer'); return }
  step.start()
  try {
    await ensureTranslatorFor(renderer, scene)
    const started = performance.now()
    let shown = ''
    const report = await renderer.prepareShaders(scene, {
      signal,
      onProgress: (done, total) => {
        if (total <= 0) return
        // The renderer reports every frame; the screen redraws on a change, and once a second while a long
        // build keeps the count still: one shader can take a minute, and the step must read as alive (it is
        // also what keeps the loading screen's watchdog from closing on it).
        const seconds = Math.floor((performance.now() - started) / 1000)
        const left = total - done
        const detail = left > 0 && seconds >= 3 ? `${left} building · ${seconds} s` : ''
        const key = `${done}/${total}/${detail}`
        if (key === shown) return
        shown = key
        step.progress(already.done + Math.min(done, total), already.total + total, detail)
      },
    })
    if (signal?.aborted) { step.skip('closed'); return }
    const built = already.done + report.built
    if (report.timedOut) step.done(`${report.remaining} still building`)
    else step.done(built ? `${built} built` : 'up to date')
  } catch (e) {
    step.fail(String((e as Error)?.message ?? e))
  }
}
