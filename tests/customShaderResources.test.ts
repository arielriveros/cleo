import { describe, it, expect } from 'vitest';
import { customShaderResources } from '../src/graphics/systems/customShaders';
import ClusteredLightsChunk from '../src/graphics/shaders/wgsl/clusteredLightsChunk.wgsl';

// A forward custom material's bind-group layout must carry everything its prelude samples. The light
// grid's texture went missing once (it moved groups; the filter here did not follow), which left it
// unbound on WebGL2, its sampler on unit 0 beside u_envMap's cube — and every lit forward custom
// material's draw rejected with "two textures of different types use the same sampler location".
describe('customShaderResources — forward', () => {
    const resources = customShaderResources('forward', []);

    it('carries the clustered light data at the group and binding the chunk declares, with its sampler', () => {
        const declared = ClusteredLightsChunk.resources.find((r: any) => r.kind === 'texture' && r.glslName === 'u_lightData');
        expect(declared).toBeDefined();
        const tex = resources.find(r => r.kind === 'texture' && r.glslName === 'u_lightData');
        expect(tex).toMatchObject({ group: declared!.group, binding: declared!.binding });
        expect(resources.find(r => r.kind === 'sampler' && r.glslName === 'u_lightData'))
            .toMatchObject({ group: declared!.group, binding: declared!.binding + 1 });
    });

    it('carries the scene samplers in group 0 after the environment cube', () => {
        const group0 = resources.filter(r => r.group === 0 && r.kind === 'texture').map(r => r.glslName);
        expect(group0.slice(0, 3)).toEqual(['u_envMap', 'u_sceneDepth', 'u_sceneColor']);
    });

    it('has no two resources on one group/binding', () => {
        const keys = resources.map(r => `${r.group}/${r.binding}`);
        expect(new Set(keys).size).toBe(keys.length);
    });
});

describe('usedResources', () => {
    // WebGPU's automatic layout drops every binding the entry points never reach. Listing one anyway made
    // the group invalid ("binding index 7 not present") and blacked out the frame: the Valley's water
    // reads the light grid with textureLoad, so its light-data SAMPLER is declared and never used.
    it('keeps only resources the WGSL uses, matched by group and binding', async () => {
        const { usedResources } = await import('../src/graphics/systems/customShaders');
        const wgsl = `
@group(3) @binding(6) var u_lightData_texture: texture_2d<f32>;
@group(3) @binding(7) var u_lightData_sampler: sampler;
@group(3) @binding(0) var shadows: texture_depth_2d_array;
@fragment fn main() -> @location(0) vec4<f32> { let a = textureLoad(u_lightData_texture, vec2<i32>(0), 0); return a; }`;
        const res = [
            { group: 3, binding: 6, name: 'a', kind: 'texture', type: 't', glslName: 'u_lightData' },
            { group: 3, binding: 7, name: 'b', kind: 'sampler', type: 's', glslName: 'u_lightData' },
            { group: 3, binding: 0, name: 'c', kind: 'texture', type: 't', glslName: 'u_shadowCascades' },
            { group: 0, binding: 0, name: 'd', kind: 'texture', type: 't', glslName: 'u_undeclared' },
        ] as any[];
        expect(usedResources(res, wgsl).map(r => r.binding + ':' + r.group)).toEqual(['6:3', '0:0']);
        expect(usedResources(res)).toBe(res);   // no WGSL (WebGL2): untouched
    });
});
