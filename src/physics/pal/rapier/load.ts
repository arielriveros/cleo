import type * as RapierModule from '@dimforge/rapier3d-compat';

// The one place the Rapier package is loaded: on demand, through a dynamic import, so a build or a page that
// never asks for Rapier never loads its ~4 MB (its WASM is embedded in the module, base64). In the published
// player that import is a chunk of its own, shipped only by games on Rapier (the editor's
// vite.player.config.ts); in a game without it the import fails, and the engine falls back to cannon.

export type Rapier = typeof RapierModule;

let loaded: Rapier | null = null;
let loading: Promise<Rapier> | null = null;

/** Load and initialize Rapier, once. */
export function loadRapier(): Promise<Rapier> {
    return loading ??= (async () => {
        const mod = await import('@dimforge/rapier3d-compat');
        const rapier = ((mod as unknown as { default?: Rapier }).default ?? mod) as Rapier;
        await rapier.init();
        loaded = rapier;
        return rapier;
    })();
}

/** Rapier, once {@link loadRapier} has resolved. */
export function rapier(): Rapier {
    if (!loaded) throw new Error('physics: Rapier is not loaded (acquirePhysicsBackend first)');
    return loaded;
}
