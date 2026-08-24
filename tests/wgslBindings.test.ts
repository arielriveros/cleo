import { describe, it, expect } from 'vitest';
import { samplerBindingsOf, declaredGroupsOf } from '../src/graphics/rhi/webgpu/wgslBindings';
import ScreenProgram from '../src/graphics/shaders/wgsl/screen.wgsl';
import PresentProgram from '../src/graphics/shaders/wgsl/present.wgsl';

/**
 * Which of a module's bindings are samplers.
 *
 * `WebGPUDevice.createBindGroup` synthesises the sampler this engine keeps on its textures rather than
 * in a bind-group entry — but ONLY where the shader declares one. Getting that wrong does not shade
 * differently: WebGPU rejects a bind group whose entry count disagrees with its layout, which
 * invalidates the whole command buffer, so the pass does not even clear and the target reads back as
 * zeros. That looks exactly like a shader producing nothing, which is how it went unnoticed.
 */
describe('samplerBindingsOf', () => {
    it('finds the sampler beside a sampled texture', () => {
        const found = samplerBindingsOf(`
            @group(0) @binding(0) var t: texture_2d<f32>;
            @group(0) @binding(1) var s: sampler;
        `);
        expect([...(found.get(0) ?? [])]).toEqual([1]);
    });

    it('finds a comparison sampler', () => {
        const found = samplerBindingsOf(`
            @group(3) @binding(0) var shadows: texture_depth_2d_array;
            @group(3) @binding(1) var shadowCmp: sampler_comparison;
        `);
        expect([...(found.get(3) ?? [])]).toEqual([1]);
    });

    it('reports NOTHING for a texture read with textureLoad', () => {
        // The case that broke the volume readback: no sampler is declared, so none may be added.
        const found = samplerBindingsOf('@group(0) @binding(0) var v: texture_3d<f32>;');
        expect(found.size).toBe(0);
    });

    it('ignores a uniform block', () => {
        const found = samplerBindingsOf('@group(1) @binding(0) var<uniform> u: Thing;');
        expect(found.size).toBe(0);
    });

    it('ignores a storage texture', () => {
        const found = samplerBindingsOf(
            '@group(0) @binding(1) var out: texture_storage_3d<rgba8unorm, write>;');
        expect(found.size).toBe(0);
    });

    it('does not read a commented-out declaration', () => {
        // These shaders comment their bindings heavily, and a comment naming a sampler that is not
        // there would have the backend add an entry the layout has no slot for.
        const found = samplerBindingsOf(`
            // @group(0) @binding(9) var ghost: sampler;
            /* @group(0) @binding(8) var alsoGhost: sampler; */
            @group(0) @binding(0) var t: texture_2d<f32>;
        `);
        expect(found.size).toBe(0);
    });

    it('keeps groups apart', () => {
        const found = samplerBindingsOf(`
            @group(0) @binding(1) var a: sampler;
            @group(2) @binding(3) var b: sampler;
        `);
        expect([...(found.get(0) ?? [])]).toEqual([1]);
        expect([...(found.get(2) ?? [])]).toEqual([3]);
    });

    it('agrees with the engine\'s own shaders', () => {
        // screen.wgsl: one texture + its sampler. present.wgsl: two pairs, the second a depth texture.
        expect([...(samplerBindingsOf(ScreenProgram.wgsl).get(0) ?? [])]).toEqual([1]);
        expect([...(samplerBindingsOf(PresentProgram.wgsl).get(0) ?? [])]).toEqual([1, 3]);
    });
});

describe('declaredGroupsOf', () => {
    it('lists each group once, sorted', () => {
        expect(declaredGroupsOf(`
            @group(2) @binding(0) var a: sampler;
            @group(0) @binding(0) var b: sampler;
            @group(2) @binding(1) var c: sampler;
        `)).toEqual([0, 2]);
    });

    it('reports none for a module that binds nothing', () => {
        expect(declaredGroupsOf('@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }'))
            .toEqual([]);
    });
});
