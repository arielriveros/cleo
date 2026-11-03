import type { Jolt } from './load';

// load.ts in a build without Jolt: a published player built for another backend (the editor's
// vite.player.config.ts swaps this in for load.ts), so it does not carry Jolt's ~3 MB. Asking for Jolt there
// fails to load, and the engine falls back to cannon with that reason.

export type { Jolt };

export function loadJolt(): Promise<Jolt> {
    return Promise.reject(new Error('this build of the player has no Jolt'));
}

export function jolt(): Jolt {
    throw new Error('physics: this build of the player has no Jolt');
}

export function joltHeap(): { total: number; free: number } {
    throw new Error('physics: this build of the player has no Jolt');
}
