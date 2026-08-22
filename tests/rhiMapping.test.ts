import { describe, it, expect } from 'vitest';
import {
    GL_ENUMS, glTopology, isTriangleTopology, glCompare, glBlendFactor, glBlendOperation,
    glCullMode, glFrontFace, glAddressMode, glMagFilter, glMinFilter,
    glIndexType, indexByteSize, glTextureTarget, glTextureFormat, glVertexFormat,
} from '../src/graphics/rhi/webgl2/glEnums';
import {
    MODEL_VERTEX_LAYOUT, packedModelLayout, instanceMatrixLayout, isModelAttribute,
} from '../src/graphics/rhi/vertexLayouts';
import { resolveTextureFormat } from '../src/graphics/rhi/textureFormat';

// The RHI's translation layer. Everything here is pure, so it is reachable from the DOM-free suite —
// which matters because a wrong entry in one of these tables does not throw, it renders the wrong
// picture. The literal VALUES in glEnums are separately verified once against a real WebGL2 context
// (scratchpad/enumCheck); these tests cover the mapping, not the constants.

describe('glEnums — pipeline state', () => {
    it('maps every topology to a distinct enum', () => {
        const all = ['point-list', 'line-list', 'line-strip', 'triangle-list', 'triangle-strip'] as const;
        const values = all.map(glTopology);
        expect(new Set(values).size).toBe(all.length);
        expect(glTopology('triangle-list')).toBe(GL_ENUMS.TRIANGLES);
        expect(glTopology('line-list')).toBe(GL_ENUMS.LINES);
    });

    // The old triangle counter compared `mode === gl.TRIANGLES`, which counted a triangle STRIP as
    // zero triangles. Asking by name rather than by enum equality is what fixes that.
    it('counts strips as triangle topology', () => {
        expect(isTriangleTopology('triangle-list')).toBe(true);
        expect(isTriangleTopology('triangle-strip')).toBe(true);
        expect(isTriangleTopology('line-list')).toBe(false);
        expect(isTriangleTopology('point-list')).toBe(false);
    });

    it('maps every comparison to a distinct enum', () => {
        const all = ['never', 'less', 'equal', 'less-equal', 'greater', 'not-equal', 'greater-equal', 'always'] as const;
        expect(new Set(all.map(glCompare)).size).toBe(all.length);
        expect(glCompare('less-equal')).toBe(GL_ENUMS.LEQUAL);
    });

    it('maps every blend factor to a distinct enum', () => {
        const all = ['zero', 'one', 'src', 'one-minus-src', 'src-alpha', 'one-minus-src-alpha',
                     'dst', 'one-minus-dst', 'dst-alpha', 'one-minus-dst-alpha'] as const;
        expect(new Set(all.map(glBlendFactor)).size).toBe(all.length);
        // 'src'/'dst' are the COLOR factors; the alpha-suffixed names are the alpha ones. Swapping
        // these two pairs is the classic blend bug and would not otherwise be caught by anything.
        expect(glBlendFactor('src')).toBe(GL_ENUMS.SRC_COLOR);
        expect(glBlendFactor('src-alpha')).toBe(GL_ENUMS.SRC_ALPHA);
        expect(glBlendFactor('dst')).toBe(GL_ENUMS.DST_COLOR);
        expect(glBlendFactor('dst-alpha')).toBe(GL_ENUMS.DST_ALPHA);
    });

    it('maps blend operations, including the min/max pair', () => {
        expect(glBlendOperation('add')).toBe(GL_ENUMS.FUNC_ADD);
        expect(glBlendOperation('reverse-subtract')).toBe(GL_ENUMS.FUNC_REVERSE_SUBTRACT);
        expect(glBlendOperation('min')).toBe(GL_ENUMS.MIN);
        expect(glBlendOperation('max')).toBe(GL_ENUMS.MAX);
    });

    // 'none' is not a cull face, it is disabling the whole test — there is no enum for it, so the
    // caller has to branch. Returning null forces that rather than inventing a mode.
    it('returns null for cull mode none', () => {
        expect(glCullMode('none')).toBeNull();
        expect(glCullMode('front')).toBe(GL_ENUMS.FRONT);
        expect(glCullMode('back')).toBe(GL_ENUMS.BACK);
    });

    it('maps winding order', () => {
        expect(glFrontFace('ccw')).toBe(GL_ENUMS.CCW);
        expect(glFrontFace('cw')).toBe(GL_ENUMS.CW);
    });
});

describe('glEnums — samplers', () => {
    it('maps address modes', () => {
        expect(glAddressMode('clamp-to-edge')).toBe(GL_ENUMS.CLAMP_TO_EDGE);
        expect(glAddressMode('repeat')).toBe(GL_ENUMS.REPEAT);
        expect(glAddressMode('mirror-repeat')).toBe(GL_ENUMS.MIRRORED_REPEAT);
    });

    it('collapses the min filter when there is no mip chain', () => {
        expect(glMinFilter('linear', null)).toBe(GL_ENUMS.LINEAR);
        expect(glMinFilter('nearest', null)).toBe(GL_ENUMS.NEAREST);
    });

    // WebGL2 folds both halves into one enum, and all four combinations are distinct. Getting the pair
    // backwards is invisible until a texture is viewed at a distance.
    it('covers all four mipmapped combinations distinctly', () => {
        const combos = [
            glMinFilter('nearest', 'nearest'), glMinFilter('nearest', 'linear'),
            glMinFilter('linear', 'nearest'), glMinFilter('linear', 'linear'),
        ];
        expect(new Set(combos).size).toBe(4);
        expect(glMinFilter('linear', 'linear')).toBe(GL_ENUMS.LINEAR_MIPMAP_LINEAR);
        expect(glMinFilter('nearest', 'nearest')).toBe(GL_ENUMS.NEAREST_MIPMAP_NEAREST);
        expect(glMagFilter('linear')).toBe(GL_ENUMS.LINEAR);
    });
});

describe('glEnums — buffers and textures', () => {
    it('maps index formats and their byte sizes together', () => {
        expect(glIndexType('uint16')).toBe(GL_ENUMS.UNSIGNED_SHORT);
        expect(glIndexType('uint32')).toBe(GL_ENUMS.UNSIGNED_INT);
        expect(indexByteSize('uint16')).toBe(2);
        expect(indexByteSize('uint32')).toBe(4);
    });

    it('maps texture dimensions to targets', () => {
        expect(glTextureTarget('2d')).toBe(GL_ENUMS.TEXTURE_2D);
        expect(glTextureTarget('2d-array')).toBe(GL_ENUMS.TEXTURE_2D_ARRAY);
        expect(glTextureTarget('3d')).toBe(GL_ENUMS.TEXTURE_3D);
        expect(glTextureTarget('cube')).toBe(GL_ENUMS.TEXTURE_CUBE_MAP);
    });

    // Pins the exact triples the Texture constructor produced before the refactor. These are the
    // allocations the whole renderer runs on, and a changed `type` here is a silently reinterpreted
    // upload rather than an error.
    it('reproduces the triples the engine already allocated', () => {
        expect(glTextureFormat('rgba8unorm')).toEqual(
            { internalFormat: GL_ENUMS.RGBA8, format: GL_ENUMS.RGBA, type: GL_ENUMS.UNSIGNED_BYTE });
        expect(glTextureFormat('rgba16float')).toEqual(
            { internalFormat: GL_ENUMS.RGBA16F, format: GL_ENUMS.RGBA, type: GL_ENUMS.FLOAT });
        expect(glTextureFormat('r8unorm')).toEqual(
            { internalFormat: GL_ENUMS.R8, format: GL_ENUMS.RED, type: GL_ENUMS.UNSIGNED_BYTE });
        expect(glTextureFormat('r16float')).toEqual(
            { internalFormat: GL_ENUMS.R16F, format: GL_ENUMS.RED, type: GL_ENUMS.FLOAT });
        expect(glTextureFormat('depth24plus')).toEqual(
            { internalFormat: GL_ENUMS.DEPTH_COMPONENT24, format: GL_ENUMS.DEPTH_COMPONENT, type: GL_ENUMS.UNSIGNED_INT });
    });

    // WebGL2 has no BGRA internal format. Substituting RGBA8 would turn a misrouted swap-chain format
    // into a silent channel swap, which is far harder to find than a throw.
    it('refuses to allocate a WebGPU-only swap-chain format', () => {
        expect(() => glTextureFormat('bgra8unorm')).toThrow(/bgra8unorm/);
    });

    it('describes vertex formats, flagging the integer ones', () => {
        expect(glVertexFormat('float32x3')).toEqual(
            { size: 3, type: GL_ENUMS.FLOAT, normalized: false, integer: false });
        // Bone indices: 4 x int32, bound with vertexAttribIPointer rather than the float path.
        expect(glVertexFormat('sint32x4')).toEqual(
            { size: 4, type: GL_ENUMS.INT, normalized: false, integer: true });
        // unorm8x4 is normalized and NOT integer — the pair that distinguishes a packed colour from
        // a packed index.
        expect(glVertexFormat('unorm8x4').normalized).toBe(true);
        expect(glVertexFormat('unorm8x4').integer).toBe(false);
        expect(glVertexFormat('uint8x4').normalized).toBe(false);
        expect(glVertexFormat('uint8x4').integer).toBe(true);
    });
});

describe('vertexLayouts', () => {
    // The stride the skinned vertex shaders and createAnimated both assume. It was written as
    // `14 * floatSize` in one place and implied by a table of sizes in another; this pins it.
    it('lays out the model vertex at a 56-byte stride', () => {
        expect(MODEL_VERTEX_LAYOUT.arrayStride).toBe(56);
        expect(MODEL_VERTEX_LAYOUT.attributes.map(a => [a.name, a.offset])).toEqual([
            ['a_position', 0], ['a_normal', 12], ['a_texCoord', 24], ['a_tangent', 32], ['a_bitangent', 44],
        ]);
    });

    it('packs only the attributes a program declares', () => {
        const layout = packedModelLayout([
            { name: 'a_position', location: 0 },
            { name: 'a_texCoord', location: 1 },
        ]);
        expect(layout.arrayStride).toBe(20);
        expect(layout.attributes.map(a => [a.name, a.offset, a.shaderLocation]))
            .toEqual([['a_position', 0, 0], ['a_texCoord', 12, 1]]);
    });

    // The reason the layout is data and not the shader's reflected enumeration: reflection order is
    // driver- and program-dependent, and following it would interleave the same mesh differently for
    // two programs that share it.
    it('orders canonically regardless of reflected order', () => {
        const layout = packedModelLayout([
            { name: 'a_bitangent', location: 4 },
            { name: 'a_position', location: 0 },
            { name: 'a_normal', location: 1 },
        ]);
        expect(layout.attributes.map(a => a.name)).toEqual(['a_position', 'a_normal', 'a_bitangent']);
        expect(layout.attributes.map(a => a.offset)).toEqual([0, 12, 24]);
    });

    it('accepts the alternative attribute spellings', () => {
        expect(isModelAttribute('position')).toBe(true);
        expect(isModelAttribute('a_uv')).toBe(true);
        expect(isModelAttribute('uv')).toBe(true);
        expect(isModelAttribute('a_instanceMatrix0')).toBe(false);
        const layout = packedModelLayout([{ name: 'position', location: 0 }, { name: 'a_uv', location: 1 }]);
        expect(layout.attributes.map(a => a.name)).toEqual(['a_position', 'a_texCoord']);
        expect(layout.arrayStride).toBe(20);
    });

    it('does not double the stride when one attribute arrives under two spellings', () => {
        const layout = packedModelLayout([
            { name: 'a_texCoord', location: 1 },
            { name: 'a_uv', location: 2 },
        ]);
        expect(layout.attributes).toHaveLength(1);
        expect(layout.arrayStride).toBe(8);
    });

    it('drops unknown attributes, leaving them to the reflected fallback', () => {
        const layout = packedModelLayout([
            { name: 'a_position', location: 0 },
            { name: 'a_customThing', location: 9 },
        ]);
        expect(layout.attributes.map(a => a.name)).toEqual(['a_position']);
        expect(layout.arrayStride).toBe(12);
    });

    it('spreads an instance matrix across four vec4 slots', () => {
        const layout = instanceMatrixLayout(5);
        expect(layout.stepMode).toBe('instance');
        expect(layout.arrayStride).toBe(64);
        expect(layout.attributes.map(a => [a.shaderLocation, a.offset]))
            .toEqual([[5, 0], [6, 16], [7, 32], [8, 48]]);
    });
});

describe('resolveTextureFormat', () => {
    const full = { floatRenderable: true, floatFilterable: true };
    const none = { floatRenderable: false, floatFilterable: false };

    it('ignores precision and channels for depth', () => {
        const r = resolveTextureFormat({ usage: 'depth', precision: 'high', channels: 'r' }, none);
        expect(r).toEqual({ format: 'depth24plus', requested: 'depth24plus', downgraded: false });
    });

    it('infers from precision and channels', () => {
        expect(resolveTextureFormat({}, full).format).toBe('rgba8unorm');
        expect(resolveTextureFormat({ precision: 'high' }, full).format).toBe('rgba16float');
        expect(resolveTextureFormat({ channels: 'r' }, full).format).toBe('r8unorm');
        expect(resolveTextureFormat({ channels: 'r', precision: 'high' }, full).format).toBe('r16float');
    });

    // The behaviour that turns the entire HDR pipeline LDR on a device without the extensions. It is
    // preserved exactly — but it now reports itself instead of happening in silence.
    it('downgrades float formats and says so', () => {
        const r = resolveTextureFormat({ precision: 'high' }, none);
        expect(r).toEqual({ format: 'rgba8unorm', requested: 'rgba16float', downgraded: true });
        expect(resolveTextureFormat({ channels: 'r', precision: 'high' }, none).format).toBe('r8unorm');
    });

    // Renderable without filterable is the realistic mobile case, and it is NOT enough: every float
    // target the engine allocates is both rendered into and then sampled bilinearly.
    it('requires both float capabilities, not either', () => {
        const renderableOnly = { floatRenderable: true, floatFilterable: false };
        const filterableOnly = { floatRenderable: false, floatFilterable: true };
        expect(resolveTextureFormat({ precision: 'high' }, renderableOnly).downgraded).toBe(true);
        expect(resolveTextureFormat({ precision: 'high' }, filterableOnly).downgraded).toBe(true);
    });

    it('honours an explicit format over the inference', () => {
        const r = resolveTextureFormat({ format: 'rgba8unorm-srgb', precision: 'high' }, full);
        expect(r.format).toBe('rgba8unorm-srgb');
        expect(r.downgraded).toBe(false);
    });

    // An explicitly named float format has to degrade the same way an inferred one does, or naming it
    // would be the path that crashes on a weak device.
    it('still degrades an explicitly named float format', () => {
        const r = resolveTextureFormat({ format: 'rgba32float' }, none);
        expect(r).toEqual({ format: 'rgba8unorm', requested: 'rgba32float', downgraded: true });
    });
});
