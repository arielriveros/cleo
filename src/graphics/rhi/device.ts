/**
 * The device: the one object that knows which graphics API is actually running.
 *
 * Today the engine has a single seam of this kind — `glContext.ts`, an 18-line module exporting a live
 * `gl` binding that nine files import as a free variable. That worked because there was exactly one
 * backend and its type could be hardcoded. A second backend makes the free variable untenable, so this
 * interface takes its place: resources are created *through* a device, and nothing above the RHI ever
 * learns which one it has.
 *
 * Acquiring a device is asynchronous, and that is not incidental. `navigator.gpu.requestAdapter()` and
 * `adapter.requestDevice()` both return promises, which is why `Renderer.initialize()` had to become
 * async and why the framebuffer allocations moved out of the `Renderer` constructor: they call
 * `gl.createFramebuffer` and so cannot run before a device exists.
 */

import type {
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags, SamplerDescriptor,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState, RenderPassDescriptor,
    ShaderStageFlags, IndexFormat, ShaderResource,
} from './types';
import type {
    Buffer, Texture, TextureView, Sampler, ShaderModule, BindGroup, BindGroupLayout,
    RenderPipeline, RenderTarget,
} from './resources';

/** Which graphics API a device is driving. */
export type BackendKind = 'webgl2' | 'webgpu';

/**
 * What the running device can actually do.
 *
 * Every field is a real limit read back from the API, never a guess. Two of them are already load
 * bearing today and simply have nowhere to live:
 *
 * - `maxSamplersPerStage` is the 16-texture-unit budget that ES 3.00 guarantees. renderer.ts encodes
 *   it as two hand-tuned constants (`SHADOW_UNIT = 6`, `SPOT_SHADOW_UNIT = 15`) with a comment
 *   explaining that the deferred pass sits at 15 of 16, and `_applyCustomMaterial` silently drops any
 *   user sampler that would land past unit 15. Under WebGPU that ceiling is gone; under WebGL2 it is
 *   whatever the driver reports, which is often higher than 16.
 * - `floatRenderable` / `floatFilterable` are the `EXT_color_buffer_float` and
 *   `OES_texture_float_linear` pair. The first is a hard `throw` in `preInitialize` today; the second
 *   is checked in texture.ts and, when absent, silently demotes every `precision: 'high'` target to
 *   RGBA8 — turning the whole HDR pipeline LDR with no warning anywhere.
 *
 * Reporting both as capabilities is the prerequisite for handling either gracefully.
 */
export interface DeviceCapabilities {
    readonly backend: BackendKind;

    /** Largest square 2D texture. WebGPU guarantees at least 8192; WebGL2 drivers vary. */
    readonly maxTextureSize: number;
    readonly maxTextureArrayLayers: number;
    readonly max3DTextureSize: number;

    /** Simultaneous colour attachments. The G-buffer needs 3. */
    readonly maxColorAttachments: number;
    /** Texture units (WebGL2) or sampled-texture bindings per stage (WebGPU). See the note above. */
    readonly maxSamplersPerStage: number;
    readonly maxVertexAttributes: number;
    readonly maxUniformBufferBindingSize: number;

    /** Float colour targets can be rendered into at all. */
    readonly floatRenderable: boolean;
    /** Float colour targets can be sampled with LINEAR rather than only NEAREST. */
    readonly floatFilterable: boolean;

    /** Compute shaders and storage buffers. False on WebGL2, always. */
    readonly hasCompute: boolean;
    readonly hasStorageBuffers: boolean;
    /** Per-pass GPU timing is available — `EXT_disjoint_timer_query_webgl2`, or timestamp queries. */
    readonly hasTimestampQuery: boolean;

    readonly maxAnisotropy: number;
    /** Format the swap chain wants. Always `rgba8unorm` on WebGL2; often `bgra8unorm` on WebGPU. */
    readonly preferredCanvasFormat: TextureFormat;

    /** Best-effort adapter identification, for device tiering. Absent when the browser withholds it. */
    readonly adapterInfo?: {
        readonly vendor: string;
        readonly architecture: string;
        readonly device: string;
        readonly description: string;
    };
}

/** One line per capability, for the boot log. Keeps the shape in one place rather than at each site. */
export function describeCapabilities(caps: DeviceCapabilities): string {
    const parts = [
        `backend=${caps.backend}`,
        `maxTexture=${caps.maxTextureSize}`,
        `arrayLayers=${caps.maxTextureArrayLayers}`,
        `colorAttachments=${caps.maxColorAttachments}`,
        `samplers=${caps.maxSamplersPerStage}`,
        `float=${caps.floatRenderable ? (caps.floatFilterable ? 'renderable+filterable' : 'renderable') : 'none'}`,
        `compute=${caps.hasCompute}`,
        `timestamps=${caps.hasTimestampQuery}`,
    ];
    if (caps.adapterInfo?.description) parts.push(`adapter="${caps.adapterInfo.description}"`);
    return parts.join(' ');
}

// ------------------------------------------------------------------------------------------------
// Descriptors
// ------------------------------------------------------------------------------------------------

export interface BufferDescriptor {
    label?: string;
    size: number;
    usage: BufferUsageFlags;
}

export interface TextureDescriptor {
    label?: string;
    format: TextureFormat;
    dimension?: TextureDimension;
    width: number;
    height: number;
    depthOrArrayLayers?: number;
    mipLevelCount?: number;
    usage: TextureUsageFlags;
}

export interface ShaderModuleDescriptor {
    label?: string;
    /**
     * Stages this module provides, ORed together.
     *
     * A WGSL module normally carries `VERTEX | FRAGMENT` — see the note on `source` for why the two
     * stages cannot be split apart.
     */
    stage: ShaderStageFlags;
    /**
     * WGSL source, with any `#include` already expanded.
     *
     * **This is the reverse of what the plan originally assumed**, and the reversal was forced by
     * measurement rather than preference: naga's GLSL *frontend* is Vulkan GLSL — no combined sampler
     * types, no ES profile, no `precision` — so it cannot read the dialect this engine used to write.
     * Its GLSL *backend* emits exactly that dialect, because that is the path wgpu itself takes to run
     * WGSL on WebGL2. So WGSL became the source of truth, and the GLSL ES 300 the WebGL2 device
     * compiles is generated from it at build time.
     *
     * One module holds BOTH entry points because naga derives varying names (`_vs2fs_location0`) from
     * a module's location numbers, so the two stages only line up when they came from the same module.
     * That is why a `.wgsl` import is one program rather than one stage, and why
     * {@link RenderPipelineDescriptor} will usually be handed the same module twice.
     *
     * Custom materials are the exception that still travels the other way: users author GLSL, and the
     * editor's Compile button translates it to WGSL once and stores the result, so no naga ever ships
     * to a player.
     */
    source: string;
    /**
     * Entry-point function names by stage, as the module declares them.
     *
     * WebGPU needs the name at pipeline creation; there is no `main` convention to fall back on. The
     * `.wgsl` loader already extracts these, so callers pass the import's `entryPoints` through.
     */
    entryPoints?: { vertex?: string; fragment?: string; compute?: string };
    /**
     * What this program binds where, as reflected from its WGSL at build time.
     *
     * Required by any module that will be used with bind groups. A hand-written GLSL program has none
     * and can still be used for state and passes — it simply cannot be bound by group and binding, and
     * cannot run on WebGPU either.
     */
    resources?: readonly ShaderResource[];
    /**
     * The name this program is registered under in `ShaderManager`.
     *
     * WebGL2 only, and a deliberate coupling rather than an oversight: the engine already links,
     * reflects and caches every program through `Shader`/`ShaderManager`, so the WebGL2 backend reaches
     * the existing one by name instead of duplicating all three. Binding through `ShaderManager` also
     * keeps `setUniform` working (it needs `_boundShader` current) and keeps the harness's shader
     * coverage measurement intact, since that wraps `ShaderManager.bind`. WebGPU ignores it and
     * compiles `source`.
     */
    program?: string;
}

export interface RenderPipelineDescriptor {
    label?: string;
    vertex: ShaderModule;
    fragment: ShaderModule;
    vertexLayouts: VertexBufferLayout[];
    primitive: PrimitiveState;
    depthStencil?: DepthStencilState;
    colorTargets: ColorTargetState[];
}

export interface RenderTargetDescriptor {
    label?: string;
    colorViews: TextureView[];
    depthView?: TextureView;
}

/** One entry in a bind group: a buffer range, a sampled texture, or a sampler. */
export type BindGroupEntry =
    | { binding: number; buffer: Buffer; offset?: number; size?: number }
    | { binding: number; textureView: TextureView }
    | { binding: number; sampler: Sampler };

export interface BindGroupDescriptor {
    label?: string;
    layout: BindGroupLayout;
    entries: BindGroupEntry[];
}

// ------------------------------------------------------------------------------------------------
// Command recording
// ------------------------------------------------------------------------------------------------

/**
 * Records draws inside one render pass.
 *
 * Deliberately narrow. There is no `enable`, no `depthMask`, no `cullFace` and no `useProgram` here —
 * all of that lives in the immutable {@link RenderPipeline} a draw is recorded against. That is the
 * whole reason the abstraction is shaped this way: WebGL2 can dedupe a pipeline bind down into the
 * `GLState` calls it already makes, whereas WebGPU could not have reconstructed a pipeline from a
 * stream of individual state mutations.
 */
export interface RenderPassEncoder {
    setPipeline(pipeline: RenderPipeline): void;
    setBindGroup(group: number, bindGroup: BindGroup, dynamicOffsets?: readonly number[]): void;
    setVertexBuffer(slot: number, buffer: Buffer, offset?: number): void;
    setIndexBuffer(buffer: Buffer, format: IndexFormat, offset?: number): void;
    setViewport(x: number, y: number, width: number, height: number): void;
    setScissor(x: number, y: number, width: number, height: number): void;
    draw(vertexCount: number, instanceCount?: number, firstVertex?: number): void;
    drawIndexed(indexCount: number, instanceCount?: number, firstIndex?: number, baseVertex?: number): void;
    end(): void;
}

/**
 * Records a frame's work.
 *
 * WebGPU genuinely defers submission until `finish()`; WebGL2 issues each call immediately and
 * `finish()` is a no-op. Callers must write for the deferred model, because it is the one that
 * constrains — a WebGL2-shaped caller that reads back a result mid-frame would deadlock on WebGPU.
 */
export interface CommandEncoder {
    beginRenderPass(target: RenderTarget, descriptor: RenderPassDescriptor): RenderPassEncoder;
    copyTextureToTexture(source: TextureView, destination: TextureView, width: number, height: number): void;
    finish(): void;
}

// ------------------------------------------------------------------------------------------------
// The device
// ------------------------------------------------------------------------------------------------

export interface Device {
    readonly backend: BackendKind;
    readonly capabilities: DeviceCapabilities;

    createBuffer(descriptor: BufferDescriptor): Buffer;
    createTexture(descriptor: TextureDescriptor): Texture;
    createTextureView(texture: Texture, baseMipLevel?: number, baseArrayLayer?: number): TextureView;
    createSampler(descriptor: SamplerDescriptor): Sampler;
    createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule;
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline;
    createRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget;
    createBindGroup(descriptor: BindGroupDescriptor): BindGroup;

    /** The swap chain's current target. Reacquired every frame: WebGPU hands back a new one each time. */
    getCurrentSurfaceTarget(): RenderTarget;

    writeBuffer(buffer: Buffer, offset: number, data: ArrayBufferView): void;
    writeTexture(texture: Texture, data: ArrayBufferView, width: number, height: number,
                 mipLevel?: number, arrayLayer?: number): void;

    createCommandEncoder(label?: string): CommandEncoder;

    /**
     * Read a colour attachment back to the CPU.
     *
     * Asynchronous on purpose. WebGL2 could satisfy this synchronously with `readPixels`, and does
     * today — `Renderer.screenshotOffscreen` returns a data URL from a straight-line call. WebGPU
     * cannot: `copyTextureToBuffer` followed by `mapAsync` is inherently deferred. Since the editor's
     * thumbnail capture is the only caller, the async signature is the honest one for both.
     */
    readPixels(view: TextureView, x: number, y: number, width: number, height: number): Promise<Uint8Array>;

    /** Release the device and everything still alive on it. */
    destroy(): void;
}
