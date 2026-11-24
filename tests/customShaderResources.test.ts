import { describe, it, expect } from 'vitest';
import { customShaderResources, screenShaderResources, screenUserSamplers, usedResources } from '../src/graphics/systems/customShaders';
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

// A screen material reads the sun's shadow map only when its source calls `cleoSunShadow`. The opt-in is
// what keeps every screen material saved before it hashing exactly as it did: a prelude that changed for
// all of them would have stranded their stored WGSL, and published games would stop drawing them.
describe('customShaderResources — screen, sun shadow', () => {
    const plain = 'vec4 fragment() { return texture(u_screenTexture, fragTexCoord); }';
    const shadowed = 'vec4 fragment() { vec3 p = vec3(0.0); return vec4(cleoSunShadow(p, vec3(0.0, 1.0, 0.0))); }';

    it('gives a plain screen material no group 3 and no shadow library', async () => {
        const { assembleCustomFragment } = await import('../src/graphics/systems/customShaders');
        expect(customShaderResources('screen', [], plain).some(r => r.group === 3)).toBe(false);
        for (const dialect of ['es300', 'vulkan'] as const) {
            const src = assembleCustomFragment('screen', plain, [], dialect);
            expect(src).not.toMatch(/directionalShadow|u_view\b|cleoFragCoord/);
        }
    });

    it('gives a material calling cleoSunShadow the sun cascades in group 3, and only those', () => {
        // WebGPU's layout holds what the entry point reaches: the cascade texture and its comparison
        // sampler. Listing the spot and point atlases too made a six-entry group against a two-entry
        // layout -- an invalid group and a black frame.
        const res = customShaderResources('screen', [], shadowed);
        const group3 = res.filter(r => r.group === 3);
        expect(group3.map(r => `${r.binding}:${r.kind}:${r.glslName}`))
            .toEqual(['0:texture:u_shadowCascades', '1:sampler:u_shadowCascades']);
        const keys = res.map(r => `${r.group}/${r.binding}`);
        expect(new Set(keys).size).toBe(keys.length);
    });

    it('assembles the library and u_view in both dialects', async () => {
        const { assembleCustomFragment } = await import('../src/graphics/systems/customShaders');
        const es = assembleCustomFragment('screen', shadowed, [], 'es300');
        expect(es).toMatch(/uniform mat4 u_view;/);
        expect(es).toMatch(/float cleoSunShadow\(vec3 worldPos, vec3 N\)/);
        const vk = assembleCustomFragment('screen', shadowed, [], 'vulkan');
        // The library's block beside the screen engine block (binding 0), its maps in group 3.
        expect(vk).toMatch(/layout\(std140, set = 1, binding = 2\) uniform/);
        expect(vk).toMatch(/layout\(set = 3, binding = 0\) uniform texture2DArray u_shadowCascades_t;/);
        expect(vk).toMatch(/layout\(set = 1, binding = 0\) uniform CleoEngineUniforms \{[^}]*mat4 u_view;/);
    });

    // The lighting's directionalShadow keeps both filters behind a runtime switch, runs one twice to blend
    // cascades and adds the clouds' noise. Pasted into the pencil-sketch screen material it took 71 s to compile
    // in the desktop editor's Chromium (Electron 31), and the GPU process gave up: the device was lost and Play
    // froze. The helper reads one cascade with four taps and must stay that light.
    it('keeps cleoSunShadow to one cascade and four taps: no filter loops, no cascade blend, no clouds', async () => {
        const { assembleCustomFragment } = await import('../src/graphics/systems/customShaders');
        for (const dialect of ['es300', 'vulkan'] as const) {
            const src = assembleCustomFragment('screen', shadowed, [], dialect);
            const start = src.indexOf('float cleoSunShadow(vec3 worldPos, vec3 N) {');
            expect(start).toBeGreaterThan(-1);
            const body = src.slice(start, src.indexOf('\n}\n', start));
            expect(body).not.toMatch(/directionalShadow|cleoCascadeVisibility|cleoCloudShadow|\bfor\s*\(/);
            expect(body.match(/cleoCascadeTap\(/g)?.length).toBe(4);
        }
    });
});

// The velocity buffer, opt-in the same way: a screen material naming cleoVelocity / cleoObjectVelocity gets it as
// a third engine sampler, so its own samplers move one pair along -- in the resource list and the prelude alike.
describe('customShaderResources — screen, velocity', () => {
    const moving = 'vec4 fragment() { return vec4(cleoObjectVelocity(fragTexCoord), 0.0, 1.0); }';
    const both = 'vec4 fragment() { vec3 p = vec3(0.0); return vec4(cleoVelocity(fragTexCoord), cleoSunShadow(p, vec3(0.0, 1.0, 0.0)), 1.0); }';
    const paper = [{ name: 'paper', type: 'sampler2D', value: null }] as any[];

    it('puts u_velocity after the depth and the user samplers after it', () => {
        const group0 = customShaderResources('screen', paper, moving).filter(r => r.group === 0);
        expect(group0.map(r => `${r.binding}:${r.kind}:${r.glslName}`)).toEqual([
            '0:texture:u_screenTexture', '1:sampler:u_screenTexture', '2:texture:u_depth', '3:sampler:u_depth',
            '4:texture:u_velocity', '5:sampler:u_velocity', '6:texture:u_paper', '7:sampler:u_paper',
        ]);
    });

    it('declares the sampler and the camera matrices in both dialects, and leaves other materials alone', async () => {
        const { assembleCustomFragment } = await import('../src/graphics/systems/customShaders');
        for (const dialect of ['es300', 'vulkan'] as const) {
            const src = assembleCustomFragment('screen', moving, paper, dialect);
            expect(src).toMatch(/u_velocity/);
            expect(src).toMatch(/u_uvPrevViewProj/);
            expect(src).toMatch(/vec2 cleoObjectVelocity\(vec2 uv\)/);
        }
        const vk = assembleCustomFragment('screen', moving, paper, 'vulkan');
        expect(vk).toMatch(/layout\(set = 0, binding = 4\) uniform texture2D u_velocity_t;/);
        expect(vk).toMatch(/layout\(set = 0, binding = 6\) uniform texture2D u_paper_t;/);
        const shadowOnly = 'vec4 fragment() { vec3 p = vec3(0.0); return vec4(cleoSunShadow(p, vec3(0.0, 1.0, 0.0))); }';
        expect(assembleCustomFragment('screen', shadowOnly, [], 'vulkan')).not.toMatch(/u_velocity|u_uvViewProj/);
    });

    it('combines with the sun shadow: both libraries, both groups', async () => {
        const { assembleCustomFragment } = await import('../src/graphics/systems/customShaders');
        const res = customShaderResources('screen', [], both);
        expect(res.some(r => r.glslName === 'u_velocity')).toBe(true);
        expect(res.some(r => r.group === 3 && r.glslName === 'u_shadowCascades')).toBe(true);
        const vk = assembleCustomFragment('screen', both, [], 'vulkan');
        expect(vk).toMatch(/float cleoSunShadow/);
        expect(vk).toMatch(/vec2 cleoVelocity/);
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

// The screen pass binds its user samplers by these, after its engine ones: each needs the binding's TYPE,
// because a cubemap uniform takes a cube (its panorama wrapped) and a 2D texture in that slot is refused.
describe('screenUserSamplers', () => {
    const uniforms = [
        { name: 'strength', type: 'float', value: 1 },
        { name: 'lut', type: 'sampler2D', value: null },
        { name: 'sky', type: 'samplerCube', value: null },
    ] as any[];

    it('names each user sampler with the WGSL texture type its binding declares, in declaration order', () => {
        expect(screenUserSamplers(uniforms)).toEqual([
            { name: 'u_lut', type: 'texture_2d<f32>' },
            { name: 'u_sky', type: 'texture_cube<f32>' },
        ]);
    });

    it('matches the layout the screen program declares', () => {
        const declared = screenShaderResources(uniforms).filter(r => r.kind === 'texture');
        for (const s of screenUserSamplers(uniforms))
            expect(declared.find(r => r.glslName === s.name)?.type).toBe(s.type);
    });
});

// What WebGPU's automatic layout keeps is what the ENTRY POINT reaches, not what the module mentions: naga keeps
// every prelude function, called or not, so a mention is no use at all. Counting mentions kept the sun's cascades
// for every forward material, whether or not it called shadowCalculation(), and the layout of one that did not had
// no binding 0 -- "binding index 0 not present", the frame's command buffer invalid, the viewport black.
describe('usedResources — what the entry point reaches', () => {
    const res = [
        { group: 3, binding: 0, name: 'a', kind: 'texture', type: 't', glslName: 'u_shadowCascades' },
        { group: 3, binding: 2, name: 'b', kind: 'texture', type: 't', glslName: 'u_spotShadows' },
        { group: 3, binding: 6, name: 'c', kind: 'texture', type: 't', glslName: 'u_lightData' },
    ] as any[];
    const decls = `
@group(3) @binding(0) var cascades_t: texture_depth_2d_array;
@group(3) @binding(2) var spots_t: texture_depth_2d_array;
@group(3) @binding(6) var lights_t: texture_2d<f32>;`;
    const bindings = (out: any[]) => out.map(r => r.binding);

    it('drops what only an uncalled function names, and keeps what a call chain reaches', () => {
        const wgsl = `${decls}
fn shadowCalculation() -> f32 { return f32(textureNumLayers(cascades_t)); }
fn spotVisibility() -> f32 { return f32(textureNumLayers(spots_t)); }
fn light() -> vec4<f32> { return textureLoad(lights_t, vec2<i32>(0), 0) * spotVisibility(); }
@fragment fn main() -> @location(0) vec4<f32> { return light(); }`;
        expect(bindings(usedResources(res, wgsl))).toEqual([2, 6]);
    });

    it('walks from the named entry only, so another entry point in the module adds nothing', () => {
        // A forward material's vertex stage is the whole PBR module, whose fs_main reads everything.
        const wgsl = `${decls}
@vertex fn vs_main() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); }
@fragment fn fs_main() -> @location(0) vec4<f32> { return textureLoad(lights_t, vec2<i32>(0), 0) * f32(textureNumLayers(cascades_t)); }`;
        expect(bindings(usedResources(res, { wgsl, entry: 'vs_main' }))).toEqual([]);
        expect(bindings(usedResources(res, wgsl))).toEqual([0, 6]);   // no entry named: every entry point
    });

    it('takes a resource any stage reaches', () => {
        const fragment = `${decls}\n@fragment fn main() -> @location(0) vec4<f32> { return textureLoad(lights_t, vec2<i32>(0), 0); }`;
        const vertex = `@group(3) @binding(0) var c: texture_depth_2d_array;\n@vertex fn vs() -> @builtin(position) vec4<f32> { return vec4<f32>(f32(textureNumLayers(c))); }`;
        expect(bindings(usedResources(res, { wgsl: fragment, entry: 'main' }, { wgsl: vertex, entry: 'vs' }))).toEqual([0, 6]);
    });

    it('is not misled by comments', () => {
        const wgsl = `${decls}
// fn main() { cascades_t } -- a brace in a comment {
/* @fragment fn decoy() -> @location(0) vec4<f32> { textureNumLayers(spots_t); } */
@fragment fn main() -> @location(0) vec4<f32> { /* } */ return textureLoad(lights_t, vec2<i32>(0), 0); }`;
        expect(bindings(usedResources(res, wgsl))).toEqual([6]);
    });

    it('keeps everything mentioned when it cannot find the entry point to walk from', () => {
        const wgsl = `${decls}\nfn helper() -> f32 { return f32(textureNumLayers(cascades_t)); }`;
        expect(bindings(usedResources(res, { wgsl, entry: 'main' }))).toEqual([0]);
    });
});
