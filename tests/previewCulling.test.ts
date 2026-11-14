import { describe, it, expect } from 'vitest';
import { mat4, vec3 } from 'gl-matrix';
import {
    FRUSTUM_EDGES, boxMatrix, coneMatrix, edgeIndices, frustumCorners, segmentMatrix, unitBoxLines, unitConeLines,
    unitSphereLines, type FrustumCamera,
} from '../src/graphics/render/cullGhosts';
import { anyPaneCulling } from '../src/graphics/render/viewLayout';
import { methodBody, rendererSource } from './helpers/rendererSource';

// The split viewport's culling view: a preview pane that shows what the EDITING view culled, by leaving
// it out and drawing it as a tinted line ghost (render/cullGhosts.ts, EditorOverlays `_drawCullGhosts`).
// The geometry is pure and tested as such; the wiring needs a GPU, so it is pinned by its source.

const apply = (m: Float32Array, p: number[]) => {
    const out = vec3.transformMat4(vec3.create(), vec3.fromValues(p[0], p[1], p[2]), m as unknown as mat4);
    return [out[0], out[1], out[2]];
};
const close = (a: ArrayLike<number>, b: number[]) => b.forEach((v, i) => expect(a[i]).toBeCloseTo(v, 5));

describe('ghost geometry', () => {
    it('lists each edge of a triangle mesh once', () => {
        // A quad of two triangles: five edges, the diagonal shared.
        const edges = edgeIndices([0, 1, 2, 0, 2, 3]);
        expect(edges.length).toBe(10);
        const pairs = new Set<string>();
        for (let i = 0; i < edges.length; i += 2) pairs.add(`${edges[i]}-${edges[i + 1]}`);
        expect([...pairs].sort()).toEqual(['0-1', '0-2', '0-3', '1-2', '2-3']);
        // A degenerate triangle adds nothing, and a ragged tail is ignored.
        expect(edgeIndices([4, 4, 4, 1]).length).toBe(0);
    });

    it('builds closed line shapes', () => {
        expect(unitBoxLines().indices.length).toBe(24);
        expect(unitSphereLines(8).indices.length).toBe(3 * 8 * 2);
        const cone = unitConeLines(8);
        expect(cone.indices.length).toBe(8 * 2 + 4 * 2);
        expect(cone.positions[0]).toEqual([0, 0, 0]);
        expect(FRUSTUM_EDGES.length).toBe(24);
    });

    it('lays the unit shapes onto a segment, a box and a cone', () => {
        const m = new Float32Array(16);
        segmentMatrix(m, 0, [1, 2, 3], [4, 6, 3]);
        close(apply(m, [0, 0, 0]), [1, 2, 3]);
        close(apply(m, [0, 0, 1]), [4, 6, 3]);
        boxMatrix(m, 0, [0, 0, 0], [2, 4, 6]);
        close(apply(m, [0.5, 0.5, 0.5]), [2, 4, 6]);
        close(apply(m, [-0.5, -0.5, -0.5]), [0, 0, 0]);
        coneMatrix(m, 0, [1, 2, 3], [0, 0, 1], 10, 2);
        close(apply(m, [0, 0, 0]), [1, 2, 3]);
        close(apply(m, [0, 0, 1]), [1, 2, 13]);
        const rim = apply(m, [1, 0, 1]);
        expect(Math.hypot(rim[0] - 1, rim[1] - 2)).toBeCloseTo(2, 5);
        expect(rim[2]).toBeCloseTo(13, 5);
    });
});

describe('frustumCorners', () => {
    // At the origin looking down -Z: the view matrix is the identity.
    const camera = (over: Partial<FrustumCamera>): FrustumCamera => ({
        type: 'perspective', position: [0, 0, 0], viewMatrix: mat4.create() as unknown as number[],
        fov: 90, ratio: 2, near: 1, far: 10, left: -1, right: 1, bottom: -2, top: 2, ...over,
    });

    it('spans a perspective camera, its far plane pulled in to the reach', () => {
        const c = frustumCorners(camera({}), 5);
        close(c.subarray(0, 3), [-2, -1, -1]);     // near bottom-left: tan(45) = 1, times the ratio across
        close(c.subarray(6, 9), [2, 1, -1]);       // near top-right
        close(c.subarray(12, 15), [-10, -5, -5]);  // far bottom-left, at the 5 m reach rather than 10
    });

    it('spans an orthographic camera, its width scaled by the ratio like its projection', () => {
        const c = frustumCorners(camera({ type: 'orthographic', ratio: 1.5 }), 1000);
        close(c.subarray(0, 3), [-1.5, -2, -1]);
        close(c.subarray(18, 21), [1.5, 2, -10]);
    });
});

describe('culling view wiring', () => {
    it('only counts a pane with a switch on', () => {
        expect(anyPaneCulling(undefined)).toBe(false);
        expect(anyPaneCulling({ frustum: false, occlusion: false, foliage: false, lights: false })).toBe(false);
        expect(anyPaneCulling({ frustum: false, occlusion: false, foliage: true, lights: false })).toBe(true);
    });

    it('keeps the editing frustum and camera before any preview draws, and the culling in the preview state', () => {
        const previews = methodBody('_renderPreviews');
        const kept = previews.indexOf('this._visibility.editingFrustum.setFromViewProjection(this._view.viewProj);');
        expect(kept).toBeGreaterThan(-1);
        expect(previews).toContain('this._visibility.editingCamera = this._view.camera;');
        expect(kept).toBeLessThan(previews.indexOf('this._passes.flushFrameEncoder(true);'));
        const swap = methodBody('_withPreviewState');
        expect(swap).toContain('view.previewCulling = anyPaneCulling(culling) ? culling : null;');
        expect(swap).toMatch(/finally \{[\s\S]*view\.previewCulling = null;/);
    });

    it('leaves out what the editing view culled, from every model draw', () => {
        const outside = methodBody('outsideFrustum');
        expect(outside).toContain('const verdict = this.editingVerdict(node);');
        expect(outside).toContain('(verdict === CULL_OUTSIDE && shown.frustum) || (verdict === CULL_OCCLUDED && shown.occlusion)');
    });

    it('draws the editing view\'s own foliage batches instead of re-culling', () => {
        expect(methodBody('preparePreview')).toContain('if (this._mirrorsEditing()) return;');
        expect(methodBody('_bucketsOf')).toContain('this._view.preview && !this._mirrorsEditing()');
        expect(methodBody('colourChunks')).toContain('this._view.preview && !this._mirrorsEditing()');
    });

    it('records the light culling in the editing view only, and drops it in a preview that shows it', () => {
        const grid = methodBody('buildLightGrid');
        expect(grid).toContain('this._recordsEditing = !this._view.preview && !this._view.capturing && !this._view.cubeFace;');
        expect(grid).toContain('this._dropsEditing = this._view.preview && !!this._view.previewCulling?.lights;');
        expect(methodBody('packLightRecords')).toContain('(dropsEditing && this.editingLightCull.has(node))');
    });

    it('ghosts only in a preview showing the culling, under the gizmos', () => {
        const overlay = methodBody('renderEditorOverlay');
        const ghosts = overlay.indexOf('this._drawCullGhosts(scene);');
        expect(overlay).toContain("if (this._view.preview && this._view.previewCulling && this._passes.beginPass('overlay'))");
        expect(ghosts).toBeGreaterThan(-1);
        expect(ghosts).toBeLessThan(overlay.indexOf('this._renderGizmos(gizmos);'));
        // One instance buffer for the pass, each draw bound at its own offset.
        expect(rendererSource()).toContain('this._passes.recordInstancedDraw(pass, mesh, this._ghostInstances!, list.length / 16, offset * 4);');
    });
});
