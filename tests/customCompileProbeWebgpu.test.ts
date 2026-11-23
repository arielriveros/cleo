import { describe, it, expect, vi, beforeEach } from 'vitest';

// The material inspector's Compile asks `tryCompileCustom` whether a shader compiles. It used to build the GLSL
// program on the device -- which a WebGPU device refuses for every shader ("WebGPU needs the build-time vertex
// inputs…"), so on WebGPU each Compile showed that as the error and the material never took the edit or stored
// its WGSL. There the translation is the verdict.

const built: any[] = [];
vi.mock('../src/graphics/rhi/deviceHandle', () => ({
    device: {
        backend: 'webgpu',
        capabilities: { backend: 'webgpu', conventions: { runtimeShaderLanguage: 'wgsl' } },
        // As the real one does for a descriptor without its build-time layout.
        createShaderProgram: (desc: any) => {
            built.push(desc);
            if (!desc.vertexInputs || !desc.uniformBlocks) throw new Error(`${desc.label}: WebGPU needs the build-time vertex inputs`);
            return { dispose() {} };
        },
    },
}));

import { setWgslTranslator, tryCompileCustom } from '../src/graphics/systems/customShaders';

const SOURCE = 'vec4 fragment() { return texture(u_screenTexture, fragTexCoord); }';

beforeEach(() => { built.length = 0; setWgslTranslator(null); });

describe('the compile probe on a WGSL device', () => {
    it('never builds the GLSL program, and returns the translation', () => {
        setWgslTranslator(glsl => `/* from ${glsl.length} chars */ @fragment fn main() {}`);
        const res = tryCompileCustom('screen', SOURCE, []);
        expect(res.ok).toBe(true);
        expect(res.error).toBeUndefined();
        expect(res.wgsl).toMatch(/@fragment fn main/);
        expect(built).toEqual([]);
    });

    it('reports a shader that does not translate as the compile error', () => {
        setWgslTranslator(() => { throw new Error('naga: unknown identifier `u_nope`'); });
        const res = tryCompileCustom('screen', 'vec4 fragment() { return vec4(u_nope); }', []);
        expect(res.ok).toBe(false);
        expect(res.error).toMatch(/u_nope/);
    });

    it('passes a shader through when there is no translator to judge it with yet', () => {
        expect(tryCompileCustom('screen', SOURCE, [])).toEqual({ ok: true });
        expect(built).toEqual([]);
    });
});
