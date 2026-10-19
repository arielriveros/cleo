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
