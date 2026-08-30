import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Node, Scene, Terrain, TerrainMaterial } from 'cleo';
// From the engine SOURCE, which is what `cleo` is aliased to in this suite (see vitest.config.ts), so
// these reach the same module instances `Terrain` uses rather than a second copy.
import { setGLContext } from '../../src/graphics/glContext';
import { setDevice } from '../../src/graphics/rhi/deviceHandle';
import { WebGL2Device } from '../../src/graphics/rhi/webgl2/webgl2Device';
import { PREVIEW_TERRAIN_SIZE, REFERENCE_LANDSCAPE } from '../src/features/demoScene/previewFraming';
import { buildTerrainPreviewSubject } from '../src/features/demoScene/previewTerrainSubject';

/**
 * The terrain-material preview has to be scaled against the landscape, not against itself.
 *
 * This is the file that would have caught the thing an author actually hit: relief that looked right in
 * the preview and did not exist on the ground. Nothing was wrong with the algorithm — the preview ran
 * the same code — but the patch is 8 m and a landscape is 200, and tiling the material the same NUMBER
 * of times on both put one repeat at 0.4 m here and 10 m there. The same 5 cm of authored depth is
 * pronounced relief across a 0.4 m tile and a half-percent grade across a 10 m one.
 *
 * Two quantities have to match for the preview to mean anything: metres per repeat, which sets how big
 * the relief looks, and metres per vertex, which sets how much of the height map becomes geometry and
 * how much is left to the parallax march. Both are asserted here.
 */

// A stubbed context, the same one the engine's terrain tests use. This suite otherwise keeps GL out, and
// that rule is about speed rather than purity — a Proxy costs nothing, and `Terrain` cannot build a chunk
// without something to hand its buffers to.
beforeAll(() => {
    let n = 0;
    const constants: Record<string, number> = {
        UNSIGNED_SHORT: 0x1403, UNSIGNED_INT: 0x1405, ARRAY_BUFFER: 0x8892,
        ELEMENT_ARRAY_BUFFER: 0x8893, STATIC_DRAW: 0x88e4, FLOAT: 0x1406, TRIANGLES: 0x0004,
    };
    const objects = new Set(['createVertexArray', 'createBuffer', 'createTexture']);
    const gl = new Proxy({}, {
        get: (_t, key: string) => (key in constants ? constants[key]
            : objects.has(key) ? () => ({ id: ++n }) : () => undefined),
    });
    setGLContext(gl as any);
    setDevice(new WebGL2Device(gl as unknown as WebGL2RenderingContext));
});

const material = (tiling = 20) => {
    const tm = TerrainMaterial.Create('pbr', {});
    tm.textures.set('displacementMap', 'height-id');
    tm.displacementScale = 0.05;
    tm.tiling = tiling;
    return tm;
};

/** World metres covered by one repeat of the layer's height map. */
const metresPerRepeat = (t: Terrain) => t.size / (t as any)._layers[0].tiling;
/** World metres between adjacent render vertices. */
const spacing = (t: Terrain) => t.size / ((t.resolution - 1) * t.densityFor());

describe('the preview patch matches the landscape it will be painted on', () => {
    it('one repeat covers the same metres', () => {
        // The 25x error, stated as the thing it broke. Before this the preview used the material's own
        // tiling on an 8 m patch, so this ratio was the size ratio itself.
        const landscape = new Terrain({ size: 200, resolution: 129, chunkQuads: 32 });
        landscape.setLayer(0, material());
        const preview = buildTerrainPreviewSubject(new Scene(), material(), landscape).terrain;
        expect(metresPerRepeat(preview)).toBeCloseTo(metresPerRepeat(landscape), 6);
    });

    it('and the patch is fine enough to be a surface', () => {
        // The spacing match used to be load-bearing: relief was split between the terrain's vertices
        // and the march at a mip derived from vertices-per-repeat, so a preview at a different vertex
        // density cut the height map somewhere else and showed a different surface. Relief is entirely
        // marched now, so the grid only has to resolve the patch — but a preview built from one quad
        // would have no interior and nothing to shade, so the lower bound still matters.
        const landscape = new Terrain({ size: 200, resolution: 129, chunkQuads: 32 });
        landscape.setLayer(0, material());
        const preview = buildTerrainPreviewSubject(new Scene(), material(), landscape).terrain;
        expect(preview.resolution).toBeGreaterThanOrEqual(9);
    });

    it('tracks a landscape of another size', () => {
        for (const size of [50, 400, 1000]) {
            const landscape = new Terrain({ size, resolution: 129, chunkQuads: 32 });
            landscape.setLayer(0, material());
            const preview = buildTerrainPreviewSubject(new Scene(), material(), landscape).terrain;
            expect(metresPerRepeat(preview), `size ${size}`).toBeCloseTo(metresPerRepeat(landscape), 6);
        }
    });

    it('falls back to the documented reference when the scene has no landscape', () => {
        // A material authored before any terrain exists still has to be judged against something.
        const preview = buildTerrainPreviewSubject(new Scene(), material(), null).terrain;
        expect(metresPerRepeat(preview))
            .toBeCloseTo(REFERENCE_LANDSCAPE.size / 20, 6);
    });
});

describe('the reference constant', () => {
    it('names a real default landscape, for a material authored before one exists', () => {
        // It used to carry a `density` too, mirroring a vertex density the engine derived; that went
        // with the vertex bake. What is left has to stay constructible, or the no-landscape fallback
        // quotes a terrain that could never exist.
        const landscape = new Terrain({
            size: REFERENCE_LANDSCAPE.size, resolution: REFERENCE_LANDSCAPE.resolution, chunkQuads: 32,
        });
        expect(landscape.size).toBe(REFERENCE_LANDSCAPE.size);
        expect(landscape.resolution).toBe(REFERENCE_LANDSCAPE.resolution);
    });
});

describe('the preview looks DOWN at the patch', () => {
    // It looked UP. Positive pitch is down in this engine — `setRotation([90,0,0])` gives forward
    // (0,-1,0) — and the rig hangs the camera at `-radius * pivotForward`, so the -42 that was here put
    // it 10.6 m UNDERNEATH the terrain. That made the preview useless as a reference in three ways at
    // once: `parallaxFrame` orients by the view vector, so the whole POM basis mirrored while
    // `addLayer`'s lighting normal still pointed up; the key light fell on the far side of the surface;
    // and terrain is `side: 'front'`, so the patch was being judged from its culled face. Thumbnails,
    // which capture with no user interaction, were all shot from below.

    it('TERRAIN_PITCH is positive, i.e. pointing down', () => {
        const src = readFileSync(
            join(__dirname, '..', 'src', 'features', 'demoScene', 'createMaterialPreviewScene.ts'),
            'utf-8');
        const m = src.match(/const TERRAIN_PITCH\s*=\s*(-?[\d.]+)/);
        expect(m, 'TERRAIN_PITCH not found').not.toBeNull();
        expect(Number(m![1]), 'negative pitch looks UP, at the culled face').toBeGreaterThan(0);
    });

    it('and the rig that consumes it puts the camera above the patch', () => {
        // Asserted through the engine's own transform composition rather than by reading the constant,
        // because the sign only becomes a position after the pivot rotation and the -radius offset.
        const src = readFileSync(
            join(__dirname, '..', 'src', 'features', 'demoScene', 'createMaterialPreviewScene.ts'),
            'utf-8');
        const pitch = Number(src.match(/const TERRAIN_PITCH\s*=\s*(-?[\d.]+)/)![1]);
        const yaw = Number(src.match(/const INIT_YAW\s*=\s*(-?[\d.]+)/)![1]);

        const scene = new Scene();
        const pivot = new Node('pivot');
        scene.addNode(pivot);
        pivot.setRotation([pitch, yaw, 0]);
        const cam = new Node('cam');
        cam.setPosition([0, 0, -15.84]);          // fitDistance(PREVIEW_TERRAIN_RADIUS)
        pivot.addChild(cam);
        (scene as any).update?.(0, 0);

        expect(cam.worldPosition[1], 'the camera must be above y = 0, where the patch is')
            .toBeGreaterThan(0);
    });
});

describe('nothing re-pins the preview tiling to 1', () => {
    it('not in EngineContext, which is where it used to happen', () => {
        // `refreshTerrainMaterialPreview` re-set the layer with `tiling: 1` on every inspector edit,
        // contradicting the builder and undoing the scale match on the first keystroke — and taking the
        // derived density to 1 with it, so the preview then ran a different branch of the bake entirely.
        const src = readFileSync(join(__dirname, '..', 'src', 'features', 'EngineContext.tsx'), 'utf-8')
            .replace(/\/\/[^\n]*/g, '');
        expect(src).not.toMatch(/setLayer\([^)]*tiling:\s*1\s*[,}]/);
        expect(src, 'it must rebase against the landscape instead').toMatch(/PREVIEW_TERRAIN_SIZE/);
    });

    it('and the builder scales rather than pinning', () => {
        const src = readFileSync(
            join(__dirname, '..', 'src', 'features', 'demoScene', 'previewTerrainSubject.ts'), 'utf-8')
            .replace(/\/\/[^\n]*/g, '');
        expect(src).toMatch(/tiling:\s*tm\.tiling\s*\*\s*PREVIEW_TERRAIN_SIZE/);
        expect(PREVIEW_TERRAIN_SIZE).toBeLessThan(REFERENCE_LANDSCAPE.size);
    });
});
