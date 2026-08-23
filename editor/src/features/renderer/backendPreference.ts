import type { BackendKind } from 'cleo';

/**
 * The graphics API the editor asks for when it constructs the engine.
 *
 * Kept out of the project and out of the dock layout on purpose: this is a property of the MACHINE the
 * editor is running on, not of the scene being authored. A project opened on a machine without WebGPU
 * should not carry a WebGPU request with it, and a layout reset should not silently change which API
 * the renderer runs on.
 *
 * It is read exactly once, before `new CleoEngine(...)`. A live context cannot change API underneath
 * the buffers, textures and programs built on it, so switching takes effect on the next reload — the
 * Renderer Settings panel says so rather than pretending the toggle is instant.
 */

const KEY = 'cleo_renderer_backend';

export function readBackendPreference(): BackendKind {
    try {
        return localStorage.getItem(KEY) === 'webgpu' ? 'webgpu' : 'webgl2';
    } catch {
        // Private mode, or storage disabled. WebGL2 is the backend that always exists.
        return 'webgl2';
    }
}

export function writeBackendPreference(backend: BackendKind): void {
    try {
        // Store only the non-default, so clearing the setting also clears the key rather than leaving
        // an explicit 'webgl2' that looks like a deliberate choice forever.
        if (backend === 'webgl2') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, backend);
    } catch {
        /* nothing to do — the preference simply will not persist */
    }
}
