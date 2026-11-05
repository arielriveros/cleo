import { describe, it, expect, vi } from 'vitest';
import { mat4 } from 'gl-matrix';
import { Visibility } from '../src/graphics/render/visibility';

/**
 * Visibility.buildOcclusion keeps last frame's CPU occlusion buffer when nothing it is built from changed,
 * and rebuilds on any change. Driven with one Occluder volume (a wall) and a fake view: the buffer must hide
 * the box behind the wall on every frame, kept or rebuilt, and be rebuilt exactly when an input moves.
 */
function setup() {
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000);
    const camera = { position: new Float32Array([0, 2, 10]) };
    const view = { camera, viewProj: mat4.create(), cubeFace: false };
    const lookFrom = (x: number) => {
        camera.position[0] = x;
        mat4.multiply(view.viewProj, proj, mat4.lookAt(mat4.create(), [x, 2, 10], [x, 2, 0], [0, 1, 0]));
    };
    lookFrom(0);
    const wall = {
        enabled: true, visible: true, transformVersion: 1, worldTransform: mat4.create(),
        localBox(min: number[], max: number[]) { min[0] = -4; min[1] = 0; min[2] = 2; max[0] = 4; max[1] = 5; max[2] = 2.5; },
    };
    const scene = { landscapes: new Set(), occluders: new Set([wall]) };
    const host = { selectedNodeId: null, thumbnailMode: false };
    const vis = new Visibility(host as never, view as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never);
    vis.frustum.setFromViewProjection(view.viewProj);
    const begin = vi.spyOn(vis.occlusion, 'begin');
    const build = () => { vis.frustum.setFromViewProjection(view.viewProj); vis.buildOcclusion(scene as never); };
    const hidden = () => vis.occlusion.isBoxOccluded([-1, 0, -3], [1, 2, -1]);
    return { vis, build, begin, wall, scene, lookFrom, hidden };
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

    it('rebuilds when the camera moves or an occluder changes', () => {
        const { build, begin, wall, lookFrom, scene } = setup();
        build();
        lookFrom(0.01); build();
        expect(begin).toHaveBeenCalledTimes(2);
        wall.transformVersion++; build();
        expect(begin).toHaveBeenCalledTimes(3);
        wall.enabled = false; build();
        expect(begin).toHaveBeenCalledTimes(4);
        wall.enabled = true; build();
        expect(begin).toHaveBeenCalledTimes(5);
        scene.occluders = new Set([wall]); build();       // the scene's lists were rebuilt
        expect(begin).toHaveBeenCalledTimes(6);
        build();
        expect(begin).toHaveBeenCalledTimes(6);
    });

    it('rebuilds when the occlusion mode changes', () => {
        const { build, begin, vis } = setup();
        build();
        vis.occlusionMode = 'terrain'; build();   // no landscapes: nothing to occlude, nothing kept
        vis.occlusionMode = 'all'; build();
        expect(begin).toHaveBeenCalledTimes(3);
    });
});
