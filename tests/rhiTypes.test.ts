import { describe, it, expect } from 'vitest';
import {
    TEXTURE_FORMAT_INFO, isDepthFormat, textureByteSize,
    vertexFormatSize, packedLayoutSize,
    BufferUsage, TextureUsage, ShaderStage,
    DEFAULT_BLEND, ADDITIVE_BLEND,
} from '../src/graphics/rhi/types';
import type { TextureFormat, VertexBufferLayout } from '../src/graphics/rhi/types';
import { describeCapabilities } from '../src/graphics/rhi/device';
import type { DeviceCapabilities } from '../src/graphics/rhi/device';

// The RHI's pure half. None of this touches a context, which is the point: the format tables, the
// byte-size arithmetic and the vertex-layout maths are the parts most likely to be quietly wrong, and
// they are the only parts a DOM-free suite can reach. See vitest.config.ts for why that policy holds.

const ALL_FORMATS = Object.keys(TEXTURE_FORMAT_INFO) as TextureFormat[];

describe('TEXTURE_FORMAT_INFO', () => {
    it('describes every declared format', () => {
        // The union and the table are kept in step by the Record<TextureFormat, …> annotation, which
        // catches a missing row at compile time. This asserts the other direction — no stray rows — and
        // that nothing was left half-filled.
        expect(ALL_FORMATS.length).toBeGreaterThan(0);
        for (const format of ALL_FORMATS) {
            const info = TEXTURE_FORMAT_INFO[format];
            expect(info.bytesPerTexel).toBeGreaterThan(0);
            expect(info.channels).toBeGreaterThan(0);
            expect(['color', 'depth']).toContain(info.aspect);
        }
    });

    it('marks depth formats as depth and nothing else', () => {
        const depth = ALL_FORMATS.filter(isDepthFormat);
        expect(depth.sort()).toEqual(['depth24plus', 'depth32float']);
    });

    // Both backends refuse to filter a depth texture with a plain sampler — WebGL2 needs a shadow
    // sampler, WebGPU a `sampler_comparison`. A depth format claiming to be filterable would send the
    // shadow cascades down the wrong sampler path.
    it('never claims a depth format is filterable', () => {
        for (const format of ALL_FORMATS.filter(isDepthFormat))
            expect(TEXTURE_FORMAT_INFO[format].filterable).toBe(false);
    });

    // The pair that decides whether the HDR pipeline is real or silently 8-bit. Float formats are
    // renderable only with EXT_color_buffer_float and filterable only with OES_texture_float_linear,
    // and the two fail independently — so the table must not promise filtering for either float format.
    it('does not promise unconditional filtering for float formats', () => {
        expect(TEXTURE_FORMAT_INFO['rgba16float'].filterable).toBe(false);
        expect(TEXTURE_FORMAT_INFO['rgba32float'].filterable).toBe(false);
        expect(TEXTURE_FORMAT_INFO['r16float'].filterable).toBe(false);
    });
});

describe('textureByteSize', () => {
    it('measures a single mip level', () => {
        expect(textureByteSize('rgba8unorm', 256, 256)).toBe(256 * 256 * 4);
        expect(textureByteSize('r8unorm', 256, 256)).toBe(256 * 256);
        expect(textureByteSize('rgba16float', 64, 32)).toBe(64 * 32 * 8);
    });

    it('multiplies by array layers', () => {
        // The shadow cascade array: 2048 square, one layer per cascade, 24-bit depth.
        expect(textureByteSize('depth24plus', 2048, 2048, 3)).toBe(2048 * 2048 * 4 * 3);
    });

    it('sums a real mip chain rather than assuming 4/3', () => {
        // 4x4 RGBA8 with 3 levels: 16 + 4 + 1 texels.
        expect(textureByteSize('rgba8unorm', 4, 4, 1, 3)).toBe((16 + 4 + 1) * 4);
    });

    it('floors each dimension at 1 and stops at 1x1', () => {
        // 4x1 halves to 2x1 then 1x1 and must not keep going, nor let height reach 0.
        expect(textureByteSize('r8unorm', 4, 1, 1, 8)).toBe(4 + 2 + 1);
    });

    it('treats a zero or fractional size as at least one texel', () => {
        expect(textureByteSize('rgba8unorm', 0, 0)).toBe(4);
        expect(textureByteSize('rgba8unorm', 1, 1, 0, 0)).toBe(4);
    });
});

describe('vertex layouts', () => {
    it('sizes every attribute format', () => {
        expect(vertexFormatSize('float32')).toBe(4);
        expect(vertexFormatSize('float32x3')).toBe(12);
        expect(vertexFormatSize('uint8x4')).toBe(4);
        expect(vertexFormatSize('uint16x4')).toBe(8);
    });

    // The engine's standard model vertex: position, normal, uv, tangent, bitangent — the 14-float,
    // 56-byte interleaved stride that Mesh hardcodes today. An explicit layout has to reproduce it
    // exactly, because a WebGPU pipeline validates the stride against the declared attributes.
    it('measures the 14-float model vertex as 56 bytes', () => {
        const layout: VertexBufferLayout = {
            arrayStride: 56,
            stepMode: 'vertex',
            attributes: [
                { name: 'a_position',  shaderLocation: 0, offset: 0,  format: 'float32x3' },
                { name: 'a_normal',    shaderLocation: 1, offset: 12, format: 'float32x3' },
                { name: 'a_texCoord',  shaderLocation: 2, offset: 24, format: 'float32x2' },
                { name: 'a_tangent',   shaderLocation: 3, offset: 32, format: 'float32x3' },
                { name: 'a_bitangent', shaderLocation: 4, offset: 44, format: 'float32x3' },
            ],
        };
        expect(packedLayoutSize(layout)).toBe(56);
        expect(packedLayoutSize(layout)).toBe(layout.arrayStride);
    });

    it('reports the packed size even when the stride is padded', () => {
        const padded: VertexBufferLayout = {
            arrayStride: 16,
            stepMode: 'instance',
            attributes: [{ name: 'a_offset', shaderLocation: 5, offset: 0, format: 'float32x3' }],
        };
        expect(packedLayoutSize(padded)).toBe(12);
        expect(padded.arrayStride).toBe(16);
    });
});

describe('usage flags', () => {
    // Bit flags only work if they are actually distinct bits. A duplicated value would make two
    // unrelated usages indistinguishable after an OR, which no type check would catch.
    it('assigns a distinct bit to every usage', () => {
        for (const group of [BufferUsage, TextureUsage, ShaderStage]) {
            const values = Object.values(group) as number[];
            expect(new Set(values).size).toBe(values.length);
            for (const value of values) expect(value & (value - 1)).toBe(0);
        }
    });

    it('composes without collision', () => {
        const usage = BufferUsage.VERTEX | BufferUsage.COPY_DST;
        expect(usage & BufferUsage.VERTEX).toBeTruthy();
        expect(usage & BufferUsage.COPY_DST).toBeTruthy();
        expect(usage & BufferUsage.INDEX).toBe(0);
    });
});

describe('blend presets', () => {
    // The bloom mask contract: the alpha channel of the scene buffer is the bloom mask, not coverage,
    // so the default blend must leave the DESTINATION alpha exactly as it found it. That is zero/one —
    // `dst = 0*src + 1*dst` — and it is what `Renderer._restoreDefaultBlend` has always set with
    // `blendFuncSeparate(SRC_ALPHA, ONE_MINUS_SRC_ALPHA, ZERO, ONE)`.
    //
    // This asserted `one` until the forward pass became the first caller of the constant. Nothing
    // used it before then, so the constant and this test agreed with each other and with nothing
    // else; a transparent object would have accumulated coverage into the mask and dimmed every
    // bloom source behind it.
    it('leaves destination alpha untouched by default', () => {
        expect(DEFAULT_BLEND.color).toEqual(
            { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' });
        expect(DEFAULT_BLEND.alpha).toEqual(
            { srcFactor: 'zero', dstFactor: 'one', operation: 'add' });
        expect(DEFAULT_BLEND.alpha.srcFactor).not.toBe(DEFAULT_BLEND.color.srcFactor);
    });

    it('accumulates for the additive preset', () => {
        expect(ADDITIVE_BLEND.color).toEqual({ srcFactor: 'one', dstFactor: 'one', operation: 'add' });
    });
});

describe('describeCapabilities', () => {
    const base: DeviceCapabilities = {
        backend: 'webgl2',
        maxTextureSize: 16384,
        maxTextureArrayLayers: 2048,
        max3DTextureSize: 2048,
        maxColorAttachments: 8,
        maxSamplersPerStage: 16,
        maxVertexAttributes: 16,
        maxUniformBufferBindingSize: 65536,
        floatRenderable: true,
        floatFilterable: true,
        hasCompute: false,
        hasStorageBuffers: false,
        hasTimestampQuery: true,
        maxAnisotropy: 16,
        preferredCanvasFormat: 'rgba8unorm',
    };

    it('names the backend and the float support level', () => {
        const line = describeCapabilities(base);
        expect(line).toContain('backend=webgl2');
        expect(line).toContain('float=renderable+filterable');
        expect(line).toContain('samplers=16');
    });

    // The case that matters on mobile: renderable but not filterable means every `precision: 'high'`
    // target silently falls back to RGBA8 in texture.ts. The log line has to distinguish it.
    it('distinguishes renderable-only from fully filterable float support', () => {
        expect(describeCapabilities({ ...base, floatFilterable: false })).toContain('float=renderable');
        expect(describeCapabilities({ ...base, floatFilterable: false })).not.toContain('filterable');
        expect(describeCapabilities({ ...base, floatRenderable: false })).toContain('float=none');
    });

    it('includes adapter info only when the browser supplied it', () => {
        expect(describeCapabilities(base)).not.toContain('adapter=');
        const withAdapter = describeCapabilities({
            ...base,
            adapterInfo: { vendor: 'Acme', architecture: '', device: 'GPU 1', description: 'Acme — GPU 1' },
        });
        expect(withAdapter).toContain('adapter="Acme — GPU 1"');
    });
});
