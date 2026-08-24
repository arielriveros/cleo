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
    ShaderStageFlags, SamplerDescriptor, ShaderResource, AddressMode, TextureConfigureDescriptor,
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

    // --- uploads -------------------------------------------------------------------------------
    //
    // The engine has half a dozen ways to get pixels into a texture and they are genuinely different
    // operations, not one with a flag: a decoded image, six cube faces, raw bytes, a sub-rectangle,
    // and three kinds of empty storage to render into. Collapsing them into a single `writeTexture`
    // was tried on paper and does not survive contact — an immutable array needs its layer count at
    // allocation, a volume needs its depth, and a cube needs all six faces before it is complete.
    //
    // Every one is self-contained: no bind-then-upload pair. WebGL2 has to bind a texture before
    // `texImage2D` and WebGPU has no such concept, so the bind belongs inside the backend, not in a
    // call the caller has to remember to make first.

    /** Settle the sampling and colour-space state the uploads below apply. Called once, before them. */
    configure(descriptor: TextureConfigureDescriptor): void;

    /** Upload a decoded image, or allocate empty 2D storage when `image` is null. */
    upload2D(image: TexImageSource | null, width: number, height: number, mipMap: boolean): void;

    /** Upload all six cube faces in +X -X +Y -Y +Z -Z order, or allocate six empty ones. */
    uploadCube(images: readonly TexImageSource[] | null, width: number, height: number,
               mipMap: boolean): void;

    /** Upload one cube face, by INDEX into that same order — not a backend face enum. */
    uploadFace(face: number, image: TexImageSource, mipMap: boolean): void;

    /** Upload raw RGBA8 bytes, unflipped and unmipped, so the data maps 1:1 to UVs. */
    uploadBytes(data: Uint8Array, width: number, height: number, wrapping: AddressMode): void;

    /** Patch a sub-rectangle of RGBA8 bytes into existing 2D storage. */
    uploadRegion(x: number, y: number, width: number, height: number, data: Uint8Array): void;

    /** Allocate an empty cubemap with `levels` mips, to render faces into. */
    allocateCube(size: number, levels: number): void;

    /** Allocate an empty 3D volume. */
    allocateVolume(width: number, height: number, depth: number, wrapping: AddressMode): void;

    /** Allocate an empty depth array — the shadow cascades. `compare` selects a comparison sampler. */
    allocateDepthArray(size: number, layers: number, compare: boolean): void;

    /** Turn the comparison sampler on or off. Reading a shadow texture without it is undefined. */
    setCompareMode(enabled: boolean): void;

    generateMipmaps(): void;

    /**
     * Report the dimensions back, once an upload knows them.
     *
     * WebGL2 allocates storage through the upload calls above, so the size is not known at creation
     * — which is why `byteSize` once read 0 for a texture nobody had uploaded to yet, and every render
     * target built from it came out 1x1. WebGPU knows its size up front and can treat this as an
     * assertion rather than a setter.
     */
    setSize(width: number, height: number, depthOrArrayLayers?: number, mipLevelCount?: number): void;
    /**
     * Bumped whenever the underlying handle is REPLACED, never on a write.
     *
     * WebGL2 re-specifies storage in place and keeps its texture object, so this is constant there. A
     * `GPUTexture` fixes its size at creation, so resizing one means destroying it and making another -
     * and every {@link TextureView} taken from the old one then refers to storage that no longer
     * exists. This is how a cache notices. See `WebGPUTexture.setSize`.
     */
    readonly generation: number;
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
    /**
     * The texture's {@link Texture.generation} when this view was taken.
     *
     * A view is only valid for the storage it was made from. Recording which generation that was is
     * what lets a caller that CACHES a view notice the storage underneath it has been replaced -
     * comparing against `texture.generation` costs one number and cannot go stale, whereas comparing
     * dimensions duplicates a condition that lives somewhere else.
     */
    readonly generation: number;
}

export interface Sampler extends GpuResource {
    readonly descriptor: Readonly<SamplerDescriptor>;
}

/**
 * A compiled shader module.
 *
 * On WebGPU this wraps a `GPUShaderModule` built straight from the engine's WGSL; on WebGL2 it wraps
 * the `WebGLShader` compiled from the GLSL ES 300 generated from that same WGSL at build time. One
 * source tree, two dialects, neither hand-maintained.
 *
 * Compilation diagnostics are surfaced through `compilationInfo` rather than by throwing, because the
 * editor's custom-material UI shows the compiler log to the user and needs it whether or not the
 * compile succeeded.
 */
export interface ShaderModule extends GpuResource {
    /** Stages this module provides, ORed. A WGSL module usually carries vertex and fragment both. */
    readonly stage: ShaderStageFlags;
    /** Empty when the module compiled cleanly. */
    readonly compilationInfo: readonly string[];
    /**
     * Entry-point names by stage.
     *
     * WebGPU requires one at pipeline creation and has no `main` convention; WebGL2 ignores them
     * because naga always emits `main`.
     */
    readonly entryPoints: {
        readonly vertex?: string;
        readonly fragment?: string;
        readonly compute?: string;
    };
    /**
     * What this program binds where. Empty for a hand-written GLSL program, which therefore cannot be
     * used with bind groups — see {@link ShaderResource}.
     */
    readonly resources: readonly ShaderResource[];
}

/**
 * What a shader stage expects to be bound, by group and binding index.
 *
 * WebGL2 has no such object — the layout is recovered by reflecting the linked program — so its
 * backend synthesises one and uses it to assign texture units. That indirection was the point, and it
 * paid: the hardcoded `SHADOW_UNIT = 6` / `SPOT_SHADOW_UNIT = 15` constants are gone from renderer.ts,
 * and with them the rule that a custom material silently dropped every sampler past unit 15.
 */
export interface BindGroupLayout extends GpuResource {
    readonly group: number;
}

export interface BindGroup extends GpuResource {
    readonly layout: BindGroupLayout;
}

/**
 * An immutable compute program.
 *
 * Separate from {@link RenderPipeline} rather than a mode of it because the two share nothing a
 * caller can set: no vertex layouts, no primitive state, no colour targets, no depth state. All a
 * dispatch needs is the module and the layouts its bind groups have to satisfy.
 *
 * Deliberately minimal, and meant to stay that way. The engine has exactly ONE compute workload —
 * the cloud-noise volume bake, which a render pass cannot express on WebGPU because an attachment
 * must be a 2D or 2D-array view and a 3D texture's z-slice is neither. Building a general compute
 * system on the strength of one bake would be designing against a sample of one.
 */
export interface ComputePipeline extends GpuResource {
    /** Layouts this pipeline binds, indexed by group. */
    readonly bindGroupLayouts: readonly BindGroupLayout[];
}

export interface RenderPipeline extends GpuResource {
    readonly vertexLayouts: readonly VertexBufferLayout[];
    readonly primitive: Readonly<PrimitiveState>;
    readonly depthStencil?: Readonly<DepthStencilState>;
    readonly colorTargets: readonly ColorTargetState[];
    /** Layouts this pipeline binds, indexed by group. */
    readonly bindGroupLayouts: readonly BindGroupLayout[];
    /**
     * What this pipeline's shader declares, by group and binding.
     *
     * A layout says how many entries a group takes; this says what they MEAN — which is what a caller
     * assembling a material bind group needs in order to know that binding 4 wants the normal map and
     * binding 8 wants the environment cube.
     *
     * It was reached as `(pipeline as any).module.resources`, which is a property only the WebGL2
     * pipeline has. Same shape as every other blind spot in this port: an untyped cast that the backend
     * it was written against happens to satisfy.
     */
    readonly resources: readonly ShaderResource[];
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
