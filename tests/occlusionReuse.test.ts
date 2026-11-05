import { describe, it, expect } from 'vitest';
import { mat4 } from 'gl-matrix';
import { OcclusionBuffer } from '../src/graphics/occlusion/occlusionBuffer';
import { OcclusionReuseKey } from '../src/graphics/occlusion/occlusionReuse';

// The CPU occlusion buffer is kept across frames whose inputs did not change (the editor's parked camera)
// instead of being rasterized again. Two things have to hold: the key notices any changed input, and a
// kept buffer answers exactly as it did, with the per-frame query counters starting again from zero.

describe('OcclusionReuseKey', () => {
    const camera = {}, landscapes = new Set();
    const write = (key: OcclusionReuseKey, vp: number[], version = 3, cam: object = camera, list: object = landscapes) => {
        key.begin();
        key.ref(cam); key.ref(list);
        key.nums(vp, 16);
        key.num(version);
    };
    const vp = Array.from({ length: 16 }, (_, i) => i * 0.5);

    it('matches nothing until a build is committed', () => {
        const key = new OcclusionReuseKey();
        write(key, vp);
        expect(key.matches()).toBe(false);
        key.commit();
        write(key, vp);
        expect(key.matches()).toBe(true);
    });

    it('notices a changed number, object or length', () => {
        const key = new OcclusionReuseKey();
        write(key, vp); key.commit();
        const moved = [...vp]; moved[12] += 1e-6;
        write(key, moved); expect(key.matches()).toBe(false);
        write(key, vp, 4); expect(key.matches()).toBe(false);
        write(key, vp, 3, {}); expect(key.matches()).toBe(false);
        write(key, vp, 3, camera, new Set()); expect(key.matches()).toBe(false);
        write(key, vp); key.num(1); expect(key.matches()).toBe(false);
        write(key, vp); expect(key.matches()).toBe(true);
    });

    it('never matches NaN, and forgets everything on invalidate', () => {
        const key = new OcclusionReuseKey();
        write(key, vp, NaN); key.commit();
        write(key, vp, NaN); expect(key.matches()).toBe(false);
        write(key, vp); key.commit();
        key.invalidate();
        write(key, vp); expect(key.matches()).toBe(false);
    });
});

describe('OcclusionBuffer.resetQueryStats', () => {
    const proj = mat4.perspective(mat4.create(), Math.PI / 3, 16 / 9, 0.1, 1000);
    const view = mat4.lookAt(mat4.create(), [0, 2, 10], [0, 2, 0], [0, 1, 0]);
    const vp = mat4.multiply(mat4.create(), proj, view);

    it('keeps the buffer and its answers, and counts queries from zero again', () => {
        const b = new OcclusionBuffer(256, 144);
        b.begin(vp);
        b.rasterizeBox([-4, 0, 2], [4, 5, 2.5]);
        b.finish();
        const boxes: [number[], number[]][] = [
            [[-1, 0, -3], [1, 2, -1]], [[-1, 0, 4], [1, 2, 5]], [[6, 0, -3], [8, 2, -1]], [[-1, 0, -3], [1, 7, -1]],
        ];
        const first = boxes.map(([min, max]) => b.isBoxOccluded(min, max));
        expect(first).toEqual([true, false, false, false]);
        expect(b.stats.tested).toBe(4);
        const triangles = b.stats.triangles;
        b.resetQueryStats();
        expect([b.stats.tested, b.stats.occluded]).toEqual([0, 0]);
        expect(b.stats.triangles).toBe(triangles);
        expect(boxes.map(([min, max]) => b.isBoxOccluded(min, max))).toEqual(first);
        expect([b.stats.tested, b.stats.occluded]).toEqual([4, 1]);
    });
});
