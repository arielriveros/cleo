import type { BackendKind } from 'cleo';

/**
 * The graphics API the editor asks for when it constructs the engine. A property of the machine, so it
 * must stay out of the project and out of the dock layout.
 *
 * Read exactly once, before `new CleoEngine(...)`: a live context cannot change API underneath the
 * buffers, textures and programs built on it, so a switch takes effect on the next reload.
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
        // Store only the non-default, so clearing the setting also clears the key.
        if (backend === 'webgl2') localStorage.removeItem(KEY);
        else localStorage.setItem(KEY, backend);
    } catch {
        /* nothing to do — the preference simply will not persist */
    }
}
