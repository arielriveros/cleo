import type { BackendKind } from './device';

/**
 * Which graphics APIs this build can actually drive, and why a request might not be honoured.
 *
 * The engine ships one working backend (WebGL2) and an RHI shaped for a second. Rather than hide that,
 * the selection is a REQUEST that gets resolved here against two independent facts — whether the
 * browser exposes the API at all, and whether this build implements it — because the two call for
 * different responses from whoever asked. "Your browser has no WebGPU" is the user's to fix; "not
 * implemented yet" is ours.
 */

/**
 * True when the browser exposes a WebGPU entry point.
 *
 * Presence of `navigator.gpu` only means the API surface exists; an adapter request can still fail on
 * a blocklisted driver. That is a heavier, asynchronous question than a settings toggle should ask, and
 * it is moot while {@link WEBGPU_IMPLEMENTED} is false.
 */
export function webgpuAvailableInBrowser(): boolean {
    return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

/**
 * Whether this build can RENDER A SCENE on WebGPU.
 *
 * Not the same question as "does a WebGPU device exist", and the difference is the whole reason this
 * constant is still false. `rhi/webgpu/webgpuDevice.ts` is a complete `Device` — buffers, textures,
 * samplers, shader modules, pipelines, bind groups, render passes, layered attachments and readback —
 * verified against a real driver by `tools/harness/webgpuCheck.js`, including two of the engine's own
 * `.wgsl` programs drawing pixel-exact output.
 *
 * What does not exist is the path from a scene to that device: `renderer.ts` still issues ~160 raw
 * `gl.*` calls, so nothing above the RHI can be pointed at a second backend yet. Flipping this now
 * would trade an honest "not yet" for a black viewport.
 *
 * Flip it when the renderer draws through `Device` rather than through `gl` — WEBGPU_ROADMAP.md M5/M6.
 */
export const WEBGPU_IMPLEMENTED = false;

/**
 * Resolve a backend request. Returns null when it can be honoured, or the reason it cannot.
 *
 * Called once, at device acquisition. There is no way to swap a live context's API underneath the
 * buffers, textures and programs already built on it, so a changed preference only takes effect when a
 * new engine is constructed — hosts that expose this as a setting have to say so.
 */
export function resolveBackendRequest(requested: BackendKind | undefined): string | null {
    if (!requested || requested === 'webgl2') return null;

    if (!webgpuAvailableInBrowser())
        return 'this browser does not expose navigator.gpu';
    if (!WEBGPU_IMPLEMENTED)
        return 'the WebGPU device works, but the renderer does not draw through it yet';
    return null;
}
