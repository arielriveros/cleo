/**
 * The RHI's string vocabulary translated into WebGL2's numeric enums.
 *
 * The constants are written out as literals rather than read off a `WebGL2RenderingContext`, which is
 * the same call `indexFormat.ts` already makes for `GL_UNSIGNED_SHORT` / `GL_UNSIGNED_INT`. Two
 * reasons, and the second is the one that matters: the values are frozen by the specification and can
 * never change, and hardcoding them keeps this module free of a context — so the whole translation
 * layer is reachable from the DOM-free vitest suite, where a wrong table would otherwise only ever
 * surface as a mis-rendered frame.
 *
 * `tests/glEnums.test.ts` covers the tables here; `scratchpad/enumCheck` verifies them once against a
 * real context, because a literal that is merely self-consistent is still wrong if it is the wrong
 * literal.
 */

import type {
    PrimitiveTopology, CompareFunction, BlendFactor, BlendOperation, CullMode, FrontFace,
    AddressMode, FilterMode, IndexFormat, TextureFormat, TextureDimension, VertexFormat,
} from '../types';

// ------------------------------------------------------------------------------------------------
// Raw WebGL2 enum values
// ------------------------------------------------------------------------------------------------

const GL = {
    // Primitive topology
    POINTS: 0x0000, LINES: 0x0001, LINE_STRIP: 0x0003, TRIANGLES: 0x0004, TRIANGLE_STRIP: 0x0005,

    // Depth / stencil comparison
    NEVER: 0x0200, LESS: 0x0201, EQUAL: 0x0202, LEQUAL: 0x0203,
    GREATER: 0x0204, NOTEQUAL: 0x0205, GEQUAL: 0x0206, ALWAYS: 0x0207,

    // Blend factors
    ZERO: 0, ONE: 1,
    SRC_COLOR: 0x0300, ONE_MINUS_SRC_COLOR: 0x0301,
    SRC_ALPHA: 0x0302, ONE_MINUS_SRC_ALPHA: 0x0303,
    DST_ALPHA: 0x0304, ONE_MINUS_DST_ALPHA: 0x0305,
    DST_COLOR: 0x0306, ONE_MINUS_DST_COLOR: 0x0307,

    // Blend equations
    FUNC_ADD: 0x8006, MIN: 0x8007, MAX: 0x8008,
    FUNC_SUBTRACT: 0x800A, FUNC_REVERSE_SUBTRACT: 0x800B,

    // Face culling / winding
    FRONT: 0x0404, BACK: 0x0405, FRONT_AND_BACK: 0x0408,
    CW: 0x0900, CCW: 0x0901,

    // Filtering
    NEAREST: 0x2600, LINEAR: 0x2601,
    NEAREST_MIPMAP_NEAREST: 0x2700, LINEAR_MIPMAP_NEAREST: 0x2701,
    NEAREST_MIPMAP_LINEAR: 0x2702, LINEAR_MIPMAP_LINEAR: 0x2703,

    // Wrapping
    REPEAT: 0x2901, CLAMP_TO_EDGE: 0x812F, MIRRORED_REPEAT: 0x8370,

    // Data types
    BYTE: 0x1400, UNSIGNED_BYTE: 0x1401, SHORT: 0x1402, UNSIGNED_SHORT: 0x1403,
    INT: 0x1404, UNSIGNED_INT: 0x1405, FLOAT: 0x1406, HALF_FLOAT: 0x140B,
    UNSIGNED_INT_24_8: 0x84FA,

    // Texture targets
    TEXTURE_2D: 0x0DE1, TEXTURE_3D: 0x806F, TEXTURE_CUBE_MAP: 0x8513, TEXTURE_2D_ARRAY: 0x8C1A,

    // Pixel formats
    DEPTH_COMPONENT: 0x1902, RED: 0x1903, RGBA: 0x1908,

    // Sized internal formats
    R8: 0x8229, R16F: 0x822D,
    RGBA8: 0x8058, SRGB8_ALPHA8: 0x8C43, RGBA16F: 0x881A, RGBA32F: 0x8814,
    DEPTH_COMPONENT24: 0x81A6, DEPTH_COMPONENT32F: 0x8CAC,
} as const;

/** The raw table, exported so a live-context check can diff it against the real thing. */
export const GL_ENUMS = GL;

// ------------------------------------------------------------------------------------------------
// Pipeline state
// ------------------------------------------------------------------------------------------------

const TOPOLOGY: Readonly<Record<PrimitiveTopology, number>> = {
    'point-list': GL.POINTS,
    'line-list': GL.LINES,
    'line-strip': GL.LINE_STRIP,
    'triangle-list': GL.TRIANGLES,
    'triangle-strip': GL.TRIANGLE_STRIP,
};
export function glTopology(topology: PrimitiveTopology): number { return TOPOLOGY[topology]; }

/**
 * Whether a topology rasterises triangles.
 *
 * `Mesh.draw` needs this for its triangle counter, which previously read `mode === gl.TRIANGLES` —
 * a comparison that silently under-counted every strip. Asking the question by name rather than by
 * enum equality is what fixes it.
 */
export function isTriangleTopology(topology: PrimitiveTopology): boolean {
    return topology === 'triangle-list' || topology === 'triangle-strip';
}

const COMPARE: Readonly<Record<CompareFunction, number>> = {
    'never': GL.NEVER, 'less': GL.LESS, 'equal': GL.EQUAL, 'less-equal': GL.LEQUAL,
    'greater': GL.GREATER, 'not-equal': GL.NOTEQUAL, 'greater-equal': GL.GEQUAL, 'always': GL.ALWAYS,
};
export function glCompare(compare: CompareFunction): number { return COMPARE[compare]; }

const BLEND_FACTOR: Readonly<Record<BlendFactor, number>> = {
    'zero': GL.ZERO, 'one': GL.ONE,
    'src': GL.SRC_COLOR, 'one-minus-src': GL.ONE_MINUS_SRC_COLOR,
    'src-alpha': GL.SRC_ALPHA, 'one-minus-src-alpha': GL.ONE_MINUS_SRC_ALPHA,
    'dst': GL.DST_COLOR, 'one-minus-dst': GL.ONE_MINUS_DST_COLOR,
    'dst-alpha': GL.DST_ALPHA, 'one-minus-dst-alpha': GL.ONE_MINUS_DST_ALPHA,
};
export function glBlendFactor(factor: BlendFactor): number { return BLEND_FACTOR[factor]; }

const BLEND_OP: Readonly<Record<BlendOperation, number>> = {
    'add': GL.FUNC_ADD, 'subtract': GL.FUNC_SUBTRACT, 'reverse-subtract': GL.FUNC_REVERSE_SUBTRACT,
    'min': GL.MIN, 'max': GL.MAX,
};
export function glBlendOperation(operation: BlendOperation): number { return BLEND_OP[operation]; }

/**
 * Face to cull. `'none'` has no enum of its own — it is `gl.disable(CULL_FACE)` — so it maps to null
 * and the caller must branch rather than pass a mode.
 */
export function glCullMode(cull: CullMode): number | null {
    return cull === 'none' ? null : cull === 'front' ? GL.FRONT : GL.BACK;
}

export function glFrontFace(face: FrontFace): number { return face === 'cw' ? GL.CW : GL.CCW; }

// ------------------------------------------------------------------------------------------------
// Samplers
// ------------------------------------------------------------------------------------------------

const ADDRESS_MODE: Readonly<Record<AddressMode, number>> = {
    'clamp-to-edge': GL.CLAMP_TO_EDGE, 'repeat': GL.REPEAT, 'mirror-repeat': GL.MIRRORED_REPEAT,
};
export function glAddressMode(mode: AddressMode): number { return ADDRESS_MODE[mode]; }

/** Magnification filter, which has no mip component. */
export function glMagFilter(filter: FilterMode): number {
    return filter === 'nearest' ? GL.NEAREST : GL.LINEAR;
}

/**
 * Minification filter, which folds the mip filter in.
 *
 * WebGL2 has one enum for both halves, so a `mipmap` of null means "no mip chain" and collapses to the
 * plain filter. Getting this pair wrong is invisible until a texture is viewed at a distance, which is
 * why it is a table rather than a nest of conditionals.
 */
export function glMinFilter(filter: FilterMode, mipmap: FilterMode | null): number {
    if (mipmap === null) return filter === 'nearest' ? GL.NEAREST : GL.LINEAR;
    if (filter === 'nearest')
        return mipmap === 'nearest' ? GL.NEAREST_MIPMAP_NEAREST : GL.NEAREST_MIPMAP_LINEAR;
    return mipmap === 'nearest' ? GL.LINEAR_MIPMAP_NEAREST : GL.LINEAR_MIPMAP_LINEAR;
}

// ------------------------------------------------------------------------------------------------
// Buffers and textures
// ------------------------------------------------------------------------------------------------

export function glIndexType(format: IndexFormat): number {
    return format === 'uint16' ? GL.UNSIGNED_SHORT : GL.UNSIGNED_INT;
}

export function indexByteSize(format: IndexFormat): number { return format === 'uint16' ? 2 : 4; }

const TEXTURE_TARGET: Readonly<Record<TextureDimension, number>> = {
    '2d': GL.TEXTURE_2D, '2d-array': GL.TEXTURE_2D_ARRAY, '3d': GL.TEXTURE_3D, 'cube': GL.TEXTURE_CUBE_MAP,
};
export function glTextureTarget(dimension: TextureDimension): number { return TEXTURE_TARGET[dimension]; }

/** The (internalFormat, format, type) triple WebGL2 needs for every texture allocation. */
export interface GlTextureFormat {
    readonly internalFormat: number;
    readonly format: number;
    readonly type: number;
}

const TEXTURE_FORMAT: Readonly<Record<Exclude<TextureFormat, 'bgra8unorm'>, GlTextureFormat>> = {
    'r8unorm':         { internalFormat: GL.R8,                format: GL.RED,             type: GL.UNSIGNED_BYTE },
    'r16float':        { internalFormat: GL.R16F,              format: GL.RED,             type: GL.FLOAT },
    'rgba8unorm':      { internalFormat: GL.RGBA8,             format: GL.RGBA,            type: GL.UNSIGNED_BYTE },
    'rgba8unorm-srgb': { internalFormat: GL.SRGB8_ALPHA8,      format: GL.RGBA,            type: GL.UNSIGNED_BYTE },
    'rgba16float':     { internalFormat: GL.RGBA16F,           format: GL.RGBA,            type: GL.FLOAT },
    'rgba32float':     { internalFormat: GL.RGBA32F,           format: GL.RGBA,            type: GL.FLOAT },
    'depth24plus':     { internalFormat: GL.DEPTH_COMPONENT24, format: GL.DEPTH_COMPONENT, type: GL.UNSIGNED_INT },
    'depth32float':    { internalFormat: GL.DEPTH_COMPONENT32F, format: GL.DEPTH_COMPONENT, type: GL.FLOAT },
};

/**
 * Translate an RHI format for `texImage2D` / `texStorage2D`.
 *
 * Throws for `bgra8unorm`: WebGL2 has no BGRA *internal* format at all, and the format only exists in
 * the union because WebGPU's `getPreferredCanvasFormat()` commonly returns it for the swap chain. It
 * can therefore never reach a WebGL2 allocation, and quietly substituting RGBA8 would turn a
 * misrouted swap-chain format into a silent channel swap rather than an error.
 */
export function glTextureFormat(format: TextureFormat): GlTextureFormat {
    if (format === 'bgra8unorm')
        throw new Error('bgra8unorm is a WebGPU swap-chain format and cannot be allocated on WebGL2');
    return TEXTURE_FORMAT[format];
}

// ------------------------------------------------------------------------------------------------
// Vertex attributes
// ------------------------------------------------------------------------------------------------

/** What `vertexAttribPointer` needs for one attribute. */
export interface GlVertexFormat {
    /** Components per attribute, 1..4. */
    readonly size: number;
    readonly type: number;
    /** Whether integer data is scaled into 0..1 (or -1..1) when read by the shader. */
    readonly normalized: boolean;
    /** True when the attribute must be bound with `vertexAttribIPointer` instead. */
    readonly integer: boolean;
}

const VERTEX_FORMAT: Readonly<Record<VertexFormat, GlVertexFormat>> = {
    'float32':   { size: 1, type: GL.FLOAT,          normalized: false, integer: false },
    'float32x2': { size: 2, type: GL.FLOAT,          normalized: false, integer: false },
    'float32x3': { size: 3, type: GL.FLOAT,          normalized: false, integer: false },
    'float32x4': { size: 4, type: GL.FLOAT,          normalized: false, integer: false },
    'uint8x4':   { size: 4, type: GL.UNSIGNED_BYTE,  normalized: false, integer: true  },
    'unorm8x4':  { size: 4, type: GL.UNSIGNED_BYTE,  normalized: true,  integer: false },
    'uint16x2':  { size: 2, type: GL.UNSIGNED_SHORT, normalized: false, integer: true  },
    'uint16x4':  { size: 4, type: GL.UNSIGNED_SHORT, normalized: false, integer: true  },
    'sint32':    { size: 1, type: GL.INT,            normalized: false, integer: true  },
    'sint32x2':  { size: 2, type: GL.INT,            normalized: false, integer: true  },
    'sint32x3':  { size: 3, type: GL.INT,            normalized: false, integer: true  },
    'sint32x4':  { size: 4, type: GL.INT,            normalized: false, integer: true  },
    'uint32':    { size: 1, type: GL.UNSIGNED_INT,   normalized: false, integer: true  },
    'uint32x2':  { size: 2, type: GL.UNSIGNED_INT,   normalized: false, integer: true  },
    'uint32x3':  { size: 3, type: GL.UNSIGNED_INT,   normalized: false, integer: true  },
    'uint32x4':  { size: 4, type: GL.UNSIGNED_INT,   normalized: false, integer: true  },
};

export function glVertexFormat(format: VertexFormat): GlVertexFormat { return VERTEX_FORMAT[format]; }
