import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import { Camera } from '../src/core/camera';
import { spriteQuadInto } from '../src/core/math';
import { Sprite } from '../src/graphics/sprite';
import { Tileset } from '../src/graphics/tilemap/tileset';
import { SpriteNode } from '../src/core/scene/nodes/spriteNode';

// 2D sprites: sized by their tileset's pixels per unit, placed by a pivot, mirrored by a flip, and cut from
// free-form regions as well as a grid.

const sheet = (extra: Partial<ConstructorParameters<typeof Tileset>[0]> = {}) => new Tileset({
    id: 'sheet', textureId: 'sheet.png', imageWidth: 270, imageHeight: 135, tileWidth: 135, tileHeight: 135,
    columns: 2, rows: 1, ...extra,
});

/** The four corners of a sprite quad placed by `m`, as [minX, minY, maxX, maxY]. */
function extent(m: mat4): number[] {
    const xs: number[] = [], ys: number[] = [];
    for (const [x, y] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
        const p = vec3.transformMat4(vec3.create(), [x, y, 0], m);
        xs.push(p[0]); ys.push(p[1]);
    }
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].map(v => +v.toFixed(6));
}

const ortho = () => {
    const c = new Camera({ type: 'orthographic' });
    c.position = vec3.fromValues(0, 0, 10);
    c.eye = vec3.fromValues(0, 0, 9);
    return c;
};

describe('spriteQuadInto', () => {
    it('sizes the unit quad and moves the pivot onto the origin', () => {
        const m = mat4.create();
        spriteQuadInto(m, 4, 2, 0.5, 0);
        expect(extent(m)).toEqual([-2, 0, 2, 2]);
        const c = mat4.create();
        spriteQuadInto(c, 4, 2, 0.5, 0.5);
        expect(extent(c)).toEqual([-2, -1, 2, 1]);
    });

    it('works on a scaled matrix, in the matrix\'s units', () => {
        const m = mat4.fromScaling(mat4.create(), [2, 3, 1]);
        spriteQuadInto(m, 1, 1, 0, 0);
        expect(extent(m)).toEqual([0, 0, 2, 3]);
    });
});

describe('Tileset pixels per unit and regions', () => {
    it('sizes nothing without pixels per unit: the legacy unit quad', () => {
        const s = new Sprite({ tileset: sheet() });
        expect(s.quadSize(0, [0, 0])).toEqual([1, 1]);
    });

    it('sizes a sprite by its tile over pixels per unit', () => {
        const s = new Sprite({ tileset: sheet({ pixelsPerUnit: 16 }) });
        const [w, h] = s.quadSize(0, [0, 0]);
        expect(w).toBeCloseTo(135 / 16, 6);
        expect(h).toBeCloseTo(135 / 16, 6);
    });

    it('cuts free-form regions, sized and mapped each its own', () => {
        const ts = sheet({ imageWidth: 100, imageHeight: 50, regions: [[0, 0, 10, 20], [40, 10, 30, 30]], pixelsPerUnit: 10 });
        expect(ts.tileCount).toBe(2);
        expect(ts.sizeOf(1)).toEqual([30, 30]);
        const uv = ts.uvOf(1);
        // [left, bottom, right, top], V measured from the bottom.
        expect([...uv].map(v => +v.toFixed(4))).toEqual([0.4, 0.2, 0.7, 0.8]);
        expect(new Sprite({ tileset: ts, tileIndex: 0 }).quadSize(0, [0, 0])).toEqual([1, 2]);
    });

    it('round-trips pixels per unit and regions, and writes neither when unset', () => {
        const plain = sheet().serialize();
        expect('pixelsPerUnit' in plain).toBe(false);
        expect('regions' in plain).toBe(false);
        const ts = sheet({ pixelsPerUnit: 16, regions: [[1, 2, 3, 4]] });
        const back = Tileset.parse(ts.serialize());
        expect(back.pixelsPerUnit).toBe(16);
        expect(back.regions).toEqual([[1, 2, 3, 4]]);
    });

    it('drops regions that are not rectangles, and keeps none when none are left', () => {
        expect(sheet({ regions: [[1, 2] as any] }).hasRegions).toBe(false);
        expect(sheet({ regions: [] }).hasRegions).toBe(false);
        expect(sheet({ regions: [[0, 0, 0, 0]] }).sizeOf(0)).toEqual([1, 1]);
    });
});

describe('Sprite pivot and flip', () => {
    it('defaults to the centre, unflipped, and writes none of it then', () => {
        const s = new Sprite();
        expect(s.pivot).toEqual([0.5, 0.5]);
        expect(s.flipX).toBe(false);
        const json = s.serialize();
        expect('pivot' in json || 'flipX' in json || 'flipY' in json).toBe(false);
    });

    it('round-trips a pivot and flips', () => {
        const s = new Sprite({ pivot: [0.5, 0.35], flipX: true, flipY: true });
        const back = Sprite.parse(s.serialize());
        expect(back.pivot).toEqual([0.5, 0.35]);
        expect(back.flipX).toBe(true);
        expect(back.flipY).toBe(true);
    });
});

describe('SpriteNode.quadMatrixInto', () => {
    const warrior = (pivot: [number, number], flipX = false) => {
        const node = new SpriteNode('w', new Sprite({ tileset: sheet({ pixelsPerUnit: 16 }), pivot, flipX }), 'free');
        node.updateTransforms(null);
        return node;
    };

    it('stands a sprite pivoted at its feet on its position', () => {
        const node = warrior([0.5, 0]);
        node.setPosition([3, 1, 0]);
        node.updateTransforms(null);
        const [x0, y0, x1, y1] = extent(node.quadMatrixInto(mat4.create(), ortho()));
        expect(y0).toBeCloseTo(1, 5);
        expect(y1 - y0).toBeCloseTo(135 / 16, 5);
        expect((x0 + x1) / 2).toBeCloseTo(3, 5);
    });

    it('mirrors the pivot with the image', () => {
        const right = extent(warrior([0.25, 0.5]).quadMatrixInto(mat4.create(), ortho()));
        const left = extent(warrior([0.25, 0.5], true).quadMatrixInto(mat4.create(), ortho()));
        // A pivot a quarter in from the left is a quarter in from the right once flipped.
        expect(right[0]).toBeCloseTo(-0.25 * 135 / 16, 5);
        expect(left[2]).toBeCloseTo(0.25 * 135 / 16, 5);
    });

    it('bounds a pixel-sized sprite by its quad, a legacy one by a small box round its origin', () => {
        const box = warrior([0.5, 0]).getBoundingBox();
        expect(box.max[1] - box.min[1]).toBeCloseTo(135 / 16, 4);
        const legacy = new SpriteNode('l', new Sprite({ tileset: sheet() }), 'free');
        legacy.updateTransforms(null);
        const b = legacy.getBoundingBox();
        expect(b.max[0] - b.min[0]).toBeCloseTo(0.6, 5);
    });
});
