import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
// @ts-expect-error -- plain .mjs shared with the two bundler configs; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { MAX_TERRAIN_SURFACES, SURFACE_EPSILON, RANGE_FALLOFF_MIN } from '../src/terrain/terrainLayers';

// The landscape layer stack's shader, checked the only ways available without a GPU: it must survive
// naga (WGSL validation + the GLSL the WebGL2 backend runs), bind exactly three array textures however
// many surfaces there are, and keep every fetch inside the loop an explicit-gradient one — an implicit
// derivative below a data-dependent `continue` is a module Dawn rejects outright.

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const CHUNK = readFileSync(join(WGSL_DIR, 'chunks', 'terrainStack.wgsl'), 'utf-8');

/** A deferred terrain program around the chunk, the way geometryTerrain composes it. */
const PROGRAM = `
#include "./chunks/modelVertex.wgsl"
#include "./chunks/tonemap.wgsl"
#include "./chunks/terrainStack.wgsl"

struct GBuffer {
    @location(0) albedoMetallic: vec4<f32>,
    @location(1) normalRoughness: vec4<f32>,
    @location(2) emissiveAO: vec4<f32>,
};

@fragment
fn fs_main(in: VertexOutput) -> GBuffer {
    let s = resolveTerrainSurface(in.fragPos, in.uv, tbnOf(in));
    var out: GBuffer;
    out.albedoMetallic = vec4<f32>(s.albedo, s.metallic);
    let octN = octEncode(s.normal);
    out.normalRoughness = vec4<f32>(octN.x, octN.y, 0.5,
        filterSpecularRoughness(s.roughness, s.normal, u_terrain.u_specularAA));
    out.emissiveAO = vec4<f32>(0.0, 0.0, 0.0, s.ao);
    return out;
}
`;

async function translate() {
    const composed = resolveIncludes(PROGRAM, WGSL_DIR, {
        read: (p: string) => readFileSync(p, 'utf-8'),
        resolve: (dir: string, rel: string) => join(dir, rel),
        onDependency: () => {},
    });
    return translateWgsl(composed, join(WGSL_DIR, 'terrainStackProbe.wgsl'));
}

/** The body of `resolveTerrainSurface`. */
function resolveBody(): string {
    const start = CHUNK.indexOf('fn resolveTerrainSurface');
    return CHUNK.slice(start);
}

describe('terrain layer stack shader', () => {
    it('translates through naga to both stages', async () => {
        const out = await translate();
        expect(out.vertex).toBeTruthy();
        expect(out.fragment).toBeTruthy();
        expect(out.fragment).toContain('sampler2DArray');
    });

    it('binds exactly three array textures, whatever the surface count', async () => {
        const out = await translate();
        const group0 = out.resources.filter((r: any) => r.group === 0);
        const textures = group0.filter((r: any) => r.kind === 'texture');
        expect(textures.map((r: any) => r.glslName).sort()).toEqual(['u_masks', 'u_surfAlbedo', 'u_surfNormal']);
        for (const t of textures) expect(t.type).toContain('texture_2d_array');
        expect(group0.filter((r: any) => r.kind === 'sampler').length).toBe(3);
    });

    it('takes derivatives once, above the loop, and only explicit-gradient fetches below it', () => {
        const body = resolveBody();
        const loop = body.indexOf('for (var i');
        expect(loop).toBeGreaterThan(0);
        const below = body.slice(loop);
        expect(below).not.toMatch(/\bdpdx\b|\bdpdy\b|\bfwidth\b/);
        expect(below).not.toMatch(/textureSample\(/);
        expect(below).not.toMatch(/textureSampleBias\(/);
        expect(body.slice(0, loop)).toMatch(/dpdx\(baseUv\)/);
        // The helpers the loop calls take no derivatives either.
        for (const fn of ['rangeCoverage', 'transitionShift', 'ruleNoise', 'valueNoise', 'hash12', 'slopeDegrees'])
            expect(CHUNK.slice(CHUNK.indexOf(`fn ${fn}`), CHUNK.indexOf('}', CHUNK.indexOf(`fn ${fn}`))))
                .not.toMatch(/\bdpdx\b|\bdpdy\b|textureSample\(/);
    });

    it('shares its constants with the CPU twin', () => {
        const constant = (name: string) => Number(new RegExp(`const ${name}: \\w+ = ([^;]+);`).exec(CHUNK)![1]);
        expect(constant('MAX_TERRAIN_SURFACES')).toBe(MAX_TERRAIN_SURFACES);
        expect(constant('SURFACE_EPSILON')).toBe(SURFACE_EPSILON);
        expect(constant('RANGE_FALLOFF_MIN')).toBe(RANGE_FALLOFF_MIN);
        for (const m of CHUNK.matchAll(/array<vec4<f32>, (\d+)>/g)) expect(Number(m[1])).toBe(MAX_TERRAIN_SURFACES);
    });

    it('no per-surface uniform name ends in a digit (naga would escape it)', () => {
        const struct = CHUNK.slice(CHUNK.indexOf('struct TerrainUniforms'), CHUNK.indexOf('};', CHUNK.indexOf('struct TerrainUniforms')));
        for (const m of struct.matchAll(/^\s*(u_\w+)\s*:/gm)) expect(m[1]).not.toMatch(/\d$/);
    });
});
