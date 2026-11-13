import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Scene, sceneDimensionOf } from '../src/core/scene/scene';
import { Tilemap } from '../src/graphics/tilemap/tilemap';
import { RENDER_2D_DEFAULTS, RENDER_3D_DEFAULTS } from '../src/graphics/render/settingsTypes';
import { methodBody, rendererSource } from './helpers/rendererSource';

// The flat 2D frame: a 2D scene (Scene.dimension) drawn with none of the 3D passes. These pin what it runs
// and what it does not, and the data that decides it.

describe('Scene.dimension', () => {
    it('is 3D by default and absent from a 3D scene file, so old saves read unchanged', async () => {
        const scene = new Scene();
        expect(scene.dimension).toBe('3D');
        const json = await scene.serialize(true);
        expect('dimension' in json.scene).toBe(false);
        const back = new Scene();
        back.parse(json, true);
        expect(back.dimension).toBe('3D');
    });

    it('round-trips a 2D scene through the scene file', async () => {
        const scene = new Scene();
        scene.dimension = '2D';
        const json = await scene.serialize(true);
        expect(json.scene.dimension).toBe('2D');
        const back = new Scene();
        back.parse(json, true);
        expect(back.dimension).toBe('2D');
    });

    it('reads only an explicit 2D as 2D', () => {
        expect(sceneDimensionOf({ dimension: '2D' })).toBe('2D');
        expect(sceneDimensionOf({ dimension: '3D' })).toBe('3D');
        expect(sceneDimensionOf({ dimension: 'flat' })).toBe('3D');
        expect(sceneDimensionOf({})).toBe('3D');
        expect(sceneDimensionOf(null)).toBe('3D');
    });

    it('resets on parse: a 3D scene parsed into a scene object that held a 2D one is 3D', async () => {
        const flat = new Scene();
        flat.dimension = '2D';
        const json = await new Scene().serialize(true);
        flat.parse(json, true);
        expect(flat.dimension).toBe('3D');
    });
});

describe('Tilemap.entitySort', () => {
    it("defaults to 'y' and is written only when it is a side view", () => {
        const map = new Tilemap({ kind: 'orthogonal', cellWidth: 1, cellHeight: 1 });
        expect(map.entitySort).toBe('y');
        expect('entitySort' in map.serialize()).toBe(false);
        map.entitySort = 'none';
        const json = map.serialize();
        expect(json.entitySort).toBe('none');
        expect(Tilemap.deserialize(json).entitySort).toBe('none');
        expect(Tilemap.deserialize({ ...json, entitySort: 'sideways' }).entitySort).toBe('y');
    });
});

describe('the flat 2D frame', () => {
    const frame = () => methodBody('_renderFrame2D');
    const passes = () => readFileSync(join(__dirname, '..', 'src', 'graphics', 'render', 'frame2d.ts'), 'utf-8').replace(/\r\n/g, '\n');

    it('is dispatched from render() for a 2D scene unless its settings ask for the full pipeline', () => {
        const render = methodBody('render');
        expect(render).toMatch(/scene\.dimension === '2D' && this\._pipeline2D === 'flat'/);
        expect(render).toContain('this._renderFrame2D(scene)');
        expect(render).toContain('this._renderFrame(scene)');
        // Leaving the flat frame drops the temporal histories it never kept up.
        expect(render).toMatch(/if \(this\._view\.flat2D && !flat\) this\.invalidateTemporalHistory\(\)/);
    });

    it('runs none of the 3D passes', () => {
        const body = frame() + passes();
        for (const needle of ['renderCascades', 'renderSpotShadows', 'renderPointShadows', 'geometryPass', 'deferredLightingPass',
                              'renderForwardOverlay', 'renderSky', 'renderVolumetricClouds', 'taaResolvePass', 'produceVelocity',
                              'meterScene', 'meterPass', 'updateIBL', 'updateSkyAtmosphere', '_gi.update', 'buildOcclusion',
                              'detectObjectMotion', 'ssilPass', 'ssrPass', 'decalReceiverPass', 'renderShelter'])
            expect(body, needle).not.toContain(needle);
    });

    it('draws the 2D pass, the editor chrome and the selection, then the post chain', () => {
        const body = frame();
        expect(body).toContain('this._frame2D.render(scene)');
        expect(body).toContain('this._applyPostProcessing(scene)');
        expect(body.indexOf('this._frame2D.render(scene)')).toBeLessThan(body.indexOf('this._applyPostProcessing(scene)'));
        const scene = methodBody('render', passes());
        expect(scene).toContain('render2DPass(scene)');
        expect(scene).toContain('renderEditorOverlay(scene, helpers, gizmos)');
        expect(scene).toContain('renderSelectionMask([], selected)');
        // The background is cleared with its depth: nothing copied a G-buffer's into it.
        expect(scene).toMatch(/beginFullscreenPass\(this\._targets\.scene\.renderTarget, '2d\.clear', true, bg, true\)/);
    });

    it('builds the light grid only for lit editor chrome, never for the game', () => {
        const scene = methodBody('render', passes());
        expect(scene).toMatch(/if \(gizmos\.length > 0 \|\| helpers\.length > 0\) \{[^}]*buildLightGrid\(scene\)/);
    });

    it('is unjittered, and leaves no previous view for a 3D frame to reproject through', () => {
        const body = frame();
        expect(body).toContain('this._view.taaJitterActive = false;');
        expect(body).toContain('this._view.hasPrevViewProj = false;');
        expect(body).toContain('this._temporal.motionBlurWillRun = false;');
    });

    it('exposes at 1 and never meters', () => {
        const source = rendererSource();
        expect(methodBody('resolveExposure', source)).toMatch(/if \(this\._view\.flat2D\) \{\s*this\._view\.exposure = 1;/);
        expect(methodBody('meteringActive', source)).toContain('!this._view.flat2D');
    });

    it('leaves the post chain\'s depth and sky effects and the debug channels out', () => {
        const graph = methodBody('_buildPostGraph');
        expect(graph).toMatch(/godRaysEnabled \|\| this\._view\.flat2D\) continue/);
        expect(graph).toMatch(/'dof\.coc'\] \|\| this\._view\.flat2D\) continue/);
        expect(graph).toMatch(/!== 'orthographic' && !this\._view\.flat2D\)/);
        expect(graph).toMatch(/debugView !== 'final' && !this\._view\.flat2D\)/);
    });

    it('takes no depth snapshot for a sprite soft fade or a particle to read', () => {
        const source = rendererSource();
        expect(source).toMatch(/depth: this\._host\.thumbnailMode \|\| this\._view\.flat2D \? null/);
        expect(source).toMatch(/const live = blendClass !== BLEND_OVERLAY && !this\._host\.thumbnailMode && !this\._view\.flat2D/);
    });
});

describe('the 2D look', () => {
    it('shows authored pixels: no tone curve, bloom only past white', () => {
        expect(RENDER_2D_DEFAULTS.toneMapper).toBe('none');
        expect(RENDER_2D_DEFAULTS.bloomMode).toBe('threshold');
        expect(RENDER_2D_DEFAULTS.bloomThreshold).toBeGreaterThan(1);
    });

    it('has a 3D value for every key it sets', () => {
        expect(Object.keys(RENDER_3D_DEFAULTS).sort()).toEqual(Object.keys(RENDER_2D_DEFAULTS).sort());
    });
});
