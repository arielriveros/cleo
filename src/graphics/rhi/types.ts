/**
 * Backend-neutral vocabulary for the render hardware interface (RHI).
 *
 * Every name here is WebGPU's, deliberately. The mapping only runs one way: expressing WebGPU's
 * immutable pipelines, bind groups and explicit render passes on top of WebGL2 is routine, while
 * expressing WebGL2's mutable global state on top of WebGPU is not possible at all. So the abstraction
 * is shaped like the stricter of the two APIs, and the WebGL2 backend translates *down* into the
 * deduped `GLState` calls it already makes.
 *
 * String unions rather than numeric enums, for three reasons: they survive `JSON.stringify` into a
 * pipeline-cache key without a lookup table, they read in a debugger, and — the one that actually
 * forced it — a numeric enum would have to pick one backend's constants and would silently become a
 * lie on the other. `TextureConfig` in texture.ts already made this choice for its own options; this
 * is that convention carried across the whole interface.
 *
 * This module is pure data and types. It imports nothing, touches no context, and is safe to load in
 * the DOM-free test suite.
 */

// ------------------------------------------------------------------------------------------------
// Textures
// ------------------------------------------------------------------------------------------------

/**
 * Texture formats the engine can allocate.
 *
 * Only the formats reachable from `TextureConfig` today, plus the two canvas formats a WebGPU swap
 * chain can hand back. Adding one means adding a row to {@link TEXTURE_FORMAT_INFO} — that table is
 * exhaustive over this union, so the compiler names the omission instead of failing at runtime.
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
 * Static properties of a format, kept as one exhaustive table so no backend has to re-derive them.
 *
 * `filterable` is the field that matters most in practice: WebGL2 needs `OES_texture_float_linear`
 * before a 16F/32F texture can be sampled with LINEAR, and WebGPU gates 32F filtering behind the
 * `float32-filterable` feature. Both are optional on real hardware, which is why texture.ts already
 * silently downgrades `precision: 'high'` to RGBA8 when the extension is missing. Naming the property
 * here is what will let a capability check report that downgrade rather than hide it.
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
 * Bytes a mip chain of `format` occupies at these dimensions.
 *
 * Mips converge on 4/3 of the base level, but the renderer reports GPU memory per resource in the
 * stats panel and a closed-form 4/3 would drift from what `Texture.byteSize` already reports. So this
 * sums the real levels, each dimension halved and floored at 1 — which is what both APIs allocate.
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

/**
 * The sampling and colour-space state a texture applies to every upload that follows.
 *
 * Settled once rather than passed to each upload because it is a property of the TEXTURE, not of any
 * one write: the same cube gets six faces and a mip chain, and all seven operations have to agree
 * about filtering and flip. Depth is called out explicitly because it overrides both — a depth
 * texture is forced to NEAREST/CLAMP whatever was asked for, and filtering one is undefined.
 */
export interface TextureConfigureDescriptor {
    readonly format: TextureFormat;
    readonly addressMode: AddressMode;
    readonly minFilter: 'nearest' | 'linear' | 'linear-mipmap-linear';
    /** Images arrive top-left-origin and GL samples bottom-left; false flips on upload. */
    readonly flipY: boolean;
    readonly isDepth: boolean;
}
export type FilterMode = 'nearest' | 'linear';

export interface SamplerDescriptor {
    addressModeU?: AddressMode;
    addressModeV?: AddressMode;
    addressModeW?: AddressMode;
    magFilter?: FilterMode;
    minFilter?: FilterMode;
    mipmapFilter?: FilterMode;
    /**
     * Makes this a comparison sampler — `sampler2DArrayShadow` in GLSL, `sampler_comparison` in WGSL.
     * Set for the shadow cascades and the spot atlas, which sample with hardware depth compare rather
     * than reading depth back and comparing by hand. See shaders/environment/shadows.glsl.
     */
    compare?: CompareFunction;
    maxAnisotropy?: number;
}

// ------------------------------------------------------------------------------------------------
// Buffers and vertex layout
// ------------------------------------------------------------------------------------------------

/**
 * Buffer usage flags, combined with a bitwise OR.
 *
 * Bit flags rather than a string union because usages genuinely compose — a vertex buffer rewritten
 * every frame is `VERTEX | COPY_DST` — and both APIs model them as a mask. `STORAGE` and `INDIRECT`
 * have no WebGL2 equivalent at all; they are declared here because compute skinning and GPU-driven
 * culling are the point of the port, and a backend that cannot honour them should say so through
 * {@link DeviceCapabilities} rather than by lacking the vocabulary.
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
 * One `@group(G) @binding(B)` a program declares, as reflected from its WGSL at build time.
 *
 * This is what makes a {@link BindGroup} satisfiable on both backends. WebGPU binds by group and
 * binding directly. WebGL2 has neither concept, so its backend assigns a texture unit and sets the
 * combined sampler uniform named by `glslName` — which is why the GLSL name travels alongside the WGSL
 * one rather than being recomputed.
 *
 * A texture and its sampler share a `glslName`: WGSL keeps them apart, GLSL ES has only combined
 * samplers, so `u_x_texture` and `u_x_sampler` are one `uniform sampler2D u_x`. The WebGL2 backend acts
 * on the texture entry and skips the sampler one; WebGPU honours both.
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

/**
 * Vertex attribute formats.
 *
 * The engine's own layouts are entirely float32 today — including bone indices, which ride as floats
 * inside the 14-float interleaved skinned vertex rather than as integers. The integer formats are
 * declared anyway because a WebGPU pipeline must name a format for every attribute, and packing bone
 * indices as `uint8x4` is the obvious first win once the layout is explicit rather than inferred from
 * attribute names.
 */
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
     * Attribute name as the shader declares it. Carried alongside `shaderLocation` because the WebGL2
     * backend still resolves attributes by name through `getActiveAttrib` — exactly what `Mesh` does
     * today via its `_CANON_ATTR` table — while a WebGPU pipeline binds purely by location.
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
 * The engine's default: straight alpha-over for colour, and the destination alpha left ALONE.
 *
 * Exactly what `Renderer._restoreDefaultBlend` sets — `blendFuncSeparate(SRC_ALPHA,
 * ONE_MINUS_SRC_ALPHA, ZERO, ONE)` — and it has to be, because the alpha channel of the scene buffer
 * is the bloom mask, not coverage. `zero`/`one` on the alpha half IS what "surviving the colour blend
 * intact" means: a bare `gl.blendFunc` restore that forgot the alpha half is precisely the bug that
 * once made bloom emit nothing at all.
 *
 * This constant previously said `one`/`one-minus-src-alpha` for alpha under that same comment, which
 * would accumulate coverage into the mask and dim every bloom source behind a transparent object.
 * Nothing used it yet, so the error was inert; the forward pass was the first thing to reach for it.
 */
export const DEFAULT_BLEND: BlendState = {
    color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
    alpha: { srcFactor: 'zero',      dstFactor: 'one',                 operation: 'add' },
};

/** Additive, for the god-ray composite and the bloom upsample chain. */
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
 * What happens to an attachment at the start of a pass.
 *
 * The distinction is nearly free on desktop WebGL2 but load-bearing on tile-based mobile GPUs, where
 * `'clear'` spares the driver reading the previous contents back into tile memory. The engine issues
 * `gl.clear` by hand at the top of most passes today; making it part of the descriptor is what turns
 * that into a real optimisation rather than a redundant write.
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
    /**
     * Render into one layer of a `2d-array` depth target, or one face of a cube.
     *
     * This is the shadow cascades and the spot atlas. WebGL2 reaches a layer through
     * `framebufferTextureLayer`; WebGPU through `createView({ baseArrayLayer })`. Both are expressible,
     * which is why the cascade array survives the port unchanged — see LayeredDepthFramebuffer.
     */
    baseArrayLayer?: number;
}

export interface RenderPassDescriptor {
    /**
     * Name matching a `RenderPass` in gpuProfiler.ts, so a pass boundary and a profiler scope are one
     * thing rather than two lists that drift apart.
     */
    label: string;
    colorAttachments: ColorAttachmentDescriptor[];
    depthAttachment?: DepthAttachmentDescriptor;
}
