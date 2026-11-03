import type { Rapier } from './load';

// load.ts in a build without Rapier: the published player built for cannon games (the editor's
// vite.player.config.ts swaps this in for load.ts), so it does not carry Rapier's ~4 MB. Asking for Rapier
// there fails to load, and the engine falls back to cannon with that reason.

export type { Rapier };

export function loadRapier(): Promise<Rapier> {
    return Promise.reject(new Error('this build of the player has no Rapier'));
}

export function rapier(): Rapier {
    throw new Error('physics: this build of the player has no Rapier');
}
