import { describe, expect, it, vi, beforeEach } from 'vitest'
import { CustomMaterial, type Material, type Scene } from 'cleo'
import type { LoadStepHandle } from '@cleo/app-kit/feedback/loadingStore'

// The loading screen holds on "Compiling shaders" until the renderer has built everything the open scene can draw
// with (Renderer.prepareShaders); at startup that one step counts the engine's own programs first. The step must settle whatever happens, show the count as it
// moves, and the WGSL translator must be loaded first when a custom material needs it on WebGPU.

const translator = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@cleo/app-kit/engine/wgslTranslator', () => ({
  ensureWgslTranslator: async () => { translator.calls++; return true },
}))

import { prepareSceneShaders, sceneHasCustomMaterials, ensureTranslatorFor, engineShaderProgress, type ShaderPreparer } from '../src/utils/sceneShaders'

function sceneWith(opts: { model?: Material[]; screen?: Material[] } = {}): Scene {
  return {
    modelsExceptTerrain: opts.model ? [{ model: { materials: opts.model } }] : [],
    landscapes: [],
    cameras: opts.screen ? [{ screenMaterials: opts.screen }] : [{ screenMaterials: [] }],
  } as unknown as Scene
}

function recorder(): { step: LoadStepHandle; log: string[] } {
  const log: string[] = []
  const step: LoadStepHandle = {
    start: () => { log.push('start'); return step },
    progress: (d, n, detail) => { log.push(`progress ${d}/${n}${detail ? ' ' + detail : ''}`); return step },
    done: (detail) => { log.push(`done ${detail ?? ''}`.trim()); return step },
    fail: (m) => { log.push(`fail ${m}`); return step },
    skip: (detail) => { log.push(`skip ${detail ?? ''}`.trim()); return step },
  }
  return { step, log }
}

function renderer(backend: string, run: ShaderPreparer['prepareShaders']): ShaderPreparer {
  return { backend, prepareShaders: run }
}

beforeEach(() => { translator.calls = 0 })

describe('compiling the open scene\'s shaders', () => {
  it('finds a custom material on a model or in any camera\'s screen materials', () => {
    const screen = CustomMaterial.Create(null, 'screen')
    const surface = CustomMaterial.Create(null, 'forward')
    expect(sceneHasCustomMaterials(sceneWith())).toBe(false)
    expect(sceneHasCustomMaterials(sceneWith({ model: [{} as Material] }))).toBe(false)
    expect(sceneHasCustomMaterials(sceneWith({ model: [surface] }))).toBe(true)
    expect(sceneHasCustomMaterials(sceneWith({ screen: [screen] }))).toBe(true)
  })

  it('loads the translator first on WebGPU when a custom material needs it, and only then', async () => {
    const custom = sceneWith({ screen: [CustomMaterial.Create(null, 'screen')] })
    await ensureTranslatorFor({ backend: 'webgl2' }, custom)
    await ensureTranslatorFor({ backend: 'webgpu' }, sceneWith())
    expect(translator.calls).toBe(0)
    await ensureTranslatorFor({ backend: 'webgpu' }, custom)
    expect(translator.calls).toBe(1)
  })

  it('shows the count as it moves, without repeats, and what it built', async () => {
    const { step, log } = recorder()
    const r = renderer('webgpu', async (_scene, options) => {
      options.onProgress?.(0, 0)
      options.onProgress?.(0, 2)
      options.onProgress?.(0, 2)
      options.onProgress?.(1, 2)
      options.onProgress?.(2, 2)
      return { built: 2, remaining: 0, timedOut: false, seconds: 1 }
    })
    await prepareSceneShaders(r, sceneWith(), step)
    expect(log).toEqual(['start', 'progress 0/2', 'progress 1/2', 'progress 2/2', 'done 2 built'])
  })

  it("is one count at startup: the engine's programs, held short of done, then the scene's on top", async () => {
    const { step, log } = recorder()
    engineShaderProgress(step, 40, 120)
    const engine = engineShaderProgress(step, 120, 120)
    // All 120 in, but the step is not finished: the scene's shaders are still to come.
    expect(log).toEqual(['progress 40/121', 'progress 120/121'])
    log.length = 0
    const r = renderer('webgpu', async (_scene, options) => {
      options.onProgress?.(0, 3)
      options.onProgress?.(3, 3)
      return { built: 3, remaining: 0, timedOut: false, seconds: 1 }
    })
    await prepareSceneShaders(r, sceneWith(), step, undefined, engine)
    expect(log).toEqual(['start', 'progress 120/123', 'progress 123/123', 'done 123 built'])
  })

  it('says when nothing needed building, and when it gave up waiting', async () => {
    const quiet = recorder()
    await prepareSceneShaders(renderer('webgl2', async () => ({ built: 0, remaining: 0, timedOut: false, seconds: 0 })),
                              sceneWith(), quiet.step)
    expect(quiet.log).toEqual(['start', 'done up to date'])
    const slow = recorder()
    await prepareSceneShaders(renderer('webgpu', async () => ({ built: 3, remaining: 2, timedOut: true, seconds: 300 })),
                              sceneWith(), slow.step)
    expect(slow.log.at(-1)).toBe('done 2 still building')
  })

  it('settles the step on an error, and skips it with no renderer or once the project closed', async () => {
    const broken = recorder()
    await prepareSceneShaders(renderer('webgpu', async () => { throw new Error('device lost') }), sceneWith(), broken.step)
    expect(broken.log).toEqual(['start', 'fail device lost'])
    const none = recorder()
    await prepareSceneShaders(null, sceneWith(), none.step)
    expect(none.log).toEqual(['skip no renderer'])
    const closed = recorder()
    const abort = new AbortController()
    await prepareSceneShaders(renderer('webgpu', async () => { abort.abort(); return { built: 0, remaining: 1, timedOut: false, seconds: 0 } }),
                              sceneWith(), closed.step, abort.signal)
    expect(closed.log).toEqual(['start', 'skip closed'])
  })
})
