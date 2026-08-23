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
 * The DRAW path above it is portable now too: every draw in the harness scene goes through the RHI
 * command model, and `renderer.ts` is down to a few dozen raw `gl.*` calls, none of them in a pass.
 *
 * What is still WebGL2-only is the SHADER and UNIFORM layer. `ShaderManager.bind(name)` selects a linked
 * GL program, and ~330 `setUniform(name, value)` call sites in the renderer reach uniforms the way
 * WebGL2 does: by name, into a std140 block whose member offsets the driver reports. WebGPU has no such
 * reflection and no `useProgram` — a pipeline carries its own module, and uniforms are bytes written at
 * offsets computed from the WGSL layout rules. Both halves of that already exist
 * (`tools/wgslLayout.mjs` computes the offsets, `rhi/uniformSet.ts` writes by name, and
 * `npm run harness:uniforms` checks all 1,697 members against a real driver); what does not exist is a
 * `Shader` that routes to them instead of to `gl.uniform*`.
 *
 * Flipping this constant before that lands would trade an honest "not yet" for a black viewport.
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
