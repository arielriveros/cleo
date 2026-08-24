import type { Device } from './device';

/**
 * The live device, in a module of its own — the same shape, and for the same reason, as `glContext.ts`.
 *
 * Every low-level wrapper needs to reach the device, and routing that through the renderer would put
 * the renderer (and therefore the scene, and therefore every node class) back into the dependency graph
 * of the smallest leaves in the engine. Exported as a live binding so consumers read `device` as a
 * plain value and see the assignment the moment the renderer makes it.
 *
 * It lives HERE rather than in `webgl2/webgl2Device.ts`, where it started, because the type is what the
 * consumers get: nine modules — `Mesh`, `Texture`, the three framebuffers, `uniformBlocks`,
 * `texturePacker`, `tileMesh` — imported it from the WebGL2 backend and were therefore typed against
 * `WebGL2Device`. Nothing stopped one of them reaching for a WebGL2-only member, and nothing would have
 * reported it until a WebGPU device was assigned here and the whole engine failed at runtime. Typed as
 * the INTERFACE, the compiler answers that question at every call site instead.
 *
 * This module imports nothing at runtime (the `Device` import is types only), so it cannot participate
 * in a cycle no matter who reads it.
 */
export let device: Device;

/** Called once by the renderer, immediately after it acquires a context. */
export function setDevice(next: Device): void { device = next; }
