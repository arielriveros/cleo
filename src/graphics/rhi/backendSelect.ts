import type { BackendKind } from './device';

// Which graphics APIs this build can drive. A backend choice is a REQUEST, resolved against two
// separate facts: whether the browser exposes the API, and whether this build implements it.

/**
 * True when the browser exposes a WebGPU entry point. Surface only — an adapter request can still fail
 * on a blocklisted driver.
 */
export function webgpuAvailableInBrowser(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Whether this build can render a scene on WebGPU — a stricter question than whether a WebGPU device
 * can be acquired. The remaining WebGL2-only calls are the `glDevice()` sites.
 */
export const WEBGPU_IMPLEMENTED = true;

/**
 * Resolve a backend request: null when it can be honoured, else the reason it cannot. Called once, at
 * device acquisition — a changed preference only takes effect when a new engine is constructed.
 */
export function resolveBackendRequest(requested: BackendKind | undefined): string | null {
    if (!requested || requested === 'webgl2') return null;

    if (!webgpuAvailableInBrowser())
        return 'this browser does not expose navigator.gpu';
    if (!WEBGPU_IMPLEMENTED)
        return 'the WebGPU device works, but the renderer does not draw through it yet';
    return null;
}
