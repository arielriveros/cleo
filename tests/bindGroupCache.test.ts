import { describe, it, expect, beforeEach } from 'vitest';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { BindGroupCache } from '../src/graphics/render/bindGroups';
import type { FrameTargets } from '../src/graphics/render/frameTargets';
import type { Texture } from '../src/graphics/texture';
import type { RenderPipeline } from '../src/graphics/rhi/resources';

/** A stand-in texture: what the bind-group cache reads off one. */
const texture = (name: string) => ({ name, sampledView: { name }, rhiTexture: { generation: 0 } }) as unknown as Texture;

const cascades = texture('cascades'), spots = texture('spots'), points = texture('points'), grid = texture('grid');
const shelter = texture('shelter');

/** A pipeline whose group 3 declares exactly these resources. */
function pipeline(label: string, group3: { name: string; binding: number }[]): RenderPipeline {
    return {
        label,
        resources: group3.map(r => ({ group: 3, binding: r.binding, glslName: r.name, kind: 'texture', type: 'texture_2d<f32>' })),
        layoutForGroup: () => ({}),
    } as unknown as RenderPipeline;
}

let created: { label: string; entries: { binding: number; textureView: unknown }[] }[] = [];
beforeEach(() => {
    created = [];
    setDevice({ createBindGroup: (d: any) => { created.push(d); return { label: d.label }; } } as any);
});

function cache() {
    return new BindGroupCache({
        shadowCascades: () => cascades, spotShadows: () => spots, pointShadows: () => points, lightGrid: () => grid,
        weatherShelter: () => shelter,
    }, {} as FrameTargets);
}

describe('the frame-lighting group', () => {
    it('names only the bindings the program declares', () => {
        // A naga-translated custom surface that samples the sun's cascades but no spot or point shadow:
        // its layout has no binding 2 or 4, and naming them would invalidate the frame's command buffer.
        const water = pipeline('water', [{ name: 'u_shadowCascades', binding: 0 }, { name: 'u_lightData', binding: 6 }]);
        cache().frameLightingGroup(water);
        expect(created[0].entries.map(e => e.binding)).toEqual([0, 6]);
    });

    it('reads the light grid alone for a program without shadows, and nothing for an unlit one', () => {
        const c = cache();
        const terrain = pipeline('terrainForward', [{ name: 'u_lightData', binding: 6 }]);
        const basic = pipeline('basic', []);
        expect(c.declaresShadowGroup(terrain)).toBe(false);
        expect(c.declaresLightGrid(terrain)).toBe(true);
        expect(c.declaresFrameLighting(basic)).toBe(false);
        c.frameLightingGroup(terrain);
        expect(created[0].entries.map(e => e.binding)).toEqual([6]);
    });

    it("binds the weather's shelter map at 8, alone for the deferred landscape and after the grid for the forward one", () => {
        const c = cache();
        const deferred = pipeline('terrainGeometry', [{ name: 'u_weatherShelter', binding: 8 }]);
        const forward = pipeline('terrainForward', [{ name: 'u_lightData', binding: 6 }, { name: 'u_weatherShelter', binding: 8 }]);
        expect(c.declaresFrameLighting(deferred)).toBe(true);
        expect(c.declaresWeatherShelter(deferred)).toBe(true);
        expect(c.declaresShadowGroup(deferred)).toBe(false);
        c.frameLightingGroup(deferred, false);
        c.frameLightingGroup(forward);
        expect(created.map(g => g.entries.map(e => e.binding))).toEqual([[8], [6, 8]]);
        expect((created[0].entries[0].textureView as { name: string }).name).toBe('shelter');
        // Never named for a program that does not declare it.
        c.frameLightingGroup(pipeline('pbr', [{ name: 'u_shadowCascades', binding: 0 }]));
        expect(created[2].entries.map(e => e.binding)).toEqual([0]);
    });

    it('leaves the punctual atlases out when the caller says so', () => {
        const lit = pipeline('pbr', [{ name: 'u_shadowCascades', binding: 0 }, { name: 'u_spotShadows', binding: 2 },
                                     { name: 'u_pointShadows', binding: 4 }, { name: 'u_lightData', binding: 6 }]);
        const c = cache();
        c.frameLightingGroup(lit, false);
        c.frameLightingGroup(lit, true);
        expect(created.map(g => g.entries.map(e => e.binding))).toEqual([[0, 6], [0, 2, 4, 6]]);
        expect(created[1].entries.map(e => (e.textureView as { name: string }).name)).toEqual(['cascades', 'spots', 'points', 'grid']);
    });
});

describe('a material group', () => {
    it('binds each map at its own binding, whatever order the shader declared them in', () => {
        // The instanced PBR family declares the shelter map (binding 12) in its vertex chunk, ahead of the
        // material maps (0-11): counted off by twos in declaration order, it landed on binding 0.
        const c = cache();
        c.fallbackTexture = texture('white');
        const p = {
            label: 'pbrGeometryInstanced~foliage',
            resources: [
                { group: 0, binding: 12, glslName: 'u_weatherShelter', kind: 'texture', type: 'texture_depth_2d_array' },
                { group: 0, binding: 0, glslName: 'u_material_baseColorTexture', kind: 'texture', type: 'texture_2d<f32>' },
                { group: 0, binding: 2, glslName: 'u_material_ormTexture', kind: 'texture', type: 'texture_2d<f32>' },
            ],
            layoutForGroup: () => ({}),
        } as unknown as RenderPipeline;
        const material = { textures: new Map<string, string>() } as any;
        c.materialGroup(p, material);
        const entries = created[0].entries.map(e => [e.binding, (e.textureView as { name: string }).name]);
        expect(entries).toEqual([[0, 'white'], [2, 'white'], [12, 'shelter']]);
    });
});

describe("the owner's last group", () => {
    const material = {};
    const lit = () => pipeline('pbr', [{ name: 'u_shadowCascades', binding: 0 }, { name: 'u_lightData', binding: 6 }]);

    it('answers a repeat bind without building the string key', () => {
        const c = cache();
        const p = lit();
        const a = texture('albedo'), n = texture('normal');
        const keyed = (c as unknown as { _textureGroupKey: (...x: unknown[]) => string });
        const real = keyed._textureGroupKey.bind(c);
        let keys = 0;
        keyed._textureGroupKey = (...x: unknown[]) => { keys++; return real(...x); };
        const first = c.textureGroup(p, 0, [a, n], undefined, material);
        for (let i = 0; i < 3; i++) expect(c.textureGroup(p, 0, [a, n], undefined, material)).toBe(first);
        expect(keys).toBe(1);
        expect(created).toHaveLength(1);
    });

    it('builds anew when a texture is swapped or its storage recreated', () => {
        const c = cache();
        const p = lit();
        const a = texture('albedo'), n = texture('normal'), other = texture('other');
        const first = c.textureGroup(p, 0, [a, n], undefined, material);
        expect(c.textureGroup(p, 0, [a, other], undefined, material)).not.toBe(first);
        (n as unknown as { rhiTexture: { generation: number } }).rhiTexture.generation = 1;
        const third = c.textureGroup(p, 0, [a, n], undefined, material);
        expect(third).not.toBe(first);
        expect(created).toHaveLength(3);
    });

    it('keeps a group per pipeline an owner is drawn with', () => {
        const c = cache();
        const gbuffer = lit(), forward = lit();
        const a = texture('albedo');
        const g = c.textureGroup(gbuffer, 0, [a], undefined, material);
        const f = c.textureGroup(forward, 0, [a], undefined, material);
        expect(c.textureGroup(gbuffer, 0, [a], undefined, material)).toBe(g);
        expect(c.textureGroup(forward, 0, [a], undefined, material)).toBe(f);
        expect(created).toHaveLength(2);
    });

    it('reuses the frame-lighting group per pipeline', () => {
        const c = cache();
        const p = lit();
        const first = c.frameLightingGroup(p);
        expect(c.frameLightingGroup(p)).toBe(first);
        expect(created).toHaveLength(1);
    });
});

// The per-object table binds as group 2, binding 0 of every program that reads it — one group per
// pipeline (auto layouts are per pipeline), rebuilt only when the table texture is replaced.
describe('the object-table group', () => {
    const objectPipeline = (label: string) => ({
        label,
        resources: [{ group: 2, binding: 0, glslName: 'u_objectData', kind: 'texture', type: 'texture_2d<f32>' }],
        layoutForGroup: () => ({}),
    }) as unknown as RenderPipeline;

    it('says which pipelines read the table', () => {
        expect(cache().declaresObjectData(objectPipeline('pbr'))).toBe(true);
        expect(cache().declaresObjectData(pipeline('basic', [{ name: 'u_shadowCascades', binding: 0 }]))).toBe(false);
    });

    it('builds one group per pipeline and table, and a new one when the table is replaced', () => {
        const c = cache();
        const a = objectPipeline('a'), b = objectPipeline('b');
        const table = texture('table');
        const first = c.objectDataGroup(a, table);
        expect(c.objectDataGroup(a, table)).toBe(first);
        expect(created.at(-1)!.entries).toEqual([{ binding: 0, textureView: (table as any).sampledView }]);
        expect(c.objectDataGroup(b, table)).not.toBe(first);
        const grown = texture('grown');
        expect(c.objectDataGroup(a, grown)).not.toBe(first);
        expect(created.length).toBe(3);
    });
});
