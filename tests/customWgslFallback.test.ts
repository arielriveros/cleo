import { describe, it, expect, vi, beforeEach } from 'vitest';

// A published game has no GLSL -> WGSL translator, so on WebGPU a custom material can only render from
// the WGSL it was saved with. These pin the rule `webgpuHalf` applies: the stored WGSL is used exactly
// when its hash matches the Vulkan source the material assembles to NOW — not when only the material's
// own `type` matches, because an engine prelude change moves bindings under an unchanged material.

const created: any[] = [];
vi.mock('../src/graphics/rhi/deviceHandle', () => ({
    device: {
        backend: 'webgpu',
        createShaderProgram: (desc: any) => { created.push(desc); return { dispose() {} }; },
    },
}));

import { CustomMaterial } from '../src/graphics/material';
import { ensureCustomShader, customWgslHash, setWgslTranslator, customShaderModules } from '../src/graphics/systems/customShaders';

const SOURCE = 'vec4 fragment() { return vec4(u_tint, 1.0); }';
let counter = 0;

function material(): CustomMaterial {
    const m = CustomMaterial.Create(null, 'forward');
    // A unique body per test: registration is cached by content hash across the whole module.
    m.fragmentSource = `${SOURCE}\n// ${counter++}`;
    m.uniforms = [{ name: 'tint', type: 'vec3', value: [1, 0, 0] }];
    m.refreshType();
    return m;
}

beforeEach(() => { created.length = 0; setWgslTranslator(null); });

describe('custom materials without a translator (a published WebGPU game)', () => {
    it('compiles from the stored WGSL when its hash matches the assembled source', () => {
        const m = material();
        m.compiledWgsl = '/* stored */ @fragment fn main() {}';
        m.compiledWgslType = m.type;
        m.compiledWgslHash = customWgslHash(m.renderMode, m.fragmentSource, m.uniforms);
        expect(ensureCustomShader(m)).toBe(true);
        expect(created[0].wgsl).toContain('/* stored */');
        expect(customShaderModules(m)?.fragment).toContain('/* stored */');
    });

    it('ignores stored WGSL whose hash does not match (stale prelude or source)', () => {
        const m = material();
        m.compiledWgsl = '/* stale */ @fragment fn main() {}';
        m.compiledWgslType = m.type;     // the type alone would have accepted it
        m.compiledWgslHash = 'not-this-source';
        ensureCustomShader(m);
        expect(created[0].wgsl).toBeUndefined();
    });

    it('prefers a live translator over anything stored', () => {
        setWgslTranslator(() => '/* live */ @fragment fn main() {}');
        const m = material();
        m.compiledWgsl = '/* stored */';
        m.compiledWgslHash = customWgslHash(m.renderMode, m.fragmentSource, m.uniforms);
        ensureCustomShader(m);
        expect(created[0].wgsl).toContain('/* live */');
    });

    it('round-trips the hash through serialize/parse', () => {
        const m = material();
        m.compiledWgsl = 'x';
        m.compiledWgslHash = 'h';
        expect(CustomMaterial.parse(m.serialize()).compiledWgslHash).toBe('h');
    });
});
