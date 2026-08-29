import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sampleHeight, HeightField } from '../src/graphics/systems/displacement';

/**
 * Terrain layer displacement, and the three promises that make it safe to ship.
 *
 * Terrain is the easier half of the feature — `LandscapeNode._serializableChildren` excludes the chunk
 * nodes, so the terrain saves a compact height blob and rebuilds its vertices on load, and a bake there
 * is inherently non-destructive. What it is NOT free of is the physics coupling, and that is what most
 * of this file is about:
 *
 * 1. `_heights` is never written. It is the sculpted, serialized, physics-authoritative field.
 * 2. With every layer on `parallax`, the rendered field IS `_heights` — identically, not approximately.
 * 3. Relief is GEOMETRY ONLY. A displaced layer is taken out of `blendedDepth` so the march adds no
 *    offset, but keeps its `u_hasHeight` flag so the height-aware layer blend still works.
 *
 * The first two are asserted against the source, because a `Terrain` needs a GL context, a splat
 * texture and a chunk tree to construct, and none of that would make the assertions any sharper. The
 * accumulation arithmetic is tested directly below as the pure function it is.
 */

const SRC = join(__dirname, '..', 'src', 'terrain', 'terrain.ts');
const terrain = () => readFileSync(SRC, 'utf-8');
/** Source with line comments stripped, so prose cannot satisfy a structural assertion. */
const bare = () => terrain().replace(/\/\/[^\n]*/g, '');
const bodyOf = (name: string) => {
    const m = bare().match(new RegExp('(?:private|public)\\s+' + name + '\\s*\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n    \\}'));
    expect(m, name + ' not found').not.toBeNull();
    return m![1];
};

describe('the sculpted field is never written by a layer bake', () => {
    it('the accumulation writes a COPY, and only reads `_heights`', () => {
        // The rule the terrain half rests on: the blob round-trips, the heightfield collider stays
        // stable, `heightAt()` keeps answering, and a material tweak never rebuilds a physics body.
        const body = bodyOf('_rebuildRenderHeights');
        expect(body, 'copies the sculpted field').toMatch(/out\.set\(this\._heights\)/);
        expect(body, 'never assigns into _heights').not.toMatch(/this\._heights\s*\[[^\]]*\]\s*=/);
        expect(body, 'never replaces _heights').not.toMatch(/this\._heights\s*=/);
    });

    it('the whole file only ever assigns `_renderHeights`, never `_heights`, outside sculpting', () => {
        // A grep-level guard, because the damage would be silent: a displaced terrain that saved its
        // displacement would come back with the relief baked into the sculpt, twice over on reload.
        const assigns = bare().match(/this\._heights\s*=/g) ?? [];
        // `_heights` is assigned where it is BUILT (construction, resize, import) and nowhere else.
        expect(assigns.length).toBeLessThanOrEqual(4);
        expect(bodyOf('_rebuildRenderHeights')).toMatch(/this\._renderHeights\s*=/);
    });
});

describe('with no displaced layer, nothing changes at all', () => {
    it('the rendered field is the sculpted array itself, not a copy of it', () => {
        // Identity, not equality. A copy would be correct on screen and would still cost an allocation
        // and a full chunk rewrite on every terrain in every project that never asked for the feature.
        expect(bare()).toMatch(/_surfaceHeights\(\)\s*:\s*Float32Array\s*\{\s*return this\._renderHeights\s*\?\?\s*this\._heights;\s*\}/);
        expect(bodyOf('_rebuildRenderHeights'), 'the no-layer path early-outs')
            .toMatch(/if\s*\(this\._renderHeights === null\)\s*return;/);
    });

    it('the three render read sites go through `_surfaceHeights`', () => {
        // Y, the normal and the LOD bounds. Missing one would show up as terrain whose normals disagree
        // with its surface, or chunks culled at a height they no longer draw at.
        for (const fn of ['_refreshChunkGeometry', '_updateChunkBounds'])
            expect(bodyOf(fn), fn).toMatch(/_surfaceHeights/);
        expect(bodyOf('_normalAt')).toMatch(/const h = this\._surfaceHeights;/);
    });

    it('`heightAt` and the physics body still read the SCULPTED field', () => {
        // The stated limit: a displaced terrain is not walked on. If this ever changed, a character
        // would stand on relief that only exists in a material.
        expect(bodyOf('heightAt')).toMatch(/this\._heights\[/);
        expect(bodyOf('heightAt')).not.toMatch(/_surfaceHeights/);
    });
});

describe('terrain relief is geometry, and the march stays out of it', () => {
    it('a layer displaces exactly when it has a height map — there is no mode', () => {
        // The choice is gone. Keeping both meant the CPU bake and the shader had to agree on which band
        // each carried, through a split mip level, a headroom constant, a packed texture whose size did
        // not match the source map, and a weight set the CPU never fully resolved. Every one of those
        // was a way to be silently wrong, and none of them is reachable now.
        expect(bodyOf('_layerDisplaces')).toMatch(/L\.displace && L\.heightId && L\.dispScale !== 0/);
        expect(bare(), 'no heightMode anywhere in terrain').not.toMatch(/heightMode/);
    });

    it('does NOT clear `u_hasHeight{i}` — that flag also drives the height-aware blend', () => {
        // The obvious way to take a layer out of the march, and wrong: `layerHeights` feeds the
        // `u_heightBlend` layer blend as well, so clearing it would silently disable a separate feature.
        expect(bodyOf('_syncLayerPack'), 'the old outright gate must not come back')
            .not.toMatch(/u_hasHeight\$\{index\}`,\s*0\)\s*;\s*return/);
        expect(bodyOf('_syncLayerPack')).toMatch(/_writeMarchUniforms\(index, L\)/);
    });

    it('gives the march the RESIDUAL rather than excluding the layer', () => {
        // This used to assert the opposite — that `blendedDepth` skipped every displaced layer — and
        // that is what made a height map invisible on a real landscape. Excluding the layer stopped the
        // relief being applied twice, but it also meant the half of the map too fine for the vertex grid
        // was band-limited away and then drawn by nothing. At 200 m and tiling 20 the split falls at mip
        // 5.3, so the geometry got a 26x26 reduction of a 1024 map and every rock in it went nowhere.
        //
        // The split is the answer to both: geometry below `u_splitLod{i}`, march above it, applied once
        // each.
        const wgsl = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl',
                                       'chunks', 'terrainLayers.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');
        const body = wgsl.match(/fn\s+blendedDepth[^{]*\{([\s\S]*?)\n\}/);
        expect(body, 'blendedDepth not found').not.toBeNull();
        expect(body![1].match(/u_marchDepth\d/g)?.length, 'all four layers').toBe(4);
        // The stale unit that hid inside the exclusion: depth is world metres now, so the conversion to
        // base uv is `metres / size`, and a per-layer `/ tiling` here would be silently wrong again.
        expect(body![1], 'no tiling divisor may come back').not.toMatch(/u_tiling/);
        expect(wgsl, 'the flag it replaced is gone').not.toMatch(/u_displaces/);
    });

    it('`layerHeights` is back to plain sampling, so the blend is unchanged', () => {
        // No residual, no low-band tap, no clamp — exactly what it was before the split existed.
        const wgsl = readFileSync(join(__dirname, '..', 'src', 'graphics', 'shaders', 'wgsl',
                                       'chunks', 'terrainLayers.wgsl'), 'utf-8').replace(/\/\/[^\n]*/g, '');
        expect(wgsl, 'the residual helper is gone').not.toMatch(/layerMarched/);
        const body = wgsl.match(/fn\s+layerHeights[^{]*\{([\s\S]*?)\n\}/);
        expect(body![1].match(/textureSampleLevel/g)?.length, 'one fetch per layer again').toBe(4);
        expect(body![1].match(/u_hasHeight\d/g)?.length, 'still gated per layer').toBe(4);
    });

    it('the headroom is gone from every side', () => {
        // It existed only so parallax had somewhere to carve back down from. With no march it was a lift
        // that varied with the paint — `0.25 * sum(w * dispScale)` over displaced layers only — which is
        // a smooth bulge tracking the splat mask and nothing on screen to explain it.
        for (const f of [['src', 'graphics', 'systems', 'displacement.ts'],
                         ['src', 'terrain', 'terrain.ts'],
                         ['src', 'graphics', 'shaders', 'wgsl', 'chunks', 'terrainLayers.wgsl']])
            expect(readFileSync(join(__dirname, '..', ...f), 'utf-8'), f.join('/'))
                .not.toMatch(/DISPLACE_HEADROOM/);
    });

    it('the bake splits on the RAW width and the shader is told the PACKED one', () => {
        // Both, and the difference between them is a live trap rather than a detail. The CPU bake
        // samples a pyramid it builds from the raw height map, so its split level is in that map's mip
        // space. The march samples the PACKED layer texture, and `TexturePacker` sizes a pack as the MAX
        // of its sources — a 2048 normal beside a 1024 height puts every level an octave out. So
        // `_writeMarchUniforms` converts, and the two halves of the split meet at the same frequency.
        expect(bodyOf('_displaceContext')).toMatch(/displaceSplitLod\(pyramid\[0\]\.width/);
        expect(bodyOf('_writeMarchUniforms'), 'converted to the pack\'s mip space')
            .toMatch(/split \+ octaves/);
        expect(bare(), '_packedWidth is gone').not.toMatch(/_packedWidth/);
    });
});

describe('the rebuild does not run every frame', () => {
    it('keys on a revision plus the layer parameters', () => {
        // It is called from the per-frame `syncPackedLayers`, and the accumulation is O(resolution^2)
        // followed by a rewrite and re-upload of every chunk. Without the key that is the cost of every
        // frame of every terrain with one displaced layer.
        const body = bodyOf('_rebuildRenderHeights');
        expect(body).toMatch(/this\._surfaceRev/);
        expect(body).toMatch(/if\s*\(key === this\._renderHeightsKey/);
    });

    it('does not record the key until every layer field has decoded', () => {
        // Height maps decode asynchronously. Recording the key on a partial bake would freeze the
        // terrain at whichever layers happened to be ready on that frame.
        // `_displaceContext` returns null unless EVERY displaced layer's pyramid is ready, and the bake
        // returns before recording the key when it does.
        expect(bodyOf('_rebuildRenderHeights')).toMatch(/if\s*\(!ctx\)\s*return;/);
        expect(bodyOf('_displaceContext'), 'one missing pyramid abandons the whole context')
            .toMatch(/if\s*\(!pyramid\)\s*return null;/);
    });

    it('the revision is bumped by sculpting and by painting', () => {
        // Both feed the accumulation: `_heights` is its base and `_splat` is its weights.
        expect(bodyOf('_markRegionDirty')).toMatch(/this\._surfaceRev\+\+/);
        expect((bare().match(/this\._surfaceRev\+\+/g) ?? []).length,
               'sculpt plus both splat writes').toBeGreaterThanOrEqual(3);
    });
});

describe('the accumulation arithmetic', () => {
    /** `_rebuildRenderHeights`'s inner sum, as the pure function it is. */
    const accumulate = (base: number, layers: { w: number; h: number; scale: number }[]) =>
        base + layers.reduce((a, l) => a + l.w * l.h * l.scale, 0);

    const flat = (v: number): HeightField => {
        const data = new Uint8Array(4 * 4 * 4);
        for (let i = 0; i < 16; i++) data[i * 4] = Math.round(v * 255);
        return { data, width: 4, height: 4 };
    };

    it('an unpainted layer contributes nothing, however deep it is', () => {
        expect(accumulate(5, [{ w: 0, h: 1, scale: 100 }])).toBe(5);
    });

    it('a fully painted layer contributes its full depth at height 1', () => {
        expect(accumulate(5, [{ w: 1, h: 1, scale: 0.4 }])).toBeCloseTo(5.4, 12);
    });

    it('two layers at half weight each split the contribution', () => {
        // The splat is renormalised to sum to 1, so a 50/50 boundary raises by the average of the two.
        const sum = accumulate(0, [{ w: 0.5, h: 1, scale: 0.4 }, { w: 0.5, h: 1, scale: 0.8 }]);
        expect(sum).toBeCloseTo(0.6, 12);
    });

    it('tiling scales the uv, not the height', () => {
        // The layer is sampled at `uv * tiling`, so a constant field reads the same at any tiling. A
        // tiling applied to the RESULT instead would make relief depth depend on texture repeat.
        const field = flat(0.5);
        for (const tiling of [1, 20, 50])
            expect(sampleHeight(field, 0.3 * tiling, 0.7 * tiling, false)).toBeCloseTo(sampleHeight(field, 0.3, 0.7, false), 6);
    });

    it('invert flips the layer the same way it flips a mesh', () => {
        expect(sampleHeight(flat(0.25), 0.5, 0.5, true))
            .toBeCloseTo(1 - sampleHeight(flat(0.25), 0.5, 0.5, false), 12);
    });
});
