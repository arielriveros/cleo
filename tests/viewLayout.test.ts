import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { isSplitLayout, paneRects, paneViewport, type ViewLayout } from '../src/graphics/render/viewLayout';
import { methodBody } from './helpers/rendererSource';

// The editor's split viewport (render/viewLayout.ts): one editing pane drawn by the full frame, preview
// panes drawn after it through their own cameras with nothing temporal. The arithmetic runs; the frame's
// contract is read off the source, as the other renderer tests do (constructing a Renderer needs a GPU).

describe('paneRects', () => {
    it('splits row-major from the top left into equal integer panes', () => {
        expect(paneRects(800, 600, 2, 2)).toEqual([
            { x: 0, y: 0, w: 400, h: 300 }, { x: 400, y: 0, w: 400, h: 300 },
            { x: 0, y: 300, w: 400, h: 300 }, { x: 400, y: 300, w: 400, h: 300 },
        ]);
        expect(paneRects(800, 600, 2, 1)).toEqual([{ x: 0, y: 0, w: 400, h: 600 }, { x: 400, y: 0, w: 400, h: 600 }]);
        expect(paneRects(800, 600, 1, 2)).toEqual([{ x: 0, y: 0, w: 800, h: 300 }, { x: 0, y: 300, w: 800, h: 300 }]);
    });

    it('keeps every pane the same size, leaving an odd pixel unused', () => {
        const rects = paneRects(801, 599, 2, 2);
        for (const r of rects) expect([r.w, r.h]).toEqual([400, 299]);
        expect(rects[3]).toEqual({ x: 400, y: 299, w: 400, h: 299 });
    });

    it('never makes a pane of zero size', () => {
        for (const r of paneRects(1, 1, 2, 2)) expect(r.w * r.h).toBeGreaterThan(0);
    });
});

describe('paneViewport', () => {
    const rect = { x: 400, y: 0, w: 400, h: 300 };
    it('counts y from the top on a top-left origin (WebGPU)', () => {
        expect(paneViewport(rect, 600, true)).toEqual([400, 0, 400, 300]);
    });
    it('counts y from the bottom on a bottom-left origin (WebGL2)', () => {
        expect(paneViewport(rect, 600, false)).toEqual([400, 300, 400, 300]);
        expect(paneViewport({ x: 0, y: 300, w: 400, h: 300 }, 600, false)).toEqual([0, 0, 400, 300]);
    });
});

describe('isSplitLayout', () => {
    const pane = { camera: null, realtime: false };
    it('takes a real split only', () => {
        expect(isSplitLayout(null)).toBe(false);
        expect(isSplitLayout({ cols: 1, rows: 1, primary: 0, panes: [pane] })).toBe(false);
        expect(isSplitLayout({ cols: 2, rows: 1, primary: 0, panes: [pane, pane] })).toBe(true);
    });
    it('refuses a pane count or a primary that does not fit', () => {
        expect(isSplitLayout({ cols: 2, rows: 2, primary: 0, panes: [pane, pane] } as ViewLayout)).toBe(false);
        expect(isSplitLayout({ cols: 2, rows: 1, primary: 2, panes: [pane, pane] })).toBe(false);
    });
});

describe('the preview path', () => {
    const previews = methodBody('_renderPreviews');
    const view = methodBody('_renderPreviewView');

    it('runs inside the frame, after the editing view stamps its next frame, before the counter moves', () => {
        const frame = methodBody('_renderFrame');
        const at = frame.indexOf('this._renderPreviews(scene, shadowLight);');
        expect(at).toBeGreaterThan(frame.indexOf('this._temporal.capturePrevTransforms(scene);'));
        expect(at).toBeGreaterThan(frame.indexOf('this._view.hasPrevViewProj = true;'));
        expect(at).toBeLessThan(frame.indexOf('this._view.frameIndex++;'));
    });

    it('submits what the frame recorded before each preview writes a buffer', () => {
        expect(previews.indexOf('this._passes.flushFrameEncoder(true);'))
            .toBeLessThan(previews.indexOf('this._withPreviewState('));
    });

    it('redraws the cascades whole at the editing view\'s next frame', () => {
        expect(previews.indexOf('this._shadows.requestFullUpdate();'))
            .toBeGreaterThan(previews.indexOf('this._withPreviewState('));
    });

    it('touches none of the editing view\'s temporal state', () => {
        for (const call of ['invalidateTemporalHistory', '_detectTemporalCut', 'capturePrevTransforms',
                            'detectObjectMotion', 'stampAnimationView', 'buildOcclusion', 'beginGpuOcclusion',
                            'advanceWindTime', 'simulateParticles', 'ensureFoliageUploaded', 'frameIndex++'])
            expect(view, call).not.toContain(call);
    });

    it('runs with the preview flag, no TAA phase and no previous camera, and restores them', () => {
        const swap = methodBody('_withPreviewState');
        expect(swap).toContain('view.preview = true;');
        expect(swap).toContain('view.hasPrevViewProj = false;');
        expect(swap).toContain('view.taaJitterActive = false;');
        expect(swap).toMatch(/finally \{[\s\S]*view\.preview = false;[\s\S]*view\.camera = editingCamera;/);
    });

    it('is gated wherever a subsystem keeps per-camera history', () => {
        expect(methodBody('ssilPass')).toContain("!this._view.preview && this._passes.beginPass('ssao.temporal')");
        // The radiance copy (render/sceneRadiance.ts); `capture` names more than one method.
        const radiance = readFileSync(join(__dirname, '..', 'src', 'graphics', 'render', 'sceneRadiance.ts'), 'utf-8');
        expect(methodBody('capture', radiance)).toContain('this._view.preview) return;');
        expect(methodBody('_meterScene')).toContain('this._view.preview) return;');
        expect(methodBody('_renderDeferred')).toContain("!this._view.preview && this._passes.beginPass('ssr')");
        expect(methodBody('renderForwardOverlay')).toContain("!this._view.preview && !this._sky.cloudSkyActive(scene)");
        expect(methodBody('_applyPostProcessing')).toContain('if (!this._view.preview) this._autoExposure.resolveExposure();');
    });

    it('draws no gizmo handles in a preview', () => {
        expect(methodBody('renderEditorOverlay')).toContain('this._view.preview ? EditorOverlays._NO_GIZMOS : gizmoNodes');
    });
});
