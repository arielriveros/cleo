import { describe, it, expect } from 'vitest';
import {
    GL_ENUMS, glTopology, isTriangleTopology, glCompare, glBlendFactor, glBlendOperation,
    glCullMode, glFrontFace, glAddressMode, glMagFilter, glMinFilter,
    glIndexType, indexByteSize, glTextureTarget, glTextureFormat, glVertexFormat,
    glBufferTarget, glBufferUsageHint,
} from '../src/graphics/rhi/webgl2/glEnums';
import {
    MODEL_VERTEX_LAYOUT, TILE_VERTEX_LAYOUT, packedModelLayout, instanceMatrixLayout, isModelAttribute,
    modelVertexLayout,
} from '../src/graphics/rhi/vertexLayouts';
import { resolveTextureFormat } from '../src/graphics/rhi/textureFormat';
import { vertexFormatSize, BufferUsage } from '../src/graphics/rhi/types';

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

describe('buffer usage mapping', () => {
    // WebGL2 has no usage mask — a buffer belongs to a target — so a usage naming several roles has to
    // pick one, and index has to win. ELEMENT_ARRAY_BUFFER is VAO state: binding an index buffer to
    // ARRAY_BUFFER instead does not error, it silently draws from the wrong memory.
    it('resolves index before vertex before uniform', () => {
        expect(glBufferTarget(BufferUsage.INDEX)).toBe(GL_ENUMS.ELEMENT_ARRAY_BUFFER);
        expect(glBufferTarget(BufferUsage.VERTEX)).toBe(GL_ENUMS.ARRAY_BUFFER);
        expect(glBufferTarget(BufferUsage.UNIFORM)).toBe(GL_ENUMS.UNIFORM_BUFFER);
        expect(glBufferTarget(BufferUsage.INDEX | BufferUsage.VERTEX)).toBe(GL_ENUMS.ELEMENT_ARRAY_BUFFER);
        expect(glBufferTarget(BufferUsage.VERTEX | BufferUsage.UNIFORM)).toBe(GL_ENUMS.ARRAY_BUFFER);
    });

    // A copy-only buffer must NOT land on ARRAY_BUFFER: binding it there would clobber whatever vertex
    // binding was live at the time.
    it('parks a copy-only buffer on a neutral target', () => {
        const target = glBufferTarget(BufferUsage.COPY_SRC | BufferUsage.COPY_DST);
        expect(target).toBe(GL_ENUMS.COPY_READ_BUFFER);
        expect(target).not.toBe(GL_ENUMS.ARRAY_BUFFER);
    });

    // COPY_DST is the "this gets rewritten" signal, since WebGPU has no draw hints to carry across.
    it('derives the draw hint from COPY_DST', () => {
        expect(glBufferUsageHint(BufferUsage.VERTEX)).toBe(GL_ENUMS.STATIC_DRAW);
        expect(glBufferUsageHint(BufferUsage.INDEX)).toBe(GL_ENUMS.STATIC_DRAW);
        expect(glBufferUsageHint(BufferUsage.VERTEX | BufferUsage.COPY_DST)).toBe(GL_ENUMS.DYNAMIC_DRAW);
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

    // modelVertexLayout takes TWO programs and conflating them is the bug these pin.
    //
    // `ModelNode.initializeModel` packs the vertex buffer to exactly the attributes the material's own
    // program declares, so the stride is a property of the MATERIAL, not of whatever draws it later. A
    // Basic model is 20 bytes; a PBR one is 56. Reading the former at the latter's stride does not
    // throw — it walks every third vertex and draws a cube as a flat stretched bar.
    const PBR_ATTRS = [
        { name: 'a_position', location: 0 }, { name: 'a_normal', location: 1 },
        { name: 'a_texCoord', location: 2 }, { name: 'a_tangent', location: 3 },
        { name: 'a_bitangent', location: 4 },
    ];
    const BASIC_ATTRS = [{ name: 'position', location: 0 }, { name: 'texCoord', location: 1 }];
    const DEPTH_ATTRS = [{ name: 'a_position', location: 0 }];

    it('reads a Basic model at the stride its own program packed', () => {
        const layout = modelVertexLayout(BASIC_ATTRS, BASIC_ATTRS);
        expect(layout.arrayStride).toBe(20);
        expect(layout.attributes.map(a => [a.name, a.shaderLocation, a.offset]))
            .toEqual([['a_position', 0, 0], ['a_texCoord', 1, 12]]);
    });

    it('reads a PBR model at the full 56-byte stride', () => {
        const layout = modelVertexLayout(PBR_ATTRS, PBR_ATTRS);
        expect(layout.arrayStride).toBe(56);
        expect(layout.attributes.map(a => a.offset)).toEqual([0, 12, 24, 32, 44]);
    });

    it('gives a depth-only program the offsets of the buffer it is reading, not its own', () => {
        // Over a PBR buffer: stride 56, position at 0.
        const overPBR = modelVertexLayout(DEPTH_ATTRS, PBR_ATTRS);
        expect(overPBR.arrayStride).toBe(56);
        expect(overPBR.attributes).toHaveLength(1);
        // Over a Basic buffer the very same program needs stride 20 — which is why the pipeline cache
        // has to key on the buffer's program as well as the drawing one.
        const overBasic = modelVertexLayout(DEPTH_ATTRS, BASIC_ATTRS);
        expect(overBasic.arrayStride).toBe(20);
        expect(overBasic.attributes.map(a => a.offset)).toEqual([0]);
    });

    it('falls back to the full layout when no buffer program is named', () => {
        // Skinned meshes are always written at the full 56 bytes by createAnimated, whatever draws them.
        const layout = modelVertexLayout(DEPTH_ATTRS);
        expect(layout.arrayStride).toBe(56);
        expect(layout.attributes.map(a => [a.name, a.offset])).toEqual([['a_position', 0]]);
    });

    it('matches attribute spellings across the two programs', () => {
        // The buffer program spells it `texCoord`, the drawing one `a_uv`; they are the same attribute
        // and matching on the raw string would silently drop it.
        const layout = modelVertexLayout([{ name: 'a_uv', location: 7 }], BASIC_ATTRS);
        expect(layout.arrayStride).toBe(20);
        expect(layout.attributes.map(a => [a.shaderLocation, a.offset])).toEqual([[7, 12]]);
    });

    it('spreads an instance matrix across four vec4 slots', () => {
        const layout = instanceMatrixLayout(5);
        expect(layout.stepMode).toBe('instance');
        expect(layout.arrayStride).toBe(64);
        expect(layout.attributes.map(a => [a.shaderLocation, a.offset]))
            .toEqual([[5, 0], [6, 16], [7, 32], [8, 48]]);
    });
});

describe('TILE_VERTEX_LAYOUT', () => {
    // position.xy | uv.xy | colour.rgba. tileMesh.ts now derives FLOATS_PER_VERTEX from this stride, so
    // a change here moves the scratch-buffer arithmetic with it instead of silently disagreeing.
    it('packs 8 floats into a 32-byte stride', () => {
        expect(TILE_VERTEX_LAYOUT.arrayStride).toBe(32);
        expect(TILE_VERTEX_LAYOUT.arrayStride / 4).toBe(8);
        expect(TILE_VERTEX_LAYOUT.attributes.map(a => [a.name, a.offset, a.shaderLocation])).toEqual([
            ['a_position', 0, 0], ['a_uv', 8, 1], ['a_color', 16, 2],
        ]);
    });

    // Fixed rather than reflected, matching the explicit layout(location=) in tilemap.vs. Locations
    // must be distinct and gapless from 0 or the shader binds the wrong buffer slice.
    it('assigns distinct sequential locations', () => {
        const locations = TILE_VERTEX_LAYOUT.attributes.map(a => a.shaderLocation);
        expect(locations).toEqual([0, 1, 2]);
    });

    // The offsets have to tile the stride exactly: any gap means the colour attribute reads into the
    // next vertex, which renders as scrolling tint rather than as an error.
    it('has offsets that exactly tile the stride', () => {
        let expected = 0;
        for (const attribute of TILE_VERTEX_LAYOUT.attributes) {
            expect(attribute.offset).toBe(expected);
            expected += vertexFormatSize(attribute.format);
        }
        expect(expected).toBe(TILE_VERTEX_LAYOUT.arrayStride);
    });

    // The tilemap vertex is NOT the model vertex, and conflating the two is the trap tileMesh.ts's
    // header warns about. Sharing the binder must not have quietly shared the layout.
    it('stays distinct from the model vertex', () => {
        expect(TILE_VERTEX_LAYOUT.arrayStride).not.toBe(MODEL_VERTEX_LAYOUT.arrayStride);
        expect(TILE_VERTEX_LAYOUT.attributes.map(a => a.name))
            .not.toEqual(MODEL_VERTEX_LAYOUT.attributes.map(a => a.name));
    });
});

describe('integer vs float attribute binding', () => {
    // applyVertexLayout branches on this flag to choose vertexAttribIPointer over vertexAttribPointer.
    // Routing bone indices through the float entry point converts the bits instead of reinterpreting
    // them, and every vertex then skins to joint 0 — a failure that renders as a collapsed mesh.
    it('flags exactly the formats that need vertexAttribIPointer', () => {
        for (const format of ['sint32x4', 'uint8x4', 'uint16x4', 'uint32'] as const)
            expect(glVertexFormat(format).integer).toBe(true);
        for (const format of ['float32x2', 'float32x3', 'float32x4', 'unorm8x4'] as const)
            expect(glVertexFormat(format).integer).toBe(false);
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
