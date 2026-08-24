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
 * What is left is the RESOURCE layer, and it is a short, specific list — every remaining WebGL2-only
 * call in the engine is a `glDevice()` site, 40 of them:
 *
 *   - `Mesh` (19) owns a `WebGLVertexArrayObject` and hands raw `WebGLBuffer` handles to
 *     `vertexAttribPointer`. WebGPU has no VAO; the pipeline carries the layout. This one is on the
 *     path of every draw, so it is the blocker that matters. `TileMesh` (7) is the same shape.
 *   - `uniformBlocks` (2, the global UNIFORM_BUFFER binding points), `webgl2Commands` (2, inside the
 *     backend), `texturePacker` (1), and the renderer's own 6 (vertex-layout buffers + the cloud-noise
 *     bake framebuffer).
 *   - The three framebuffer wrappers are down to ONE call each, all the same one: `unbind()`, which
 *     restores the default framebuffer. That is the legacy bind model, and it is a symptom rather than
 *     a cause — every remaining caller is a draw or clear issued OUTSIDE a pass, which is the same set
 *     `Mesh` sits at the centre of. Port the draws and these go with them.
 *   - `Renderer.initialize` acquires a WebGL2 context unconditionally and never calls
 *     `acquireWebGPUDevice`.
 *
 * Flipping this constant before those land would trade an honest "not yet" for a black viewport.
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
