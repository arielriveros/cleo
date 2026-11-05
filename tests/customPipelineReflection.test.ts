import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/graphics/rhi/deviceHandle', () => ({
    device: {
        backend: 'webgpu',
        capabilities: { backend: 'webgpu', conventions: { runtimeShaderLanguage: 'wgsl' } },
        createShaderProgram: () => ({ dispose() {} }),
    },
}));

import { CustomMaterial } from '../src/graphics/material';
import {
    ensureCustomShader, setWgslTranslator, customShaderModules, customShaderResources, usedResources,
    customPipelineReflection,
} from '../src/graphics/systems/customShaders';

// A forward custom material's pipeline reflection filters its resources through `usedResources`, a regex
// pass over the whole translated WGSL — 2.5 ms for the Valley's pond, which used to pay it on every draw.
// It is now built once per material and rebuilt only when something it is built from changes.

let counter = 0;
function material(mode: 'forward' | 'deferred' = 'forward'): CustomMaterial {
    const m = CustomMaterial.Create(null, mode);
    m.fragmentSource = `vec4 fragment() { return vec4(u_tint, 1.0); }\n// ${counter++}`;
    m.uniforms = [{ name: 'tint', type: 'vec3', value: [1, 0, 0] }];
    m.refreshType();
    return m;
}

const WGSL = `
@group(3) @binding(6) var u_lightData_texture: texture_2d<f32>;
@group(3) @binding(7) var u_lightData_sampler: sampler;
@fragment fn main() -> @location(0) vec4<f32> { return textureLoad(u_lightData_texture, vec2<i32>(0), 0); }`;

beforeEach(() => { setWgslTranslator(() => WGSL); });

describe('customPipelineReflection', () => {
    it('builds the forward reflection once, with exactly what the per-draw code built', () => {
        const m = material();
        ensureCustomShader(m);
        const entry = customShaderModules(m)!;
        expect(entry).toBeDefined();
        const first = customPipelineReflection(m, 'forward');
        for (let i = 0; i < 5; i++) expect(customPipelineReflection(m, 'forward')).toBe(first);
        const expected = usedResources(customShaderResources('forward', m.uniforms), entry.fragment, entry.vertex);
        expect(first.resources.slice(0, expected.length)).toEqual(expected);
        // The vertex module is the base program's, which reads the per-object table at group 2.
        expect(first.resources.slice(expected.length)).toEqual(
            [expect.objectContaining({ group: 2, binding: 0, glslName: 'u_objectData' })]);
        expect(first.wgsl).toBe(entry.fragment);
        expect(first.entryPoints).toEqual({ fragment: 'main' });
        expect(first.vertexWgsl).toEqual({ wgsl: entry.vertex, entryPoint: entry.vertexEntry });
    });

    it('rebuilds for another mode, which carries other engine samplers and no usedResources pass', () => {
        const m = material();
        ensureCustomShader(m);
        const forward = customPipelineReflection(m, 'forward');
        const deferred = customPipelineReflection(m, 'deferred');
        expect(deferred).not.toBe(forward);
        const own = customShaderResources('deferred', m.uniforms);
        expect(deferred.resources.slice(0, own.length)).toEqual(own);
        expect(deferred.resources.slice(own.length).map(r => r.glslName)).toEqual(['u_objectData']);
    });

    it('rebuilds when the uniforms array is replaced', () => {
        const m = material();
        ensureCustomShader(m);
        const before = customPipelineReflection(m, 'forward');
        m.uniforms = [...m.uniforms, { name: 'mask', type: 'sampler2D', value: null } as never];
        const after = customPipelineReflection(m, 'forward');
        expect(after).not.toBe(before);
        expect(after.resources.some(r => r.glslName === 'u_mask')).toBe(true);
    });

    it('rebuilds when the material compiles to a new program', () => {
        const m = material();
        ensureCustomShader(m);
        const before = customPipelineReflection(m, 'forward');
        setWgslTranslator(() => WGSL + '\n// recompiled');
        m.fragmentSource += '\n// edited';
        m.refreshType();
        ensureCustomShader(m);
        const after = customPipelineReflection(m, 'forward');
        expect(after).not.toBe(before);
        expect(after.wgsl).toContain('// recompiled');
    });

    it('without translated WGSL (WebGL2), keeps every resource and names no module', () => {
        setWgslTranslator(null);
        const m = material();
        ensureCustomShader(m);
        expect(customShaderModules(m)).toBeUndefined();
        const r = customPipelineReflection(m, 'forward');
        // No translated WGSL: WebGL2's hand-written vertex stage, which keeps u_model — no table.
        expect(r.resources).toEqual(customShaderResources('forward', m.uniforms));
        expect(r.wgsl).toBeUndefined();
        expect(r.vertexWgsl).toBeUndefined();
    });
});
