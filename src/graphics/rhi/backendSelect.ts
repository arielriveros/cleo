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
 * Not the same question as "does a WebGPU device exist". `rhi/webgpu/webgpuDevice.ts` is a complete
 * `Device` — buffers, textures, samplers, shader modules, pipelines, bind groups, render passes,
 * layered attachments and readback — verified against a real driver by `tools/harness/webgpuCheck.js`,
 * including two of the engine's own `.wgsl` programs drawing pixel-exact output.
 *
 * The DRAW path above it is portable: every draw in the harness scene goes through the RHI command
 * model, and `renderer.ts` is down to 29 raw `gl.*` calls, none of them inside a pass.
 *
 * The SHADER and UNIFORM layer is no longer the blocker either — that note used to live here and is now
 * out of date. `rhi/shaderProgram.ts` is the seam, `WebGPUShaderProgram` implements it, the renderer
 * builds all 55 of its programs through `device.createShaderProgram`, and `harness:webgpu` drives
 * `setUniform` by name into the right group on a real adapter. The swap chain is done too: the surface
 * is on the interface and the harness reads back a pass that drew into it.
 *
 * What is left is the RESOURCE layer, and it is a short, specific list - every remaining WebGL2-only
 * call in the engine is a `glDevice()` site, 21 of them:
 *
 *   - `TileMesh` (7) owns a `WebGLVertexArrayObject` and hands raw `WebGLBuffer` handles to
 *     `vertexAttribPointer`. WebGPU has no VAO; the pipeline carries the layout. `Mesh` was the same
 *     shape and was 19 of these; its VAO is LAZY now and its whole VAO-configuration family is guarded
 *     off WebGL2, leaving 5 sites inside legacy draw paths WebGPU never takes.
 *   - `uniformBlocks` (2, the global UNIFORM_BUFFER binding points), `webgl2Commands` (2, inside the
 *     backend), `texturePacker` (1), the renderer's own 2, and the three framebuffer wrappers (1 each,
 *     all `unbind()` - the legacy bind model).
 *
 * `Renderer.initialize` acquires a real WebGPU device and startup now runs all the way through program
 * creation and into `_initializeIBL`, where the FIRST REAL RENDER PASS is built and the driver refuses
 * its colour attachment. That is a different class of blocker from the ones before it: nothing left to
 * port, only something to get right. `harness:webgpu:boot` ratchets on it and `webgpuBoot.json` carries
 * the history of every stage this has moved through.
 *
 * Flipping this constant before those land would trade an honest "not yet" for a black viewport.
 */
export const WEBGPU_IMPLEMENTED = true;

/**
 * May a WebGPU device be ACQUIRED, even though the renderer cannot yet draw through one?
 *
 * A strictly narrower question than {@link WEBGPU_IMPLEMENTED}, and it needs its own answer: acquisition
 * is the first link in the chain and it cannot be exercised end-to-end while the only gate on it is the
 * flag that also promises a rendered frame. Everything downstream — the boot probe, the per-stage
 * failure record, the ratchet in `tools/harness/webgpuBoot.json` — is unreachable code until this
 * returns true for someone.
 *
 * A RUNTIME hatch rather than a build constant, deliberately. A second bundle-time flag would have to be
 * kept in step with this one in webpack, in the editor's dev server and in the harness's own build; a
 * query parameter is reachable from all three plus an address bar, with nothing to keep in step. It is
 * not wired to any editor UI, and `WEBGPU_IMPLEMENTED` still gates what users are offered — a hatch that
 * shows up in a settings dropdown is not a hatch.
 */
export function webgpuAcquisitionAllowed(): boolean {
    if (WEBGPU_IMPLEMENTED) return true;
    if (typeof window === 'undefined') return false;
    return (window as unknown as { __CLEO_WEBGPU_PROBE?: boolean }).__CLEO_WEBGPU_PROBE === true
        || new URLSearchParams(window.location.search).get('cleoWebgpuProbe') === '1';
}

/**
 * How far a backend request actually got, and where it stopped.
 *
 * Lives here rather than on the renderer because it describes the OUTCOME of the selection this module
 * performs, and because `renderer.ts` cannot declare a module-scope interface without the declaration
 * landing in the middle of a 6,000-line class file.
 *
 * The value of recording stages rather than a single boolean is the ratchet: on WebGPU, initialization
 * is expected to fail, and which stage it fails AT is the migration's actual progress metric. A gate
 * that only asked "did it work" would read false for the whole port and then true once, telling you
 * nothing on any day in between.
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
    // The narrower predicate, not WEBGPU_IMPLEMENTED: acquiring a device is a step the probe is allowed
    // to take before drawing through one works. The message is unchanged for everybody else, because for
    // everybody else nothing about the answer has changed.
    if (!webgpuAcquisitionAllowed())
        return 'the WebGPU device works, but the renderer does not draw through it yet';
    return null;
}
