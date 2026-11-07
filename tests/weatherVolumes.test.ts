import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { mat4, vec3 } from 'gl-matrix';
// @ts-expect-error -- plain .mjs shared with the two bundler configs; it has no declarations.
import { translateWgsl } from '../tools/wgslTranslate.mjs';
// @ts-expect-error -- same.
import { resolveIncludes } from '../tools/shaderIncludes.mjs';
import { Node } from '../src/core/scene/nodes/node';
import { WeatherNode, MIN_WEATHER_VOLUME_SIZE } from '../src/core/scene/nodes/weatherNode';
import { WEATHER_PRESETS } from '../src/core/scene/nodes/weatherPresets';
import {
    MAX_WEATHER_VOLUMES, gatherWeather, packWeather, resolveWeatherAt, snowForLandscape, shelterFootprint,
    shelterMatrix, shelterClearanceDepth, SHELTER_RANGE, SHELTER_CLEARANCE,
} from '../src/graphics/render/weatherPack';
import { ShadowPasses } from '../src/graphics/render/shadows';
import { Material } from '../src/graphics/material';

/**
 * Weather volumes (WeatherNode as a box, render/weatherPack.ts, chunks/weatherVolumes.wgsl): rain and
 * snow inside a box on the landscape and its plants, kept off what stands under something solid.
 */

const box = (name: string, opts: ConstructorParameters<typeof WeatherNode>[1], at: [number, number, number] = [0, 0, 0]) => {
    const n = new WeatherNode(name, opts);
    n.setPosition(at);
    n.updateTransforms();
    return n;
};
const camera = vec3.fromValues(0, 2, 0);

describe('the weather node', () => {
    it('reads a scene saved before boxes as unbounded, exactly as it looked', () => {
        const legacy = new WeatherNode('w', { wetness: 0.6, snow: 0.2 });
        expect(legacy.bounded).toBe(false);
        expect(legacy.size).toEqual([0, 0, 0]);
        expect(legacy.weightAt(vec3.fromValues(1e4, -50, 3e3))).toBe(1);
        expect(legacy.shelter).toBe(true);
    });

    it('is a box: inside, feathered at the faces, nothing outside or disabled', () => {
        const n = box('w', { size: [20, 10, 20], blendDistance: 2, wetness: 1 });
        expect(n.bounded).toBe(true);
        expect(n.weightAt(vec3.fromValues(0, 0, 0))).toBe(1);
        expect(n.weightAt(vec3.fromValues(9, 0, 0))).toBeGreaterThan(0);
        expect(n.weightAt(vec3.fromValues(9, 0, 0))).toBeLessThan(1);
        expect(n.weightAt(vec3.fromValues(11, 0, 0))).toBe(0);
        n.enabled = false;
        expect(n.weightAt(vec3.fromValues(0, 0, 0))).toBe(0);
    });

    it('turns with its node', () => {
        const n = box('w', { size: [40, 10, 4], blendDistance: 0, wetness: 1 });
        n.setRotation([0, 90, 0]);
        n.updateTransforms();
        expect(n.weightAt(vec3.fromValues(0, 0, 15))).toBe(1);
        expect(n.weightAt(vec3.fromValues(15, 0, 0))).toBe(0);
    });

    it('clamps a bounded size but keeps [0, 0, 0] as the whole scene', () => {
        const n = new WeatherNode('w');
        n.size = [5, 0, -2];
        expect(n.size).toEqual([5, MIN_WEATHER_VOLUME_SIZE, MIN_WEATHER_VOLUME_SIZE]);
        n.size = [0, 0, 0];
        expect(n.bounded).toBe(false);
    });

    it('round-trips every field, the snow material included', () => {
        const snow = Material.PBR({ baseColor: [0.95, 0.96, 1], roughness: 0.7 });
        const n = box('w', {
            size: [30, 8, 12], blendDistance: 3, priority: 2, enabled: false, wetness: 0.4, snow: 0.8, puddles: 0.25,
            snowTiling: 6, snowSlope: 30, snowBreakup: 0.7, shelter: false, snowMaterial: snow.serialize(), snowMaterialId: 'mat-snow',
        });
        const json = (n as any)._serializePayload().weather;
        const back = new WeatherNode('again', json);
        for (const key of ['size', 'blendDistance', 'priority', 'enabled', 'wetness', 'snow', 'puddles', 'snowTiling', 'snowSlope', 'snowBreakup', 'shelter', 'snowMaterialId'] as const)
            expect((back as any)[key], key).toEqual((n as any)[key]);
        expect(back.snowMaterial?.properties.get('roughness')).toBeCloseTo(0.7);
    });

    it('presets set the weather only, never the box, the material or the shelter', () => {
        const n = box('w', { size: [10, 10, 10], shelter: false });
        expect(n.applyPreset('rain')).toBe(true);
        expect([n.wetness, n.puddles]).toEqual([1, 0.7]);
        expect(n.size).toEqual([10, 10, 10]);
        expect(n.shelter).toBe(false);
        for (const p of WEATHER_PRESETS) for (const key of Object.keys(p.options))
            expect(['wetness', 'snow', 'puddles'], `${p.id}.${key}`).toContain(key);
    });

    it('is parsed back by the scene loader as a weather node with its box', () => {
        const root = new Node('root');
        WeatherNode.parse(root, { name: 'Rain', id: 'rain', type: 'weather', position: [1, 2, 3], weather: { size: [8, 4, 8], wetness: 1 } });
        const w = root.children[0] as WeatherNode;
        expect(w).toBeInstanceOf(WeatherNode);
        expect(w.size).toEqual([8, 4, 8]);
    });
});

describe('the frame’s volumes', () => {
    it('keep at most four, the highest priority and the nearest first, in composite order', () => {
        const far = box('far', { size: [4, 4, 4], wetness: 1 }, [80, 0, 0]);
        const near = [0, 1, 2, 3].map(i => box(`n${i}`, { size: [4, 4, 4], wetness: 1, priority: i % 2 }, [i * 5, 0, 0]));
        const dry = box('dry', { size: [4, 4, 4] });
        const picked = gatherWeather([far, ...near, dry], camera);
        expect(picked.length).toBe(MAX_WEATHER_VOLUMES);
        expect(picked).not.toContain(far);
        expect(picked).not.toContain(dry);
        // Ascending priority: the priority-1 volumes composite last.
        expect(picked.map(v => v.priority)).toEqual([0, 0, 1, 1]);
    });

    it('drop what is out of reach, never an unbounded one', () => {
        const away = box('away', { size: [10, 10, 10], wetness: 1 }, [5000, 0, 0]);
        const everywhere = new WeatherNode('everywhere', { wetness: 0.5 });
        expect(gatherWeather([away, everywhere], camera)).toEqual([everywhere]);
    });

    it('composite in priority order, so a dry box inside a snowy one carves a dry pocket', () => {
        const winter = box('winter', { size: [100, 50, 100], blendDistance: 0, snow: 1, wetness: 0.2 });
        const shed = box('shed', { size: [6, 6, 6], blendDistance: 0, priority: 1, wetness: 0 });
        shed.snow = 0; shed.wetness = 0.001;
        const pack = packWeather(gatherWeather([winter, shed], camera));
        const inside = resolveWeatherAt(pack, vec3.fromValues(0, 0, 0));
        const outside = resolveWeatherAt(pack, vec3.fromValues(20, 0, 20));
        expect(inside.snow).toBe(0);
        expect(outside.snow).toBe(1);
        expect(outside.wet).toBeCloseTo(0.2);
    });

    it('pack the slope as its cosine, the shelter as a flag, and an unbounded box as weight 1', () => {
        const v = new WeatherNode('v', { snow: 1, snowSlope: 60, snowBreakup: 0.3, shelter: false });
        const pack = packWeather([v]);
        expect(pack.count).toBe(1);
        expect(pack.shape[0]).toBeCloseTo(0.5);
        expect(pack.shape[1]).toBeCloseTo(0.3);
        expect(pack.amount[3]).toBe(0);
        expect(pack.blend[3]).toBe(1);
        expect(resolveWeatherAt(pack, vec3.fromValues(1e4, 0, 0)).snow).toBe(1);
    });

    it('hash the pack, so the foliage shadow cache follows the weather', () => {
        const v = box('v', { size: [10, 10, 10], wetness: 0.5 });
        const a = packWeather([v]).hash;
        v.wetness = 0.6;
        expect(packWeather([v]).hash).not.toBe(a);
        expect(packWeather([]).count).toBe(0);
    });
});

describe('the snow material on a landscape', () => {
    const land = { min: vec3.fromValues(-100, -10, -100), max: vec3.fromValues(100, 50, 100) };
    const material = Material.PBR({ baseColor: [1, 1, 1] }).serialize();

    it('comes from the highest-priority snowing volume that reaches the landscape', () => {
        const low = box('low', { size: [10, 10, 10], snow: 1, snowMaterial: material, priority: 0 });
        const high = box('high', { size: [10, 10, 10], snow: 1, snowMaterial: material, priority: 3 }, [20, 0, 0]);
        const away = box('away', { size: [10, 10, 10], snow: 1, snowMaterial: material, priority: 9 }, [900, 0, 0]);
        const bare = box('bare', { size: [10, 10, 10], snow: 1, priority: 10 });
        expect(snowForLandscape([low, high, away, bare], land)).toBe(high);
    });

    it('is none while nothing snows', () => {
        expect(snowForLandscape([box('rain', { size: [10, 10, 10], wetness: 1, snowMaterial: material })], land)).toBeNull();
    });
});

describe('the shelter map', () => {
    const rain = () => box('rain', { size: [60, 20, 60], wetness: 1 });

    it('covers a square round the camera, snapped to its texels, and recentres only past an eighth of it', () => {
        const f = shelterFootprint([rain()], vec3.fromValues(3.03, 0, -7.41), 1024, null)!;
        const texel = SHELTER_RANGE / 1024;
        expect(f.size).toBe(SHELTER_RANGE);
        expect(Math.abs(f.centre[0] / texel - Math.round(f.centre[0] / texel))).toBeLessThan(1e-6);
        const kept = shelterFootprint([rain()], vec3.fromValues(3.03 + SHELTER_RANGE / 9, 0, -7.41), 1024, f)!;
        expect(kept.centre).toBe(f.centre);
        const moved = shelterFootprint([rain()], vec3.fromValues(3.03 + SHELTER_RANGE / 7, 0, -7.41), 1024, f)!;
        expect(moved.centre).not.toBe(f.centre);
    });

    it('is not drawn when no volume keeps shelter there', () => {
        const open = rain(); open.shelter = false;
        expect(shelterFootprint([open], camera, 1024, null)).toBeNull();
        expect(shelterFootprint([box('far', { size: [10, 10, 10], wetness: 1 }, [500, 0, 0])], camera, 1024, null)).toBeNull();
    });

    it('looks straight down: the top of the box at depth 0, its bottom at 1, the clearance in between', () => {
        const f = shelterFootprint([rain()], camera, 1024, null)!;
        const m = shelterMatrix(mat4.create(), f);
        const depthAt = (y: number) => {
            const p = vec3.transformMat4(vec3.create(), vec3.fromValues(f.centre[0], y, f.centre[1]), m);
            return p[2] * 0.5 + 0.5;
        };
        expect(depthAt(f.top)).toBeCloseTo(0, 5);
        expect(depthAt(f.bottom)).toBeCloseTo(1, 5);
        expect(shelterClearanceDepth(f)).toBeCloseTo(SHELTER_CLEARANCE / (f.top - f.bottom), 8);
        // North (-Z) is up the map, east (+X) to the right: x and z land on the map's two axes.
        const east = vec3.transformMat4(vec3.create(), vec3.fromValues(f.centre[0] + 10, 0, f.centre[1]), m);
        expect(east[0]).toBeGreaterThan(0);
        expect(Math.abs(east[1])).toBeLessThan(1e-6);
    });

    it('is cast by solid, still, large-enough models: never foliage, glass or something moving', () => {
        const solid = Material.PBR({});
        const glass = Material.PBR({}); glass.config.transparent = true;
        const leaves = Material.PBR({}); (leaves as any).foliage = true;
        const thatch = Material.PBR({}); thatch.config.alphaCutoff = 0.5;
        expect(ShadowPasses.isShelterCaster([solid], 3, false)).toBe(true);
        expect(ShadowPasses.isShelterCaster([thatch], 3, false)).toBe(true);
        expect(ShadowPasses.isShelterCaster([glass], 3, false)).toBe(false);
        expect(ShadowPasses.isShelterCaster([leaves, solid], 3, false)).toBe(false);
        expect(ShadowPasses.isShelterCaster([solid], 0.2, false)).toBe(false);
        expect(ShadowPasses.isShelterCaster([solid], 3, true)).toBe(false);
    });
});

const WGSL_DIR = join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl');
const compose = (file: string, defines: Record<string, number> = {}) => resolveIncludes(readFileSync(join(WGSL_DIR, file), 'utf-8'), WGSL_DIR, {
    read: (p: string) => readFileSync(p, 'utf-8'), resolve: (dir: string, rel: string) => join(dir, rel), onDependency: () => {}, defines,
});

describe('the weather shaders', () => {
    it('reach the landscape through a fragment-only block and the shelter map at group 3, binding 8', async () => {
        for (const file of ['geometryTerrain.wgsl', 'terrainForward.wgsl']) {
            const out = await translateWgsl(compose(file), join(WGSL_DIR, file));
            // naga writes every struct into both stages; the BLOCK is what a stage reads.
            expect(out.fragment, file).toMatch(/uniform TerrainWeatherUniforms_block_\d+Fragment/);
            expect(out.vertex, file).not.toMatch(/uniform TerrainWeatherUniforms_block/);
            expect(out.fragment, file).toMatch(/uniform highp sampler2DArrayShadow u_weatherShelter;/);
            const shelter = out.resources.find((r: any) => r.glslName === 'u_weatherShelter' && r.kind === 'texture');
            expect(shelter, file).toMatchObject({ group: 3, binding: 8 });
        }
    });

    it('reach every plant through the vertex block, with the shelter map in group 0 after the material maps', async () => {
        const out = await translateWgsl(compose('geometryPBRInstanced.wgsl', { CLEO_POM: 0, CLEO_WIND: 1, CLEO_FOLIAGE: 1 }),
                                        join(WGSL_DIR, 'geometryPBRInstanced.wgsl'));
        expect(out.vertex).toMatch(/uniform InstancedTransform_block_\d+Vertex/);
        expect(out.fragment).not.toMatch(/uniform InstancedTransform_block/);
        expect(out.vertex).toMatch(/uniform highp sampler2DArrayShadow u_weatherShelter;/);
        expect(out.resources.find((r: any) => r.glslName === 'u_weatherShelter' && r.kind === 'texture')).toMatchObject({ group: 0, binding: 12 });
        // The shadows bow the same plants the same way, from their own vertex block.
        const depth = await translateWgsl(compose('shadowMapInstanced.wgsl', { CLEO_WIND: 1, CLEO_FOLIAGE: 1 }),
                                          join(WGSL_DIR, 'shadowMapInstanced.wgsl'));
        expect(depth.vertex).toMatch(/weatherCount/);
    });

    it('leave the landscape in uniform control flow: no derivative, no implicit fetch, no early return', () => {
        const body = readFileSync(join(WGSL_DIR, 'chunks', 'terrainWeather.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');
        const apply = body.slice(body.indexOf('fn applyTerrainWeather'));
        expect(apply).not.toMatch(/\bdpdx|\bdpdy|\bfwidth/);
        expect(apply).not.toMatch(/textureSample\(/);
        expect(apply).not.toMatch(/\breturn\b/);
    });
});

describe("the snow material's layer of a landscape", () => {
    it('is the row after the stack, outside the composite, and every surface stays as it was', async () => {
        const { TerrainLayerStack } = await import('../src/terrain/terrainLayerStack');
        const { TerrainMaterial } = await import('../src/graphics/material');
        const stack = new TerrainLayerStack(16, 16);
        stack.setBase(TerrainMaterial.Create('pbr', {}));
        const snow = Material.PBR({ baseColor: [0.9, 0.92, 1], roughness: 0.6, metallic: 0 });
        snow.textures.set('baseColorTexture', 'snow-albedo');
        snow.textures.set('normalMap', 'snow-normal');
        const plain = Material.Terrain();
        stack.writeUniforms(plain);
        const m = Material.Terrain();
        stack.writeUniforms(m, undefined, 1, { material: snow, tiling: 500 });
        const count = m.properties.get('u_surfCount');
        expect(count).toBe(plain.properties.get('u_surfCount'));
        expect(m.properties.get('u_snowLayer')).toBe(count);
        expect(plain.properties.get('u_snowLayer')).toBe(-1);
        const mat = m.properties.get('u_surfMaterial'), flags = m.properties.get('u_surfFlags');
        expect([mat[count * 4 + 1], mat[count * 4 + 2]].map(v => Math.round(v * 100) / 100)).toEqual([0.6, 500]);
        expect([flags[count * 4], flags[count * 4 + 2]]).toEqual([1, 1]);
        // The stack's own rows are untouched.
        for (let i = 0; i < count * 4; i++) expect(mat[i]).toBe(plain.properties.get('u_surfMaterial')[i]);
    });
});
