import { describe, it, expect, vi } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Visibility } from '../src/graphics/render/visibility';

/**
 * Visibility.buildOcclusion keeps last frame's CPU occlusion buffer when nothing it is built from changed,
 * and rebuilds on any change. Driven with one landscape (a plateau standing between the camera and a box
 * beyond it) and a fake view: the buffer must hide the box on every frame, kept or rebuilt, and be rebuilt
 * exactly when an input moves. Occlusion volumes are not occluders: they never reach the buffer.
 */
const R = 257, SIZE = 256;

function plateau(): Float32Array {
    // Terrain spans [-128, 128] on x and z (origin at its centre): 20 m high for z <= 0, flat 0 beyond. Wide,
    // because the occluder is lowered to the minimum over 64-sample windows (terrainOccluder.ts).
    const heights = new Float32Array(R * R);
    for (let row = 0; row < R; row++) {
        const z = (row / (R - 1)) * SIZE - SIZE / 2;
        for (let c = 0; c < R; c++) heights[row * R + c] = z <= 0 ? 20 : 0;
    }
    return heights;
}

function setup() {
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000);
    const camera = { position: new Float32Array([0, 2, 20]) };
    const view = { camera, viewProj: mat4.create(), cubeFace: false };
    const lookFrom = (x: number) => {
        camera.position[0] = x;
        mat4.multiply(view.viewProj, proj, mat4.lookAt(mat4.create(), [x, 2, 20], [x, 2, 0], [0, 1, 0]));
    };
    lookFrom(0);
    const heights = plateau();
    const terrain = {
        heights, resolution: R, size: SIZE, origin: [0, 0, 0], heightsVersion: 1,
        heightAt: (x: number, z: number) => {
            const row = Math.round(((z + SIZE / 2) / SIZE) * (R - 1)), c = Math.round(((x + SIZE / 2) / SIZE) * (R - 1));
            return row < 0 || row >= R || c < 0 || c >= R ? 0 : heights[row * R + c];
        },
    };
    const landscape = { visible: true, terrain };
    const scene = { landscapes: new Set([landscape]), occlusionVolumes: new Set<object>() };
    const host = { selectedNodeId: null, thumbnailMode: false };
    const vis = new Visibility(host as never, view as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    vis.frustum.setFromViewProjection(view.viewProj);
    const begin = vi.spyOn(vis.occlusion, 'begin');
    const build = () => { vis.frustum.setFromViewProjection(view.viewProj); vis.buildOcclusion(scene as never); };
    // Past the terrain's far edge, at the camera's height: the plateau stands in between.
    const hidden = () => vis.occlusion.isBoxOccluded([-1, 0, -140], [1, 2, -134]);
    return { vis, build, begin, landscape, scene, lookFrom, hidden };
}

describe('Visibility.buildOcclusion reuse', () => {
    it('builds once while nothing changes, and keeps answering', () => {
        const { build, begin, hidden, vis } = setup();
        build();
        expect(begin).toHaveBeenCalledTimes(1);
        expect(hidden()).toBe(true);
        for (let i = 0; i < 5; i++) {
            build();
            expect(hidden()).toBe(true);
            expect(vis.occlusion.stats.tested).toBe(1);   // counted from zero each frame
        }
        expect(begin).toHaveBeenCalledTimes(1);
        expect(vis.occlusionFrameStats.triangles).toBeGreaterThan(0);
    });

    it('rebuilds when the camera moves or a landscape changes', () => {
        const { build, begin, landscape, lookFrom, scene } = setup();
        build();
        lookFrom(0.01); build();
        expect(begin).toHaveBeenCalledTimes(2);
        landscape.visible = false; build();
        expect(begin).toHaveBeenCalledTimes(3);
        landscape.visible = true; build();
        expect(begin).toHaveBeenCalledTimes(4);
        scene.landscapes = new Set([landscape]); build();       // the scene's lists were rebuilt
        expect(begin).toHaveBeenCalledTimes(5);
        build();
        expect(begin).toHaveBeenCalledTimes(5);
    });

    it("builds the same buffer under 'terrain' and 'all' (volumes are not occluders), none under 'off'", () => {
        const { build, begin, vis, hidden } = setup();
        build();
        vis.occlusionMode = 'terrain'; build();
        expect(hidden()).toBe(true);
        vis.occlusionMode = 'all'; build();
        expect(begin).toHaveBeenCalledTimes(1);
        vis.occlusionMode = 'off'; build();
        expect(begin).toHaveBeenCalledTimes(1);
    });

    it('never rasterizes an occlusion volume', () => {
        const { build, begin, scene, vis } = setup();
        build();
        // A big volume between the camera and an open-ground box: it must not hide what is behind it.
        scene.occlusionVolumes = new Set([{ enabled: true, visible: true, transformVersion: 1, version: 1, size: [40, 20, 2],
                                            worldTransform: mat4.fromTranslation(mat4.create(), [0, 5, 12]) }]);
        build();
        expect(begin).toHaveBeenCalledTimes(1);
        expect(vis.occlusion.isBoxOccluded([-1, 0.5, 8], [1, 2, 10])).toBe(false);
    });
});
