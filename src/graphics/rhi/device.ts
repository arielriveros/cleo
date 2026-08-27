// The device: the one object that knows which graphics API is running. Resources are created THROUGH
// a device, and nothing above the RHI learns which one it has. Acquisition is asynchronous, which is
// why `Renderer.initialize()` is async and no allocation happens in the `Renderer` constructor.

import type {
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags, SamplerDescriptor,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState, RenderPassDescriptor,
    ShaderStageFlags, IndexFormat, ShaderResource,
} from './types';
import type {
    Buffer, Texture, TextureView, Sampler, ShaderModule, BindGroup, BindGroupLayout,
    RenderPipeline, RenderTarget, ComputePipeline,
} from './resources';
import type { ShaderProgram, ShaderProgramDescriptor } from './shaderProgram';

/** Which graphics API a device is driving. */
export type BackendKind = 'webgl2' | 'webgpu';

/** What the running device can do. Every field is a real limit read back from the API, never a guess. */
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
    /** Stages this module provides, ORed together. A WGSL module normally carries `VERTEX | FRAGMENT`. */
    stage: ShaderStageFlags;
    /**
     * WGSL source, `#include`s expanded; the WebGL2 GLSL is generated from it at build time. One module
     * holds BOTH entry points — naga derives varying names from a module's own location numbers.
     */
    source: string;
    /** Entry-point names by stage. WebGPU needs them at pipeline creation; there is no `main` convention. */
    entryPoints?: { vertex?: string; fragment?: string; compute?: string };
    /**
     * What this program binds where, reflected from its WGSL at build time. Required for bind groups;
     * a hand-written GLSL program has none and cannot run on WebGPU.
     */
    resources?: readonly ShaderResource[];
    /**
     * The name this program is registered under in `ShaderManager`. WebGL2 only — binding through
     * `ShaderManager` is what keeps `setUniform` working. WebGPU ignores it and compiles `source`.
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

/**
 * A compute pipeline is a module and nothing else — the bind-group layouts come from the module's own
 * `@group`/`@binding` declarations, as {@link RenderPipelineDescriptor} does.
 */
export interface ComputePipelineDescriptor {
    label?: string;
    compute: ShaderModule;
}

export interface RenderTargetDescriptor {
    label?: string;
    colorViews: TextureView[];
    depthView?: TextureView;
}

/** One entry in a bind group: a buffer range, a sampled texture, a storage texture, or a sampler. */
export type BindGroupEntry =
    | { binding: number; buffer: Buffer; offset?: number; size?: number }
    | { binding: number; textureView: TextureView }
    /**
     * A texture bound for WRITING by a compute shader. Its own arm, not a flag: WebGPU validates it
     * against `STORAGE_BINDING`, and WebGL2 can throw rather than assign a unit that writes nothing.
     */
    | { binding: number; storageTextureView: TextureView }
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
 * Records draws inside one render pass. Narrow on purpose: no `enable`, `depthMask`, `cullFace` or
 * `useProgram` — all of it lives in the immutable {@link RenderPipeline} a draw is recorded against.
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
 * Records a frame's work. Callers must write for the DEFERRED model WebGPU uses — reading a result
 * back mid-frame would deadlock there, though WebGL2 issues every call immediately.
 */
/** Records dispatches inside one compute pass. No indirect dispatch, dynamic offsets or timestamps. */
export interface ComputePassEncoder {
    setPipeline(pipeline: ComputePipeline): void;
    setBindGroup(group: number, bindGroup: BindGroup): void;
    /** Workgroup COUNTS, not thread counts — the module's `@workgroup_size` supplies the rest. */
    dispatchWorkgroups(x: number, y?: number, z?: number): void;
    end(): void;
}

export interface CommandEncoder {
    beginRenderPass(target: RenderTarget, descriptor: RenderPassDescriptor): RenderPassEncoder;
    /** Open a compute pass. Throws on WebGL2 — gate the call on `capabilities.hasCompute`, not on a backend name. */
    beginComputePass(label?: string): ComputePassEncoder;
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

    /**
     * A view of the WHOLE texture — every mip, every layer, the texture's own dimension. What a shader
     * sampling a cube or an array needs; {@link createTextureView} narrows instead, for attachments.
     */
    createWholeTextureView(texture: Texture): TextureView;
    createSampler(descriptor: SamplerDescriptor): Sampler;
    createShaderModule(descriptor: ShaderModuleDescriptor): ShaderModule;

    /**
     * Build a linked, uniform-writable program — the thing the engine writes uniforms into. Distinct
     * from {@link createShaderModule}, which describes a program to a pipeline.
     */
    createShaderProgram(descriptor: ShaderProgramDescriptor): ShaderProgram;
    createRenderPipeline(descriptor: RenderPipelineDescriptor): RenderPipeline;
    /** Build a compute pipeline. Throws on WebGL2 — see {@link DeviceCapabilities.hasCompute}. */
    createComputePipeline(descriptor: ComputePipelineDescriptor): ComputePipeline;
    createRenderTarget(descriptor: RenderTargetDescriptor): RenderTarget;
    createBindGroup(descriptor: BindGroupDescriptor): BindGroup;

    /** The swap chain's current target. Reacquired every frame: WebGPU hands back a new one each time. */
    getCurrentSurfaceTarget(): RenderTarget;

    /**
     * Re-establish the surface configuration. Needed after the canvas is RE-PARENTED or the device is
     * replaced — not for a plain resize, which the swap chain follows on its own.
     */
    reconfigureSurface(): void;

    writeBuffer(buffer: Buffer, offset: number, data: ArrayBufferView): void;

    /**
     * Replace a buffer's contents, resizing if the data no longer fits. RETURNS the buffer to use from
     * now on, which may not be the one passed in. Callers that never resize want {@link writeBuffer}.
     */
    reallocateBuffer(buffer: Buffer, data: ArrayBufferView): Buffer;
    writeTexture(texture: Texture, data: ArrayBufferView, width: number, height: number,
                 mipLevel?: number, arrayLayer?: number): void;

    createCommandEncoder(label?: string): CommandEncoder;

    /**
     * Read a colour attachment back to the CPU. Asynchronous because WebGPU's `copyTextureToBuffer` +
     * `mapAsync` is; callers must finish rendering and restore their state BEFORE awaiting.
     */
    readPixels(view: TextureView, x: number, y: number, width: number, height: number): Promise<Uint8Array>;

    /**
     * Switch per-pass GPU timing on or off. `sink` fires once per timed pass with its label and
     * elapsed milliseconds, from {@link collectTimestamps} only. A no-op on WebGL2.
     */
    setTimestampCollection(enabled: boolean, sink: (label: string, ms: number) => void): void;

    /**
     * Deliver whatever timings have come back and start reading what is newly finished. NEVER waits on
     * the GPU, so results arrive one to three frames late and an empty call is the ordinary case.
     */
    collectTimestamps(): void;

    /** Release the device and everything still alive on it. */
    destroy(): void;
}
