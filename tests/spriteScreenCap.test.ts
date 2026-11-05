import { describe, expect, it } from 'vitest';
import { mat4 } from 'gl-matrix';
import { capSpriteScreenSize } from '../src/graphics/render/sprites2d';
import { Camera } from '../src/core/camera';

/**
 * SpriteNode.maxScreenSize, the cap on how tall a sprite draws (the editor's viewport icons, 0.5 m
 * billboards from a small raster that blurred when the camera came close). The renderer shrinks the
 * quad's model matrix once it would draw taller than the cap, in perspective by view depth and in
 * orthographic by the view's height, so a 2D zoom is capped too.
 */

const cap = (camera: Camera, m: mat4, maxCssPx: number, cssHeight = 1000) => {
    capSpriteScreenSize(m, maxCssPx, camera, cssHeight);
    return Math.hypot(m[4], m[5], m[6]);
};

/** A 0.5 m quad `distance` in front of a camera at the origin looking down -Z. */
const quadAt = (distance: number) => {
    const m = mat4.create();
    mat4.translate(m, m, [0, 0, -distance]);
    mat4.scale(m, m, [0.5, 0.5, 0.5]);
    return m;
};

const pixelsTall = (worldHeight: number, distance: number, fov = 60, cssHeight = 1000) =>
    worldHeight * cssHeight / (2 * distance * Math.tan(fov * Math.PI / 360));

describe('sprite screen-size cap', () => {
    const perspective = () => new Camera({ type: 'perspective', fov: 60, near: 0.1, far: 1000 });

    it('leaves a sprite drawn smaller than the cap alone', () => {
        // 0.5 m at 20 m with fov 60 on a 1000 px view is about 22 px.
        expect(cap(perspective(), quadAt(20), 64)).toBeCloseTo(0.5, 6);
    });

    it('shrinks a close sprite to exactly the cap', () => {
        const height = cap(perspective(), quadAt(1), 64);
        expect(height).toBeLessThan(0.5);
        expect(pixelsTall(height, 1)).toBeCloseTo(64, 3);
    });

    it('keeps the position, only the 3×3 scales', () => {
        const m = quadAt(1);
        cap(perspective(), m, 64);
        expect([m[12], m[13], m[14], m[15]]).toEqual([0, 0, -1, 1]);
    });

    it('caps an orthographic view by its height, so zooming in 2D stops growing it', () => {
        const ortho = new Camera({ type: 'orthographic', left: -1, right: 1, top: 1, bottom: -1, near: 0.1, far: 100 });
        // 0.5 m of a 2 m tall view on 1000 px is 250 px: capped to 64 px, i.e. 0.128 m.
        expect(cap(ortho, quadAt(5), 64)).toBeCloseTo(0.128, 6);
    });

    it('does nothing without a measurable canvas', () => {
        expect(cap(perspective(), quadAt(1), 64, 0)).toBeCloseTo(0.5, 6);
    });
});
