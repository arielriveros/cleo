/**
 * GPU resource handles, as the RHI sees them.
 *
 * Every one of these is an interface, not a class: the two backends have nothing in common at the
 * implementation level, and the only thing callers above the RHI may do with a handle is pass it back
 * to the device. In particular none of them exposes its native object — no `.texture`, no `.program`,
 * no `.framebuffer`. That is the single rule that keeps `renderer.ts` backend-agnostic, and it is
 * exactly the rule today's wrappers break: `Texture.texture`, `Mesh.vertexArray`, `Shader.program` and
 * `Framebuffer.framebuffer` all hand out raw WebGL handles, which is why the renderer can reach around
 * them whenever it is convenient.
 *
 * `destroy()` is explicit rather than left to the GC on both backends, so resource lifetime stays the
 * caller's decision and `Renderer._estimateGpuBytes` keeps meaning something.
 */

import type {
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState,
    ShaderStageFlags, SamplerDescriptor,
} from './types';

/** Common to every resource: a debug label and explicit disposal. */
export interface GpuResource {
    /** Shown in backend debug tooling and in engine logs. Never load-bearing. */
    readonly label: string;
    destroy(): void;
}

export interface Buffer extends GpuResource {
    readonly size: number;
    readonly usage: BufferUsageFlags;
}

export interface Texture extends GpuResource {
    readonly format: TextureFormat;
    readonly dimension: TextureDimension;
    readonly width: number;
    readonly height: number;
    /** Slices of a 3D volume, layers of an array, or 6 for a cube. 1 for a plain 2D texture. */
    readonly depthOrArrayLayers: number;
    readonly mipLevelCount: number;
    readonly usage: TextureUsageFlags;
    /** Bytes this texture occupies on the GPU, including its mip chain. */
    readonly byteSize: number;
}

/**
 * A view onto part of a texture: one mip, one array layer, one cube face.
 *
 * Separate from {@link Texture} because rendering into a single cascade layer or a single cube face is
 * something both backends do constantly (IBL convolution, the sky-atmosphere bake, every shadow
 * cascade) and neither expresses it by binding the whole texture.
 */
export interface TextureView extends GpuResource {
    readonly texture: Texture;
    readonly baseMipLevel: number;
    readonly baseArrayLayer: number;
}

export interface Sampler extends GpuResource {
    readonly descriptor: Readonly<SamplerDescriptor>;
}

/**
 * A compiled shader module.
 *
 * On WebGL2 this wraps a compiled `WebGLShader`; on WebGPU a `GPUShaderModule` translated from the
 * same GLSL source. Compilation diagnostics are surfaced through `compilationInfo` rather than by
 * throwing, because the editor's custom-material UI shows the compiler log to the user and needs it
 * whether or not the compile succeeded.
 */
export interface ShaderModule extends GpuResource {
    readonly stage: ShaderStageFlags;
    /** Empty when the module compiled cleanly. */
    readonly compilationInfo: readonly string[];
}

/**
 * What a shader stage expects to be bound, by group and binding index.
 *
 * WebGL2 has no such object — the layout is recovered by reflecting the linked program — so its
 * backend synthesises one and uses it to assign texture units. That indirection is the point: it is
 * what removes the hardcoded `SHADOW_UNIT = 6` / `SPOT_SHADOW_UNIT = 15` constants from renderer.ts
 * and, with them, the rule that a custom material silently drops every sampler past unit 15.
 */
export interface BindGroupLayout extends GpuResource {
    readonly group: number;
}

export interface BindGroup extends GpuResource {
    readonly layout: BindGroupLayout;
}

export interface RenderPipeline extends GpuResource {
    readonly vertexLayouts: readonly VertexBufferLayout[];
    readonly primitive: Readonly<PrimitiveState>;
    readonly depthStencil?: Readonly<DepthStencilState>;
    readonly colorTargets: readonly ColorTargetState[];
    /** Layouts this pipeline binds, indexed by group. */
    readonly bindGroupLayouts: readonly BindGroupLayout[];
}

/**
 * A render target: colour attachments plus an optional depth attachment.
 *
 * Replaces today's `Framebuffer` / `CubeFramebuffer` / `LayeredDepthFramebuffer` trio. The three exist
 * separately now because each reallocates its attachments differently; under the RHI the difference
 * collapses into which {@link TextureView}s are attached, which is also how both backends see it.
 */
export interface RenderTarget extends GpuResource {
    readonly colorViews: readonly TextureView[];
    readonly depthView?: TextureView;
    readonly width: number;
    readonly height: number;
}
