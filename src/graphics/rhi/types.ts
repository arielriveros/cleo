// Backend-neutral vocabulary for the render hardware interface. Every name is WebGPU's, because the
// mapping only runs one way: WebGPU's stricter model expresses on WebGL2, not the reverse.
// String unions, never numeric enums — an enum would have to pick one backend's constants.
// Pure data and types: imports nothing, touches no context.

// ------------------------------------------------------------------------------------------------
// Textures
// ------------------------------------------------------------------------------------------------

/**
 * Texture formats the engine can allocate. Adding one requires a row in {@link TEXTURE_FORMAT_INFO},
 * which is exhaustive over this union.
 */
export type TextureFormat =
    | 'r8unorm'
    | 'r16float'
    | 'rgba8unorm'
    | 'rgba8unorm-srgb'
    | 'bgra8unorm'
    | 'rgba16float'
    | 'rgba32float'
    | 'depth24plus'
    | 'depth32float';

/** What a format holds. Depth formats are never colour-attachable and never blendable. */
export type TextureAspect = 'color' | 'depth';

/** Shape of a texture, matching the four targets `TextureConfig.target` already exposes. */
export type TextureDimension = '2d' | '2d-array' | '3d' | 'cube';

/**
 * Static properties of a format, as one exhaustive table so no backend re-derives them. `filterable`
 * is optional on real hardware on both backends, which is what drives the RGBA8 downgrade.
 */
export interface TextureFormatInfo {
    readonly aspect: TextureAspect;
    readonly bytesPerTexel: number;
    /** Colour channels stored. Drives byte-size accounting, not the sampling swizzle. */
    readonly channels: number;
    /** Can be a render-pass colour (or depth) attachment. */
    readonly renderable: boolean;
    /** Can be sampled with a linear filter *without* an optional feature being present. */
    readonly filterable: boolean;
}

export const TEXTURE_FORMAT_INFO: Readonly<Record<TextureFormat, TextureFormatInfo>> = {
    'r8unorm':         { aspect: 'color', bytesPerTexel: 1,  channels: 1, renderable: true, filterable: true  },
    'r16float':        { aspect: 'color', bytesPerTexel: 2,  channels: 1, renderable: true, filterable: false },
    'rgba8unorm':      { aspect: 'color', bytesPerTexel: 4,  channels: 4, renderable: true, filterable: true  },
    'rgba8unorm-srgb': { aspect: 'color', bytesPerTexel: 4,  channels: 4, renderable: true, filterable: true  },
    'bgra8unorm':      { aspect: 'color', bytesPerTexel: 4,  channels: 4, renderable: true, filterable: true  },
    'rgba16float':     { aspect: 'color', bytesPerTexel: 8,  channels: 4, renderable: true, filterable: false },
    'rgba32float':     { aspect: 'color', bytesPerTexel: 16, channels: 4, renderable: true, filterable: false },
    'depth24plus':     { aspect: 'depth', bytesPerTexel: 4,  channels: 1, renderable: true, filterable: false },
    'depth32float':    { aspect: 'depth', bytesPerTexel: 4,  channels: 1, renderable: true, filterable: false },
};

/** Whether `format` carries depth rather than colour. */
export function isDepthFormat(format: TextureFormat): boolean {
    return TEXTURE_FORMAT_INFO[format].aspect === 'depth';
}

/**
 * Bytes a mip chain of `format` occupies at these dimensions. Sums the real levels rather than using
 * the closed-form 4/3, so it matches what both APIs actually allocate.
 */
export function textureByteSize(
    format: TextureFormat, width: number, height: number, depthOrLayers: number = 1, mipCount: number = 1,
): number {
    const texel = TEXTURE_FORMAT_INFO[format].bytesPerTexel;
    const layers = Math.max(1, Math.floor(depthOrLayers));
    let total = 0;
    let w = Math.max(1, Math.floor(width));
    let h = Math.max(1, Math.floor(height));
    for (let level = 0; level < Math.max(1, mipCount); level++) {
        total += w * h * layers * texel;
        if (w === 1 && h === 1) break;
        w = Math.max(1, w >> 1);
        h = Math.max(1, h >> 1);
    }
    return total;
}

// ------------------------------------------------------------------------------------------------
// Samplers
// ------------------------------------------------------------------------------------------------

export type AddressMode = 'clamp-to-edge' | 'repeat' | 'mirror-repeat';
export type FilterMode = 'nearest' | 'linear';

/**
 * The sampling and colour-space state a texture applies to every upload that follows — a property of
 * the texture, not of a write. Depth overrides it: forced to NEAREST/CLAMP whatever was asked for.
 *
 * May be applied MORE THAN ONCE. Re-configuring retunes a texture that already holds pixels, which is
 * what lets the editor change wrap/filter/anisotropy without re-decoding the image — see
 * `Texture.applySettings`. A backend must therefore treat this as a write to live state, not as part
 * of construction.
 */
export interface TextureConfigureDescriptor {
    readonly format: TextureFormat;
    /** Per axis. W addresses the third axis of a 3D volume and is ignored by 2D and cube targets. */
    readonly addressModeU: AddressMode;
    readonly addressModeV: AddressMode;
    readonly addressModeW: AddressMode;
    readonly minFilter: FilterMode;
    readonly magFilter: FilterMode;
    /**
     * The filter BETWEEN mip levels, or null for "this texture has no mip chain" — the exact pair
     * {@link glMinFilter} takes, rather than WebGL2's fused single enum. Fusing them here used to lose
     * the chain on a nearest-minified texture, which had no spelling in the old union.
     */
    readonly mipmapFilter: FilterMode | null;
    /**
     * Samples along the axis of anisotropy; 1 disables it. Backends clamp to
     * {@link DeviceCapabilities.maxAnisotropy}, and force it back to 1 unless all three filters are
     * linear — WebGPU rejects such a sampler outright, and WebGL2 would silently ignore it.
     */
    readonly maxAnisotropy: number;
    /** The mip range the sampler may read. Omitted means the whole chain. */
    readonly lodMinClamp?: number;
    readonly lodMaxClamp?: number;
    /**
     * TRUE flips the image vertically on upload. Images arrive top-left-origin and GL samples
     * bottom-left, so an unflipped upload reads upside down.
     *
     * Note the polarity: `TextureConfig.flipY` one layer up means the OPPOSITE, and has to, because its
     * `false` default is baked into every project saved to date. `Texture`'s constructor is the one
     * place that inverts, and this descriptor is truthful from here down.
     */
    readonly flipY: boolean;
    readonly isDepth: boolean;
}

export interface SamplerDescriptor {
    addressModeU?: AddressMode;
    addressModeV?: AddressMode;
    addressModeW?: AddressMode;
    magFilter?: FilterMode;
    minFilter?: FilterMode;
    mipmapFilter?: FilterMode;
    /**
     * Makes this a comparison sampler — `sampler2DArrayShadow` in GLSL, `sampler_comparison` in WGSL.
     * Set for the shadow cascades and the spot atlas.
     */
    compare?: CompareFunction;
    maxAnisotropy?: number;
    /** The mip range this sampler may read. Omitted means the whole chain. */
    lodMinClamp?: number;
    lodMaxClamp?: number;
}

// ------------------------------------------------------------------------------------------------
// Buffers and vertex layout
// ------------------------------------------------------------------------------------------------

/**
 * Buffer usage flags, combined with a bitwise OR. `STORAGE` and `INDIRECT` have no WebGL2 equivalent;
 * a backend that cannot honour them reports so through {@link DeviceCapabilities}.
 */
export const BufferUsage = {
    VERTEX:   0x0001,
    INDEX:    0x0002,
    UNIFORM:  0x0004,
    STORAGE:  0x0008,
    INDIRECT: 0x0010,
    COPY_SRC: 0x0020,
    COPY_DST: 0x0040,
} as const;
export type BufferUsageFlags = number;

/** Texture usage flags, combined with a bitwise OR. Mirrors `GPUTextureUsage`. */
export const TextureUsage = {
    COPY_SRC:          0x01,
    COPY_DST:          0x02,
    TEXTURE_BINDING:   0x04,
    STORAGE_BINDING:   0x08,
    RENDER_ATTACHMENT: 0x10,
} as const;
export type TextureUsageFlags = number;

/** Shader stage flags, combined with a bitwise OR. */
export const ShaderStage = {
    VERTEX:   0x1,
    FRAGMENT: 0x2,
    COMPUTE:  0x4,
} as const;
export type ShaderStageFlags = number;

/**
 * One `@group(G) @binding(B)` a program declares, reflected from its WGSL at build time. A texture and
 * its sampler SHARE a `glslName`, which is what WebGL2 binds through, so it skips the sampler entry.
 */
export interface ShaderResource {
    readonly group: number;
    readonly binding: number;
    /** The identifier as written in WGSL. */
    readonly name: string;
    readonly kind: 'texture' | 'sampler' | 'uniform' | 'storage' | 'other';
    /** The WGSL type — `texture_2d<f32>`, `sampler_comparison`, or a struct name. */
    readonly type: string;
    /** The name the generated GLSL uses. A texture/sampler pair collapses onto one. */
    readonly glslName: string;
}

/** Vertex attribute formats. The engine's own layouts are float32 throughout, bone indices included. */
export type VertexFormat =
    | 'float32' | 'float32x2' | 'float32x3' | 'float32x4'
    | 'uint8x4' | 'unorm8x4'
    | 'uint16x2' | 'uint16x4'
    | 'sint32' | 'sint32x2' | 'sint32x3' | 'sint32x4'
    | 'uint32' | 'uint32x2' | 'uint32x3' | 'uint32x4';

const VERTEX_FORMAT_SIZE: Readonly<Record<VertexFormat, number>> = {
    'float32': 4, 'float32x2': 8, 'float32x3': 12, 'float32x4': 16,
    'uint8x4': 4, 'unorm8x4': 4,
    'uint16x2': 4, 'uint16x4': 8,
    'sint32': 4, 'sint32x2': 8, 'sint32x3': 12, 'sint32x4': 16,
    'uint32': 4, 'uint32x2': 8, 'uint32x3': 12, 'uint32x4': 16,
};

/** Bytes one attribute of `format` occupies. */
export function vertexFormatSize(format: VertexFormat): number { return VERTEX_FORMAT_SIZE[format]; }

export interface VertexAttribute {
    /**
     * Attribute name as the shader declares it. Carried alongside `shaderLocation` because WebGL2
     * resolves attributes by name; a WebGPU pipeline binds purely by location.
     */
    name: string;
    shaderLocation: number;
    offset: number;
    format: VertexFormat;
}

/** How the buffer advances: per vertex, or per instance (WebGL2's `vertexAttribDivisor(1)`). */
export type VertexStepMode = 'vertex' | 'instance';

export interface VertexBufferLayout {
    arrayStride: number;
    stepMode: VertexStepMode;
    attributes: VertexAttribute[];
}

/** Sum of the declared attribute sizes. Not necessarily `arrayStride` — a layout may be padded. */
export function packedLayoutSize(layout: VertexBufferLayout): number {
    let total = 0;
    for (const attribute of layout.attributes) total += vertexFormatSize(attribute.format);
    return total;
}

export type IndexFormat = 'uint16' | 'uint32';

// ------------------------------------------------------------------------------------------------
// Pipeline state
// ------------------------------------------------------------------------------------------------

export type PrimitiveTopology = 'point-list' | 'line-list' | 'line-strip' | 'triangle-list' | 'triangle-strip';
export type CullMode = 'none' | 'front' | 'back';
export type FrontFace = 'ccw' | 'cw';

export type CompareFunction =
    | 'never' | 'less' | 'equal' | 'less-equal' | 'greater' | 'not-equal' | 'greater-equal' | 'always';

export type BlendFactor =
    | 'zero' | 'one'
    | 'src' | 'one-minus-src' | 'src-alpha' | 'one-minus-src-alpha'
    | 'dst' | 'one-minus-dst' | 'dst-alpha' | 'one-minus-dst-alpha';

export type BlendOperation = 'add' | 'subtract' | 'reverse-subtract' | 'min' | 'max';

export interface BlendComponent {
    srcFactor: BlendFactor;
    dstFactor: BlendFactor;
    operation: BlendOperation;
}

export interface BlendState {
    color: BlendComponent;
    alpha: BlendComponent;
}

/**
 * The engine's default: alpha-over for colour, destination alpha left ALONE. The alpha half must stay
 * `zero`/`one` — the scene buffer's alpha channel is the bloom mask, not coverage.
 */
export const DEFAULT_BLEND: BlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero',      dstFactor: 'one',                 operation: 'add' },
};

/** Additive, for the god-ray composite and the bloom upsample chain. */
/** Whether a topology rasterises triangles. Strips and fans count, which a `=== TRIANGLES` test misses. */
export function isTriangleTopology(topology: PrimitiveTopology): boolean {
    return topology === 'triangle-list' || topology === 'triangle-strip';
}

export const ADDITIVE_BLEND: BlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
};

export interface ColorTargetState {
    format: TextureFormat;
    /** Absent means blending is disabled for this target. */
    blend?: BlendState;
    /** Per-channel write mask, RGBA order. Defaults to all four enabled. */
    writeMask?: [boolean, boolean, boolean, boolean];
}

export interface DepthStencilState {
    format: TextureFormat;
    depthWriteEnabled: boolean;
    depthCompare: CompareFunction;
    /** Constant and slope-scaled depth bias, as the shadow passes use. */
    depthBias?: number;
    depthBiasSlopeScale?: number;
}

export interface PrimitiveState {
    topology: PrimitiveTopology;
    cullMode: CullMode;
    frontFace: FrontFace;
    /** Only meaningful for a strip topology that needs a primitive-restart value. */
    stripIndexFormat?: IndexFormat;
}

// ------------------------------------------------------------------------------------------------
// Render passes
// ------------------------------------------------------------------------------------------------

/**
 * What happens to an attachment at the start of a pass. Nearly free on desktop, load-bearing on
 * tile-based GPUs where `'clear'` spares reading the previous contents into tile memory.
 */
export type LoadOp = 'load' | 'clear';

/** Whether results are kept. `'discard'` frees a tile-based GPU from writing them out at all. */
export type StoreOp = 'store' | 'discard';

export interface ColorAttachmentDescriptor {
    /** Index into the render target's colour attachments. */
    target: number;
    loadOp: LoadOp;
    storeOp: StoreOp;
    /** RGBA. Only read when `loadOp` is `'clear'`. */
    clearValue?: [number, number, number, number];
}

export interface DepthAttachmentDescriptor {
    loadOp: LoadOp;
    storeOp: StoreOp;
    /** Only read when `loadOp` is `'clear'`. */
    clearValue?: number;
    /** Render into one layer of a `2d-array` depth target, or one cube face: the shadow cascades and spot atlas. */
    baseArrayLayer?: number;
}

export interface RenderPassDescriptor {
    /**
     * What this pass is called: debug marker, GPU-timing row, and the WebGPU profiler's attribution key.
     * NOT the same name space as `RenderPass` in gpuProfiler.ts — `PASS_LABEL_TO_SCOPE` is the mapping.
     */
    label: string;
    colorAttachments: ColorAttachmentDescriptor[];
    depthAttachment?: DepthAttachmentDescriptor;
}
