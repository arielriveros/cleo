import { describe, it, expect, vi, beforeEach } from 'vitest';

// On WebGPU a custom material builds from WGSL: the editor's translator (naga, loaded on demand) or the
// translation saved with it, which an engine change to the prelude leaves stale. Built before the translator
// was installed, a material found neither, its program could not be made (not even the magenta fallback), and
// it stayed unbuildable -- drawing nothing -- until its source next changed. It is built again, translated,
// once a translator is installed.

const created: any[] = [];
vi.mock('../src/graphics/rhi/deviceHandle', () => ({
    device: {
        backend: 'webgpu',
        capabilities: { backend: 'webgpu', conventions: { runtimeShaderLanguage: 'wgsl' } },
        // As the WebGPU device does: no build-time reflection (no WGSL), no program.
        createShaderProgram: (desc: any) => {
            if (!desc.wgsl) throw new Error(`${desc.label}: WebGPU needs the build-time vertex inputs`);
            created.push(desc);
            return { dispose() {} };
        },
    },
}));

import { CustomMaterial } from '../src/graphics/material';
import { ensureCustomShader, setWgslTranslator, customShaderReady } from '../src/graphics/systems/customShaders';

let counter = 0;
function material(): CustomMaterial {
    const m = CustomMaterial.Create(null, 'forward');
    m.fragmentSource = `vec4 fragment() { return vec4(1.0); }\n// ${counter++}`;
    m.uniforms = [];
    m.refreshType();
    return m;
}

beforeEach(() => { created.length = 0; setWgslTranslator(null); });

describe('a custom material built before the WGSL translator', () => {
    it('is built again, translated, once the translator is installed', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const m = material();
        expect(ensureCustomShader(m)).toBe(false);
        expect(customShaderReady(m)).toBe(false);
        // Asked again with nothing new: still nothing, and no retry storm.
        expect(ensureCustomShader(m)).toBe(false);
        expect(created).toHaveLength(0);

        setWgslTranslator(() => '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }');
        expect(ensureCustomShader(m)).toBe(true);
        expect(customShaderReady(m)).toBe(true);
        expect(created).toHaveLength(1);
        expect(created[0].wgsl).toContain('@fragment');
        warn.mockRestore();
    });

    it('fails a source the translator rejects like one that does not compile, instead of throwing', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        setWgslTranslator(() => { throw new Error('GLSL parse failed: UnknownVariable("u_intensity")'); });
        const m = material();
        // Thrown from here, it took down the frame drawing the material, every frame.
        expect(() => ensureCustomShader(m)).not.toThrow();
        expect(ensureCustomShader(m)).toBe(false);
        expect(customShaderReady(m)).toBe(false);
        expect(created).toHaveLength(0);
        warn.mockRestore();
    });

    it('leaves a material that was built with its WGSL alone', () => {
        setWgslTranslator(() => '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(0.5); }');
        const m = material();
        expect(ensureCustomShader(m)).toBe(true);
        setWgslTranslator(() => '@fragment fn main() -> @location(0) vec4<f32> { return vec4<f32>(0.25); }');
        expect(ensureCustomShader(m)).toBe(true);
        expect(created).toHaveLength(1);
    });
});
