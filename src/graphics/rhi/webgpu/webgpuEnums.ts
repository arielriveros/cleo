/**
 * RHI vocabulary → WebGPU vocabulary.
 *
 * Most of these tables are the identity map, and that is not an accident: `rhi/types.ts` deliberately
 * took WebGPU's names so that the mapping which *cannot* be lossless — WebGPU's immutable pipelines
 * onto WebGL2's mutable global state — is the one that runs downhill. Writing the identity out anyway
 * buys something a cast would not: each table is an exhaustive `Record` over its union, so adding an
 * RHI format or blend factor fails to compile until somebody decides what WebGPU should do with it.
 *
 * Three mappings are genuinely NOT the identity, and they are the reason this module exists rather than
 * a handful of `as GPUTextureFormat` casts scattered through the device:
 *
 * - **Dimension.** RHI (and WebGL2) treat `2d-array` and `cube` as texture *shapes*. WebGPU does not:
 *   a `GPUTextureDimension` is only `1d` / `2d` / `3d`, and array-ness and cube-ness are properties of
 *   the *view*. So one RHI dimension becomes a texture dimension plus a view dimension plus a layer
 *   count, which is exactly the split {@link gpuTextureDimension}, {@link gpuViewDimension} and
 *   {@link layersForDimension} make explicit.
 * - **Usage flags.** `BufferUsage` / `TextureUsage` / `ShaderStage` are our own bit values and do not
 *   coincide with `GPUBufferUsage` / `GPUTextureUsage` / `GPUShaderStage`. Passing ours straight
 *   through would be accepted by the API and produce a resource with the wrong permissions.
 * - **Depth formats.** A depth attachment cannot be a colour target, and WebGPU rejects it loudly
 *   rather than silently, so {@link gpuTextureFormat} is paired with `isDepthFormat` at every use.
 */

import {
    BufferUsage, TextureUsage, ShaderStage,
    type TextureFormat, type TextureDimension, type BufferUsageFlags, type TextureUsageFlags,
    type ShaderStageFlags, type AddressMode, type FilterMode, type CompareFunction,
    type BlendFactor, type BlendOperation, type CullMode, type FrontFace,
    type PrimitiveTopology, type IndexFormat, type VertexFormat, type LoadOp, type StoreOp,
} from '../types';

// ------------------------------------------------------------------------------------------------
// Textures
// ------------------------------------------------------------------------------------------------

/**
 * Every format in the RHI union is spelled the same way in WebGPU.
 *
 * That is true today because the union was chosen from WebGPU's list; it is written out so it stays
 * true. `rgba32float` is here, but note that *filtering* it needs the optional `float32-filterable`
 * feature — the device requests it when the adapter offers it and reports the outcome through
 * `DeviceCapabilities.floatFilterable`.
 */
const TEXTURE_FORMAT: Readonly<Record<TextureFormat, GPUTextureFormat>> = {
    'r8unorm': 'r8unorm',
    'r16float': 'r16float',
    'rgba8unorm': 'rgba8unorm',
    'rgba8unorm-srgb': 'rgba8unorm-srgb',
    'bgra8unorm': 'bgra8unorm',
    'rgba16float': 'rgba16float',
    'rgba32float': 'rgba32float',
    'depth24plus': 'depth24plus',
    'depth32float': 'depth32float',
};
export function gpuTextureFormat(format: TextureFormat): GPUTextureFormat { return TEXTURE_FORMAT[format]; }

/** The reverse map, for reporting a swap-chain format the RHI did not choose. */
export function rhiTextureFormat(format: GPUTextureFormat): TextureFormat {
    for (const key of Object.keys(TEXTURE_FORMAT) as TextureFormat[]) {
        if (TEXTURE_FORMAT[key] === format) return key;
    }
    // Only reachable if a browser reports a preferred canvas format outside our union. Falling back to
    // the one every implementation supports is better than allocating a target nothing can present.
    return 'rgba8unorm';
}

/** The underlying storage shape. Array and cube textures are both plain 2D textures with layers. */
const TEXTURE_DIMENSION: Readonly<Record<TextureDimension, GPUTextureDimension>> = {
    '2d': '2d',
    '2d-array': '2d',
    '3d': '3d',
    'cube': '2d',
};
export function gpuTextureDimension(dimension: TextureDimension): GPUTextureDimension {
    return TEXTURE_DIMENSION[dimension];
}

/** How a shader sees it. This is where `2d-array` and `cube` actually live in WebGPU. */
const VIEW_DIMENSION: Readonly<Record<TextureDimension, GPUTextureViewDimension>> = {
    '2d': '2d',
    '2d-array': '2d-array',
    '3d': '3d',
    'cube': 'cube',
};
export function gpuViewDimension(dimension: TextureDimension): GPUTextureViewDimension {
    return VIEW_DIMENSION[dimension];
}

/**
 * Layer count implied by the shape, before the descriptor's own request is considered.
 *
 * A cube is six layers by definition and a caller that says otherwise is wrong; everything else takes
 * whatever it asked for, defaulting to one.
 */
export function layersForDimension(dimension: TextureDimension, requested: number | undefined): number {
    if (dimension === 'cube') return 6;
    return Math.max(1, Math.floor(requested ?? 1));
}

// ------------------------------------------------------------------------------------------------
// Usage flags
// ------------------------------------------------------------------------------------------------

/**
 * Our bits are not WebGPU's bits.
 *
 * `BufferUsage.VERTEX` is 0x0001 while `GPUBufferUsage.VERTEX` is 0x0020, so handing our mask straight
 * to `createBuffer` yields a buffer with a plausible-looking but wrong usage set — one that fails at
 * the first bind rather than at creation.
 */
export function gpuBufferUsage(usage: BufferUsageFlags): GPUBufferUsageFlags {
    let out = 0;
    if (usage & BufferUsage.VERTEX) out |= GPUBufferUsage.VERTEX;
    if (usage & BufferUsage.INDEX) out |= GPUBufferUsage.INDEX;
    if (usage & BufferUsage.UNIFORM) out |= GPUBufferUsage.UNIFORM;
    if (usage & BufferUsage.STORAGE) out |= GPUBufferUsage.STORAGE;
    if (usage & BufferUsage.INDIRECT) out |= GPUBufferUsage.INDIRECT;
    if (usage & BufferUsage.COPY_SRC) out |= GPUBufferUsage.COPY_SRC;
    if (usage & BufferUsage.COPY_DST) out |= GPUBufferUsage.COPY_DST;
    return out;
}

export function gpuTextureUsage(usage: TextureUsageFlags): GPUTextureUsageFlags {
    let out = 0;
    if (usage & TextureUsage.COPY_SRC) out |= GPUTextureUsage.COPY_SRC;
    if (usage & TextureUsage.COPY_DST) out |= GPUTextureUsage.COPY_DST;
    if (usage & TextureUsage.TEXTURE_BINDING) out |= GPUTextureUsage.TEXTURE_BINDING;
    if (usage & TextureUsage.STORAGE_BINDING) out |= GPUTextureUsage.STORAGE_BINDING;
    if (usage & TextureUsage.RENDER_ATTACHMENT) out |= GPUTextureUsage.RENDER_ATTACHMENT;
    return out;
}

export function gpuShaderStage(stage: ShaderStageFlags): GPUShaderStageFlags {
    let out = 0;
    if (stage & ShaderStage.VERTEX) out |= GPUShaderStage.VERTEX;
    if (stage & ShaderStage.FRAGMENT) out |= GPUShaderStage.FRAGMENT;
    if (stage & ShaderStage.COMPUTE) out |= GPUShaderStage.COMPUTE;
    return out;
}

// ------------------------------------------------------------------------------------------------
// Samplers
// ------------------------------------------------------------------------------------------------

const ADDRESS_MODE: Readonly<Record<AddressMode, GPUAddressMode>> = {
    'clamp-to-edge': 'clamp-to-edge',
    'repeat': 'repeat',
    'mirror-repeat': 'mirror-repeat',
};
export function gpuAddressMode(mode: AddressMode): GPUAddressMode { return ADDRESS_MODE[mode]; }

const FILTER_MODE: Readonly<Record<FilterMode, GPUFilterMode>> = {
    'nearest': 'nearest',
    'linear': 'linear',
};
export function gpuFilterMode(mode: FilterMode): GPUFilterMode { return FILTER_MODE[mode]; }

const COMPARE: Readonly<Record<CompareFunction, GPUCompareFunction>> = {
    'never': 'never',
    'less': 'less',
    'equal': 'equal',
    'less-equal': 'less-equal',
    'greater': 'greater',
    'not-equal': 'not-equal',
    'greater-equal': 'greater-equal',
    'always': 'always',
};
export function gpuCompare(fn: CompareFunction): GPUCompareFunction { return COMPARE[fn]; }

// ------------------------------------------------------------------------------------------------
// Pipeline state
// ------------------------------------------------------------------------------------------------

const BLEND_FACTOR: Readonly<Record<BlendFactor, GPUBlendFactor>> = {
    'zero': 'zero',
    'one': 'one',
    'src': 'src',
    'one-minus-src': 'one-minus-src',
    'src-alpha': 'src-alpha',
    'one-minus-src-alpha': 'one-minus-src-alpha',
    'dst': 'dst',
    'one-minus-dst': 'one-minus-dst',
    'dst-alpha': 'dst-alpha',
    'one-minus-dst-alpha': 'one-minus-dst-alpha',
};
export function gpuBlendFactor(factor: BlendFactor): GPUBlendFactor { return BLEND_FACTOR[factor]; }

const BLEND_OP: Readonly<Record<BlendOperation, GPUBlendOperation>> = {
    'add': 'add',
    'subtract': 'subtract',
    'reverse-subtract': 'reverse-subtract',
    'min': 'min',
    'max': 'max',
};
export function gpuBlendOperation(op: BlendOperation): GPUBlendOperation { return BLEND_OP[op]; }

const CULL_MODE: Readonly<Record<CullMode, GPUCullMode>> = {
    'none': 'none',
    'front': 'front',
    'back': 'back',
};
export function gpuCullMode(mode: CullMode): GPUCullMode { return CULL_MODE[mode]; }

const FRONT_FACE: Readonly<Record<FrontFace, GPUFrontFace>> = { 'ccw': 'ccw', 'cw': 'cw' };
export function gpuFrontFace(face: FrontFace): GPUFrontFace { return FRONT_FACE[face]; }

const TOPOLOGY: Readonly<Record<PrimitiveTopology, GPUPrimitiveTopology>> = {
    'point-list': 'point-list',
    'line-list': 'line-list',
    'line-strip': 'line-strip',
    'triangle-list': 'triangle-list',
    'triangle-strip': 'triangle-strip',
};
export function gpuTopology(topology: PrimitiveTopology): GPUPrimitiveTopology { return TOPOLOGY[topology]; }

const INDEX_FORMAT: Readonly<Record<IndexFormat, GPUIndexFormat>> = {
    'uint16': 'uint16',
    'uint32': 'uint32',
};
export function gpuIndexFormat(format: IndexFormat): GPUIndexFormat { return INDEX_FORMAT[format]; }

const VERTEX_FORMAT: Readonly<Record<VertexFormat, GPUVertexFormat>> = {
    'float32': 'float32',
    'float32x2': 'float32x2',
    'float32x3': 'float32x3',
    'float32x4': 'float32x4',
    'uint8x4': 'uint8x4',
    'unorm8x4': 'unorm8x4',
    'uint16x2': 'uint16x2',
    'uint16x4': 'uint16x4',
    'sint32': 'sint32',
    'sint32x2': 'sint32x2',
    'sint32x3': 'sint32x3',
    'sint32x4': 'sint32x4',
    'uint32': 'uint32',
    'uint32x2': 'uint32x2',
    'uint32x3': 'uint32x3',
    'uint32x4': 'uint32x4',
};
export function gpuVertexFormat(format: VertexFormat): GPUVertexFormat { return VERTEX_FORMAT[format]; }

const STEP_MODE = { 'vertex': 'vertex', 'instance': 'instance' } as const;
export function gpuStepMode(mode: 'vertex' | 'instance'): GPUVertexStepMode { return STEP_MODE[mode]; }

// ------------------------------------------------------------------------------------------------
// Render passes
// ------------------------------------------------------------------------------------------------

const LOAD_OP: Readonly<Record<LoadOp, GPULoadOp>> = { 'load': 'load', 'clear': 'clear' };
export function gpuLoadOp(op: LoadOp): GPULoadOp { return LOAD_OP[op]; }

const STORE_OP: Readonly<Record<StoreOp, GPUStoreOp>> = { 'store': 'store', 'discard': 'discard' };
export function gpuStoreOp(op: StoreOp): GPUStoreOp { return STORE_OP[op]; }

/**
 * Per-channel write mask → `GPUColorWriteFlags`.
 *
 * Defaults to all four channels, matching `ColorTargetState.writeMask`'s documented default and
 * WebGL2's `colorMask(true, true, true, true)`.
 */
export function gpuColorWriteMask(mask: readonly [boolean, boolean, boolean, boolean] | undefined): GPUColorWriteFlags {
    if (!mask) return GPUColorWrite.ALL;
    let out = 0;
    if (mask[0]) out |= GPUColorWrite.RED;
    if (mask[1]) out |= GPUColorWrite.GREEN;
    if (mask[2]) out |= GPUColorWrite.BLUE;
    if (mask[3]) out |= GPUColorWrite.ALPHA;
    return out;
}
