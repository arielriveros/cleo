import { PhysicsSystem } from 'cleo'

/**
 * A new physics worker. Throws where workers are unavailable, which the engine reads as "keep the step on
 * the main thread". Shared by the editor and its Play-in-window page (src/player/session.tsx).
 */
export function createPhysicsWorker(): Worker {
  if (typeof Worker === 'undefined') throw new Error('Web Workers are not available here')
  // `new Worker(new URL('./x.ts', import.meta.url), { type: 'module' })` is the form Vite bundles.
  return new Worker(new URL('./physicsWorkerEntry.ts', import.meta.url), { type: 'module', name: 'cleo-physics' })
}

/**
 * Let the engine run its physics step in a Web Worker (Options ▸ Engine ▸ Runtime ▸ Physics thread). Only
 * the factory is installed here; whether a world uses it is the project's setting, applied with the other
 * runtime options (applyEngineRuntime). Where workers are unavailable the factory throws and the step
 * stays on the main thread.
 */
export function installPhysicsWorker(): void {
  PhysicsSystem.workerFactory = createPhysicsWorker
}
