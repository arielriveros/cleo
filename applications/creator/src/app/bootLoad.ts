import { beginLoad, continueLoad, currentLoad, type LoadHandle } from '@cleo/app-kit/feedback/loadingStore';

// The Creator's startup load: the engine's own phases plus the sub-application the user last had open.
// Two owners report into it -- CreatorEngineProvider (device, shaders, physics, frame) and the Shell
// (the sub-app's code chunk) -- and whichever settles last closes it.

export const BOOT_STEPS = [
  { id: 'device', label: 'Graphics device', weight: 2 },
  { id: 'shaders', label: 'Shaders', weight: 6 },
  { id: 'physics', label: 'Physics', weight: 1 },
  { id: 'workspace', label: 'Creator tools', weight: 2 },
  { id: 'frame', label: 'First frame', weight: 1 },
];

let boot: LoadHandle | null = null;

/** The startup load, begun on first use. */
export function bootLoad(): LoadHandle {
  if (!boot) boot = beginLoad('Starting Cleo Creator', BOOT_STEPS, 'fullscreen');
  return boot;
}

/** True while the startup load is still on screen. */
export function booting(): boolean {
  return !!boot && boot.active;
}

/** Close `load` once none of its steps is pending or running. */
export function finishIfSettled(load: LoadHandle | null = continueLoad()): void {
  const state = currentLoad();
  if (!load || !state || state.id !== load.id) return;
  if (state.steps.every(s => s.status !== 'pending' && s.status !== 'running')) load.finish();
}

/** Settle every unfinished step (after a failure), so the screen closes on the error. */
export function abandonBoot(reason: string): void {
  const state = currentLoad();
  if (!boot || !state || state.id !== boot.id) return;
  for (const s of state.steps) if (s.status === 'pending' || s.status === 'running') boot.step(s.id).skip(reason);
  boot.finish();
}
