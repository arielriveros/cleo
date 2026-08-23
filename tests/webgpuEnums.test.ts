import { describe, it, expect, beforeAll } from 'vitest';
import {
    gpuTextureFormat, rhiTextureFormat, gpuTextureDimension, gpuViewDimension, layersForDimension,
    gpuBufferUsage, gpuTextureUsage, gpuShaderStage, gpuColorWriteMask,
    gpuAddressMode, gpuFilterMode, gpuCompare, gpuBlendFactor, gpuBlendOperation,
    gpuCullMode, gpuFrontFace, gpuTopology, gpuIndexFormat, gpuVertexFormat,
    gpuLoadOp, gpuStoreOp,
} from '../src/graphics/rhi/webgpu/webgpuEnums';
import {
    TEXTURE_FORMAT_INFO, BufferUsage, TextureUsage, ShaderStage,
} from '../src/graphics/rhi/types';
import type { TextureFormat, TextureDimension } from '../src/graphics/rhi/types';

/**
 * The RHI → WebGPU mapping tables.
 *
 * Reachable from a DOM-free suite because the module only touches WebGPU's global flag objects inside
 * function bodies, never at import time. The flag values below are the SPEC's, written out by hand
 * rather than read from a browser — which is the whole point: a test that read `GPUBufferUsage.VERTEX`
 * from the same global the implementation reads would pass no matter which bit we assigned.
 *
 * `tools/harness/webgpuCheck.js` covers the half that needs a driver.
 */

// Per https://www.w3.org/TR/webgpu/#buffer-usage — deliberately NOT the same values as ours.
const SPEC_BUFFER_USAGE = {
    MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008,
    INDEX: 0x0010, VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080,
    INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
};
const SPEC_TEXTURE_USAGE = {
    COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04,
    STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
const SPEC_SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };
const SPEC_COLOR_WRITE = { RED: 0x1, GREEN: 0x2, BLUE: 0x4, ALPHA: 0x8, ALL: 0xf };

beforeAll(() => {
    const scope = globalThis as Record<string, unknown>;
    scope.GPUBufferUsage = SPEC_BUFFER_USAGE;
    scope.GPUTextureUsage = SPEC_TEXTURE_USAGE;
    scope.GPUShaderStage = SPEC_SHADER_STAGE;
    scope.GPUColorWrite = SPEC_COLOR_WRITE;
});

const ALL_FORMATS = Object.keys(TEXTURE_FORMAT_INFO) as TextureFormat[];
const ALL_DIMENSIONS: TextureDimension[] = ['2d', '2d-array', '3d', 'cube'];

describe('texture formats', () => {
    it('maps every RHI format to a WebGPU format of the same name', () => {
        // True today because the union was chosen from WebGPU's list. Asserted so it stays true when
        // somebody adds a format — the Record annotation forces a row, this forces a *correct* row.
        for (const format of ALL_FORMATS) expect(gpuTextureFormat(format)).toBe(format);
    });

    it('round-trips a swap-chain format back into the RHI union', () => {
        expect(rhiTextureFormat('bgra8unorm')).toBe('bgra8unorm');
        expect(rhiTextureFormat('rgba8unorm')).toBe('rgba8unorm');
    });

    it('falls back rather than returning a format the engine cannot allocate', () => {
        // A browser is free to report a preferred canvas format outside our union. Allocating a target
        // in a format `TEXTURE_FORMAT_INFO` has never heard of would break byte accounting and every
        // readback stride; presenting through rgba8unorm merely costs a blit.
        expect(rhiTextureFormat('rgb10a2unorm' as GPUTextureFormat)).toBe('rgba8unorm');
        expect(TEXTURE_FORMAT_INFO[rhiTextureFormat('rgb10a2unorm' as GPUTextureFormat)]).toBeDefined();
    });
});

describe('dimensions', () => {
    // The one shape mismatch between the two APIs. WebGPU has no array or cube TEXTURE dimension —
    // both are 2D storage, and the array-ness lives on the view.
    it('stores arrays and cubes as 2d textures', () => {
        expect(gpuTextureDimension('2d')).toBe('2d');
        expect(gpuTextureDimension('2d-array')).toBe('2d');
        expect(gpuTextureDimension('cube')).toBe('2d');
        expect(gpuTextureDimension('3d')).toBe('3d');
    });

    it('keeps array-ness and cube-ness on the view', () => {
        expect(gpuViewDimension('2d')).toBe('2d');
        expect(gpuViewDimension('2d-array')).toBe('2d-array');
        expect(gpuViewDimension('cube')).toBe('cube');
        expect(gpuViewDimension('3d')).toBe('3d');
    });

    it('never reports a dimension WebGPU does not accept', () => {
        for (const dimension of ALL_DIMENSIONS) {
            expect(['1d', '2d', '3d']).toContain(gpuTextureDimension(dimension));
            expect(['1d', '2d', '2d-array', 'cube', 'cube-array', '3d'])
                .toContain(gpuViewDimension(dimension));
        }
    });

    it('forces a cube to six layers regardless of what was asked for', () => {
        expect(layersForDimension('cube', undefined)).toBe(6);
        expect(layersForDimension('cube', 1)).toBe(6);
        expect(layersForDimension('cube', 12)).toBe(6);
    });

    it('defaults every other shape to a single layer', () => {
        expect(layersForDimension('2d', undefined)).toBe(1);
        expect(layersForDimension('2d-array', 4)).toBe(4);
        expect(layersForDimension('3d', 64)).toBe(64);
        // A zero or negative request would make `createTexture` throw well away from the caller.
        expect(layersForDimension('2d-array', 0)).toBe(1);
    });
});

describe('usage flags', () => {
    // The failure this guards is silent: our bits and WebGPU's are both small integers, so passing
    // ours straight through produces a valid-looking resource with the wrong permissions, and the
    // error lands at the first bind rather than at creation.
    it('translates buffer usages onto the spec bits, which are NOT ours', () => {
        expect(BufferUsage.VERTEX).not.toBe(SPEC_BUFFER_USAGE.VERTEX);
        expect(gpuBufferUsage(BufferUsage.VERTEX)).toBe(SPEC_BUFFER_USAGE.VERTEX);
        expect(gpuBufferUsage(BufferUsage.INDEX)).toBe(SPEC_BUFFER_USAGE.INDEX);
        expect(gpuBufferUsage(BufferUsage.UNIFORM)).toBe(SPEC_BUFFER_USAGE.UNIFORM);
        expect(gpuBufferUsage(BufferUsage.STORAGE)).toBe(SPEC_BUFFER_USAGE.STORAGE);
        expect(gpuBufferUsage(BufferUsage.INDIRECT)).toBe(SPEC_BUFFER_USAGE.INDIRECT);
        expect(gpuBufferUsage(BufferUsage.COPY_SRC)).toBe(SPEC_BUFFER_USAGE.COPY_SRC);
        expect(gpuBufferUsage(BufferUsage.COPY_DST)).toBe(SPEC_BUFFER_USAGE.COPY_DST);
    });

    it('combines buffer usages rather than picking one', () => {
        expect(gpuBufferUsage(BufferUsage.VERTEX | BufferUsage.COPY_DST))
            .toBe(SPEC_BUFFER_USAGE.VERTEX | SPEC_BUFFER_USAGE.COPY_DST);
        expect(gpuBufferUsage(0)).toBe(0);
    });

    it('translates texture usages and shader stages', () => {
        expect(gpuTextureUsage(TextureUsage.RENDER_ATTACHMENT | TextureUsage.COPY_SRC))
            .toBe(SPEC_TEXTURE_USAGE.RENDER_ATTACHMENT | SPEC_TEXTURE_USAGE.COPY_SRC);
        expect(gpuTextureUsage(TextureUsage.TEXTURE_BINDING)).toBe(SPEC_TEXTURE_USAGE.TEXTURE_BINDING);
        expect(gpuShaderStage(ShaderStage.VERTEX | ShaderStage.FRAGMENT))
            .toBe(SPEC_SHADER_STAGE.VERTEX | SPEC_SHADER_STAGE.FRAGMENT);
        expect(gpuShaderStage(ShaderStage.COMPUTE)).toBe(SPEC_SHADER_STAGE.COMPUTE);
    });

    it('defaults an absent colour write mask to all four channels', () => {
        expect(gpuColorWriteMask(undefined)).toBe(SPEC_COLOR_WRITE.ALL);
        expect(gpuColorWriteMask([true, true, true, true])).toBe(SPEC_COLOR_WRITE.ALL);
        expect(gpuColorWriteMask([false, false, false, false])).toBe(0);
        expect(gpuColorWriteMask([true, false, false, true]))
            .toBe(SPEC_COLOR_WRITE.RED | SPEC_COLOR_WRITE.ALPHA);
    });
});

describe('the identity tables', () => {
    // Each of these is the identity because rhi/types.ts took WebGPU's vocabulary on purpose. Writing
    // them out is what makes a future divergence a compile error in the Record instead of a runtime
    // surprise, and this asserts the values rather than only the shape.
    it('passes sampler and comparison state through unchanged', () => {
        expect(gpuAddressMode('mirror-repeat')).toBe('mirror-repeat');
        expect(gpuFilterMode('nearest')).toBe('nearest');
        expect(gpuCompare('less-equal')).toBe('less-equal');
    });

    it('passes blend state through unchanged', () => {
        expect(gpuBlendFactor('one-minus-src-alpha')).toBe('one-minus-src-alpha');
        expect(gpuBlendFactor('dst-alpha')).toBe('dst-alpha');
        expect(gpuBlendOperation('reverse-subtract')).toBe('reverse-subtract');
    });

    it('passes primitive state through unchanged', () => {
        expect(gpuCullMode('back')).toBe('back');
        expect(gpuFrontFace('ccw')).toBe('ccw');
        expect(gpuTopology('triangle-strip')).toBe('triangle-strip');
        expect(gpuIndexFormat('uint16')).toBe('uint16');
        expect(gpuVertexFormat('float32x3')).toBe('float32x3');
        expect(gpuVertexFormat('unorm8x4')).toBe('unorm8x4');
    });

    it('passes load and store ops through unchanged', () => {
        expect(gpuLoadOp('clear')).toBe('clear');
        expect(gpuLoadOp('load')).toBe('load');
        expect(gpuStoreOp('discard')).toBe('discard');
        expect(gpuStoreOp('store')).toBe('store');
    });
});
