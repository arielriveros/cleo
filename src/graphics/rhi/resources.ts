// GPU resource handles, as the RHI sees them. All interfaces, and none may expose its native object:
// the only thing a caller above the RHI does with a handle is pass it back to the device.
// `destroy()` is explicit on both backends, so lifetime stays the caller's decision.

import type {
    TextureFormat, TextureDimension, TextureUsageFlags, BufferUsageFlags,
    VertexBufferLayout, PrimitiveState, DepthStencilState, ColorTargetState,
    ShaderStageFlags, SamplerDescriptor, ShaderResource, AddressMode, TextureConfigureDescriptor,
} from './types';
// Type-only, so this does not add a module edge at runtime: `device.ts` imports this file back.
import type { CommandEncoder } from './device';

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
    // Genuinely different operations, not one with a flag: an immutable array needs its layer count at
    // allocation, a volume its depth, a cube all six faces. Each is self-contained — no bind-then-upload
    // pair, because WebGPU has no bind and WebGL2's belongs inside the backend.

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

    /**
     * (Re)build levels 1..N from level 0. Pass the caller's open `encoder` — an encoder of its own
     * submits FIRST and builds the chain from a level nothing has written. Omit only once level 0 is queued.
     */
    generateMipmaps(encoder?: CommandEncoder): void;

    /**
     * Report the dimensions back once an upload knows them. A setter on WebGL2, where storage comes
     * from the upload; an assertion on WebGPU, which fixes its size at creation.
     */
    setSize(width: number, height: number, depthOrArrayLayers?: number, mipLevelCount?: number): void;
    /**
     * Bumped whenever the underlying handle is REPLACED, never on a write — how a cache notices that
     * every {@link TextureView} taken from the old storage is now stale. Constant on WebGL2.
     */
    readonly generation: number;
}

/** A view onto part of a texture: one mip, one array layer, one cube face. */
export interface TextureView extends GpuResource {
    readonly texture: Texture;
    readonly baseMipLevel: number;
    readonly baseArrayLayer: number;
    /**
     * The texture's {@link Texture.generation} when this view was taken. A cached view is valid only
     * while this still matches `texture.generation`.
     */
    readonly generation: number;
}

export interface Sampler extends GpuResource {
    readonly descriptor: Readonly<SamplerDescriptor>;
}

/**
 * A compiled shader module — WGSL on WebGPU, the GLSL ES 300 generated from it on WebGL2. Diagnostics
 * come back through `compilationInfo` rather than by throwing, so the editor can show the log either way.
 */
export interface ShaderModule extends GpuResource {
    /** Stages this module provides, ORed. A WGSL module usually carries vertex and fragment both. */
    readonly stage: ShaderStageFlags;
    /** Empty when the module compiled cleanly. */
    readonly compilationInfo: readonly string[];
    /** Entry-point names by stage. Required by WebGPU at pipeline creation; ignored by WebGL2. */
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
 * What a shader stage expects to be bound, by group and binding index. WebGL2 has no such object, so
 * its backend synthesises one from the linked program and uses it to assign texture units.
 */
export interface BindGroupLayout extends GpuResource {
    readonly group: number;
}

export interface BindGroup extends GpuResource {
    readonly layout: BindGroupLayout;
}

/**
 * An immutable compute program: the module, plus the layouts its bind groups must satisfy. Minimal on
 * purpose — the engine has one compute workload, and a general system built on it would be premature.
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
     * What this pipeline's shader declares, by group and binding. A layout says how many entries a
     * group takes; this says what they MEAN, which is what assembling a material bind group needs.
     */
    readonly resources: readonly ShaderResource[];

    /** The layout for one group index, or undefined when the shaders never declared it. */
    layoutForGroup(group: number): BindGroupLayout | undefined;
}

/** A render target: colour attachments plus an optional depth attachment, as {@link TextureView}s. */
export interface RenderTarget extends GpuResource {
    readonly colorViews: readonly TextureView[];
    readonly depthView?: TextureView;
    readonly width: number;
    readonly height: number;
}
