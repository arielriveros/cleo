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
 * May a WebGPU device be ACQUIRED, even where the renderer cannot draw through one? A runtime query
 * parameter rather than a build flag, so the harness, dev server and address bar all reach it.
 */
export function webgpuAcquisitionAllowed(): boolean {
    if (WEBGPU_IMPLEMENTED) return true;
    if (typeof window === 'undefined') return false;
    return (window as unknown as { __CLEO_WEBGPU_PROBE?: boolean }).__CLEO_WEBGPU_PROBE === true
        || new URLSearchParams(window.location.search).get('cleoWebgpuProbe') === '1';
}

/**
 * How far a backend request got, and where it stopped. Stages rather than a boolean, because which
 * stage a WebGPU boot fails at is what `tools/harness/webgpuBoot.json` ratchets on.
 */
export interface DeviceProbe {
    /** The backend that was asked for. */
    requested: BackendKind;
    /** The backend that was acquired, or null when acquisition itself never completed. */
    acquired: BackendKind | null;
    /** Why {@link acquired} differs from {@link requested}, or null when the request was met. */
    fallbackReason: string | null;
    /**
     * Stage names completed, in order: `device`, `profiler`, `screenQuad`, `framebuffers`,
     * `preInitialize`, `programs`, `firstFrame`.
     */
    reached: string[];
    /** The first stage that threw, with the stack — null while nothing has. */
    failedAt: { stage: string; message: string; stack: string } | null;
}

/**
 * Resolve a backend request: null when it can be honoured, else the reason it cannot. Called once, at
 * device acquisition — a changed preference only takes effect when a new engine is constructed.
 */
export function resolveBackendRequest(requested: BackendKind | undefined): string | null {
    if (!requested || requested === 'webgl2') return null;

    if (!webgpuAvailableInBrowser())
        return 'this browser does not expose navigator.gpu';
    // The narrower predicate, not WEBGPU_IMPLEMENTED: the probe may acquire a device before drawing works.
    if (!webgpuAcquisitionAllowed())
        return 'the WebGPU device works, but the renderer does not draw through it yet';
    return null;
}
