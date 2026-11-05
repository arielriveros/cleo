import { describe, it, expect, beforeEach } from 'vitest';
import { setDevice } from '../src/graphics/rhi/deviceHandle';
import { BindGroupCache } from '../src/graphics/render/bindGroups';
import type { FrameTargets } from '../src/graphics/render/frameTargets';
import type { Texture } from '../src/graphics/texture';
import type { RenderPipeline } from '../src/graphics/rhi/resources';

/** A stand-in texture: what the bind-group cache reads off one. */
const texture = (name: string) => ({ name, sampledView: { name }, rhiTexture: { generation: 0 } }) as unknown as Texture;

const cascades = texture('cascades'), spots = texture('spots'), points = texture('points'), grid = texture('grid');

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
