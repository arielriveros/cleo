import type JoltModule from 'jolt-physics';

// The one place the Jolt package (JoltPhysics.js) is loaded: on demand, through a dynamic import, so a build
// or a page that never asks for Jolt never loads its ~3 MB (its WASM is embedded in the module, base64). A
// published player built without Jolt aliases this file to a stub (see the editor's vite.player.config.ts).
//
// The package's default is the single-threaded build (wasm-compat). The threaded one calls a contact listener
// written in JavaScript from its job threads, where that JavaScript does not exist (see
// docs/reference/physics-backends.md).

export type Jolt = typeof JoltModule;

let loaded: Jolt | null = null;
let loading: Promise<Jolt> | null = null;

/** Load and initialize Jolt, once. */
export function loadJolt(): Promise<Jolt> {
    return loading ??= (async () => {
        const mod = await import('jolt-physics');
        const init = ((mod as unknown as { default?: Jolt }).default ?? mod) as Jolt;
        loaded = await init();
        return loaded;
    })();
}

/** Jolt, once {@link loadJolt} has resolved. */
export function jolt(): Jolt {
    if (!loaded) throw new Error('physics: Jolt is not loaded (acquirePhysicsBackend first)');
    return loaded;
}

/** Jolt's WASM heap in bytes: a fixed size, and what is free of it now. */
export function joltHeap(): { total: number; free: number } {
    const J = jolt(), statics = J.JoltInterface.prototype;
    return { total: statics.sGetTotalMemory(), free: statics.sGetFreeMemory() };
}
